import { app, BrowserWindow, dialog } from 'electron'
import { execFile, spawn, type ChildProcess } from 'child_process'
import { createHash, randomUUID } from 'crypto'
import { createReadStream, existsSync, type Dirent } from 'fs'
import { mkdir, readFile, readdir, realpath, stat, unlink, writeFile } from 'fs/promises'
import { isAbsolute, join, relative } from 'path'
import type {
  StrumCheckpointCandidateInputContract,
  StrumCheckpointCandidateOutputContract,
  StrumCheckpointCandidateTargetContract,
  StrumCheckpointOutputCandidate,
  StrumCheckpointOutputContracts,
  StrumPromotionJobDescriptor,
  StrumPromotionJobResult
} from '../../shared/strumTrainingContracts'
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
const SAFE_RUNTIME_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const SAFE_STRUM_RUNTIME_FALLBACK_ID = /^strum-\d+\.\d+\.\d+\+git\.[a-f0-9]{7,64}$/
const SAFE_PROTOCOL_VERSION = /^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){0,2}$/
const SAFE_RUNTIME_CAPABILITY = /^[a-z][a-z0-9_]{0,63}$/
const SAFE_RUNTIME_PIPELINE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}){0,3}$/
const SAFE_RUNTIME_DEVICE = /^[a-z][a-z0-9_]{0,31}$/
const SAFE_SOURCE_REVISION = /^[a-f0-9]{7,64}$/

export type TrainingPipeline = {
  id: string
  display_name: string
  kind: string
  version: number
  status: string
  preparation_status: string
  training_status: string
  catalog_requirements: Record<string, unknown>
  prepare_schema: Record<string, unknown>
  train_schema: Record<string, unknown> | null
  checkpoint_outputs: string[]
  checkpoint_output_contracts?: StrumCheckpointOutputContracts
  inference_capability: string | null
  private_request_fields: string[]
  catalog_inspection_option_keys: string[]
  training_requirements: string[]
  promotion_jobs: TrainingPromotionJob[]
}

/**
 * Public, path-free metadata for a STRUM-owned post-training operation. The
 * renderer may describe this metadata, but it never receives values for the
 * declared private request fields.
 */
export type TrainingPromotionJob = StrumPromotionJobDescriptor

