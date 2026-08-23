import { app, BrowserWindow, dialog } from 'electron'
import { execFile, spawn, type ChildProcess } from 'child_process'
import { createHash, randomUUID } from 'crypto'
import { createReadStream, existsSync, type Dirent } from 'fs'
import { mkdir, readFile, readdir, realpath, stat, unlink, writeFile } from 'fs/promises'
import { join } from 'path'
import { resolvePythonCommand, type PythonCommand } from './runner'
import { sanitizeTrainingSchemaValues } from './trainingSchema'
import type { AutoChartRunOptions, AutoChartRunResult } from './types'

const PROTOCOL_MAJOR = 1
const TRAINING_ROOT_NAME = 'strum-training'
const RUNTIME_SETTINGS_NAME = 'runtime.json'
const REGISTRY_NAME = 'registry.json'
const MODEL_BUNDLE_MANIFEST_NAME = 'strum-model-bundle.json'
const MAX_DISCOVERED_MODEL_MANIFESTS = 256
const MAX_MODEL_DISCOVERY_DEPTH = 8
const MODEL_DISCOVERY_IGNORED_DIRECTORIES = new Set([
  '.git',
  '.hg',
  '.svn',
  '__pycache__',
  'node_modules'
])

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
  /** OCTAVE's previous run-backed profile records retain this field. */
  runId?: string
  /** STRUM's declared profile ID. This may differ from OCTAVE's local ID. */
  strumProfileId?: string
  /** Opaque, manifest-derived identity for a discovered model bundle. */
  artifactId?: string
  /** The STRUM-declared policy validated for this default. */
  difficultyPolicy?: string
  pipelineId: string
  runtimeId: string
  createdAt: string
  isDefault: boolean
}

/**
 * Local-only registry data. `checkpointRoot` must never cross the main-process
 * boundary: renderer callers identify a verified bundle solely by its opaque
 * artifact identity.
 */
type StoredAutoChartProfile = AutoChartProfile & {
  checkpointRoot: string
  manifestSha256?: string
}

export type DiscoveredCheckpointProfile = {
  profileId: string
  capability: string
  instruments: string[]
  difficultyPolicies: string[]
  requiredComponents: string[]
  execution: {
    status: 'available' | 'not_available'
    difficultyPolicies: string[]
  }
}

export type DiscoveredCheckpoint = {
  artifactId: string
  modelId: string
  manifestSha256: string
  schemaVersion: number
  compatibility: Record<string, string | number>
  components: Array<{ id: string; sha256: string; byteLength: number }>
  profiles: DiscoveredCheckpointProfile[]
  rejectedProfileCount: number
  deploymentStatus: 'ready' | 'not_deployable'
}

export type CheckpointDiscovery = {
  candidateCount: number
  profileCount: number
  rejectedBundleCount: number
  truncated: boolean
  candidates: DiscoveredCheckpoint[]
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
  developerPython?: PythonCommand
  developerRuntimeLock?: DeveloperRuntimeLock
  installedWorkerPath?: string
  installedRuntimeLock?: InstalledRuntimeLock
}

type RuntimeProbeLock = {
  runtimeId: string
  protocolVersion: string
  capabilities: string[]
  sourceRevision: string | null
  dirty: boolean
  validatedAt: string
}

type DeveloperRuntimeLock = RuntimeProbeLock & {
  sourceRoot: string
}

type InstalledRuntimeLock = RuntimeProbeLock & {
  workerSha256: string
  workerByteLength: number
}

type WorkerInvocation = {
  command: string
  baseArgs: string[]
  env: NodeJS.ProcessEnv
  cwd?: string
}

