import { app, BrowserWindow } from 'electron'
import { execFile, spawn, type ChildProcess } from 'child_process'
import { randomUUID } from 'crypto'
import { existsSync } from 'fs'
import { mkdir, readFile, unlink, writeFile } from 'fs/promises'
import { join } from 'path'
import { resolvePythonCommand } from './runner'

const PROTOCOL_MAJOR = 1
const TRAINING_ROOT_NAME = 'strum-training'
const RUNTIME_SETTINGS_NAME = 'runtime.json'
const REGISTRY_NAME = 'registry.json'

export type TrainingPipeline = {
  id: string
  display_name: string
  kind: string
  catalog_requirements: {
    instrument: string
    difficulties: string[]
    audio_roles: string[]
    audio_policy: string
  }
  prepare_schema: Record<string, unknown>
  train_schema: Record<string, unknown>
  checkpoint_outputs: string[]
  inference_capability: string | null
}

export type TrainingRuntime = {
  runtimeId: string
  displayName: string
  kind: 'bundled_inference' | 'developer_override' | 'managed_checkout' | 'installed_runtime'
  protocolVersion: string
  capabilities: string[]
  pipelineIds: string[]
  deviceSupport: string[]
  trainingSetupRequired: boolean
  dirty: boolean
  sourceRevision: string | null
}

export type TrainingCatalogInspection = {
  pipelineId: string
  eligibleCount: number
  recordCount: number
  excluded: Record<string, number>
  audioPolicy: string
  estimatedStorageBytes: number
}

export type TrainingTask = {
  taskViewId: string
  catalogId: string
  catalogName: string
  pipelineId: string
  eligibleCount: number
  contentHash: string
  createdAt: string
}

export type TrainingRun = {
  runId: string
  taskViewId: string
  pipelineId: string
  checkpointCount: number
  deployable: boolean
  checkpointManifestHash: string
  createdAt: string
}

export type TrainingJobEvent = {
  jobId: string
  sequence: number
  stage: string
  progress?: number
  state?:
    | 'queued'
    | 'validating'
    | 'provisioning'
    | 'running'
    | 'cancelling'
    | 'succeeded'
    | 'failed'
    | 'cancelled'
  code?: string
  message: string
  result?: Record<string, unknown>
}

type RuntimeSettings = {
  developerSourceRoot?: string
}

type TrainingRegistry = {
  tasks: Array<TrainingTask & { taskRoot: string; catalogRoot: string }>
  runs: Array<TrainingRun & { outputRoot: string }>
}

type RunningTrainingJob = {
  process: ChildProcess
  requestPath: string
  sequence: number
  cancelling: boolean
  runId?: string
}

const runningJobs = new Map<string, RunningTrainingJob>()

function trainingRoot(): string {
  return join(app.getPath('userData'), TRAINING_ROOT_NAME)
}

function registryPath(): string {
  return join(trainingRoot(), REGISTRY_NAME)
}

function runtimeSettingsPath(): string {
  return join(trainingRoot(), RUNTIME_SETTINGS_NAME)
}

function workerScriptPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'resources', 'strum', 'strum_worker.py')
    : join(process.cwd(), 'resources', 'strum', 'strum_worker.py')
}

function broadcast(payload: TrainingJobEvent): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('training:progress', payload)
  }
}

async function readRuntimeSettings(): Promise<RuntimeSettings> {
  try {
    return JSON.parse(await readFile(runtimeSettingsPath(), 'utf8')) as RuntimeSettings
  } catch {
    return {}
  }
}

async function readRegistry(): Promise<TrainingRegistry> {
  try {
    const registry = JSON.parse(await readFile(registryPath(), 'utf8')) as TrainingRegistry
    return {
      tasks: Array.isArray(registry.tasks) ? registry.tasks : [],
      runs: Array.isArray(registry.runs) ? registry.runs : []
    }
  } catch {
    return { tasks: [], runs: [] }
  }
}