export type TrainingPromotionResult = StrumPromotionJobResult & {
  /** Opaque OCTAVE identity for chaining private evidence between jobs. */
  promotionId: string
  candidateArtifactId: string
  /** Present only after OCTAVE re-inspects a packaged model bundle. */
  artifactId?: string
  deploymentStatus?: DiscoveredCheckpoint['deploymentStatus']
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
  audioPolicy: Record<string, unknown>
  estimatedStorageBytes: number
  storageEstimateCapped: boolean
  storageEstimateSemantics: string
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
  /** Opaque identity of a worker re-inspected candidate, if registration succeeded. */
  artifactId?: string
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
  compatibility: Record<string, string | number | boolean | null>
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
  result?: Record<string, unknown> | TrainingPromotionResult
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

/**
 * The selected local runtime is part of OCTAVE's validated state, not merely
 * an implementation detail of a worker invocation.  STRUM probes from older
 * workers do not always repeat `runtime_kind`, so keep the lock-derived kind
 * alongside the invocation until its public DTO is normalized.
 */
type ResolvedWorkerInvocation = {
  invocation: WorkerInvocation
  runtimeKind: TrainingRuntime['kind']
  runtimeSelectionEpoch: number
}

type CandidateBinding = {
  artifactId: string
  bundleRoot: string
  taskView: string
  catalogRoot: string
}

type StoredTrainingRun = TrainingRun & {
  outputRoot: string
  /** Main-process-only promotion binding. Never expose these paths through IPC. */
  candidateBinding?: CandidateBinding
}

type StoredPromotion = TrainingPromotionResult & {
  candidateArtifactId: string
  kind: TrainingPromotionJob['kind']
  /** Main-process-only worker output location. */
  outputRoot: string
}

type TrainingRegistry = {
  tasks: Array<TrainingTask & { taskRoot: string; catalogRoot: string }>
  runs: StoredTrainingRun[]
  promotions?: StoredPromotion[]
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
/** A runtime selection is not visible to any worker action until its lock is durable. */
let runtimeSelectionActivation: Promise<TrainingRuntime | null> | null = null
let runtimeSelectionEpoch = 0
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
      promotions: Array.isArray(registry.promotions) ? registry.promotions : [],
      defaultProfileId:
        typeof registry.defaultProfileId === 'string' ? registry.defaultProfileId : undefined
    }
  } catch {
    return { tasks: [], runs: [], profiles: [], promotions: [] }
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

async function resolveWorkerInvocation(purpose: string): Promise<ResolvedWorkerInvocation> {
  for (;;) {
    const selectionEpoch = runtimeSelectionEpoch
    const activation = runtimeSelectionActivation
    if (activation) {
      await activation
      continue
    }
    const settings = await readRuntimeSettings()
    if (selectionEpoch !== runtimeSelectionEpoch || runtimeSelectionActivation) continue
    if (settings.installedWorkerPath) {
      await verifyInstalledRuntimeLock(settings)
      if (selectionEpoch !== runtimeSelectionEpoch || runtimeSelectionActivation) continue
      return {
        runtimeSelectionEpoch: selectionEpoch,
        runtimeKind: 'installed_runtime',
        invocation: {
          command: settings.installedWorkerPath,
          baseArgs: [],
          env: await workerEnvironment(settings)
        }
      }
    }
    if (settings.developerSourceRoot) {
      const invocation = await verifyDeveloperRuntimeLock(settings)
      if (selectionEpoch !== runtimeSelectionEpoch || runtimeSelectionActivation) continue
      return {
        runtimeSelectionEpoch: selectionEpoch,
        runtimeKind: 'developer_override',
        invocation
      }
    }
    const invocation = await bundledAdapterInvocation(purpose, settings)
    if (selectionEpoch !== runtimeSelectionEpoch || runtimeSelectionActivation) continue
    return {
      runtimeSelectionEpoch: selectionEpoch,
      runtimeKind: 'bundled_inference',
      invocation
    }
  }
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
  const version =
    typeof value.protocol_version === 'string'
      ? value.protocol_version
      : typeof value.protocol_version === 'number' &&
          Number.isSafeInteger(value.protocol_version) &&
          value.protocol_version > 0
        ? String(value.protocol_version)
        : ''
  if (!SAFE_PROTOCOL_VERSION.test(version)) {
    throw new Error('The selected STRUM runtime reported an invalid protocol version.')
  }
  if (Number(version.split('.')[0]) !== PROTOCOL_MAJOR) {
    throw new Error('The selected STRUM runtime uses an unsupported protocol version.')
  }
  const directRuntimeId = value.runtime_id
  const fallbackRuntimeId = runtimeMetadata.id
  const runtimeId =
    typeof directRuntimeId === 'string'
      ? directRuntimeId
      : directRuntimeId === undefined || directRuntimeId === null
        ? typeof fallbackRuntimeId === 'string'
          ? fallbackRuntimeId
          : 'unknown-runtime'
        : ''
  const validRuntimeId =
    typeof directRuntimeId === 'string'
      ? SAFE_RUNTIME_ID.test(runtimeId)
      : runtimeId === 'unknown-runtime' || SAFE_STRUM_RUNTIME_FALLBACK_ID.test(runtimeId)
  if (!validRuntimeId) {
    throw new Error('The selected STRUM runtime reported an invalid runtime identity.')
  }
  const safeList = (candidate: unknown, pattern: RegExp, field: string): string[] => {
    if (candidate === undefined) return []
    if (
      !Array.isArray(candidate) ||
      !candidate.every((entry) => typeof entry === 'string' && pattern.test(entry))
    ) {
      throw new Error(`The selected STRUM runtime reported invalid ${field}.`)
    }
    return [...new Set(candidate)]
  }
  const rawCapabilities = safeList(value.capabilities, SAFE_RUNTIME_CAPABILITY, 'capabilities')
  const rawPipelines = value.pipeline_ids ?? value.pipelines
  const sourceRevision = value.source_revision ?? runtimeMetadata.source_revision
  if (
    sourceRevision !== undefined &&
    sourceRevision !== null &&
    (typeof sourceRevision !== 'string' || !SAFE_SOURCE_REVISION.test(sourceRevision))
  ) {
    throw new Error('The selected STRUM runtime reported an invalid source revision.')
  }
  return {
    runtimeId,
    displayName: `STRUM ${defaultKind.replaceAll('_', ' ')} runtime`,
    kind: defaultKind,
    protocolVersion: version,
    capabilities: [
      ...new Set([
        ...rawCapabilities,
        ...(rawCapabilities.includes('dataset_prepare') && rawCapabilities.includes('training_start')
          ? ['training']
          : [])
      ])
    ],
    pipelineIds: safeList(rawPipelines, SAFE_RUNTIME_PIPELINE_ID, 'pipeline identifiers'),
    deviceSupport: safeList(value.device_support, SAFE_RUNTIME_DEVICE, 'device support'),
    trainingSetupRequired: Boolean(value.training_setup_required),
    dirty: Boolean(value.dirty ?? runtimeMetadata.source_dirty),
    sourceRevision: sourceRevision ?? null
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
  for (;;) {
    const resolved = await resolveWorkerInvocation('training-probe')
    if (
      resolved.runtimeSelectionEpoch !== runtimeSelectionEpoch ||
      runtimeSelectionActivation
    ) {
      continue
    }
    return await runWorkerJsonWithInvocation(resolved.invocation, args)
  }
}

export async function probeTrainingRuntime(): Promise<TrainingRuntime> {
  for (;;) {
    const resolved = await resolveWorkerInvocation('training-probe')
    if (
      resolved.runtimeSelectionEpoch !== runtimeSelectionEpoch ||
      runtimeSelectionActivation
    ) {
      continue
    }
    return normalizeRuntime(
      await runWorkerJsonWithInvocation(resolved.invocation, ['probe', '--json']),
      resolved.runtimeKind
    )
  }
}

async function enableDetectedDeveloperTrainingRuntimeOnce(): Promise<TrainingRuntime | null> {
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

function beginRuntimeSelection(
  operation: () => Promise<TrainingRuntime | null>
): Promise<TrainingRuntime | null> {
  if (runtimeSelectionActivation) return runtimeSelectionActivation
  runtimeSelectionEpoch += 1
  const activation = operation()
  runtimeSelectionActivation = activation
  return activation.finally(() => {
    if (runtimeSelectionActivation === activation) runtimeSelectionActivation = null
  })
}

export function enableDetectedDeveloperTrainingRuntime(): Promise<TrainingRuntime | null> {
  return beginRuntimeSelection(enableDetectedDeveloperTrainingRuntimeOnce)
}

async function chooseInstalledTrainingRuntimeOnce(): Promise<TrainingRuntime | null> {
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
      ),
      'installed_runtime'
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

export function chooseInstalledTrainingRuntime(): Promise<TrainingRuntime | null> {
  return beginRuntimeSelection(chooseInstalledTrainingRuntimeOnce)
}

const CHECKPOINT_OUTPUT_CONTRACTS_FORMAT = 'strum-candidate-checkpoint-output-contracts/v1'
const MAX_OUTPUT_CONTRACT_CANDIDATES = 16
const MAX_OUTPUT_CONTRACT_LIST_LENGTH = 32
const MAX_PIPELINE_METADATA_DEPTH = 8
const MAX_PIPELINE_METADATA_ENTRIES = 64

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[] = allowed
): boolean {
  return (
    required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    Object.keys(value).every((key) => allowed.includes(key))
  )
}

function isSafeContractName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[A-Za-z][A-Za-z0-9._-]{0,120}(?:\/[A-Za-z][A-Za-z0-9._-]{0,120})*\/v[1-9][0-9]*$/.test(value)
  )
}

function isSafeContractToken(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)
}

function isSafeDisplayText(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 512 &&
    !value.includes('\\') &&
    !value.includes('/') &&
    !Array.from(value).some((character) => character.charCodeAt(0) < 32) &&
    !value.includes('..') &&
    !value.startsWith('/')
  )
}

function isSafeMetadataString(value: unknown): value is string {
  return isSafeDisplayText(value) || isSafeContractName(value)
}

function normalizeNonNegativeCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function normalizeExclusionReasonCounts(value: unknown): Record<string, number> | null {
  if (!isRecord(value) || Object.keys(value).length > MAX_PIPELINE_METADATA_ENTRIES) return null
  const normalized: Record<string, number> = {}
  for (const [key, rawCount] of Object.entries(value)) {
    const count = normalizeNonNegativeCount(rawCount)
    if (!isSafeContractToken(key) || count === null) return null
    normalized[key] = count
  }
  return normalized
}

/**
 * Pipeline policy/schema metadata is descriptive only, but it still crosses
 * into the renderer. Keep it bounded and path-free instead of forwarding an
 * arbitrary worker object. Versioned identifiers are the sole allowed slash
 * containing values.
 */
function normalizePipelineMetadata(value: unknown, depth = 0): unknown | null {
  if (depth > MAX_PIPELINE_METADATA_DEPTH) return null
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string') return isSafeMetadataString(value) ? value : null
  if (Array.isArray(value)) {
    if (value.length > MAX_PIPELINE_METADATA_ENTRIES) return null
    const normalized = value.map((entry) => normalizePipelineMetadata(entry, depth + 1))
    return normalized.some((entry) => entry === null) ? null : normalized
  }
  if (!isRecord(value) || Object.keys(value).length > MAX_PIPELINE_METADATA_ENTRIES) return null
  const normalized: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (!isSafeContractToken(key)) return null
    const next = normalizePipelineMetadata(entry, depth + 1)
    if (next === null) return null
    normalized[key] = next
  }
  return normalized
}

function normalizeMetadataRecord(value: unknown): Record<string, unknown> | null {
  const normalized = normalizePipelineMetadata(value)
  return isRecord(normalized) ? normalized : null
}