type TrainingRegistry = {
  tasks: Array<TrainingTask & { taskRoot: string; catalogRoot: string }>
  runs: Array<TrainingRun & { outputRoot: string }>
  profiles?: StoredAutoChartProfile[]
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
/**
 * This deliberately lives only in the main process. Renderer clients receive
 * opaque artifact IDs and cannot ask OCTAVE to run an arbitrary local path.
 */
const discoveredCheckpointRoots = new Map<string, string>()

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

function hasVersionedWorkerSource(root: string): boolean {
  return existsSync(join(root, 'src', 'worker.py'))
}

function findDetectedDeveloperRoot(): string | null {
  const configured = process.env.OCTAVE_STRUM_SOURCE_DIR?.trim()
  const candidates = [configured, join(process.cwd(), '..', 'strum'), join(process.cwd(), 'strum')]
  return (
    candidates.find((candidate): candidate is string =>
      Boolean(
        candidate && (hasVersionedWorkerSource(candidate) || hasLegacyGuitarSources(candidate))
      )
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

function runtimeProbeLock(runtime: TrainingRuntime): RuntimeProbeLock {
  return {
    runtimeId: runtime.runtimeId,
    protocolVersion: runtime.protocolVersion,
    capabilities: [...runtime.capabilities].sort(),
    sourceRevision: runtime.sourceRevision,
    dirty: runtime.dirty,
    validatedAt: new Date().toISOString()
  }
}

function installedRuntimeLock(
  runtime: TrainingRuntime,
  fingerprint: { sha256: string; byteLength: number }
): InstalledRuntimeLock {
  return {
    ...runtimeProbeLock(runtime),
    workerSha256: fingerprint.sha256,
    workerByteLength: fingerprint.byteLength
  }
}

function developerRuntimeLock(runtime: TrainingRuntime, sourceRoot: string): DeveloperRuntimeLock {
  return { ...runtimeProbeLock(runtime), sourceRoot }
}

function runtimeMatchesLock(runtime: TrainingRuntime, lock: RuntimeProbeLock): boolean {
  return (
    runtime.runtimeId === lock.runtimeId &&
    runtime.protocolVersion === lock.protocolVersion &&
    runtime.sourceRevision === lock.sourceRevision &&
    runtime.dirty === lock.dirty &&
    [...runtime.capabilities].sort().join('\u0000') ===
      lock.capabilities.slice().sort().join('\u0000')
  )
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

async function bundledAdapterInvocation(
  purpose: string,
  settings: RuntimeSettings
): Promise<WorkerInvocation> {
  const python = settings.developerPython ?? (await resolvePythonCommand(purpose))
  const script = workerScriptPath()
  if (!existsSync(script)) throw new Error('OCTAVE could not find its STRUM runtime adapter.')
  return {
    command: python.command,
    baseArgs: [...python.baseArgs, script],
    env: await workerEnvironment(settings)
  }
}

async function developerWorkerInvocation(settings: RuntimeSettings): Promise<WorkerInvocation> {
  const root = settings.developerSourceRoot
  const python = settings.developerPython
  if (!root || !python) {
    throw new Error('Enable the developer STRUM runtime again to validate this checkout.')
  }
  if (!hasVersionedWorkerSource(root))
    return await bundledAdapterInvocation('training-probe', settings)
  return {
    command: python.command,
    baseArgs: [...python.baseArgs, '-m', 'src.worker'],
    env: await workerEnvironment(settings),
    cwd: root
  }
}

async function verifyDeveloperRuntimeLock(settings: RuntimeSettings): Promise<WorkerInvocation> {
  const lock = settings.developerRuntimeLock
  if (
    !settings.developerSourceRoot ||
    !settings.developerPython ||
    !lock ||
    lock.sourceRoot !== settings.developerSourceRoot ||
    (!hasVersionedWorkerSource(settings.developerSourceRoot) &&
      !hasLegacyGuitarSources(settings.developerSourceRoot))
  ) {
    throw new Error('Enable the developer STRUM runtime again to validate this checkout.')
  }
  const invocation = await developerWorkerInvocation(settings)
  const runtime = normalizeRuntime(
    await runWorkerJsonWithInvocation(invocation, ['probe', '--json']),
    'developer_override'
  )
  if (runtime.kind !== 'developer_override' || !runtimeMatchesLock(runtime, lock)) {
    throw new Error(
      'The developer STRUM runtime changed after validation. Enable it again to continue.'
    )
  }
  return invocation
}

async function resolveWorkerInvocation(purpose: string): Promise<WorkerInvocation> {
  const settings = await readRuntimeSettings()
  if (settings.installedWorkerPath) {
    await verifyInstalledRuntimeLock(settings)
    return {
      command: settings.installedWorkerPath,
      baseArgs: [],
      env: await workerEnvironment(settings)
    }
  }
  if (settings.developerSourceRoot) return await verifyDeveloperRuntimeLock(settings)
  return await bundledAdapterInvocation(purpose, settings)
}

function normalizeRuntime(
  raw: unknown,
  defaultKind: TrainingRuntime['kind'] = 'bundled_inference'
): TrainingRuntime {
  if (!raw || typeof raw !== 'object')
    throw new Error('STRUM did not return a runtime description.')
  const value = raw as Record<string, unknown>
  const runtimeMetadata =
    value.runtime && typeof value.runtime === 'object' && !Array.isArray(value.runtime)
      ? (value.runtime as Record<string, unknown>)
      : {}
  const version = String(value.protocol_version ?? '')
  if (Number(version.split('.')[0]) !== PROTOCOL_MAJOR) {
    throw new Error('The selected STRUM runtime uses an unsupported protocol version.')
  }
  const kind = String(value.runtime_kind ?? defaultKind)
  if (
    !['bundled_inference', 'developer_override', 'managed_checkout', 'installed_runtime'].includes(
      kind
    )
  ) {
    throw new Error('The selected STRUM runtime reported an invalid runtime kind.')
  }
  return {
    runtimeId: String(value.runtime_id ?? runtimeMetadata.id ?? 'unknown-runtime'),
    displayName: String(value.display_name ?? 'STRUM runtime'),
    kind: kind as TrainingRuntime['kind'],
    protocolVersion: version,
    capabilities: [
      ...new Set([
        ...(Array.isArray(value.capabilities) ? value.capabilities.map(String) : []),
        ...(Array.isArray(value.capabilities) && value.capabilities.includes('dataset_prepare')
          ? ['training']
          : [])
      ])
    ],
    pipelineIds: Array.isArray(value.pipeline_ids)
      ? value.pipeline_ids.map(String)
      : Array.isArray(value.pipelines)
        ? value.pipelines.map(String)
        : [],
    deviceSupport: Array.isArray(value.device_support) ? value.device_support.map(String) : [],
    trainingSetupRequired: Boolean(value.training_setup_required),
    dirty: Boolean(value.dirty ?? runtimeMetadata.source_dirty),
    sourceRevision: value.source_revision
      ? String(value.source_revision)
      : runtimeMetadata.source_revision
        ? String(runtimeMetadata.source_revision)
        : null
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
      { env: worker.env, cwd: worker.cwd, timeout: 20_000 },
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
  const detectedRoot = findDetectedDeveloperRoot()
  if (!detectedRoot) return null
  const root = await realpath(detectedRoot)
  const developerPython = await resolvePythonCommand('developer-training-runtime')
  const settings: RuntimeSettings = {
    developerSourceRoot: root,
    developerPython,
    installedWorkerPath: undefined,
    installedRuntimeLock: undefined
  }
  const runtime = normalizeRuntime(
    await runWorkerJsonWithInvocation(await developerWorkerInvocation(settings), [
      'probe',
      '--json'
    ]),
    'developer_override'
  )
  if (runtime.kind !== 'developer_override') return null
  await mkdir(trainingRoot(), { recursive: true })
  await writeFile(
    runtimeSettingsPath(),
    JSON.stringify(
      {
        ...settings,
        developerRuntimeLock: developerRuntimeLock(runtime, root),
        installedWorkerPath: undefined,
        installedRuntimeLock: undefined
      },
      null,
      2
    ) + '\n',
    'utf8'
  )
  return runtime
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
          installedRuntimeLock: installedRuntimeLock(runtime, fingerprint),
          developerSourceRoot: undefined,
          developerPython: undefined,
          developerRuntimeLock: undefined
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
      .map((profile) =>
        publicAutoChartProfile(profile, profile.profileId === registry.defaultProfileId)
      )
  }
}

function publicAutoChartProfile(
  profile: StoredAutoChartProfile,
  isDefault = profile.isDefault
): AutoChartProfile {
  return {
    profileId: profile.profileId,
    ...(profile.runId ? { runId: profile.runId } : {}),
    ...(profile.strumProfileId ? { strumProfileId: profile.strumProfileId } : {}),
    ...(profile.artifactId ? { artifactId: profile.artifactId } : {}),
    ...(profile.difficultyPolicy ? { difficultyPolicy: profile.difficultyPolicy } : {}),
    pipelineId: profile.pipelineId,
    runtimeId: profile.runtimeId,
    createdAt: profile.createdAt,
    isDefault
  }
}

function isSafeIdentifier(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)
}

function isSafeCapability(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z][a-z0-9._-]{0,120}\/v[0-9]+$/.test(value)
}

function isSafeDifficultyPolicy(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z][a-z0-9._:-]{0,127}$/.test(value)
}

function isArtifactId(value: unknown): value is string {
  return typeof value === 'string' && /^strum-model-bundle\/[a-f0-9]{64}$/.test(value)
}

function normalizeComponent(
  value: unknown
): { id: string; sha256: string; byteLength: number } | null {
  if (!value || typeof value !== 'object') return null
  const component = value as Record<string, unknown>
  const id = component.id
  const sha256 = component.sha256
  const byteLength = Number(component.byte_length)
  if (
    !isSafeIdentifier(id) ||
    typeof sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(sha256) ||
    !Number.isSafeInteger(byteLength) ||
    byteLength < 0
  ) {
    return null
  }
  return { id, sha256, byteLength }
}

function normalizeDiscoveredProfile(value: unknown): DiscoveredCheckpointProfile | null {
  if (!value || typeof value !== 'object') return null
  const profile = value as Record<string, unknown>
  const execution = profile.execution
  if (!execution || typeof execution !== 'object') return null
  const executionValue = execution as Record<string, unknown>
  const profileId = profile.profile_id
  const capability = profile.capability
  const instruments = Array.isArray(profile.instruments) ? profile.instruments : null
  const difficultyPolicies = Array.isArray(profile.difficulty_policies)
    ? profile.difficulty_policies
    : null
  const requiredComponents = Array.isArray(profile.required_components)
    ? profile.required_components
    : null
  const executablePolicies = Array.isArray(executionValue.difficulty_policies)
    ? executionValue.difficulty_policies
    : null
  const executionStatus = executionValue.status
  if (
    !isSafeIdentifier(profileId) ||
    !isSafeCapability(capability) ||
    !instruments ||
    !instruments.every(isSafeIdentifier) ||
    !difficultyPolicies ||
    !difficultyPolicies.every(isSafeDifficultyPolicy) ||
    !requiredComponents ||
    !requiredComponents.every(isSafeIdentifier) ||
    !executablePolicies ||
    !executablePolicies.every(isSafeDifficultyPolicy) ||
    (executionStatus !== 'available' && executionStatus !== 'not_available')
  ) {
    return null
  }
  return {
    profileId,
    capability,
    instruments: [...instruments],
    difficultyPolicies: [...difficultyPolicies],
    requiredComponents: [...requiredComponents],
    execution: { status: executionStatus, difficultyPolicies: [...executablePolicies] }
  }
}

function normalizeDiscoveredCheckpoint(value: unknown): DiscoveredCheckpoint | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Record<string, unknown>
  const artifactId = candidate.artifact_id
  const modelId = candidate.model_id
  const manifestSha256 = candidate.manifest_sha256
  const schemaVersion = Number(candidate.schema_version)
  const components = Array.isArray(candidate.components) ? candidate.components : null
  const profiles = Array.isArray(candidate.profiles) ? candidate.profiles : null
  const rejectedProfileCount = Number(candidate.rejected_profile_count)
  const deploymentStatus = candidate.deployment_status
  const rawCompatibility = candidate.compatibility
  if (
    !isArtifactId(artifactId) ||
    !isSafeIdentifier(modelId) ||
    typeof manifestSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(manifestSha256) ||
    !Number.isSafeInteger(schemaVersion) ||
    schemaVersion < 1 ||
    !components ||
    !profiles ||
    !Number.isSafeInteger(rejectedProfileCount) ||
    rejectedProfileCount < 0 ||
    (deploymentStatus !== 'ready' && deploymentStatus !== 'not_deployable') ||
    !rawCompatibility ||
    typeof rawCompatibility !== 'object' ||
    Array.isArray(rawCompatibility)
  ) {
    return null
  }
  const normalizedComponents = components.map(normalizeComponent)
  const normalizedProfiles = profiles.map(normalizeDiscoveredProfile)
  if (normalizedComponents.some((component) => component === null)) return null
  if (normalizedProfiles.some((profile) => profile === null)) return null
  const compatibility = Object.fromEntries(
    Object.entries(rawCompatibility as Record<string, unknown>).flatMap(([key, entry]) =>
      /^[a-z][a-z0-9_]{0,63}$/.test(key) &&
      (typeof entry === 'string' || (typeof entry === 'number' && Number.isFinite(entry))) &&
      entry.toString().length <= 128
        ? [[key, entry]]
        : []
    )
  )
  return {
    artifactId,
    modelId,
    manifestSha256,
    schemaVersion,
    compatibility,
    components: normalizedComponents.filter(
      (component): component is NonNullable<typeof component> => component !== null
    ),
    profiles: normalizedProfiles.filter(
      (profile): profile is NonNullable<typeof profile> => profile !== null
    ),
    rejectedProfileCount,
    deploymentStatus
  }
}

function normalizeCheckpointDiscovery(payload: Record<string, unknown>): CheckpointDiscovery {
  const candidates = Array.isArray(payload.candidates) ? payload.candidates : []
  const normalizedCandidates = candidates.map(normalizeDiscoveredCheckpoint)
  if (
    payload.format !== 'strum-model-bundle-discovery/v1' ||
    payload.status !== 'ready' ||
    normalizedCandidates.some((candidate) => candidate === null)
  ) {
    throw new Error('STRUM did not return a valid checkpoint discovery response.')
  }
  const candidateCount = Number(payload.candidate_count)
  const profileCount = Number(payload.profile_count)
  const rejectedBundleCount = Number(payload.rejected_bundle_count)
  if (
    !Number.isSafeInteger(candidateCount) ||
    candidateCount !== normalizedCandidates.length ||
    !Number.isSafeInteger(profileCount) ||
    !Number.isSafeInteger(rejectedBundleCount) ||
    rejectedBundleCount < 0 ||
    typeof payload.truncated !== 'boolean'
  ) {
    throw new Error('STRUM returned an inconsistent checkpoint discovery response.')
  }
  const usable = normalizedCandidates.filter(
    (candidate): candidate is NonNullable<typeof candidate> => candidate !== null
  )
  if (profileCount !== usable.reduce((total, candidate) => total + candidate.profiles.length, 0)) {
    throw new Error('STRUM returned an inconsistent checkpoint discovery response.')
  }
  return {
    candidateCount,
    profileCount,
    rejectedBundleCount,
    truncated: payload.truncated,
    candidates: usable
  }
}

async function findPrivateModelBundleRoots(root: string): Promise<string[]> {
  const resolvedRoot = await realpath(root)
  const roots: string[] = []
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (roots.length >= MAX_DISCOVERED_MODEL_MANIFESTS) return
    let entries: Dirent<string>[]
    try {
      entries = await readdir(directory, { withFileTypes: true, encoding: 'utf8' })
    } catch {
      return
    }
    if (
      entries.some(
        (entry) =>
          entry.name === MODEL_BUNDLE_MANIFEST_NAME && entry.isFile() && !entry.isSymbolicLink()
      )
    ) {
      roots.push(directory)
    }
    if (depth >= MAX_MODEL_DISCOVERY_DEPTH) return
    for (const entry of entries) {
      if (
        roots.length >= MAX_DISCOVERED_MODEL_MANIFESTS ||
        !entry.isDirectory() ||
        entry.isSymbolicLink() ||
        MODEL_DISCOVERY_IGNORED_DIRECTORIES.has(entry.name)
      ) {
        continue
      }
      await visit(join(directory, entry.name), depth + 1)
    }
  }
  await visit(resolvedRoot, 0)
  return roots
}

