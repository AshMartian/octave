import { useCallback, useEffect, useMemo, useState } from 'react'
import './DatasetCurationModal.css'

type SourceCandidate = {
  candidateId: string
  kind: 'octave-library' | 'sng' | 'rb3con' | 'zip'
  songCount: number
  metadata: Record<string, string>
  midiValid: boolean
  instruments: Record<
    string,
    { status: 'present' | 'absent'; difficulties: string[]; trackNames: string[] }
  >
  trainingUse: 'allowed' | 'review_required'
  warnings: Array<{ code: string }>
  isStrumGenerated?: boolean
}

type CatalogSaveMode = 'create' | 'update' | 'clone'
export type TrainingStep = 'learn' | 'curate' | 'prepare' | 'train' | 'deploy'

export type TrainingActivity = {
  step: TrainingStep
  phase: string
  completed: number
  total: number
}

type ExistingCatalog = {
  catalogName: string
  catalogId: string
  provenance: string
  license: string
  recordCount: number
  libraryRecordCount: number
  externalRecordCount: number
}

type PackageCandidate = SourceCandidate & { groupId: string }

type PackageGroup = {
  groupId: string
  groupName: string
  strumGeneratedCount: number
  candidates: PackageCandidate[]
}

type TrainingRuntime = {
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

type TrainingPipeline = {
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

type TrainingTask = {
  taskViewId: string
  catalogId: string
  catalogName: string
  pipelineId: string
  eligibleCount: number
  contentHash: string
  createdAt: string
}

type TrainingRun = {
  runId: string
  taskViewId: string
  pipelineId: string
  checkpointCount: number
  deployable: boolean
  checkpointManifestHash: string
  createdAt: string
}

type TrainingJob = {
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
}

const CATALOG_PARENT_STORAGE_KEY = 'octave.datasetCatalogParent'
const TRAINING_LEARN_SEEN_STORAGE_KEY = 'octave.trainingLearnSeen'

const TRAINING_STEPS = [
  'learn',
  'curate',
  'prepare',
  'train',
  'deploy'
] as const satisfies readonly TrainingStep[]

const TRAINING_STEP_TAGLINES = {
  learn: 'Understand the local, personal-use training workflow before curating a catalog.',
  curate: 'Select approved songs and sources for your STRUM catalog.',
  prepare: 'Create a STRUM task view from the approved catalog assets.',
  train: 'Run STRUM from the prepared catalog and follow progress in the background.',
  deploy: 'Inspect local experiment checkpoints before deployment is allowed.'
} as const satisfies Record<TrainingStep, string>

const TRAINING_STEP_DETAILS = [
  {
    step: 'curate',
    title: 'Curate',
    description: 'Choose music you are allowed to use and build a permission-backed catalog.'
  },
  {
    step: 'prepare',
    title: 'Prepare',
    description: 'Create a STRUM task view from approved catalog assets and metadata.'
  },
  {
    step: 'train',
    title: 'Train',
    description: 'Run STRUM in the background and evaluate the checkpoints it produces.'
  },
  {
    step: 'deploy',
    title: 'Deploy',
    description: 'Select a checkpoint as a local OCTAVE auto-chart profile and default.'
  }
] as const satisfies ReadonlyArray<{
  step: TrainingStep
  title: string
  description: string
}>

function candidateLabel(candidate: SourceCandidate): string {
  const artist = candidate.metadata.artist
  const name = candidate.metadata.name
  return artist && name ? `${artist} — ${name}` : `${candidate.kind} source`
}

function TrainingStepIcon({
  step,
  complete = false
}: {
  step: TrainingStep
  complete?: boolean
}): React.JSX.Element {
  if (complete) {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="m5 12 4.2 4.2L19 6.5" />
      </svg>
    )
  }
  if (step === 'learn') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="8.5" />
        <path d="M12 10v5" />
        <path d="M12 7.2h.01" />
      </svg>
    )
  }
  if (step === 'curate') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M3.5 7.5h6l1.8 2h9.2v8.8a2.2 2.2 0 0 1-2.2 2.2H5.7a2.2 2.2 0 0 1-2.2-2.2Z" />
        <path d="M3.5 7.5V5.7a2.2 2.2 0 0 1 2.2-2.2h4.1l1.8 2H18" />
      </svg>
    )
  }
  if (step === 'prepare') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M5 4v16M12 4v16M19 4v16" />
        <path d="M3 9h4M10 15h4M17 7h4" />
        <circle cx="5" cy="9" r="2" />
        <circle cx="12" cy="15" r="2" />
        <circle cx="19" cy="7" r="2" />
      </svg>
    )
  }
  if (step === 'deploy') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 3v11" />
        <path d="m8 10 4 4 4-4" />
        <path d="M5 17.5v2a1.5 1.5 0 0 0 1.5 1.5h11a1.5 1.5 0 0 0 1.5-1.5v-2" />
      </svg>
    )
  }
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m13.5 2-9 12h6.8l-.8 8 9-12h-6.8Z" />
    </svg>
  )
}

function DatasetArtwork({
  candidateId,
  label
}: {
  candidateId: string
  label: string
}): React.JSX.Element {
  const [artwork, setArtwork] = useState<string | null>(null)

  useEffect(() => {
    let current = true
    void window.api.readDatasetCandidateArtwork(candidateId).then((dataUrl) => {
      if (current) setArtwork(dataUrl)
    })
    return () => {
      current = false
    }
  }, [candidateId])

  return artwork ? (
    <img className="dataset-artwork" src={artwork} alt={`${label} artwork`} />
  ) : (
    <span className="dataset-artwork dataset-artwork-placeholder" aria-hidden="true">
      ♪
    </span>
  )
}