function normalizeContractTokenList(
  value: unknown,
  maximum = MAX_OUTPUT_CONTRACT_LIST_LENGTH
): string[] | null {
  if (!Array.isArray(value) || value.length > maximum || !value.every(isSafeContractToken))
    return null
  return new Set(value).size === value.length ? [...value] : null
}

function normalizePromotionJob(value: unknown): TrainingPromotionJob | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(
      value,
      [
        'id',
        'display_name',
        'kind',
        'status',
        'options_schema',
        'private_request_fields',
        'optional_private_request_fields',
        'output_kind',
        'deployment_scope',
        'quality_policy',
        'calibration_policy',
        'checkpoint_selection_policy'
      ],
      [
        'id',
        'display_name',
        'kind',
        'status',
        'options_schema',
        'private_request_fields',
        'optional_private_request_fields',
        'output_kind',
        'deployment_scope'
      ]
    ) ||
    !isSafeContractName(value.id) ||
    !isSafeDisplayText(value.display_name) ||
    (value.kind !== 'evaluation' && value.kind !== 'package') ||
    !['available', 'planned', 'unavailable'].includes(String(value.status)) ||
    !isSafeContractToken(value.output_kind) ||
    !isSafeContractToken(value.deployment_scope)
  ) {
    return null
  }
  const optionsSchema = normalizeMetadataRecord(value.options_schema)
  const privateFields = normalizeContractTokenList(value.private_request_fields)
  const optionalPrivateFields = normalizeContractTokenList(value.optional_private_request_fields)
  if (
    !optionsSchema ||
    !privateFields ||
    !optionalPrivateFields ||
    (value.kind === 'package' && hasPromotionPolicyOverride(optionsSchema))
  ) {
    return null
  }
  if (privateFields.some((field) => optionalPrivateFields.includes(field))) return null
  const policies = ['quality_policy', 'calibration_policy', 'checkpoint_selection_policy'] as const
  const normalizedPolicies = Object.fromEntries(
    policies.map((key) => [
      key,
      value[key] === undefined ? undefined : normalizeMetadataRecord(value[key])
    ])
  ) as Record<(typeof policies)[number], Record<string, unknown> | null | undefined>
  if (Object.values(normalizedPolicies).some((policy) => policy === null)) return null
  return {
    id: value.id,
    display_name: value.display_name,
    kind: value.kind,
    status: value.status as TrainingPromotionJob['status'],
    options_schema: optionsSchema,
    private_request_fields: privateFields,
    optional_private_request_fields: optionalPrivateFields,
    output_kind: value.output_kind,
    deployment_scope: value.deployment_scope,
    ...(normalizedPolicies.quality_policy
      ? { quality_policy: normalizedPolicies.quality_policy }
      : {}),
    ...(normalizedPolicies.calibration_policy
      ? { calibration_policy: normalizedPolicies.calibration_policy }
      : {}),
    ...(normalizedPolicies.checkpoint_selection_policy
      ? { checkpoint_selection_policy: normalizedPolicies.checkpoint_selection_policy }
      : {})
  }
}

function hasPromotionPolicyOverride(schema: Record<string, unknown>): boolean {
  const properties = schema.properties
  if (!isRecord(properties)) return false
  return Object.keys(properties).some((key) => /(?:threshold|minimum|policy)/i.test(key))
}

function normalizeContractStrings(
  value: unknown,
  predicate: (entry: unknown) => entry is string
): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_OUTPUT_CONTRACT_LIST_LENGTH)
    return null
  if (!value.every(predicate) || new Set(value).size !== value.length) return null
  return [...value]
}

function normalizeIntegerPair(
  value: unknown,
  minimum: number,
  maximum: number
): [number, number] | null {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    !Number.isSafeInteger(value[0]) ||
    !Number.isSafeInteger(value[1]) ||
    value[0] < minimum ||
    value[1] > maximum ||
    value[0] > value[1]
  ) {
    return null
  }
  return [value[0], value[1]]
}

function normalizeCandidateInputContract(
  value: unknown
): StrumCheckpointCandidateInputContract | null {
  if (!isRecord(value) || !isSafeContractName(value.format)) return null
  if (Object.prototype.hasOwnProperty.call(value, 'event_time_source')) {
    if (
      !hasOnlyKeys(value, [
        'format',
        'event_time_source',
        'free_running_event_proposal',
        'sequence_decoding',
        'midi_emission'
      ]) ||
      !isSafeContractToken(value.event_time_source) ||
      typeof value.free_running_event_proposal !== 'boolean' ||
      typeof value.sequence_decoding !== 'boolean' ||
      typeof value.midi_emission !== 'boolean'
    ) {
      return null
    }
    return {
      format: value.format,
      event_time_source: value.event_time_source,
      free_running_event_proposal: value.free_running_event_proposal,
      sequence_decoding: value.sequence_decoding,
      midi_emission: value.midi_emission
    }
  }
  if (
    !hasOnlyKeys(value, [
      'format',
      'requires_midi_at_inference',
      'offline_window_scoring',
      'free_running_event_proposal',
      'sequence_decoding',
      'midi_emission'
    ]) ||
    typeof value.requires_midi_at_inference !== 'boolean' ||
    typeof value.offline_window_scoring !== 'boolean' ||
    typeof value.free_running_event_proposal !== 'boolean' ||
    typeof value.sequence_decoding !== 'boolean' ||
    typeof value.midi_emission !== 'boolean'
  ) {
    return null
  }
  return {
    format: value.format,
    requires_midi_at_inference: value.requires_midi_at_inference,
    offline_window_scoring: value.offline_window_scoring,
    free_running_event_proposal: value.free_running_event_proposal,
    sequence_decoding: value.sequence_decoding,
    midi_emission: value.midi_emission
  }
}

function normalizeCandidateOutputContract(
  value: unknown
): StrumCheckpointCandidateOutputContract | null {
  if (!isRecord(value) || !isSafeContractName(value.format)) return null
  if (Object.prototype.hasOwnProperty.call(value, 'outputs')) {
    const outputs = normalizeContractStrings(value.outputs, isSafeContractToken)
    if (
      !hasOnlyKeys(value, [
        'format',
        'outputs',
        'free_running_event_proposal',
        'sequence_decoding',
        'midi_emission'
      ]) ||
      !outputs ||
      typeof value.free_running_event_proposal !== 'boolean' ||
      typeof value.sequence_decoding !== 'boolean' ||
      typeof value.midi_emission !== 'boolean'
    ) {
      return null
    }
    return {
      format: value.format,
      outputs,
      free_running_event_proposal: value.free_running_event_proposal,
      sequence_decoding: value.sequence_decoding,
      midi_emission: value.midi_emission
    }
  }
  if (
    !hasOnlyKeys(value, ['format', 'event_attributes', 'midi_emission']) ||
    typeof value.event_attributes !== 'boolean' ||
    typeof value.midi_emission !== 'boolean'
  ) {
    return null
  }
  return {
    format: value.format,
    event_attributes: value.event_attributes,
    midi_emission: value.midi_emission
  }
}