async function mapPrivateArtifactRoots(
  roots: string[],
  candidates: DiscoveredCheckpoint[]
): Promise<Map<string, string>> {
  const wanted = new Set(candidates.map((candidate) => candidate.artifactId))
  const resolved = new Map<string, string>()
  let next = 0
  const workerCount = Math.min(4, roots.length)
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (next < roots.length) {
        const root = roots[next]
        next += 1
        try {
          const inspection = normalizeDiscoveredCheckpoint(
            await runWorkerJson(['checkpoint', 'inspect', '--model-root', root, '--json'])
          )
          if (inspection && wanted.has(inspection.artifactId)) {
            resolved.set(inspection.artifactId, root)
          }
        } catch {
          // The discovery response remains authoritative; this private mapping
          // pass simply prevents an unmapped item from reaching the renderer.
        }
      }
    })
  )
  return resolved
}

export async function chooseCheckpointFolder(): Promise<CheckpointDiscovery | null> {
  const selection = await dialog.showOpenDialog({
    title: 'Select a folder containing STRUM model bundles',
    properties: ['openDirectory']
  })
  if (selection.canceled || selection.filePaths.length === 0) return null
  let modelRoot: string
  try {
    modelRoot = await realpath(selection.filePaths[0])
  } catch {
    throw new Error('The selected model folder is no longer available.')
  }
  // A folder selection starts a new private discovery session. Do not retain
  // artifact-to-path bindings from an earlier folder, even if an artifact ID
  // happens to collide with a later result.
  discoveredCheckpointRoots.clear()
  const discovery = normalizeCheckpointDiscovery(
    await runWorkerJson(['checkpoint', 'discover', '--model-root', modelRoot, '--json'])
  )
  const mappedRoots = await mapPrivateArtifactRoots(
    await findPrivateModelBundleRoots(modelRoot),
    discovery.candidates
  )
  const candidates = discovery.candidates.filter((candidate) =>
    mappedRoots.has(candidate.artifactId)
  )
  for (const [artifactId, root] of mappedRoots) discoveredCheckpointRoots.set(artifactId, root)
  return {
    ...discovery,
    candidateCount: candidates.length,
    profileCount: candidates.reduce((total, candidate) => total + candidate.profiles.length, 0),
    candidates
  }
}

