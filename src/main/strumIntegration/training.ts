import { app, BrowserWindow, dialog } from 'electron'
import { execFile, spawn, type ChildProcess } from 'child_process'
import { createHash, randomUUID } from 'crypto'
import { createReadStream, existsSync } from 'fs'
import { mkdir, readFile, stat, unlink, writeFile } from 'fs/promises'
import { join } from 'path'
import { resolvePythonCommand } from './runner'
import { sanitizeTrainingSchemaValues } from './trainingSchema'
import type { AutoChartRunOptions, AutoChartRunResult } from './types'

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

export type TrainingCheckpoint = {
  runId: string
  pipelineId: string
  runtimeId: string
  taskViewId: string
  taskViewHash: string
  checkpointManifestHash: string
  deployable: boolean
  deploymentReason: string | null
  components: Array<{ id: string; sha256: string; byteLength: number }>
}

export type AutoChartProfile = {
  profileId: string
  runId: string
  pipelineId: string
  runtimeId: string
  createdAt: string
  isDefault: boolean
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
  installedWorkerPath?: string
  installedRuntimeLock?: InstalledRuntimeLock
}

type InstalledRuntimeLock = {
  workerSha256: string
  workerByteLength: number
  runtimeId: string
  protocolVersion: string
  capabilities: string[]
  sourceRevision: string | null
  validatedAt: string
}

type WorkerInvocation = {
  command: string
  baseArgs: string[]
  env: NodeJS.ProcessEnv
}

type TrainingRegistry = {
  tasks: Array<TrainingTask & { taskRoot: string; catalogRoot: string }>
  runs: Array<TrainingRun & { outputRoot: string }>
  profiles?: Array<AutoChartProfile & { checkpointRoot: string }>
  defaultProfileId?: string
}

type RunningTrainingJob = {
  process: ChildProcess
  requestPath: string
  sequence: number
  cancelling: boolean
  runId?: string
}

type RunningProfiledAutoChart = {
  process: ChildProcess
  requestPath: string
}

const runningJobs = new Map<string, RunningTrainingJob>()
const runningProfiledAutoCharts = new Map<string, RunningProfiledAutoChart>()

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

function broadcastAutoChartProgress(payload: {
  runId: string
  stage: string
  percent?: number
  message: string
}): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('strum:progress', payload)
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
      runs: Array.isArray(registry.runs) ? registry.runs : [],
      profiles: Array.isArray(registry.profiles) ? registry.profiles : [],
      defaultProfileId:
        typeof registry.defaultProfileId === 'string' ? registry.defaultProfileId : undefined
    }
  } catch {
    return { tasks: [], runs: [], profiles: [] }
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

async function workerEnvironment(settings?: RuntimeSettings): Promise<NodeJS.ProcessEnv> {
  const runtimeSettings = settings ?? (await readRuntimeSettings())
  const controlRoot = join(trainingRoot(), 'control')
  await mkdir(controlRoot, { recursive: true })
  return {
    ...process.env,
    PYTHONUTF8: '1',
    OCTAVE_STRUM_TRAINING_CONTROL_ROOT: controlRoot,
    ...(runtimeSettings.developerSourceRoot
      ? {
          OCTAVE_STRUM_SOURCE_DIR: runtimeSettings.developerSourceRoot,
          OCTAVE_STRUM_LEGACY_TRAINING_ADAPTER: '1'
        }
      : {})
  }
}

async function fingerprintWorker(path: string): Promise<{ sha256: string; byteLength: number }> {
  let fileInfo: Awaited<ReturnType<typeof stat>>
  try {
    fileInfo = await stat(path)
  } catch {
    throw new Error('The selected STRUM runtime is no longer available.')
  }
  if (!fileInfo.isFile()) throw new Error('The selected STRUM runtime is no longer available.')
  return await new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('data', (chunk: string | Buffer) => {
      hash.update(chunk)
    })
    stream.once('error', () =>
      reject(new Error('The selected STRUM runtime is no longer available.'))
    )
    stream.once('end', () => resolve({ sha256: hash.digest('hex'), byteLength: fileInfo.size }))
  })
}