function normalizeCandidateTargetContract(
  value: unknown
): StrumCheckpointCandidateTargetContract | null {
  if (!isRecord(value) || !isSafeContractName(value.kind)) return null
  const allowed = [
    'kind',
    'string_count',
    'fret_range',
    'techniques',
    'track_variant_head',
    'pitch_range',
    'channel_metadata',
    'range_state_head'
  ]
  if (!hasOnlyKeys(value, allowed, ['kind'])) return null
  const target: StrumCheckpointCandidateTargetContract = { kind: value.kind }
  if (Object.prototype.hasOwnProperty.call(value, 'string_count')) {
    const stringCount = value.string_count
    if (
      typeof stringCount !== 'number' ||
      !Number.isSafeInteger(stringCount) ||
      stringCount < 1 ||
      stringCount > 12
    )
      return null
    target.string_count = stringCount
  }
  if (Object.prototype.hasOwnProperty.call(value, 'fret_range')) {
    const range = normalizeIntegerPair(value.fret_range, 0, 127)
    if (!range) return null
    target.fret_range = range
  }
  if (Object.prototype.hasOwnProperty.call(value, 'techniques')) {
    const techniques = normalizeContractStrings(value.techniques, isSafeContractToken)
    if (!techniques) return null
    target.techniques = techniques
  }
  if (Object.prototype.hasOwnProperty.call(value, 'track_variant_head')) {
    const variants = normalizeContractStrings(value.track_variant_head, isSafeContractToken)
    if (!variants) return null
    target.track_variant_head = variants
  }
  if (Object.prototype.hasOwnProperty.call(value, 'pitch_range')) {
    const range = normalizeIntegerPair(value.pitch_range, 0, 127)
    if (!range) return null
    target.pitch_range = range
  }
  if (Object.prototype.hasOwnProperty.call(value, 'channel_metadata')) {
    if (!isSafeContractName(value.channel_metadata)) return null
    target.channel_metadata = value.channel_metadata
  }
  if (Object.prototype.hasOwnProperty.call(value, 'range_state_head')) {
    const states = normalizeContractStrings(value.range_state_head, isSafeContractToken)
    if (!states) return null
    target.range_state_head = states
  }
  return target
}

function normalizeCheckpointOutputCandidate(
  value: unknown,
  pipelineId: string
): StrumCheckpointOutputCandidate | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'component_outputs',
      'model_outputs',
      'preprocessing',
      'candidate_bundle',
      'deployment_scope'
    ])
  ) {
    return null
  }
  const componentOutputs = normalizeContractStrings(value.component_outputs, isSafeContractToken)
  const modelOutputs = normalizeContractStrings(value.model_outputs, isSafeContractToken)
  const preprocessing = value.preprocessing
  const bundle = value.candidate_bundle
  const scope = value.deployment_scope
  const negativePolicy =
    isRecord(preprocessing) &&
    Object.prototype.hasOwnProperty.call(preprocessing, 'negative_policy')
      ? preprocessing.negative_policy
      : undefined
  if (
    !componentOutputs ||
    !modelOutputs ||
    !isRecord(preprocessing) ||
    !hasOnlyKeys(
      preprocessing,
      ['id', 'input_contract', 'negative_policy'],
      ['id', 'input_contract']
    ) ||
    !isSafeContractName(preprocessing.id) ||
    !isSafeContractName(preprocessing.input_contract) ||
    (negativePolicy !== undefined && !isSafeContractName(negativePolicy)) ||
    !isRecord(bundle) ||
    !hasOnlyKeys(
      bundle,
      [
        'config_format',
        'task_kind',
        'pipeline_id',
        'model_implementation',
        'input_contract',
        'output_contract',
        'target_contract',
        'component_set',
        'profiles',
        'companions'
      ],
      [
        'config_format',
        'task_kind',
        'pipeline_id',
        'model_implementation',
        'input_contract',
        'output_contract',
        'component_set',
        'profiles',
        'companions'
      ]
    ) ||
    !isSafeContractName(bundle.config_format) ||
    !isSafeContractToken(bundle.task_kind) ||
    bundle.pipeline_id !== pipelineId ||
    !isSafeContractName(bundle.pipeline_id) ||
    !isSafeContractName(bundle.model_implementation) ||
    bundle.profiles !== 'forbidden' ||
    bundle.companions !== 'forbidden' ||
    !isRecord(scope) ||
    !hasOnlyKeys(scope, ['status', 'profile', 'chart_execution']) ||
    scope.status !== 'raw_experiment_candidate_only' ||
    scope.profile !== 'not_available' ||
    scope.chart_execution !== 'not_available'
  ) {
    return null
  }
  const inputContract = normalizeCandidateInputContract(bundle.input_contract)
  const outputContract = normalizeCandidateOutputContract(bundle.output_contract)
  const componentSet = normalizeContractStrings(bundle.component_set, isSafeContractToken)
  const targetContract = Object.prototype.hasOwnProperty.call(bundle, 'target_contract')
    ? normalizeCandidateTargetContract(bundle.target_contract)
    : undefined
  if (
    !inputContract ||
    !outputContract ||
    !componentSet ||
    componentSet.join('\u0000') !== componentOutputs.join('\u0000') ||
    (Object.prototype.hasOwnProperty.call(bundle, 'target_contract') && !targetContract)
  ) {
    return null
  }
  return {
    component_outputs: componentOutputs,
    model_outputs: modelOutputs,
    preprocessing: {
      id: preprocessing.id,
      input_contract: preprocessing.input_contract,
      ...(negativePolicy ? { negative_policy: negativePolicy } : {})
    },
    candidate_bundle: {
      config_format: bundle.config_format,
      task_kind: bundle.task_kind,
      pipeline_id: bundle.pipeline_id,
      model_implementation: bundle.model_implementation,
      input_contract: inputContract,
      output_contract: outputContract,
      ...(targetContract ? { target_contract: targetContract } : {}),
      component_set: componentSet,
      profiles: 'forbidden',
      companions: 'forbidden'
    },
    deployment_scope: {
      status: 'raw_experiment_candidate_only',
      profile: 'not_available',
      chart_execution: 'not_available'
    }
  }
}

function normalizeCheckpointOutputContracts(
  value: unknown,
  pipelineId: string
): StrumCheckpointOutputContracts | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['format', 'selector', 'by_candidate_kind']) ||
    value.format !== CHECKPOINT_OUTPUT_CONTRACTS_FORMAT ||
    !isRecord(value.selector) ||
    !hasOnlyKeys(value.selector, ['training_option', 'default']) ||
    !isSafeContractToken(value.selector.training_option) ||
    !isSafeContractName(value.selector.default) ||
    !isRecord(value.by_candidate_kind)
  ) {
    return null
  }
  const entries = Object.entries(value.by_candidate_kind)
  if (
    entries.length === 0 ||
    entries.length > MAX_OUTPUT_CONTRACT_CANDIDATES ||
    !entries.every(([candidateKind]) => isSafeContractName(candidateKind)) ||
    !Object.prototype.hasOwnProperty.call(value.by_candidate_kind, value.selector.default)
  ) {
    return null
  }
  const normalizedEntries = entries.map(
    ([candidateKind, candidate]) =>
      [candidateKind, normalizeCheckpointOutputCandidate(candidate, pipelineId)] as const
  )
  if (normalizedEntries.some(([, candidate]) => candidate === null)) return null
  return {
    format: CHECKPOINT_OUTPUT_CONTRACTS_FORMAT,
    selector: {
      training_option: value.selector.training_option,
      default: value.selector.default
    },
    by_candidate_kind: Object.fromEntries(
      normalizedEntries.filter(
        (entry): entry is readonly [string, StrumCheckpointOutputCandidate] => entry[1] !== null
      )
    )
  }
}