async function writeRegistry(registry: TrainingRegistry): Promise<void> {
  await mkdir(trainingRoot(), { recursive: true })
  await writeFile(registryPath(), JSON.stringify(registry, null, 2) + '\n', 'utf8')
}

function hasLegacyGuitarSources(root: string): boolean {
  return (
    existsSync(join(root, 'scripts', 'preprocess_guitar_windows.py')) &&
    existsSync(join(root, 'scripts', 'train_guitar_v1.py'))
  )
}

function findDetectedDeveloperRoot(): string | null {
  const configured = process.env.OCTAVE_STRUM_SOURCE_DIR?.trim()
  const candidates = [configured, join(process.cwd(), '..', 'strum'), join(process.cwd(), 'strum')]
  return (
    candidates.find((candidate): candidate is string =>
      Boolean(candidate && hasLegacyGuitarSources(candidate))
    ) ?? null
  )
}

async function workerEnvironment(): Promise<NodeJS.ProcessEnv> {
  const settings = await readRuntimeSettings()
  const controlRoot = join(trainingRoot(), 'control')
  await mkdir(controlRoot, { recursive: true })
  return {
    ...process.env,
    PYTHONUTF8: '1',
    OCTAVE_STRUM_TRAINING_CONTROL_ROOT: controlRoot,
    ...(settings.developerSourceRoot
      ? {
          OCTAVE_STRUM_SOURCE_DIR: settings.developerSourceRoot,
          OCTAVE_STRUM_LEGACY_TRAINING_ADAPTER: '1'
        }
      : {})
  }
}

function normalizeRuntime(raw: unknown): TrainingRuntime {
  if (!raw || typeof raw !== 'object')
    throw new Error('STRUM did not return a runtime description.')
  const value = raw as Record<string, unknown>
  const version = String(value.protocol_version ?? '')
  if (Number(version.split('.')[0]) !== PROTOCOL_MAJOR) {
    throw new Error('The selected STRUM runtime uses an unsupported protocol version.')
  }
  const kind = String(value.runtime_kind ?? 'bundled_inference')
  if (
    !['bundled_inference', 'developer_override', 'managed_checkout', 'installed_runtime'].includes(
      kind
    )
  ) {
    throw new Error('The selected STRUM runtime reported an invalid runtime kind.')
  }
  return {
    runtimeId: String(value.runtime_id ?? 'unknown-runtime'),
    displayName: String(value.display_name ?? 'STRUM runtime'),
    kind: kind as TrainingRuntime['kind'],
    protocolVersion: version,
    capabilities: Array.isArray(value.capabilities) ? value.capabilities.map(String) : [],
    pipelineIds: Array.isArray(value.pipeline_ids) ? value.pipeline_ids.map(String) : [],
    deviceSupport: Array.isArray(value.device_support) ? value.device_support.map(String) : [],
    trainingSetupRequired: Boolean(value.training_setup_required),
    dirty: Boolean(value.dirty),
    sourceRevision: value.source_revision ? String(value.source_revision) : null
  }
}

async function runWorkerJson(args: string[]): Promise<Record<string, unknown>> {
  const python = await resolvePythonCommand('training-probe')
  const script = workerScriptPath()
  if (!existsSync(script)) throw new Error('OCTAVE could not find its STRUM runtime adapter.')
  const env = await workerEnvironment()
  return await new Promise((resolve, reject) => {
    execFile(
      python.command,
      [...python.baseArgs, script, ...args],
      { env, timeout: 20_000 },
      (error, stdout) => {
        const line = stdout.split(/\r?\n/).find((entry) => entry.trim())
        if (error || !line) {
          reject(new Error('The selected STRUM runtime could not be validated.'))
          return
        }
        try {
          const payload = JSON.parse(line) as Record<string, unknown>
          if (payload.error) {
            reject(new Error('The selected STRUM runtime rejected this request.'))
            return
          }
          resolve(payload)
        } catch {
          reject(new Error('The selected STRUM runtime returned an invalid response.'))
        }
      }
    )
  })
}