function privateCheckpointRoot(artifactId: string): string {
  if (!isArtifactId(artifactId)) throw new Error('The selected checkpoint is invalid.')
  const root = discoveredCheckpointRoots.get(artifactId)
  if (!root) throw new Error('Select the checkpoint folder again before validation.')
  return root
}

export async function inspectDiscoveredCheckpoint(
  artifactId: string
): Promise<DiscoveredCheckpoint> {
  const root = privateCheckpointRoot(artifactId)
  const inspection = normalizeDiscoveredCheckpoint(
    await runWorkerJson(['checkpoint', 'inspect', '--model-root', root, '--json'])
  )
  if (!inspection || inspection.artifactId !== artifactId) {
    throw new Error('The selected checkpoint changed after discovery.')
  }
  return inspection
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
  void runId
  throw new Error(
    'Training experiments must be evaluated and packaged by STRUM, then selected from a verified model bundle folder.'
  )
}

export async function saveDiscoveredAutoChartProfile(options: {
  artifactId: string
  profileId: string
  difficultyPolicy: string
}): Promise<AutoChartProfile> {
  const checkpoint = await inspectDiscoveredCheckpoint(options.artifactId)
  if (checkpoint.deploymentStatus !== 'ready') {
    throw new Error('This bundle has no executable STRUM Auto Chart profile.')
  }
  const profile = checkpoint.profiles.find((entry) => entry.profileId === options.profileId)
  if (
    !profile ||
    profile.execution.status !== 'available' ||
    !profile.execution.difficultyPolicies.includes(options.difficultyPolicy)
  ) {
    throw new Error('The selected STRUM profile is not executable for that difficulty policy.')
  }
  const runtime = await probeTrainingRuntime()
  if (!runtime.capabilities.includes('chart')) {
    throw new Error('The selected STRUM runtime cannot run deployed Auto Chart profiles.')
  }
  const root = privateCheckpointRoot(options.artifactId)
  const validation = await runWorkerJson([
    'inference',
    'profile',
    'validate',
    '--model-root',
    root,
    '--profile',
    profile.profileId,
    '--difficulty-policy',
    options.difficultyPolicy,
    '--json'
  ])
  if (
    validation.status !== 'ready' ||
    validation.profile_id !== profile.profileId ||
    validation.manifest_sha256 !== checkpoint.manifestSha256
  ) {
    throw new Error('STRUM did not validate the selected checkpoint profile.')
  }
  const registry = await readRegistry()
  const profileId = `octave-strum-profile-${randomUUID()}`
  const saved: StoredAutoChartProfile = {
    profileId,
    strumProfileId: profile.profileId,
    artifactId: checkpoint.artifactId,
    manifestSha256: checkpoint.manifestSha256,
    difficultyPolicy: options.difficultyPolicy,
    pipelineId: profile.capability,
    runtimeId: runtime.runtimeId,
    createdAt: new Date().toISOString(),
    isDefault: true,
    checkpointRoot: root
  }
  registry.profiles = [
    ...(registry.profiles ?? []).filter(
      (entry) =>
        entry.artifactId !== checkpoint.artifactId || entry.strumProfileId !== profile.profileId
    ),
    saved
  ]
  registry.defaultProfileId = profileId
  await writeRegistry(registry)
  return publicAutoChartProfile(saved, true)
}