function normalizeTrainingPipeline(value: unknown): TrainingPipeline | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(
      value,
      [
        'id',
        'display_name',
        'kind',
        'version',
        'catalog_requirements',
        'prepare_schema',
        'train_schema',
        'checkpoint_outputs',
        'checkpoint_output_contracts',
        'inference_capability',
        'status',
        'preparation_status',
        'training_status',
        'private_request_fields',
        'catalog_inspection_option_keys',
        'training_requirements',
        'training_contract',
        'promotion_jobs'
      ],
      [
        'id',
        'display_name',
        'kind',
        'version',
        'catalog_requirements',
        'prepare_schema',
        'train_schema',
        'checkpoint_outputs',
        'inference_capability',
        'status',
        'preparation_status',
        'training_status',
        'private_request_fields',
        'catalog_inspection_option_keys',
        'training_requirements',
        'promotion_jobs'
      ]
    ) ||
    !isSafeContractName(value.id) ||
    !isSafeDisplayText(value.display_name) ||
    !isSafeContractToken(value.kind) ||
    typeof value.version !== 'number' ||
    !Number.isSafeInteger(value.version) ||
    value.version < 1 ||
    !isSafeContractToken(value.status) ||
    !isSafeContractToken(value.preparation_status) ||
    !isSafeContractToken(value.training_status) ||
    (value.inference_capability !== null && !isSafeContractName(value.inference_capability))
  ) {
    return null
  }
  const version = Number(value.version)
  const catalogRequirements = normalizeMetadataRecord(value.catalog_requirements)
  const prepareSchema = normalizeMetadataRecord(value.prepare_schema)
  const trainSchema =
    value.train_schema === null ? null : normalizeMetadataRecord(value.train_schema)
  const checkpointOutputs = normalizeContractTokenList(value.checkpoint_outputs)
  const privateFields = normalizeContractTokenList(value.private_request_fields)
  const inspectionKeys = normalizeContractTokenList(value.catalog_inspection_option_keys)
  const trainingRequirements = Array.isArray(value.training_requirements)
    ? value.training_requirements.every(
        (requirement) => isSafeContractToken(requirement) || isSafeContractName(requirement)
      ) && new Set(value.training_requirements).size === value.training_requirements.length
      ? ([...value.training_requirements] as string[])
      : null
    : null
  const promotionJobs = Array.isArray(value.promotion_jobs)
    ? value.promotion_jobs.map(normalizePromotionJob)
    : null
  if (
    !catalogRequirements ||
    !prepareSchema ||
    (trainSchema === null && value.train_schema !== null) ||
    !checkpointOutputs ||
    !privateFields ||
    !inspectionKeys ||
    !trainingRequirements ||
    !promotionJobs ||
    promotionJobs.some((job) => job === null) ||
    promotionJobs.length > 16 ||
    new Set(promotionJobs.map((job) => job?.id)).size !== promotionJobs.length
  ) {
    return null
  }
  const rawContracts = value.checkpoint_output_contracts
  const contracts =
    rawContracts === undefined
      ? undefined
      : normalizeCheckpointOutputContracts(rawContracts, value.id)
  if (rawContracts !== undefined && !contracts) return null
  return {
    id: value.id,
    display_name: value.display_name,
    kind: value.kind,
    version,
    status: value.status,
    preparation_status: value.preparation_status,
    training_status: value.training_status,
    catalog_requirements: catalogRequirements,
    prepare_schema: prepareSchema,
    train_schema: trainSchema,
    checkpoint_outputs: checkpointOutputs,
    ...(contracts ? { checkpoint_output_contracts: contracts } : {}),
    inference_capability: value.inference_capability,
    private_request_fields: privateFields,
    catalog_inspection_option_keys: inspectionKeys,
    training_requirements: trainingRequirements,
    promotion_jobs: promotionJobs.filter((job): job is TrainingPromotionJob => job !== null)
  }
}

export async function listTrainingPipelines(): Promise<TrainingPipeline[]> {
  const runtime = await probeTrainingRuntime()
  if (
    !runtime.capabilities.includes('dataset_prepare') ||
    !runtime.capabilities.includes('training_start')
  )
    return []
  const promotionDiscoveryAvailable = runtime.capabilities.includes('post_train_job_discovery')
  const payload = await runWorkerJson(['pipeline', 'list', '--json'])
  const pipelines = Array.isArray(payload.pipelines) ? payload.pipelines : []
  return pipelines.flatMap((pipeline) => {
    const normalized = normalizeTrainingPipeline(pipeline)
    return normalized
      ? [
          {
            ...normalized,
            promotion_jobs: promotionDiscoveryAvailable ? normalized.promotion_jobs : []
          }
        ]
      : []
  })
}

async function resolveTrainingPipeline(pipelineId: string): Promise<TrainingPipeline> {
  const pipeline = (await listTrainingPipelines()).find((candidate) => candidate.id === pipelineId)
  if (!pipeline)
    throw new Error('That training pipeline is not available in the selected STRUM runtime.')
  return pipeline
}

function normalizePromotionResult(
  value: unknown,
  pipelineId: string,
  job: TrainingPromotionJob,
  promotionId: string,
  candidateArtifactId: string
): TrainingPromotionResult | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'schema_version',
      'format',
      'status',
      'pipeline_id',
      'job_id',
      'output_kind',
      'deployment_scope',
      'result'
    ]) ||
    value.schema_version !== 1 ||
    value.format !== 'strum-post-train-job-result/v1' ||
    value.status !== 'completed' ||
    value.pipeline_id !== pipelineId ||
    value.job_id !== job.id ||
    value.output_kind !== job.output_kind ||
    value.deployment_scope !== job.deployment_scope
  ) {
    return null
  }
  const result = normalizeMetadataRecord(value.result)
  if (!result) return null
  return {
    schema_version: 1,
    format: 'strum-post-train-job-result/v1',
    status: 'completed',
    pipeline_id: pipelineId,
    job_id: job.id,
    output_kind: job.output_kind,
    deployment_scope: job.deployment_scope,
    result,
    promotionId,
    candidateArtifactId
  }
}