export async function probeTrainingRuntime(): Promise<TrainingRuntime> {
  return normalizeRuntime(await runWorkerJson(['probe', '--json']))
}

export async function enableDetectedDeveloperTrainingRuntime(): Promise<TrainingRuntime | null> {
  if (app.isPackaged) return null
  const root = findDetectedDeveloperRoot()
  if (!root) return null
  await mkdir(trainingRoot(), { recursive: true })
  await writeFile(
    runtimeSettingsPath(),
    JSON.stringify({ developerSourceRoot: root }, null, 2) + '\n',
    'utf8'
  )
  return await probeTrainingRuntime()
}

export async function listTrainingPipelines(): Promise<TrainingPipeline[]> {
  const runtime = await probeTrainingRuntime()
  if (!runtime.capabilities.includes('training')) return []
  const payload = await runWorkerJson(['pipeline', 'list', '--json'])
  const pipelines = Array.isArray(payload.pipelines) ? payload.pipelines : []
  return pipelines.filter((pipeline): pipeline is TrainingPipeline =>
    Boolean(
      pipeline &&
      typeof pipeline === 'object' &&
      typeof (pipeline as Record<string, unknown>).id === 'string'
    )
  )
}

export async function inspectTrainingCatalog(
  catalogRoot: string,
  pipelineId: string
): Promise<TrainingCatalogInspection> {
  const payload = await runWorkerJson([
    'catalog',
    'inspect',
    '--catalog',
    catalogRoot,
    '--pipeline',
    pipelineId,
    '--json'
  ])
  return {
    pipelineId: String(payload.pipeline_id ?? pipelineId),
    eligibleCount: Number(payload.eligible_count ?? 0),
    recordCount: Number(payload.record_count ?? 0),
    excluded:
      typeof payload.excluded === 'object' && payload.excluded
        ? Object.fromEntries(
            Object.entries(payload.excluded as Record<string, unknown>).map(([key, value]) => [
              key,
              Number(value)
            ])
          )
        : {},
    audioPolicy: String(payload.audio_policy ?? ''),
    estimatedStorageBytes: Number(payload.estimated_storage_bytes ?? 0)
  }
}

export async function listTrainingArtifacts(): Promise<{
  tasks: TrainingTask[]
  runs: TrainingRun[]
}> {
  const registry = await readRegistry()
  return {
    tasks: registry.tasks
      .filter((task) => existsSync(task.taskRoot))
      .map((task) => ({
        taskViewId: task.taskViewId,
        catalogId: task.catalogId,
        catalogName: task.catalogName,
        pipelineId: task.pipelineId,
        eligibleCount: task.eligibleCount,
        contentHash: task.contentHash,
        createdAt: task.createdAt
      })),
    runs: registry.runs
      .filter((run) => existsSync(run.outputRoot))
      .map((run) => ({
        runId: run.runId,
        taskViewId: run.taskViewId,
        pipelineId: run.pipelineId,
        checkpointCount: run.checkpointCount,
        deployable: run.deployable,
        checkpointManifestHash: run.checkpointManifestHash,
        createdAt: run.createdAt
      }))
  }
}