function runtimeLock(
  runtime: TrainingRuntime,
  fingerprint: { sha256: string; byteLength: number }
): InstalledRuntimeLock {
  const validatedAt = new Date().toISOString()
  return {
    workerSha256: fingerprint.sha256,
    workerByteLength: fingerprint.byteLength,
    runtimeId: runtime.runtimeId,
    protocolVersion: runtime.protocolVersion,
    capabilities: [...runtime.capabilities],
    sourceRevision: runtime.sourceRevision,
    validatedAt
  }
}

async function verifyInstalledRuntimeLock(settings: RuntimeSettings): Promise<void> {
  const lock = settings.installedRuntimeLock
  if (!settings.installedWorkerPath || !lock) {
    throw new Error('Select the STRUM runtime again to validate its installation.')
  }
  const fingerprint = await fingerprintWorker(settings.installedWorkerPath)
  if (
    fingerprint.sha256 !== lock.workerSha256 ||
    fingerprint.byteLength !== lock.workerByteLength
  ) {
    throw new Error(
      'The selected STRUM runtime changed after validation. Select it again to continue.'
    )
  }
}

async function resolveWorkerInvocation(purpose: string): Promise<WorkerInvocation> {
  const settings = await readRuntimeSettings()
  const env = await workerEnvironment(settings)
  if (settings.installedWorkerPath) {
    await verifyInstalledRuntimeLock(settings)
    return { command: settings.installedWorkerPath, baseArgs: [], env }
  }
  const python = await resolvePythonCommand(purpose)
  const script = workerScriptPath()
  if (!existsSync(script)) throw new Error('OCTAVE could not find its STRUM runtime adapter.')
  return { command: python.command, baseArgs: [...python.baseArgs, script], env }
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

async function runWorkerJsonWithInvocation(
  worker: WorkerInvocation,
  args: string[]
): Promise<Record<string, unknown>> {
  return await new Promise((resolve, reject) => {
    execFile(
      worker.command,
      [...worker.baseArgs, ...args],
      { env: worker.env, timeout: 20_000 },
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

async function runWorkerJson(args: string[]): Promise<Record<string, unknown>> {
  return await runWorkerJsonWithInvocation(await resolveWorkerInvocation('training-probe'), args)
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
    JSON.stringify(
      {
        developerSourceRoot: root,
        installedWorkerPath: undefined,
        installedRuntimeLock: undefined
      },
      null,
      2
    ) + '\n',
    'utf8'
  )
  return await probeTrainingRuntime()
}

export async function chooseInstalledTrainingRuntime(): Promise<TrainingRuntime | null> {
  const selection = await dialog.showOpenDialog({
    title: 'Select a compatible STRUM worker',
    properties: ['openFile'],
    filters:
      process.platform === 'win32'
        ? [{ name: 'STRUM worker', extensions: ['exe', 'cmd', 'bat'] }]
        : undefined
  })
  if (selection.canceled || selection.filePaths.length === 0) return null
  const previous = await readRuntimeSettings()
  const installedWorkerPath = selection.filePaths[0]
  try {
    const runtime = normalizeRuntime(
      await runWorkerJsonWithInvocation(
        {
          command: installedWorkerPath,
          baseArgs: [],
          env: await workerEnvironment({})
        },
        ['probe', '--json']
      )
    )
    if (runtime.kind !== 'installed_runtime') {
      throw new Error('The selected worker is not an installed STRUM runtime.')
    }
    const fingerprint = await fingerprintWorker(installedWorkerPath)
    await mkdir(trainingRoot(), { recursive: true })
    await writeFile(
      runtimeSettingsPath(),
      JSON.stringify(
        {
          installedWorkerPath,
          installedRuntimeLock: runtimeLock(runtime, fingerprint),
          developerSourceRoot: undefined
        },
        null,
        2
      ) + '\n',
      'utf8'
    )
    return runtime
  } catch {
    await mkdir(trainingRoot(), { recursive: true })
    await writeFile(runtimeSettingsPath(), JSON.stringify(previous, null, 2) + '\n', 'utf8')
    return null
  }
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

async function resolveTrainingPipeline(pipelineId: string): Promise<TrainingPipeline> {
  const pipeline = (await listTrainingPipelines()).find((candidate) => candidate.id === pipelineId)
  if (!pipeline)
    throw new Error('That training pipeline is not available in the selected STRUM runtime.')
  return pipeline
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
  profiles: AutoChartProfile[]
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
      })),
    profiles: (registry.profiles ?? [])
      .filter((profile) => existsSync(profile.checkpointRoot))
      .map((profile) => ({
        profileId: profile.profileId,
        runId: profile.runId,
        pipelineId: profile.pipelineId,
        runtimeId: profile.runtimeId,
        createdAt: profile.createdAt,
        isDefault: profile.profileId === registry.defaultProfileId
      }))
  }
}

function normalizeCheckpoint(
  payload: Record<string, unknown>,
  run: TrainingRun
): TrainingCheckpoint {
  if (
    payload.run_id !== run.runId ||
    payload.pipeline_id !== run.pipelineId ||
    payload.manifest_hash !== run.checkpointManifestHash
  ) {
    throw new Error('The checkpoint does not match the selected training run.')
  }
  const components = Array.isArray(payload.components)
    ? payload.components.flatMap((component) => {
        if (!component || typeof component !== 'object') return []
        const value = component as Record<string, unknown>
        const id = typeof value.id === 'string' ? value.id : ''
        const sha256 = typeof value.sha256 === 'string' ? value.sha256 : ''
        const byteLength = Number(value.byte_length)
        return id &&
          /^[a-z0-9_.-]{1,80}$/.test(id) &&
          /^[a-f0-9]{64}$/.test(sha256) &&
          Number.isSafeInteger(byteLength) &&
          byteLength >= 0
          ? [{ id, sha256, byteLength }]
          : []
      })
    : []
  if (components.length !== run.checkpointCount) {
    throw new Error('The checkpoint bundle is incomplete.')
  }
  return {
    runId: run.runId,
    pipelineId: run.pipelineId,
    runtimeId: String(payload.runtime_id ?? ''),
    taskViewId: String(payload.task_view_id ?? ''),
    taskViewHash: String(payload.task_view_hash ?? ''),
    checkpointManifestHash: run.checkpointManifestHash,
    deployable: payload.deployable === true,
    deploymentReason:
      typeof payload.deployment_reason === 'string' ? payload.deployment_reason : null,
    components
  }
}

export async function inspectTrainingCheckpoint(runId: string): Promise<TrainingCheckpoint> {
  const registry = await readRegistry()
  const run = registry.runs.find((entry) => entry.runId === runId && existsSync(entry.outputRoot))
  if (!run) throw new Error('The selected training run is no longer available.')
  return normalizeCheckpoint(
    await runWorkerJson(['checkpoint', 'inspect', '--checkpoint', run.outputRoot, '--json']),
    run
  )
}

export async function saveAutoChartProfile(runId: string): Promise<AutoChartProfile> {
  const checkpoint = await inspectTrainingCheckpoint(runId)
  if (!checkpoint.deployable) {
    throw new Error('This experiment is not compatible with OCTAVE Auto Chart.')
  }
  const registry = await readRegistry()
  const run = registry.runs.find((entry) => entry.runId === runId && existsSync(entry.outputRoot))
  if (!run) throw new Error('The selected training run is no longer available.')
  const runtime = await probeTrainingRuntime()
  if (runtime.runtimeId !== checkpoint.runtimeId || !runtime.capabilities.includes('chart')) {
    throw new Error('The selected STRUM runtime cannot run deployed Auto Chart profiles.')
  }
  const profileId = `strum-profile-${randomUUID()}`
  const requestPath = join(app.getPath('temp'), `octave-profile-${profileId}.json`)
  try {
    await writeFile(
      requestPath,
      JSON.stringify({ profile_id: profileId, checkpoint_root: run.outputRoot }),
      'utf8'
    )
    const payload = await runWorkerJson([
      'inference',
      'profile',
      'validate',
      '--request',
      requestPath,
      '--json'
    ])
    if (payload.valid !== true) {
      throw new Error('STRUM did not validate this checkpoint for Auto Chart.')
    }
    const profile = payload.profile
    if (!profile || typeof profile !== 'object') {
      throw new Error('STRUM did not return a valid Auto Chart profile.')
    }
    const value = profile as Record<string, unknown>
    if (
      value.profile_id !== profileId ||
      value.pipeline_id !== checkpoint.pipelineId ||
      value.runtime_id !== checkpoint.runtimeId
    ) {
      throw new Error('STRUM returned a profile that does not match this checkpoint.')
    }
    const saved: AutoChartProfile & { checkpointRoot: string } = {
      profileId,
      runId: checkpoint.runId,
      pipelineId: checkpoint.pipelineId,
      runtimeId: checkpoint.runtimeId,
      createdAt: new Date().toISOString(),
      isDefault: true,
      checkpointRoot: run.outputRoot
    }
    registry.profiles = [
      ...(registry.profiles ?? []).filter((entry) => entry.runId !== runId),
      saved
    ]
    registry.defaultProfileId = profileId
    await writeRegistry(registry)
    return { ...saved, isDefault: true }
  } finally {
    try {
      await unlink(requestPath)
    } catch {
      /* idempotent cleanup */
    }
  }
}

type ResolvedAutoChartProfile = AutoChartProfile & {
  checkpointRoot: string
}

async function resolveDefaultAutoChartProfile(): Promise<ResolvedAutoChartProfile | null> {
  const registry = await readRegistry()
  const profile = (registry.profiles ?? []).find(
    (entry) => entry.profileId === registry.defaultProfileId && existsSync(entry.checkpointRoot)
  )
  if (!profile) return null
  const runtime = await probeTrainingRuntime()
  if (runtime.runtimeId !== profile.runtimeId || !runtime.capabilities.includes('chart')) {
    registry.defaultProfileId = undefined
    await writeRegistry(registry)
    return null
  }
  const requestPath = join(app.getPath('temp'), `octave-profile-check-${profile.profileId}.json`)
  try {
    await writeFile(
      requestPath,
      JSON.stringify({ profile_id: profile.profileId, checkpoint_root: profile.checkpointRoot }),
      'utf8'
    )
    const validation = await runWorkerJson([
      'inference',
      'profile',
      'validate',
      '--request',
      requestPath,
      '--json'
    ])
    if (validation.valid !== true) {
      registry.defaultProfileId = undefined
      await writeRegistry(registry)
      return null
    }
    return profile
  } catch {
    registry.defaultProfileId = undefined
    await writeRegistry(registry)
    return null
  } finally {
    try {
      await unlink(requestPath)
    } catch {
      /* idempotent cleanup */
    }
  }
}

function safeProfiledAutoChartResult(
  raw: Record<string, unknown>,
  outputDir: string
): AutoChartRunResult {
  const songFolders = Array.isArray(raw.song_folders)
    ? raw.song_folders.filter((value): value is string => typeof value === 'string')
    : []
  const errors =
    Array.isArray(raw.errors) && raw.errors.length > 0
      ? ['STRUM reported one or more charting errors.']
      : []
  return {
    success: raw.success === true,
    outputDir,
    songFolders,
    errors
  }
}

async function runResolvedAutoChartProfile(
  profile: ResolvedAutoChartProfile,
  options: Omit<AutoChartRunOptions, 'cacheDir'>
): Promise<AutoChartRunResult> {
  const worker = await resolveWorkerInvocation(options.runId)
  const requestPath = join(app.getPath('temp'), `octave-profile-chart-${options.runId}.json`)
  const request = {
    job_id: options.runId,
    profile_id: profile.profileId,
    model_root: profile.checkpointRoot,
    output_root: options.outputDir,
    inputs: {
      files: options.files,
      folders: options.folders,
      stem_folders: options.stemFolders,
      stem_songs: options.stemSongs,
      urls: options.urls
    },
    options: {
      enabled_tracks: options.enabledTracks,
      include_keys: options.includeKeys,
      difficulty_policy: 'expert_only',
      disable_online_lookup: options.disableOnlineLookup,
      keep_stems: options.keepStems,
      star_power: options.starPower,
      auto_tempo: options.autoTempo,
      tempo_map: options.tempoMap,
      manual_bpm: options.manualBpm
    }
  }
  await writeFile(requestPath, JSON.stringify(request), 'utf8')
  broadcastAutoChartProgress({
    runId: options.runId,
    stage: 'bootstrap',
    percent: 0,
    message: 'Starting the validated STRUM profile locally.'
  })
  return await new Promise((resolve, reject) => {
    const child = spawn(
      worker.command,
      [...worker.baseArgs, 'chart', '--request', requestPath, '--json-events'],
      { stdio: ['ignore', 'pipe', 'pipe'], env: worker.env, detached: process.platform !== 'win32' }
    )
    runningProfiledAutoCharts.set(options.runId, { process: child, requestPath })
    let stdoutRemainder = ''
    let stderrRemainder = ''
    let terminalResult: AutoChartRunResult | null = null
    let terminalError: Error | null = null
    const consume = (chunk: Buffer, stream: 'stdout' | 'stderr'): void => {
      const combined =
        (stream === 'stdout' ? stdoutRemainder : stderrRemainder) + chunk.toString('utf8')
      const lines = combined.split(/\r?\n/)
      const remainder = lines.pop() ?? ''
      if (stream === 'stdout') stdoutRemainder = remainder
      else stderrRemainder = remainder
      for (const line of lines) {
        try {
          const event = JSON.parse(line) as Record<string, unknown>
          if (event.event === 'progress') {
            const progress = Number(event.progress)
            broadcastAutoChartProgress({
              runId: options.runId,
              stage: typeof event.stage === 'string' ? event.stage : 'bootstrap',
              percent: Number.isFinite(progress)
                ? Math.round(Math.max(0, Math.min(1, progress)) * 100)
                : undefined,
              message: 'STRUM is processing the validated local profile.'
            })
          } else if (event.event === 'terminal') {
            if (event.state === 'succeeded' && event.result && typeof event.result === 'object') {
              terminalResult = safeProfiledAutoChartResult(
                event.result as Record<string, unknown>,
                options.outputDir
              )
            } else {
              terminalError = new Error(
                'The validated STRUM profile could not complete this chart run.'
              )
            }
          }
        } catch {
          // Reject non-protocol text without forwarding raw worker output to the UI.
        }
      }
    }
    child.stdout?.on('data', (chunk: Buffer) => consume(chunk, 'stdout'))
    child.stderr?.on('data', (chunk: Buffer) => consume(chunk, 'stderr'))
    const clean = async (): Promise<void> => {
      runningProfiledAutoCharts.delete(options.runId)
      try {
        await unlink(requestPath)
      } catch {
        /* idempotent cleanup */
      }
    }
    child.once('error', () => {
      void clean().then(() =>
        reject(new Error('The validated STRUM profile could not be started.'))
      )
    })
    child.once('close', () => {
      void clean().then(() => {
        if (stdoutRemainder) consume(Buffer.from('\n'), 'stdout')
        if (stderrRemainder) consume(Buffer.from('\n'), 'stderr')
        if (terminalResult) {
          resolve(terminalResult)
        } else {
          reject(terminalError ?? new Error('The validated STRUM profile ended unexpectedly.'))
        }
      })
    })
  })
}

export async function runDefaultAutoChartProfile(
  options: Omit<AutoChartRunOptions, 'cacheDir'>
): Promise<AutoChartRunResult | null> {
  const profile = await resolveDefaultAutoChartProfile()
  return profile ? await runResolvedAutoChartProfile(profile, options) : null
}

export async function cancelDefaultAutoChartProfile(runId: string): Promise<boolean> {
  const job = runningProfiledAutoCharts.get(runId)
  if (!job) return false
  try {
    if (process.platform !== 'win32' && job.process.pid) process.kill(-job.process.pid, 'SIGTERM')
    else job.process.kill('SIGTERM')
  } catch {
    return false
  }
  try {
    await unlink(job.requestPath)
  } catch {
    /* idempotent cleanup */
  }
  return true
}

async function startJsonEventJob(
  jobId: string,
  args: string[],
  request: Record<string, unknown>,
  onSucceeded: (result: Record<string, unknown>) => Promise<Record<string, unknown>>,
  runId?: string
): Promise<void> {
  const worker = await resolveWorkerInvocation(jobId)
  const requestPath = join(app.getPath('temp'), `octave-training-${jobId}.json`)
  await writeFile(requestPath, JSON.stringify(request), 'utf8')
  const child = spawn(
    worker.command,
    [...worker.baseArgs, ...args, '--request', requestPath, '--json-events'],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: worker.env,
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
  prepare: Record<string, unknown>
}): Promise<{ jobId: string; taskViewId: string }> {
  const pipeline = await resolveTrainingPipeline(options.pipelineId)
  const prepare = sanitizeTrainingSchemaValues(pipeline.prepare_schema, options.prepare, 'prepare')
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
      prepare
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
  train: Record<string, unknown>
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
  const pipeline = await resolveTrainingPipeline(options.pipelineId)
  const train = sanitizeTrainingSchemaValues(pipeline.train_schema, options.train, 'train')
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
      train
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