async function resolveCandidateBinding(
  artifactId: string
): Promise<{ run: StoredTrainingRun; binding: CandidateBinding }> {
  if (!isArtifactId(artifactId)) throw new Error('Select a trained STRUM candidate first.')
  const registry = await readRegistry()
  const run = registry.runs.find(
    (entry) => entry.artifactId === artifactId && entry.candidateBinding?.artifactId === artifactId
  )
  if (!run?.candidateBinding) throw new Error('That trained STRUM candidate is not available.')
  const binding = run.candidateBinding
  try {
    const [bundleRoot, taskView, catalogRoot] = await Promise.all([
      realpath(binding.bundleRoot),
      realpath(binding.taskView),
      realpath(binding.catalogRoot)
    ])
    const inspection = normalizeDiscoveredCheckpoint(
      await runWorkerJson(['checkpoint', 'inspect', '--model-root', bundleRoot, '--json'])
    )
    if (
      !inspection ||
      inspection.artifactId !== artifactId ||
      inspection.manifestSha256 !== run.checkpointManifestHash
    ) {
      throw new Error('candidate no longer matches its registered checkpoint.')
    }
    return {
      run,
      binding: { artifactId, bundleRoot, taskView, catalogRoot }
    }
  } catch {
    throw new Error('That trained STRUM candidate is no longer available.')
  }
}

function promotionOutputPath(jobId: string, job: TrainingPromotionJob): string {
  const name = job.kind === 'evaluation' ? 'result.json' : 'bundle'
  return join(trainingRoot(), 'promotions', jobId, name)
}

const SUPPORTED_PROMOTION_PRIVATE_FIELDS = new Set([
  'bundle_root',
  'experiment',
  'experiment_root',
  'task_view',
  'dataset_manifest',
  'catalog_root',
  'output',
  'evaluation'
])

function supportsPromotionPrivateFields(job: TrainingPromotionJob): boolean {
  return [...job.private_request_fields, ...job.optional_private_request_fields].every((field) =>
    SUPPORTED_PROMOTION_PRIVATE_FIELDS.has(field)
  )
}

async function resolvePromotionRequest(
  candidateArtifactId: string,
  job: TrainingPromotionJob,
  options: Record<string, unknown>,
  jobId: string
): Promise<{ request: Record<string, unknown>; outputRoot: string }> {
  const { run, binding } = await resolveCandidateBinding(candidateArtifactId)
  const outputRoot = promotionOutputPath(jobId, job)
  await mkdir(join(trainingRoot(), 'promotions', jobId), { recursive: true })
  const request: Record<string, unknown> = {
    pipeline_id: run.pipelineId,
    job_id: job.id,
    options: sanitizeTrainingSchemaValues(job.options_schema, options, 'post-training job')
  }
  const registry = await readRegistry()
  const latestEvaluation = [...(registry.promotions ?? [])]
    .reverse()
    .find(
      (entry) =>
        entry.candidateArtifactId === candidateArtifactId &&
        entry.pipeline_id === run.pipelineId &&
        entry.status === 'completed' &&
        entry.kind === 'evaluation'
    )
  let evaluationRoot: string | undefined
  if (latestEvaluation) {
    try {
      const [promotionRoot, resolvedEvaluation] = await Promise.all([
        realpath(join(trainingRoot(), 'promotions')),
        realpath(latestEvaluation.outputRoot)
      ])
      const pathWithinPromotionRoot = relative(promotionRoot, resolvedEvaluation)
      if (
        pathWithinPromotionRoot === '' ||
        isAbsolute(pathWithinPromotionRoot) ||
        pathWithinPromotionRoot.startsWith('..') ||
        pathWithinPromotionRoot.includes('..\\')
      ) {
        throw new Error('evaluation escaped private root')
      }
      evaluationRoot = resolvedEvaluation
    } catch {
      throw new Error('Required post-training evaluation evidence is unavailable.')
    }
  }
  const values: Record<string, string | undefined> = {
    bundle_root: binding.bundleRoot,
    experiment: binding.bundleRoot,
    experiment_root: binding.bundleRoot,
    task_view: binding.taskView,
    dataset_manifest: binding.taskView,
    catalog_root: binding.catalogRoot,
    output: outputRoot,
    evaluation: evaluationRoot
  }
  for (const field of job.private_request_fields) {
    const value = values[field]
    if (!value)
      throw new Error('This post-training job is not available for the selected candidate.')
    request[field] = value
  }
  for (const field of job.optional_private_request_fields) {
    const value = values[field]
    if (value) request[field] = value
  }
  return { request, outputRoot }
}

/** List only descriptor-advertised, currently available post-training actions. */
export async function listPromotionJobs(
  candidateArtifactId: string
): Promise<TrainingPromotionJob[]> {
  const runtime = await probeTrainingRuntime()
  if (
    !runtime.capabilities.includes('post_train_job_discovery') ||
    !runtime.capabilities.includes('post_train_job_start')
  ) {
    return []
  }
  const { run } = await resolveCandidateBinding(candidateArtifactId)
  const pipeline = await resolveTrainingPipeline(run.pipelineId)
  const registry = await readRegistry()
  const hasEvaluation = (registry.promotions ?? []).some(
    (entry) =>
      entry.candidateArtifactId === candidateArtifactId &&
      entry.pipeline_id === run.pipelineId &&
      entry.kind === 'evaluation' &&
      entry.status === 'completed' &&
      existsSync(entry.outputRoot)
  )
  return pipeline.promotion_jobs.filter(
    (job) =>
      job.status === 'available' &&
      supportsPromotionPrivateFields(job) &&
      (!job.private_request_fields.includes('evaluation') || hasEvaluation)
  )
}

export async function startPromotionJob(options: {
  candidateArtifactId: string
  jobId: string
  options: Record<string, unknown>
}): Promise<{ jobId: string }> {
  if (!isArtifactId(options.candidateArtifactId) || !isSafeContractName(options.jobId)) {
    throw new Error('Select a valid post-training job first.')
  }
  const runtime = await probeTrainingRuntime()
  if (!runtime.capabilities.includes('post_train_job_start')) {
    throw new Error('The selected STRUM runtime cannot run post-training jobs.')
  }
  const { run } = await resolveCandidateBinding(options.candidateArtifactId)
  const pipeline = await resolveTrainingPipeline(run.pipelineId)
  const job = pipeline.promotion_jobs.find(
    (candidate) => candidate.id === options.jobId && candidate.status === 'available'
  )
  if (!job || !supportsPromotionPrivateFields(job)) {
    throw new Error('That post-training job is not available for the selected candidate.')
  }
  const jobId = randomUUID()
  const { request, outputRoot } = await resolvePromotionRequest(
    options.candidateArtifactId,
    job,
    options.options,
    jobId
  )
  await startJsonEventJob(jobId, ['promotion', 'start'], request, async (result) => {
    const normalized = normalizePromotionResult(
      result,
      run.pipelineId,
      job,
      `promotion-${jobId}`,
      options.candidateArtifactId
    )
    if (!normalized) throw new Error('STRUM returned an invalid post-training result.')
    const packagedInspection =
      job.kind === 'package'
        ? normalizeDiscoveredCheckpoint(
            await runWorkerJson(['checkpoint', 'inspect', '--model-root', outputRoot, '--json'])
          )
        : null
    if (job.kind === 'package' && !packagedInspection) {
      throw new Error('STRUM could not re-inspect the packaged model bundle.')
    }
    const registry = await readRegistry()
    const stored: StoredPromotion = {
      ...normalized,
      candidateArtifactId: options.candidateArtifactId,
      kind: job.kind,
      outputRoot
    }
    registry.promotions = [
      ...(registry.promotions ?? []).filter((entry) => entry.promotionId !== stored.promotionId),
      stored
    ]
    await writeRegistry(registry)
    if (!packagedInspection) return normalized
    discoveredCheckpointRoots.set(packagedInspection.artifactId, outputRoot)
    return {
      ...normalized,
      artifactId: packagedInspection.artifactId,
      deploymentStatus: packagedInspection.deploymentStatus
    }
  })
  return { jobId }
}