async function startJsonEventJob(
  jobId: string,
  args: string[],
  request: Record<string, unknown>,
  onSucceeded: (result: Record<string, unknown>) => Promise<Record<string, unknown>>,
  runId?: string
): Promise<void> {
  const python = await resolvePythonCommand(jobId)
  const script = workerScriptPath()
  if (!existsSync(script)) throw new Error('OCTAVE could not find its STRUM runtime adapter.')
  const requestPath = join(app.getPath('temp'), `octave-training-${jobId}.json`)
  await writeFile(requestPath, JSON.stringify(request), 'utf8')
  const env = await workerEnvironment()
  const child = spawn(
    python.command,
    [...python.baseArgs, script, ...args, '--request', requestPath, '--json-events'],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
      detached: process.platform !== 'win32'
    }
  )
  const job: RunningTrainingJob = {
    process: child,
    requestPath,
    sequence: 0,
    cancelling: false,
    runId
  }
  runningJobs.set(jobId, job)
  broadcast({
    jobId,
    sequence: 0,
    stage: 'queued',
    progress: 0,
    state: 'queued',
    message: 'Queued locally.'
  })
  let remainder = ''
  let terminal = false
  let cleanedUp = false
  const cleanup = async (fallbackState?: 'failed' | 'cancelled'): Promise<void> => {
    if (cleanedUp) return
    cleanedUp = true
    runningJobs.delete(jobId)
    try {
      await unlink(requestPath)
    } catch {
      /* idempotent cleanup */
    }
    if (!terminal && fallbackState) {
      broadcast({
        jobId,
        sequence: job.sequence + 1,
        stage: 'complete',
        state: fallbackState,
        code: fallbackState === 'cancelled' ? 'cancelled' : 'worker_terminated',
        message:
          fallbackState === 'cancelled'
            ? 'The STRUM training job was cancelled.'
            : 'The STRUM training job ended unexpectedly.'
      })
    }
  }
  const consume = (chunk: Buffer): void => {
    remainder += chunk.toString('utf8')
    const lines = remainder.split(/\r?\n/)
    remainder = lines.pop() ?? ''
    for (const line of lines) {
      try {
        const event = JSON.parse(line) as Record<string, unknown>
        if (event.event !== 'progress' && event.event !== 'terminal') continue
        const sequence = Number(event.sequence)
        if (!Number.isInteger(sequence) || sequence <= job.sequence) continue
        job.sequence = sequence
        const message = String(event.message ?? 'STRUM is processing locally.')
        const code = event.code ? String(event.code) : undefined
        if (event.event === 'progress') {
          broadcast({
            jobId,
            sequence,
            stage: String(event.stage ?? 'running'),
            progress: Number(event.progress ?? 0),
            state: 'running',
            code,
            message
          })
          continue
        }
        terminal = true
        const state = String(event.state)
        if (
          !job.cancelling &&
          state === 'succeeded' &&
          event.result &&
          typeof event.result === 'object'
        ) {
          void onSucceeded(event.result as Record<string, unknown>)
            .then((result) => {
              broadcast({
                jobId,
                sequence,
                stage: 'complete',
                progress: 1,
                state: 'succeeded',
                message: 'Completed locally.',
                result
              })
            })
            .catch(() => {
              broadcast({
                jobId,
                sequence,
                stage: 'complete',
                state: 'failed',
                code: 'result_unavailable',
                message: 'The completed job could not be registered.'
              })
            })
        } else {
          broadcast({
            jobId,
            sequence,
            stage: 'complete',
            state: job.cancelling || state === 'cancelled' ? 'cancelled' : 'failed',
            code,
            message
          })
        }
      } catch {
        // The protocol declares stdout machine-readable. Ignore anything else
        // rather than exposing it to the renderer or user-visible logs.
      }
    }
  }
  child.stdout?.on('data', consume)
  child.stderr?.on('data', consume)
  child.once('error', () => void cleanup(job.cancelling ? 'cancelled' : 'failed'))
  child.once('close', () => void cleanup(job.cancelling ? 'cancelled' : 'failed'))
}