export function TrainingModal({
  isOpen,
  onClose,
  onActivityChange
}: {
  isOpen: boolean
  onClose: () => void
  onActivityChange: (activity: TrainingActivity | null) => void
}): React.JSX.Element | null {
  const [songs, setSongs] = useState<SourceCandidate[]>([])
  const [packageGroups, setPackageGroups] = useState<PackageGroup[]>([])
  const [selectedPackages, setSelectedPackages] = useState<Set<string>>(new Set())
  const [catalogParent, setCatalogParent] = useState<{
    parentId: string
    name: string
    path: string
  } | null>(null)
  const [existingCatalogs, setExistingCatalogs] = useState<ExistingCatalog[]>([])
  const [selectedCatalog, setSelectedCatalog] = useState<ExistingCatalog | null>(null)
  const [saveMode, setSaveMode] = useState<CatalogSaveMode>('create')
  const [activeStep, setActiveStep] = useState<TrainingStep>('learn')
  const [hasSeenLearn, setHasSeenLearn] = useState(
    () => localStorage.getItem(TRAINING_LEARN_SEEN_STORAGE_KEY) === 'true'
  )
  const [hasInitializedOpening, setHasInitializedOpening] = useState(false)
  const [catalogName, setCatalogName] = useState('octave-curated-catalog')
  const [catalogId, setCatalogId] = useState('octave-curated-dataset')
  const [provenance, setProvenance] = useState('Curated in Octave')
  const [license, setLicense] = useState('')
  const [loading, setLoading] = useState(false)
  const [scanningPackages, setScanningPackages] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [scanProgress, setScanProgress] = useState<{
    phase: 'discovering' | 'inspecting'
    completed: number
    total: number
  } | null>(null)
  const [saveProgress, setSaveProgress] = useState<{
    phase: 'checking' | 'normalizing' | 'materializing' | 'validating'
    completed: number
    total: number
  } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{
    records: number
    skipped: number
  } | null>(null)
  const [trainingRuntime, setTrainingRuntime] = useState<TrainingRuntime | null>(null)
  const [trainingPipelines, setTrainingPipelines] = useState<TrainingPipeline[]>([])
  const [selectedPipelineId, setSelectedPipelineId] = useState('')
  const [catalogInspection, setCatalogInspection] = useState<{
    pipelineId: string
    eligibleCount: number
    recordCount: number
    excluded: Record<string, number>
    audioPolicy: string
  } | null>(null)
  const [trainingTasks, setTrainingTasks] = useState<TrainingTask[]>([])
  const [trainingRuns, setTrainingRuns] = useState<TrainingRun[]>([])
  const [selectedTaskViewId, setSelectedTaskViewId] = useState('')
  const [trainingJob, setTrainingJob] = useState<TrainingJob | null>(null)
  const [trainConfig, setTrainConfig] = useState({
    epochs: 20,
    batchSize: 16,
    device: 'auto',
    seed: 20260814
  })

  const refreshLibrary = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      setSongs(await window.api.scanDatasetLibrary())
    } catch {
      setError('Could not scan the current library.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (isOpen) void refreshLibrary()
  }, [isOpen, refreshLibrary])

  useEffect(() => {
    if (!isOpen || catalogParent?.path) return
    const storedParentId = localStorage.getItem(CATALOG_PARENT_STORAGE_KEY)
    const restore = storedParentId
      ? window.api.restoreDatasetCatalogParent(storedParentId)
      : window.api.useDefaultDatasetCatalogParent()
    void restore.then((parent) => {
      if (parent) {
        setCatalogParent(parent)
        return
      }
      void window.api.useDefaultDatasetCatalogParent().then((defaultParent) => {
        if (defaultParent) setCatalogParent(defaultParent)
      })
    })
  }, [catalogParent, isOpen])

  useEffect(() => {
    if (!catalogParent) return
    localStorage.setItem(CATALOG_PARENT_STORAGE_KEY, catalogParent.parentId)
    void window.api.listDatasetCatalogs(catalogParent.parentId).then(setExistingCatalogs)
  }, [catalogParent])

  useEffect(() => {
    if (!isOpen) {
      setHasInitializedOpening(false)
      return
    }
    if (hasInitializedOpening) return
    if (!hasSeenLearn) {
      setActiveStep('learn')
      setHasInitializedOpening(true)
      return
    }
    if (!catalogParent) return
    let current = true
    void window.api.listDatasetCatalogs(catalogParent.parentId).then((catalogs) => {
      if (!current) return
      setExistingCatalogs(catalogs)
      const existingCatalog = catalogs[0]
      if (existingCatalog) {
        setSelectedCatalog(existingCatalog)
        setSaveMode('update')
        setCatalogName(existingCatalog.catalogName)
        setCatalogId(existingCatalog.catalogId)
        setProvenance(existingCatalog.provenance)
        setLicense(existingCatalog.license)
        setActiveStep('prepare')
      } else {
        setSelectedCatalog(null)
        setSaveMode('create')
        setActiveStep('curate')
      }
      setHasInitializedOpening(true)
    })
    return () => {
      current = false
    }
  }, [catalogParent, hasInitializedOpening, hasSeenLearn, isOpen])

  useEffect(() => {
    if (!isOpen || activeStep !== 'learn') return
    localStorage.setItem(TRAINING_LEARN_SEEN_STORAGE_KEY, 'true')
    setHasSeenLearn(true)
  }, [activeStep, isOpen])

  useEffect(() => {
    const unsubscribeScan = window.api.onDatasetScanProgress(setScanProgress)
    const unsubscribeSave = window.api.onDatasetSaveProgress(setSaveProgress)
    return () => {
      unsubscribeScan()
      unsubscribeSave()
    }
  }, [])

  const refreshTrainingState = useCallback(async (): Promise<void> => {
    const [runtime, pipelines, artifacts] = await Promise.all([
      window.api.getTrainingRuntime(),
      window.api.listTrainingPipelines(),
      window.api.listTrainingArtifacts()
    ])
    setTrainingRuntime(runtime)
    setTrainingPipelines(pipelines)
    setSelectedPipelineId((current) =>
      pipelines.some((pipeline) => pipeline.id === current) ? current : (pipelines[0]?.id ?? '')
    )
    setTrainingTasks(artifacts.tasks)
    setTrainingRuns(artifacts.runs)
    setSelectedTaskViewId((current) =>
      artifacts.tasks.some((task) => task.taskViewId === current)
        ? current
        : (artifacts.tasks[0]?.taskViewId ?? '')
    )
  }, [])

  useEffect(() => {
    if (isOpen) void refreshTrainingState()
  }, [isOpen, refreshTrainingState])

  useEffect(() => {
    const unsubscribe = window.api.onTrainingProgress((event) => {
      setTrainingJob({
        jobId: event.jobId,
        sequence: event.sequence,
        stage: event.stage,
        progress: event.progress,
        state: event.state,
        code: event.code,
        message: event.message
      })
      if (event.state === 'succeeded') void refreshTrainingState()
      if (event.state === 'failed') setError(event.message)
    })
    return unsubscribe
  }, [refreshTrainingState])

  useEffect(() => {
    if (
      activeStep !== 'prepare' ||
      !catalogParent ||
      !selectedCatalog ||
      !selectedPipelineId ||
      !trainingRuntime?.capabilities.includes('training')
    ) {
      setCatalogInspection(null)
      return
    }
    let current = true
    void window.api
      .inspectTrainingCatalog({
        parentId: catalogParent.parentId,
        catalogName: selectedCatalog.catalogName,
        pipelineId: selectedPipelineId
      })
      .then((inspection) => {
        if (current) setCatalogInspection(inspection)
      })
      .catch(() => {
        if (current) setCatalogInspection(null)
      })
    return () => {
      current = false
    }
  }, [activeStep, catalogParent, selectedCatalog, selectedPipelineId, trainingRuntime])

  useEffect(() => {
    if (scanningPackages) {
      onActivityChange({
        step: 'curate',
        phase: 'Scanning sources',
        completed: scanProgress?.completed ?? 0,
        total: scanProgress?.total ?? 0
      })
      return
    }
    if (exporting) {
      onActivityChange({
        step: 'curate',
        phase: `Saving ${saveProgress?.phase ?? 'catalog'}`,
        completed: saveProgress?.completed ?? 0,
        total: saveProgress?.total ?? 0
      })
      return
    }
    if (trainingJob && !['succeeded', 'failed', 'cancelled'].includes(trainingJob.state ?? '')) {
      onActivityChange({
        step: trainingJob.stage === 'training' ? 'train' : 'prepare',
        phase: trainingJob.message,
        completed: Math.round((trainingJob.progress ?? 0) * 100),
        total: 100
      })
      return
    }
    onActivityChange(null)
  }, [exporting, onActivityChange, saveProgress, scanProgress, scanningPackages, trainingJob])

  const allowedLibrarySongs = useMemo(
    () => songs.filter((song) => song.trainingUse === 'allowed' && song.midiValid),
    [songs]
  )

  const selectableLibrarySongs = useMemo(() => songs.filter((song) => song.midiValid), [songs])
  const packageCandidates = useMemo(
    () => packageGroups.flatMap((group) => group.candidates),
    [packageGroups]
  )
  const allLibrarySongsSelected =
    selectableLibrarySongs.length > 0 &&
    selectableLibrarySongs.every((song) => song.trainingUse === 'allowed')

  if (!isOpen) return null

  const toggleSong = async (song: SourceCandidate): Promise<void> => {
    const optedIn = song.trainingUse !== 'allowed'
    setError(null)
    setSongs((current) =>
      current.map((entry) =>
        entry.candidateId === song.candidateId
          ? { ...entry, trainingUse: optedIn ? 'allowed' : 'review_required' }
          : entry
      )
    )
    if (!(await window.api.setDatasetSongOptIn(song.candidateId, optedIn))) {
      setSongs((current) =>
        current.map((entry) =>
          entry.candidateId === song.candidateId
            ? { ...entry, trainingUse: song.trainingUse }
            : entry
        )
      )
      setError('Could not save that song’s dataset consent setting.')
    }
  }

  const toggleAllLibrarySongs = async (): Promise<void> => {
    const optedIn = !allLibrarySongsSelected
    const previousTrainingUse = new Map(
      selectableLibrarySongs.map((song) => [song.candidateId, song.trainingUse])
    )
    setError(null)
    setSongs((current) =>
      current.map((song) =>
        song.midiValid ? { ...song, trainingUse: optedIn ? 'allowed' : 'review_required' } : song
      )
    )
    const results = await Promise.all(
      selectableLibrarySongs.map(async (song) => [
        song.candidateId,
        await window.api.setDatasetSongOptIn(song.candidateId, optedIn)
      ])
    )
    const failedIds = new Set(
      results.filter(([, succeeded]) => !succeeded).map(([candidateId]) => candidateId)
    )
    if (failedIds.size) {
      setSongs((current) =>
        current.map((song) =>
          failedIds.has(song.candidateId)
            ? {
                ...song,
                trainingUse: previousTrainingUse.get(song.candidateId) ?? song.trainingUse
              }
            : song
        )
      )
      setError('Could not save consent for every selected song.')
    }
  }

  const addPackageFolder = async (): Promise<void> => {
    setScanningPackages(true)
    setScanProgress({ phase: 'discovering', completed: 0, total: 0 })
    setError(null)
    try {
      const discovered = await window.api.chooseDatasetPackageFolder()
      if (discovered) setPackageGroups((current) => [...current, discovered])
    } catch {
      setError('Could not scan the selected source folder.')
    } finally {
      setScanningPackages(false)
      setScanProgress(null)
    }
  }

  const removePackageGroup = async (group: PackageGroup): Promise<void> => {
    await window.api.removeDatasetPackageGroup(
      group.candidates.map((candidate) => candidate.candidateId)
    )
    setPackageGroups((current) => current.filter((entry) => entry.groupId !== group.groupId))
    setSelectedPackages((current) => {
      const next = new Set(current)
      for (const candidate of group.candidates) next.delete(candidate.candidateId)
      return next
    })
  }

  const togglePackage = async (candidate: SourceCandidate): Promise<void> => {
    const approved = !selectedPackages.has(candidate.candidateId)
    setSelectedPackages((current) => {
      const next = new Set(current)
      if (approved) next.add(candidate.candidateId)
      else next.delete(candidate.candidateId)
      return next
    })
    if (!(await window.api.setDatasetPackageApproved(candidate.candidateId, approved))) {
      setSelectedPackages((current) => {
        const next = new Set(current)
        if (approved) next.delete(candidate.candidateId)
        else next.add(candidate.candidateId)
        return next
      })
      setError('Could not save that package review decision.')
    }
  }

  const chooseCatalogParent = async (): Promise<void> => {
    const selected = await window.api.chooseDatasetCatalogParent()
    if (selected) {
      setCatalogParent(selected)
      setSelectedCatalog(null)
      setSaveMode('create')
      setExistingCatalogs([])
      setResult(null)
      setSaveProgress(null)
    }
  }

  const chooseExistingCatalog = (catalog: ExistingCatalog): void => {
    setSelectedCatalog(catalog)
    setSaveMode('update')
    setCatalogName(catalog.catalogName)
    setCatalogId(catalog.catalogId)
    setProvenance(catalog.provenance)
    setLicense(catalog.license)
  }

  const startNewCatalog = (): void => {
    setSelectedCatalog(null)
    setSaveMode('create')
  }

  const cloneCatalogRevision = (): void => {
    if (!selectedCatalog) return
    setSaveMode('clone')
    setCatalogName(`${selectedCatalog.catalogName}-revision`)
    setCatalogId(`${selectedCatalog.catalogId}-revision`)
  }

  const buildCatalog = async (catalogToUpdate?: ExistingCatalog): Promise<void> => {
    const targetCatalog = catalogToUpdate ?? selectedCatalog
    const mode = catalogToUpdate ? 'update' : saveMode
    const effectiveCatalogName = catalogToUpdate?.catalogName ?? catalogName.trim()
    const effectiveCatalogId = catalogToUpdate?.catalogId ?? catalogId.trim()
    const effectiveProvenance = provenance.trim() || catalogToUpdate?.provenance || ''
    const effectiveLicense = license.trim() || catalogToUpdate?.license || ''
    if (
      !catalogParent ||
      !effectiveCatalogName ||
      !effectiveCatalogId ||
      !effectiveProvenance ||
      !effectiveLicense
    ) {
      setError(
        'Catalog ID, catalog name, provenance, license, and a parent directory are required.'
      )
      return
    }
    if ((mode === 'update' || mode === 'clone') && !targetCatalog) {
      setError('Select an existing catalog to update or clone.')
      return
    }
    const candidateIds = [
      ...songs
        .filter((song) => song.midiValid && song.trainingUse === 'allowed')
        .map((song) => song.candidateId),
      ...packageCandidates
        .filter((entry) => selectedPackages.has(entry.candidateId))
        .map((entry) => entry.candidateId)
    ]
    setExporting(true)
    setSaveProgress({ phase: 'normalizing', completed: 0, total: candidateIds.length })
    setError(null)
    setResult(null)
    try {
      const response = await window.api.buildSongSourceCatalog({
        candidateIds,
        parentId: catalogParent.parentId,
        catalogName: effectiveCatalogName,
        catalogId: effectiveCatalogId,
        provenance: effectiveProvenance,
        license: effectiveLicense,
        mode,
        sourceCatalogName: targetCatalog?.catalogName
      })
      const refreshedCatalogs = await window.api.listDatasetCatalogs(catalogParent.parentId)
      setExistingCatalogs(refreshedCatalogs)
      const savedCatalog = refreshedCatalogs.find(
        (catalog) => catalog.catalogName === effectiveCatalogName
      )
      if (!savedCatalog) {
        throw new Error('Catalog build completed without publishing the requested catalog.')
      }
      setResult({
        records: response.recordCount,
        skipped: response.skipped.length
      })
      setSelectedCatalog(savedCatalog)
      setSaveMode('update')
      setActiveStep('prepare')
    } catch {
      setError(
        'Catalog was not published. It may have been interrupted; restart OCTAVE and retry with a new catalog name.'
      )
    } finally {
      setExporting(false)
      setSaveProgress(null)
    }
  }

  const updateCatalog = (
    event: React.MouseEvent<HTMLButtonElement>,
    catalog: ExistingCatalog
  ): void => {
    // The catalog row remains selectable, but Update is a separate action. Keep
    // this explicit so a click can never be interpreted as a row selection or
    // form submission before the update request is started.
    event.preventDefault()
    event.stopPropagation()
    chooseExistingCatalog(catalog)
    void buildCatalog(catalog)
  }

  const enableDeveloperRuntime = async (): Promise<void> => {
    setError(null)
    const runtime = await window.api.enableDeveloperTrainingRuntime()
    if (!runtime?.capabilities.includes('training')) {
      setError('No compatible local STRUM training runtime was found.')
      return
    }
    await refreshTrainingState()
  }

  const prepareDataset = async (): Promise<void> => {
    if (!catalogParent || !selectedCatalog || !selectedPipelineId) return
    setError(null)
    try {
      const started = await window.api.prepareTrainingDataset({
        parentId: catalogParent.parentId,
        catalogId: selectedCatalog.catalogId,
        catalogName: selectedCatalog.catalogName,
        pipelineId: selectedPipelineId,
        splitSeed: trainConfig.seed
      })
      setTrainingJob({
        jobId: started.jobId,
        sequence: 0,
        stage: 'queued',
        state: 'queued',
        progress: 0,
        message: 'Preparing the catalog locally.'
      })
    } catch {
      setError('STRUM could not start catalog preparation.')
    }
  }

  const startTraining = async (): Promise<void> => {
    if (!selectedTaskViewId || !selectedPipelineId) return
    setError(null)
    try {
      const started = await window.api.startTrainingRun({
        taskViewId: selectedTaskViewId,
        pipelineId: selectedPipelineId,
        train: trainConfig
      })
      setTrainingJob({
        jobId: started.jobId,
        sequence: 0,
        stage: 'queued',
        state: 'queued',
        progress: 0,
        message: 'Queuing STRUM training locally.'
      })
    } catch {
      setError('STRUM could not start this training run.')
    }
  }

  const cancelActiveTrainingJob = async (): Promise<void> => {
    if (!trainingJob) return
    await window.api.cancelTrainingJob(trainingJob.jobId)
  }

  const renderCandidate = (candidate: SourceCandidate, selectable: boolean): React.JSX.Element => (
    <label className={!candidate.midiValid ? 'disabled' : ''} key={candidate.candidateId}>
      <input
        type="checkbox"
        checked={
          selectable
            ? selectedPackages.has(candidate.candidateId)
            : candidate.trainingUse === 'allowed'
        }
        disabled={!candidate.midiValid || exporting}
        onChange={() => {
          if (selectable) {
            void togglePackage(candidate)
          } else {
            void toggleSong(candidate)
          }
        }}
      />
      {!selectable && (
        <DatasetArtwork candidateId={candidate.candidateId} label={candidateLabel(candidate)} />
      )}
      <span>
        <strong>{candidateLabel(candidate)}</strong>
        <small>
          {candidate.kind} · {candidate.midiValid ? 'valid MIDI' : 'invalid MIDI'} ·{' '}
          {selectable
            ? candidate.isStrumGenerated
              ? 'STRUM charted · select to explicitly include'
              : 'available for review'
            : candidate.trainingUse.replace('_', ' ')}
          {!selectable && candidate.isStrumGenerated ? ' · STRUM generated' : ''}
          {Object.entries(candidate.instruments)
            .map(([instrument, coverage]) => `${instrument}: ${coverage.difficulties.join('/')}`)
            .join(', ')}
          {candidate.warnings.length
            ? ` · ${candidate.warnings.map((warning) => warning.code).join(', ')}`
            : ''}
        </small>
      </span>
    </label>
  )

  return (
    <div className="dataset-curation-overlay" onClick={onClose}>
      <section
        className="dataset-curation-modal"
        onClick={(event) => event.stopPropagation()}
        aria-modal="true"
        role="dialog"
      >
        <header className="training-header">
          <h2>
            <span aria-hidden="true">🧪</span> Training
          </h2>
          <nav className="training-steps" aria-label="Training steps">
            {TRAINING_STEPS.map((step, index) => {
              const activeStepIndex = TRAINING_STEPS.indexOf(activeStep)
              const blocker =
                step === 'prepare' && !selectedCatalog
                  ? 'Create or select a catalog before preparing a dataset.'
                  : step === 'train' && !selectedCatalog
                    ? 'Select a catalog before training.'
                    : step === 'deploy' && !selectedCatalog
                      ? 'Select a catalog before deployment.'
                      : null
              return (
                <span
                  key={step}
                  className={`training-step ${activeStep === step ? 'active' : index < activeStepIndex ? 'complete' : ''}${blocker ? ' blocked' : ''}`}
                  aria-describedby={blocker ? `${step}-blocker` : undefined}
                  tabIndex={blocker ? 0 : undefined}
                >
                  <button
                    className={
                      activeStep === step ? 'active' : index < activeStepIndex ? 'complete' : ''
                    }
                    disabled={blocker !== null}
                    onClick={() => setActiveStep(step)}
                  >
                    <span className="training-step-orb" aria-hidden="true">
                      <TrainingStepIcon step={step} complete={index < activeStepIndex} />
                    </span>
                    <span className="training-step-label">{step}</span>
                  </button>
                  {blocker && (
                    <span className="training-step-blocker" id={`${step}-blocker`} role="tooltip">
                      {blocker}
                    </span>
                  )}
                </span>
              )
            })}
          </nav>
          <button className="dataset-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>
        <main>
          <p className="training-step-summary">{TRAINING_STEP_TAGLINES[activeStep]}</p>
          {error && <p className="dataset-message error">{error}</p>}
          {result && (
            <p className="dataset-message success">
              Created {result.records} allowed catalog records; skipped {result.skipped}.
            </p>
          )}
          {scanningPackages && (
            <p className="dataset-message progress" aria-live="polite">
              {scanProgress?.phase === 'discovering'
                ? `Finding packages — checked ${scanProgress.completed} folders.`
                : `Scanning selected sources — ${scanProgress?.completed ?? 0} of ${scanProgress?.total ?? '?'}.`}{' '}
              You can close this window while OCTAVE checks each package.
            </p>
          )}
          {exporting && (
            <p className="dataset-message progress" aria-live="polite">
              Saving catalog — {saveProgress?.phase ?? 'preparing'} {saveProgress?.completed ?? 0}{' '}
              of {saveProgress?.total ?? '?'}.
            </p>
          )}
          {activeStep === 'learn' ? (
            <section className="training-learn">
              <div className="training-learn-intro">
                <h3>
                  <span className="dataset-heading-icon" aria-hidden="true">
                    ✦
                  </span>{' '}
                  Train thoughtfully
                </h3>
                <p>
                  Training turns a catalog of approved songs into local STRUM checkpoints. OCTAVE
                  keeps the catalog, task views, and eventual profiles as local inputs and outputs.
                </p>
              </div>
              <div className="training-learn-runtime">
                <span
                  className={`training-runtime-dot ${trainingRuntime?.capabilities.includes('training') ? 'ready' : ''}`}
                  aria-hidden="true"
                />
                <div>
                  <strong>
                    {trainingRuntime?.displayName ?? 'Checking your local STRUM runtime…'}
                  </strong>
                  <small>
                    {trainingRuntime
                      ? `${trainingRuntime.capabilities.includes('training') ? 'Training available' : 'Inference only'} · ${trainingRuntime.deviceSupport.join(', ').toUpperCase()} · all artifacts remain local`
                      : 'OCTAVE checks the runtime before it enables any training step.'}
                  </small>
                </div>
              </div>
              <ol className="training-learn-path">
                {TRAINING_STEP_DETAILS.map((detail, index) => (
                  <li key={detail.step}>
                    <span aria-hidden="true">{index + 1}</span>
                    <div>
                      <strong>{detail.title}</strong>
                      <p>{detail.description}</p>
                    </div>
                  </li>
                ))}
              </ol>
              <aside className="training-use-notice">
                <strong>Personal and offline use</strong>
                <p>
                  Only train with music you own or have clear permission to use. Keep trained models
                  offline, and do not share them unless every training input is music you own.
                </p>
              </aside>
            </section>
          ) : activeStep === 'curate' ? (
            <>
              <section className="dataset-section dataset-details">
                <h3>
                  <span className="dataset-heading-icon" aria-hidden="true">
                    📚
                  </span>{' '}
                  Catalog editor
                </h3>
                <label className="dataset-catalog-parent">
                  Catalog parent
                  <div className="dataset-output">
                    <input
                      value={catalogParent?.path ?? catalogParent?.name ?? ''}
                      readOnly
                      placeholder="Preparing Catalog Parent"
                    />
                    <button onClick={() => void chooseCatalogParent()} disabled={exporting}>
                      <span aria-hidden="true">📁</span> Choose
                    </button>
                  </div>
                </label>
                <div className="dataset-catalog-picker">
                  <div className="dataset-section-actions">
                    <button onClick={startNewCatalog} disabled={exporting}>
                      <span aria-hidden="true">＋</span> New catalog
                    </button>
                    {saveMode === 'create' && (
                      <button onClick={() => void buildCatalog()} disabled={exporting}>
                        <span aria-hidden="true">↗</span> Create catalog
                      </button>
                    )}
                    {saveMode === 'clone' && (
                      <button onClick={() => void buildCatalog()} disabled={exporting}>
                        <span aria-hidden="true">⎇</span> Create revision
                      </button>
                    )}
                    {selectedCatalog && (
                      <button onClick={cloneCatalogRevision} disabled={exporting}>
                        <span aria-hidden="true">⎇</span> Clone as revision
                      </button>
                    )}
                  </div>
                  {existingCatalogs.map((catalog) => {
                    const isSelected = selectedCatalog?.catalogName === catalog.catalogName
                    return (
                      <div
                        className={`dataset-catalog-row${isSelected ? ' selected' : ''}`}
                        key={catalog.catalogName}
                      >
                        <button
                          className="dataset-catalog-select"
                          onClick={() => chooseExistingCatalog(catalog)}
                          disabled={exporting}
                        >
                          <strong>{catalog.catalogName}</strong>
                          <small>
                            {catalog.recordCount} records · {catalog.libraryRecordCount} library ·{' '}
                            {catalog.externalRecordCount} external
                          </small>
                        </button>
                        {isSelected && saveMode === 'update' && (
                          <button
                            type="button"
                            className="dataset-catalog-update"
                            onClick={(event) => updateCatalog(event, catalog)}
                            disabled={exporting}
                          >
                            {exporting ? 'Updating…' : 'Update'}
                          </button>
                        )}
                      </div>
                    )
                  })}
                </div>
                {saveMode === 'update' && selectedCatalog?.externalRecordCount ? (
                  <p className="dataset-message warning">
                    This catalog contains {selectedCatalog.externalRecordCount} package-backed
                    records. Updates retain them; removing them requires a separate confirmed
                    action.
                  </p>
                ) : null}
                <div className="dataset-editor-fields">
                  <label>
                    Catalog ID
                    <input
                      value={catalogId}
                      onChange={(event) => setCatalogId(event.target.value)}
                      disabled={exporting || saveMode === 'update'}
                    />
                  </label>
                  <label>
                    License / permission basis
                    <input
                      placeholder="e.g. CC BY 4.0 or internal consent record"
                      value={license}
                      onChange={(event) => setLicense(event.target.value)}
                      disabled={exporting}
                    />
                  </label>
                  <label>
                    Catalog name
                    <input
                      value={catalogName}
                      onChange={(event) => setCatalogName(event.target.value)}
                      disabled={exporting || saveMode === 'update'}
                    />
                  </label>
                  <label>
                    Provenance
                    <input
                      value={provenance}
                      onChange={(event) => setProvenance(event.target.value)}
                      disabled={exporting}
                    />
                  </label>
                </div>
              </section>
              <section className="dataset-section">
                <div className="dataset-section-heading">
                  <div>
                    <h3>
                      <span className="dataset-heading-icon" aria-hidden="true">
                        🎵
                      </span>{' '}
                      Octave library
                    </h3>
                    <p>
                      STRUM-generated songs require explicit consent. Checking a reviewed song
                      stores explicit consent in <code>song.ini</code>.
                    </p>
                  </div>
                  <div className="dataset-section-actions">
                    <button
                      onClick={() => void toggleAllLibrarySongs()}
                      disabled={loading || exporting || selectableLibrarySongs.length === 0}
                    >
                      <span aria-hidden="true">{allLibrarySongsSelected ? '−' : '✓'}</span>{' '}
                      {allLibrarySongsSelected ? 'Clear all' : 'Select all'}
                    </button>
                    <button onClick={() => void refreshLibrary()} disabled={loading || exporting}>
                      <span className={loading ? 'dataset-spin' : ''} aria-hidden="true">
                        ↻
                      </span>{' '}
                      {loading ? 'Refreshing…' : 'Refresh'}
                    </button>
                  </div>
                </div>
                <div className="dataset-song-list">
                  {loading ? (
                    <div className="dataset-library-loading" aria-live="polite">
                      <span className="dataset-loading-orbit" aria-hidden="true" />
                      <strong>Refreshing your library</strong>
                      <small>Finding songs, artwork, and saved curation consent…</small>
                    </div>
                  ) : (
                    songs.map((song) => renderCandidate(song, false))
                  )}
                  {!loading && songs.length === 0 && (
                    <p className="dataset-empty">
                      Open an Octave song library to curate its songs.
                    </p>
                  )}
                </div>
              </section>
              <section className="dataset-section">
                <div className="dataset-section-heading">
                  <div>
                    <h3>
                      <span className="dataset-heading-icon" aria-hidden="true">
                        📦
                      </span>{' '}
                      Additional packages
                    </h3>
                    <p>
                      Choose folders containing <code>.sng</code>, <code>.con</code>,{' '}
                      <code>.rb3con</code>, or <code>.zip</code>. OCTAVE parses and normalizes them
                      in the main process; this UI receives no source locations.
                    </p>
                  </div>
                  <button
                    aria-label={scanningPackages ? 'Scanning package folder' : 'Add package folder'}
                    className="dataset-icon-button"
                    onClick={() => void addPackageFolder()}
                    disabled={exporting || scanningPackages}
                    title={scanningPackages ? 'Scanning package folder' : 'Add package folder'}
                  >
                    <span className={scanningPackages ? 'dataset-spin' : ''} aria-hidden="true">
                      {scanningPackages ? '↻' : '＋'}
                    </span>
                  </button>
                </div>
                <div className="dataset-package-list">
                  {packageGroups.map((group) => (
                    <section className="dataset-package-group" key={group.groupId}>
                      <header>
                        <div>
                          <strong>{group.groupName}</strong>
                          <small>
                            {group.candidates.length} songs
                            {group.strumGeneratedCount
                              ? ` · ${group.strumGeneratedCount} STRUM-charted; select individually to include`
                              : ''}
                          </small>
                        </div>
                        <button
                          onClick={() => void removePackageGroup(group)}
                          disabled={exporting || scanningPackages}
                        >
                          Remove
                        </button>
                      </header>
                      {group.candidates.map((entry) => renderCandidate(entry, true))}
                    </section>
                  ))}
                  {!scanningPackages && packageGroups.length === 0 && (
                    <p className="dataset-empty">No additional package folders selected.</p>
                  )}
                </div>
              </section>
            </>
          ) : activeStep === 'prepare' ? (
            <section className="training-step-panel">
              <div className="training-panel-heading">
                <div>
                  <h3>Prepare a task view</h3>
                  <p>
                    STRUM revalidates approved catalog assets, assigns song-disjoint splits, and
                    creates an immutable Guitar task view. Original packages stay out of the run.
                  </p>
                </div>
                {trainingJob &&
                  !['succeeded', 'failed', 'cancelled'].includes(trainingJob.state ?? '') && (
                    <button
                      className="dataset-secondary"
                      onClick={() => void cancelActiveTrainingJob()}
                    >
                      Cancel job
                    </button>
                  )}
              </div>
              <div className="training-runtime-card">
                <span
                  className={`training-runtime-dot ${trainingRuntime?.capabilities.includes('training') ? 'ready' : ''}`}
                  aria-hidden="true"
                />
                <div>
                  <strong>{trainingRuntime?.displayName ?? 'Checking STRUM runtime…'}</strong>
                  <small>
                    {trainingRuntime
                      ? `${trainingRuntime.kind.replace('_', ' ')} · protocol ${trainingRuntime.protocolVersion}${trainingRuntime.sourceRevision ? ` · ${trainingRuntime.sourceRevision}` : ''}`
                      : 'Validating the local runtime.'}
                  </small>
                </div>
                {trainingRuntime?.trainingSetupRequired && (
                  <button
                    className="dataset-secondary"
                    onClick={() => void enableDeveloperRuntime()}
                  >
                    Enable developer override
                  </button>
                )}
              </div>
              {trainingRuntime?.kind === 'developer_override' && (
                <p className="training-inline-note training-runtime-warning">
                  Developer override: OCTAVE will run this local STRUM checkout. Use it only for a
                  checkout you control; release installs do not enable it automatically.
                </p>
              )}
              {!selectedCatalog ? (
                <p className="dataset-message warning">
                  Select a catalog in Curate before preparing a task view.
                </p>
              ) : !trainingRuntime?.capabilities.includes('training') ? (
                <p className="dataset-message warning">
                  This runtime is inference-only. Training requires an explicitly enabled developer
                  override or a future verified STRUM training runtime.
                </p>
              ) : (
                <>
                  <label className="training-control">
                    Pipeline
                    <select
                      value={selectedPipelineId}
                      onChange={(event) => setSelectedPipelineId(event.target.value)}
                    >
                      {trainingPipelines.map((pipeline) => (
                        <option key={pipeline.id} value={pipeline.id}>
                          {pipeline.display_name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="training-inspection-grid">
                    <div>
                      <span>Catalog</span>
                      <strong>{selectedCatalog.catalogName}</strong>
                    </div>
                    <div>
                      <span>Eligible Guitar songs</span>
                      <strong>{catalogInspection?.eligibleCount ?? 'Checking…'}</strong>
                    </div>
                    <div>
                      <span>Audio policy</span>
                      <strong>{catalogInspection?.audioPolicy ?? 'Prefer Guitar, then mix'}</strong>
                    </div>
                    <div>
                      <span>Split</span>
                      <strong>Song-disjoint · seed {trainConfig.seed}</strong>
                    </div>
                  </div>
                  {catalogInspection &&
                    Object.values(catalogInspection.excluded).some((count) => count > 0) && (
                      <p className="training-inline-note">
                        {Object.values(catalogInspection.excluded).reduce(
                          (sum, count) => sum + count,
                          0
                        )}{' '}
                        records are excluded because they are missing Guitar Expert labels, approved
                        audio, or a verified asset.
                      </p>
                    )}
                  <button
                    className="dataset-primary"
                    onClick={() => void prepareDataset()}
                    disabled={
                      !catalogInspection?.eligibleCount ||
                      Boolean(
                        trainingJob &&
                        !['succeeded', 'failed', 'cancelled'].includes(trainingJob.state ?? '')
                      )
                    }
                  >
                    Prepare Guitar Dataset <span aria-hidden="true">→</span>
                  </button>
                </>
              )}
              {trainingTasks.length > 0 && (
                <div className="training-artifact-list">
                  <h4>Prepared task views</h4>
                  {trainingTasks.map((task) => (
                    <button
                      className={selectedTaskViewId === task.taskViewId ? 'selected' : ''}
                      key={task.taskViewId}
                      onClick={() => setSelectedTaskViewId(task.taskViewId)}
                    >
                      <span>
                        <strong>{task.catalogName}</strong>
                        <small>{task.eligibleCount} Guitar records · immutable task view</small>
                      </span>
                      <span aria-hidden="true">
                        {selectedTaskViewId === task.taskViewId ? '✓' : '○'}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </section>
          ) : activeStep === 'train' ? (
            <section className="training-step-panel">
              <div className="training-panel-heading">
                <div>
                  <h3>Train Guitar locally</h3>
                  <p>
                    A fresh two-stage run trains onset and fret components from the selected task
                    view. Metrics, task identity, configuration, and checkpoint hashes are recorded
                    locally.
                  </p>
                </div>
                {trainingJob &&
                  !['succeeded', 'failed', 'cancelled'].includes(trainingJob.state ?? '') && (
                    <button
                      className="dataset-secondary"
                      onClick={() => void cancelActiveTrainingJob()}
                    >
                      Cancel job
                    </button>
                  )}
              </div>
              {trainingTasks.length === 0 ? (
                <p className="dataset-message warning">
                  Prepare a Guitar task view before starting training.
                </p>
              ) : (
                <>
                  <label className="training-control">
                    Prepared task view
                    <select
                      value={selectedTaskViewId}
                      onChange={(event) => setSelectedTaskViewId(event.target.value)}
                    >
                      {trainingTasks.map((task) => (
                        <option key={task.taskViewId} value={task.taskViewId}>
                          {task.catalogName} · {task.eligibleCount} Guitar songs
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="training-config-grid">
                    <label>
                      Epochs
                      <input
                        type="number"
                        min="1"
                        max="500"
                        value={trainConfig.epochs}
                        onChange={(event) =>
                          setTrainConfig((current) => ({
                            ...current,
                            epochs: Number(event.target.value) || 1
                          }))
                        }
                      />
                    </label>
                    <label>
                      Batch size
                      <input
                        type="number"
                        min="1"
                        max="256"
                        value={trainConfig.batchSize}
                        onChange={(event) =>
                          setTrainConfig((current) => ({
                            ...current,
                            batchSize: Number(event.target.value) || 1
                          }))
                        }
                      />
                    </label>
                    <label>
                      Device
                      <select
                        value={trainConfig.device}
                        onChange={(event) =>
                          setTrainConfig((current) => ({ ...current, device: event.target.value }))
                        }
                      >
                        <option value="auto">Auto</option>
                        <option value="cuda">CUDA</option>
                        <option value="mps">Apple Silicon</option>
                        <option value="cpu">CPU</option>
                      </select>
                    </label>
                    <label>
                      Seed
                      <input
                        type="number"
                        value={trainConfig.seed}
                        onChange={(event) =>
                          setTrainConfig((current) => ({
                            ...current,
                            seed: Number(event.target.value) || 1
                          }))
                        }
                      />
                    </label>
                  </div>
                  <p className="training-inline-note">
                    Runs are local and resumability is intentionally disabled until STRUM validates
                    parent checkpoint compatibility.
                  </p>
                  <button
                    className="dataset-primary"
                    onClick={() => void startTraining()}
                    disabled={Boolean(
                      trainingJob &&
                      !['succeeded', 'failed', 'cancelled'].includes(trainingJob.state ?? '')
                    )}
                  >
                    Start local Guitar run <span aria-hidden="true">⚡</span>
                  </button>
                </>
              )}
              {trainingRuns.length > 0 && (
                <div className="training-artifact-list">
                  <h4>Recent runs</h4>
                  {trainingRuns.map((run) => (
                    <div key={run.runId}>
                      <span>
                        <strong>{run.pipelineId}</strong>
                        <small>
                          {run.checkpointCount} required components ·{' '}
                          {run.deployable ? 'deployment-ready' : 'experiment only'}
                        </small>
                      </span>
                      <span
                        className={
                          run.deployable ? 'training-status-ready' : 'training-status-neutral'
                        }
                      >
                        {run.deployable ? 'Ready' : 'Review'}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </section>
          ) : (
            <section className="training-step-panel training-deploy-panel">
              <h3>Deploy a validated profile</h3>
              <p>
                OCTAVE only offers checkpoint bundles that STRUM has inspected, hash-validated, and
                declared compatible with the selected local Auto Chart runtime. The shipped profile
                remains the fallback.
              </p>
              {trainingRuns.length === 0 ? (
                <p className="dataset-message warning">
                  A completed training run is required before deployment can be evaluated.
                </p>
              ) : trainingRuns.some((run) => run.deployable) ? (
                <p className="dataset-message success">
                  A compatible checkpoint bundle is available for local profile validation.
                </p>
              ) : (
                <aside className="training-deploy-blocked">
                  <strong>Deployment safely blocked</strong>
                  <p>
                    The current Guitar compatibility adapter produces experiment checkpoints, not a
                    validated OCTAVE Auto Chart model bundle. They remain available for local
                    evaluation and are never selected automatically.
                  </p>
                </aside>
              )}
              <button className="dataset-primary" disabled>
                Save as Auto Chart default
              </button>
            </section>
          )}
        </main>
        <footer className={activeStep === 'learn' ? 'training-learn-footer' : undefined}>
          {activeStep === 'learn' ? (
            <button className="dataset-primary" onClick={() => setActiveStep('curate')}>
              I understand — Start Curating <span aria-hidden="true">→</span>
            </button>
          ) : activeStep === 'curate' ? (
            <>
              <span>
                {allowedLibrarySongs.length} library records allowed; {selectedPackages.size}{' '}
                package sources reviewed
              </span>
              <button
                className="dataset-primary"
                onClick={() => setActiveStep('prepare')}
                disabled={exporting || !selectedCatalog}
                title={
                  selectedCatalog
                    ? 'Prepare the selected catalog'
                    : 'Select a catalog to prepare a dataset'
                }
              >
                Prepare Dataset <span aria-hidden="true">→</span>
              </button>
            </>
          ) : (
            <>
              <span>
                {trainingJob &&
                !['succeeded', 'failed', 'cancelled'].includes(trainingJob.state ?? '')
                  ? `${trainingJob.message}${typeof trainingJob.progress === 'number' ? ` · ${Math.round(trainingJob.progress * 100)}%` : ''}`
                  : 'STRUM jobs continue locally when this window is closed.'}
              </span>
              <button className="dataset-primary" onClick={() => setActiveStep('curate')}>
                Back to Curate
              </button>
            </>
          )}
        </footer>
      </section>
    </div>
  )
}