export async function inspectTrainingCatalog(
  catalogRoot: string,
  pipelineId: string,
  requestedOptions: Record<string, unknown>
): Promise<TrainingCatalogInspection> {
  const pipeline = await resolveTrainingPipeline(pipelineId)
  const preparedOptions = sanitizeTrainingSchemaValues(
    pipeline.prepare_schema,
    requestedOptions,
    'catalog inspection'
  )
  const inspectionOptions = Object.fromEntries(
    Object.entries(preparedOptions).filter(([key]) =>
      pipeline.catalog_inspection_option_keys.includes(key)
    )
  )
  const payload = await runWorkerJson([
    'catalog',
    'inspect',
    '--catalog-root',
    catalogRoot,
    '--pipeline',
    pipelineId,
    '--options',
    JSON.stringify(inspectionOptions),
    '--json'
  ])
  const expectedKeys = [
    'status',
    'catalog_id',
    'record_count',
    'allowed_record_count',
    'pipeline_id',
    'eligible_count',
    'exclusion_reason_counts',
    'audio_policy',
    'estimated_storage_bytes',
    'storage_estimate_capped',
    'storage_estimate_semantics',
    'eligibility_selection'
  ]
  const recordCount = normalizeNonNegativeCount(payload.record_count)
  const allowedRecordCount = normalizeNonNegativeCount(payload.allowed_record_count)
  const eligibleCount = normalizeNonNegativeCount(payload.eligible_count)
  const estimatedStorageBytes = normalizeNonNegativeCount(payload.estimated_storage_bytes)
  if (
    !hasOnlyKeys(
      payload,
      expectedKeys,
      expectedKeys.filter((key) => key !== 'eligibility_selection')
    ) ||
    payload.status !== 'ready' ||
    !isSafeContractToken(payload.catalog_id) ||
    payload.pipeline_id !== pipelineId ||
    recordCount === null ||
    allowedRecordCount === null ||
    eligibleCount === null ||
    estimatedStorageBytes === null ||
    (payload.storage_estimate_capped !== true && payload.storage_estimate_capped !== false) ||
    !isSafeDisplayText(payload.storage_estimate_semantics)
  ) {
    throw new Error('STRUM returned an invalid catalog inspection result.')
  }
  const excluded = normalizeExclusionReasonCounts(payload.exclusion_reason_counts)
  const audioPolicy = normalizeMetadataRecord(payload.audio_policy)
  if (
    !excluded ||
    !audioPolicy ||
    (payload.eligibility_selection !== undefined &&
      !normalizeMetadataRecord(payload.eligibility_selection))
  ) {
    throw new Error('STRUM returned an invalid catalog inspection result.')
  }
  return {
    pipelineId,
    eligibleCount,
    recordCount,
    excluded,
    audioPolicy,
    estimatedStorageBytes,
    storageEstimateCapped: payload.storage_estimate_capped,
    storageEstimateSemantics: payload.storage_estimate_semantics
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
        ...(run.artifactId ? { artifactId: run.artifactId } : {}),
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
  const schemaVersion = candidate.schema_version
  const components = Array.isArray(candidate.components) ? candidate.components : null
  const profiles = Array.isArray(candidate.profiles) ? candidate.profiles : null
  const rejectedProfileCount = candidate.rejected_profile_count
  const deploymentStatus = candidate.deployment_status
  const rawCompatibility = candidate.compatibility
  if (
    !isArtifactId(artifactId) ||
    !isSafeIdentifier(modelId) ||
    typeof manifestSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(manifestSha256) ||
    typeof schemaVersion !== 'number' ||
    !Number.isSafeInteger(schemaVersion) ||
    schemaVersion < 1 ||
    !components ||
    !profiles ||
    typeof rejectedProfileCount !== 'number' ||
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
  const compatibility = normalizeDiscoveredCompatibility(rawCompatibility)
  if (!compatibility) return null
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

function normalizeDiscoveredCompatibility(
  value: unknown
): Record<string, string | number | boolean | null> | null {
  if (!isRecord(value)) return null
  const keys = Object.keys(value)
  const manifestSchema = value.manifest_schema
  const strumVersion = value.strum_version
  const allowed = new Set([
    'manifest_schema',
    'strum_version',
    'strum_revision',
    'strum_source_dirty'
  ])
  if (
    keys.length < 2 ||
    keys.length > allowed.size ||
    !keys.every((key) => allowed.has(key)) ||
    typeof manifestSchema !== 'number' ||
    !Number.isSafeInteger(manifestSchema) ||
    manifestSchema < 1 ||
    typeof strumVersion !== 'string' ||
    !/^>=\d+(?:\.\d+){0,3}(?:[-+][A-Za-z0-9._-]+)?$/.test(strumVersion)
  ) {
    return null
  }
  if (
    (value.strum_revision !== undefined && !isSafeContractToken(value.strum_revision)) ||
    (value.strum_source_dirty !== undefined &&
      value.strum_source_dirty !== null &&
      typeof value.strum_source_dirty !== 'boolean')
  ) {
    return null
  }
  return {
    manifest_schema: manifestSchema,
    strum_version: strumVersion,
    ...(value.strum_revision === undefined ? {} : { strum_revision: value.strum_revision }),
    ...(value.strum_source_dirty === undefined
      ? {}
      : { strum_source_dirty: value.strum_source_dirty })
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

export async function inspectTrainingCheckpoint(runId: string): Promise<TrainingCheckpoint> {
  const registry = await readRegistry()
  const run = registry.runs.find((entry) => entry.runId === runId && existsSync(entry.outputRoot))
  if (!run) throw new Error('The selected training run is no longer available.')
  const candidate = normalizeDiscoveredCheckpoint(
    await runWorkerJson(['checkpoint', 'inspect', '--model-root', run.outputRoot, '--json'])
  )
  if (
    !candidate ||
    candidate.manifestSha256 !== run.checkpointManifestHash ||
    (run.artifactId !== undefined && candidate.artifactId !== run.artifactId)
  ) {
    throw new Error('The checkpoint does not match the selected training run.')
  }
  return {
    runId: run.runId,
    pipelineId: run.pipelineId,
    runtimeId: (await probeTrainingRuntime()).runtimeId,
    taskViewId: run.taskViewId,
    taskViewHash:
      registry.tasks.find((task) => task.taskViewId === run.taskViewId)?.contentHash ?? '',
    checkpointManifestHash: candidate.manifestSha256,
    deployable: candidate.deploymentStatus === 'ready',
    deploymentReason:
      candidate.deploymentStatus === 'ready'
        ? null
        : 'requires STRUM profile evaluation and promotion',
    components: candidate.components
  }
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
  let worker: WorkerInvocation
  for (;;) {
    const resolved = await resolveWorkerInvocation(options.runId)
    if (
      resolved.runtimeSelectionEpoch !== runtimeSelectionEpoch ||
      runtimeSelectionActivation
    ) {
      continue
    }
    worker = resolved.invocation
    break
  }
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
  onSucceeded: (
    result: Record<string, unknown>
  ) => Promise<Record<string, unknown> | TrainingPromotionResult>,
  runId?: string
): Promise<void> {
  const requestPath = join(app.getPath('temp'), `octave-training-${jobId}.json`)
  await writeFile(requestPath, JSON.stringify(request), 'utf8')
  let worker: WorkerInvocation
  for (;;) {
    const resolved = await resolveWorkerInvocation(jobId)
    if (
      resolved.runtimeSelectionEpoch !== runtimeSelectionEpoch ||
      runtimeSelectionActivation
    ) {
      continue
    }
    worker = resolved.invocation
    break
  }
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
  const safeStage = (value: unknown): string =>
    isSafeContractToken(value) ? String(value) : 'running'
  const safeCode = (value: unknown): string | undefined =>
    isSafeContractToken(value) ? String(value) : undefined
  const localMessage = (state: string, stage: string): string => {
    if (state === 'succeeded') return 'Completed locally.'
    if (state === 'cancelled') return 'The STRUM training job was cancelled.'
    if (state === 'failed') return 'STRUM rejected or could not complete this local job.'
    return `STRUM is processing ${stage.replaceAll('_', ' ')} locally.`
  }
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
        // A worker terminal record is final even when its process buffers a
        // duplicate line before close. Never invoke registration twice.
        if (terminal) continue
        const legacyEvent = event.event
        const isLegacyProgress = legacyEvent === 'progress'
        const isLegacyTerminal = legacyEvent === 'terminal'
        const state = typeof event.state === 'string' ? event.state : ''
        const isCurrentState = ['running', 'succeeded', 'failed', 'cancelled'].includes(state)
        if (!isLegacyProgress && !isLegacyTerminal && !isCurrentState) continue
        const sequence = Number(event.sequence)
        if (!Number.isInteger(sequence) || sequence <= job.sequence) continue
        job.sequence = sequence
        const stage = safeStage(event.stage)
        const code = safeCode(event.code)
        const normalizedState = isLegacyProgress ? 'running' : state
        if (isLegacyProgress || normalizedState === 'running') {
          broadcast({
            jobId,
            sequence,
            stage,
            progress: Number(event.progress ?? 0),
            state: 'running',
            code,
            message: localMessage('running', stage)
          })
          continue
        }
        terminal = true
        if (!job.cancelling && normalizedState === 'succeeded' && isRecord(event.result)) {
          void onSucceeded(event.result)
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
            state: job.cancelling || normalizedState === 'cancelled' ? 'cancelled' : 'failed',
            code,
            message: localMessage(normalizedState, stage)
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
  // Worker d8 writes one task-view manifest at its declared output location.
  // Keep that location private; the renderer only receives OCTAVE's opaque ID.
  const taskRoot = join(trainingRoot(), 'tasks', `${taskViewId}.json`)
  await mkdir(join(trainingRoot(), 'tasks'), { recursive: true })
  await startJsonEventJob(
    jobId,
    ['dataset', 'prepare'],
    {
      catalog_root: options.catalogRoot,
      pipeline_id: options.pipelineId,
      output: taskRoot,
      options: prepare
    },
    async (result) => {
      const workerTaskViewId = result.task_view_id
      const recordCount = result.record_count
      if (
        result.status !== 'prepared' ||
        result.pipeline_id !== options.pipelineId ||
        !isSafeContractToken(workerTaskViewId) ||
        typeof recordCount !== 'number' ||
        !Number.isSafeInteger(recordCount) ||
        recordCount < 0 ||
        !isSafeContractToken(result.output_name)
      ) {
        throw new Error('STRUM returned an invalid prepared task result.')
      }
      const registry = await readRegistry()
      const task: TrainingTask & { taskRoot: string; catalogRoot: string } = {
        taskViewId,
        catalogId: options.catalogId,
        catalogName: options.catalogName,
        pipelineId: options.pipelineId,
        eligibleCount: recordCount,
        // This is STRUM's path-free task-view identity, retained under the
        // historical public field name for the existing renderer.
        contentHash: workerTaskViewId,
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
  if (!pipeline.train_schema) throw new Error('This STRUM pipeline has no training schema.')
  const train = sanitizeTrainingSchemaValues(pipeline.train_schema, options.train, 'train')
  const jobId = randomUUID()
  const runId = `run-${randomUUID()}`
  const outputRoot = join(trainingRoot(), 'runs', runId)
  await mkdir(join(trainingRoot(), 'runs'), { recursive: true })
  await startJsonEventJob(
    jobId,
    ['train', 'start'],
    {
      pipeline_id: options.pipelineId,
      task_view: task.taskRoot,
      catalog_root: task.catalogRoot,
      output: outputRoot,
      options: train
    },
    async (result) => {
      if (
        result.status !== 'completed' ||
        result.pipeline_id !== options.pipelineId ||
        !isSafeContractToken(result.bundle_name) ||
        !/^[a-f0-9]{64}$/.test(String(result.manifest_sha256 ?? '')) ||
        !Array.isArray(result.components)
      ) {
        throw new Error('STRUM returned an invalid training result.')
      }
      const inspection = normalizeDiscoveredCheckpoint(
        await runWorkerJson(['checkpoint', 'inspect', '--model-root', outputRoot, '--json'])
      )
      if (
        !inspection ||
        inspection.manifestSha256 !== result.manifest_sha256 ||
        inspection.components.length !== result.components.length
      ) {
        throw new Error('STRUM could not re-inspect the trained candidate.')
      }
      const current = await readRegistry()
      const run: TrainingRun & {
        outputRoot: string
        candidateBinding: {
          artifactId: string
          bundleRoot: string
          taskView: string
          catalogRoot: string
        }
      } = {
        runId,
        taskViewId: task.taskViewId,
        pipelineId: options.pipelineId,
        checkpointCount: inspection.components.length,
        deployable: inspection.deploymentStatus === 'ready',
        checkpointManifestHash: inspection.manifestSha256,
        artifactId: inspection.artifactId,
        createdAt: new Date().toISOString(),
        outputRoot,
        candidateBinding: {
          artifactId: inspection.artifactId,
          bundleRoot: outputRoot,
          taskView: task.taskRoot,
          catalogRoot: task.catalogRoot
        }
      }
      current.runs = [...current.runs.filter((entry) => entry.runId !== runId), run]
      await writeRegistry(current)
      return {
        runId,
        artifactId: run.artifactId,
        checkpointCount: run.checkpointCount,
        deployable: run.deployable
      }
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