type ResolvedAutoChartProfile = StoredAutoChartProfile

async function discardInvalidDefaultProfile(
  registry: TrainingRegistry,
  profileId: string
): Promise<void> {
  registry.profiles = (registry.profiles ?? []).filter((entry) => entry.profileId !== profileId)
  if (registry.defaultProfileId === profileId) registry.defaultProfileId = undefined
  await writeRegistry(registry)
}

async function resolveDefaultAutoChartProfile(): Promise<ResolvedAutoChartProfile | null> {
  const registry = await readRegistry()
  const profile = (registry.profiles ?? []).find(
    (entry) => entry.profileId === registry.defaultProfileId && existsSync(entry.checkpointRoot)
  )
  if (!profile) return null
  const runtime = await probeTrainingRuntime()
  if (runtime.runtimeId !== profile.runtimeId || !runtime.capabilities.includes('chart')) {
    await discardInvalidDefaultProfile(registry, profile.profileId)
    return null
  }
  try {
    // A profile is usable only when the current bundle re-inspection retains
    // the exact artifact and manifest identity that OCTAVE saved.
    if (!profile.artifactId || !profile.manifestSha256) {
      await discardInvalidDefaultProfile(registry, profile.profileId)
      return null
    }
    const inspection = normalizeDiscoveredCheckpoint(
      await runWorkerJson([
        'checkpoint',
        'inspect',
        '--model-root',
        profile.checkpointRoot,
        '--json'
      ])
    )
    if (
      !inspection ||
      inspection.artifactId !== profile.artifactId ||
      inspection.manifestSha256 !== profile.manifestSha256 ||
      inspection.deploymentStatus !== 'ready'
    ) {
      await discardInvalidDefaultProfile(registry, profile.profileId)
      return null
    }
    const strumProfileId = profile.strumProfileId ?? profile.profileId
    const validation = await runWorkerJson([
      'inference',
      'profile',
      'validate',
      '--model-root',
      profile.checkpointRoot,
      '--profile',
      strumProfileId,
      '--difficulty-policy',
      profile.difficultyPolicy ?? 'expert_only',
      '--json'
    ])
    if (
      validation.status !== 'ready' ||
      validation.profile_id !== strumProfileId ||
      validation.manifest_sha256 !== profile.manifestSha256
    ) {
      await discardInvalidDefaultProfile(registry, profile.profileId)
      return null
    }
    return profile
  } catch {
    await discardInvalidDefaultProfile(registry, profile.profileId)
    return null
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
    profile_id: profile.strumProfileId ?? profile.profileId,
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
      difficulty_policy: profile.difficultyPolicy ?? 'expert_only',
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
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: worker.env,
        cwd: worker.cwd,
        detached: process.platform !== 'win32'
      }
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
      cwd: worker.cwd,
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