export async function startTrainingPrepare(options: {
  catalogRoot: string
  catalogId: string
  catalogName: string
  pipelineId: string
  splitSeed?: number
}): Promise<{ jobId: string; taskViewId: string }> {
  const jobId = randomUUID()
  const taskViewId = `task-${randomUUID()}`
  const taskRoot = join(trainingRoot(), 'tasks', taskViewId)
  await mkdir(join(trainingRoot(), 'tasks'), { recursive: true })
  await startJsonEventJob(
    jobId,
    ['dataset', 'prepare'],
    {
      job_id: jobId,
      task_id: taskViewId,
      catalog_root: options.catalogRoot,
      task_root: taskRoot,
      pipeline_id: options.pipelineId,
      prepare: { split_seed: options.splitSeed ?? 20260814 }
    },
    async (result) => {
      const registry = await readRegistry()
      const task: TrainingTask & { taskRoot: string; catalogRoot: string } = {
        taskViewId,
        catalogId: options.catalogId,
        catalogName: options.catalogName,
        pipelineId: options.pipelineId,
        eligibleCount: Number(result.eligible_count ?? 0),
        contentHash: String(result.content_hash ?? ''),
        createdAt: new Date().toISOString(),
        taskRoot,
        catalogRoot: options.catalogRoot
      }
      registry.tasks = [...registry.tasks.filter((entry) => entry.taskViewId !== taskViewId), task]
      await writeRegistry(registry)
      return { taskViewId, eligibleCount: task.eligibleCount, contentHash: task.contentHash }
    }
  )
  return { jobId, taskViewId }
}

export async function startTrainingRun(options: {
  taskViewId: string
  pipelineId: string
  train: { epochs: number; batchSize: number; device: string; seed: number }
}): Promise<{ jobId: string; runId: string }> {
  const registry = await readRegistry()
  const task = registry.tasks.find(
    (entry) =>
      entry.taskViewId === options.taskViewId &&
      existsSync(entry.taskRoot) &&
      typeof entry.catalogRoot === 'string' &&
      existsSync(entry.catalogRoot)
  )
  if (!task) throw new Error('Select a prepared task view before training.')
  if (task.pipelineId !== options.pipelineId) {
    throw new Error('The selected task view belongs to a different training pipeline.')
  }
  const jobId = randomUUID()
  const runId = `run-${randomUUID()}`
  const outputRoot = join(trainingRoot(), 'runs', runId)
  await mkdir(join(trainingRoot(), 'runs'), { recursive: true })
  await startJsonEventJob(
    jobId,
    ['train', 'start'],
    {
      job_id: jobId,
      run_id: runId,
      task_root: task.taskRoot,
      catalog_root: task.catalogRoot,
      output_root: outputRoot,
      pipeline_id: options.pipelineId,
      train: {
        epochs: options.train.epochs,
        batch_size: options.train.batchSize,
        device: options.train.device,
        seed: options.train.seed
      }
    },
    async (result) => {
      const current = await readRegistry()
      const run: TrainingRun & { outputRoot: string } = {
        runId,
        taskViewId: task.taskViewId,
        pipelineId: options.pipelineId,
        checkpointCount: Number(result.checkpoint_count ?? 0),
        deployable: Boolean(result.deployable),
        checkpointManifestHash: String(result.checkpoint_manifest_hash ?? ''),
        createdAt: new Date().toISOString(),
        outputRoot
      }
      current.runs = [...current.runs.filter((entry) => entry.runId !== runId), run]
      await writeRegistry(current)
      return { runId, checkpointCount: run.checkpointCount, deployable: run.deployable }
    },
    runId
  )
  return { jobId, runId }
}

export async function cancelTrainingJob(jobId: string): Promise<boolean> {
  const job = runningJobs.get(jobId)
  if (!job) return false
  job.cancelling = true
  broadcast({
    jobId,
    sequence: job.sequence + 1,
    stage: 'cancelling',
    state: 'cancelling',
    message: 'Cancelling STRUM and its local child processes…'
  })
  try {
    if (job.runId) void runWorkerJson(['train', 'cancel', '--run', job.runId])
    setTimeout(() => {
      if (!runningJobs.has(jobId)) return
      try {
        if (process.platform !== 'win32' && job.process.pid)
          process.kill(-job.process.pid, 'SIGKILL')
        else job.process.kill('SIGKILL')
      } catch {
        /* terminal cleanup is idempotent */
      }
    }, 5_000).unref()
    return true
  } catch {
    return false
  }
}

export function killAllTrainingJobs(): void {
  for (const [jobId] of runningJobs) void cancelTrainingJob(jobId)
}
