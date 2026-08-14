import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
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
export type TrainingStep = 'curate' | 'prepare' | 'train'

export type TrainingActivity = {
  step: TrainingStep
  phase: string
  completed: number
  total: number
}

type ExistingCatalog = {
  catalogName: string
  catalogId: string
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

const CATALOG_PARENT_STORAGE_KEY = 'octave.datasetCatalogParent'

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
  const [activeStep, setActiveStep] = useState<TrainingStep>('curate')
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
    const unsubscribeScan = window.api.onDatasetScanProgress(setScanProgress)
    const unsubscribeSave = window.api.onDatasetSaveProgress(setSaveProgress)
    return () => {
      unsubscribeScan()
      unsubscribeSave()
    }
  }, [])

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
    onActivityChange(null)
  }, [exporting, onActivityChange, saveProgress, scanProgress, scanningPackages])

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

  const buildCatalog = async (): Promise<void> => {
    if (
      !catalogParent ||
      !catalogName.trim() ||
      !catalogId.trim() ||
      !provenance.trim() ||
      !license.trim()
    ) {
      setError(
        'Catalog ID, catalog name, provenance, license, and a parent directory are required.'
      )
      return
    }
    if ((saveMode === 'update' || saveMode === 'clone') && !selectedCatalog) {
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
        catalogName: catalogName.trim(),
        catalogId: catalogId.trim(),
        provenance: provenance.trim(),
        license: license.trim(),
        mode: saveMode,
        sourceCatalogName: selectedCatalog?.catalogName
      })
      const refreshedCatalogs = await window.api.listDatasetCatalogs(catalogParent.parentId)
      setExistingCatalogs(refreshedCatalogs)
      const savedCatalog = refreshedCatalogs.find(
        (catalog) => catalog.catalogName === catalogName.trim()
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
        <header>
          <div>
            <h2>
              <span aria-hidden="true">🧪</span> Training
            </h2>
            <p>Curate approved sources, prepare a training view, then run STRUM.</p>
          </div>
          <button className="dataset-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>
        <nav className="training-steps" aria-label="Training steps">
          {(['curate', 'prepare', 'train'] as const).map((step, index) => {
            const activeStepIndex = ['curate', 'prepare', 'train'].indexOf(activeStep)
            const available =
              step === 'curate' ||
              (step === 'prepare' && selectedCatalog !== null) ||
              (step === 'train' && selectedCatalog !== null)
            return (
              <Fragment key={step}>
                <button
                  className={
                    activeStep === step ? 'active' : index < activeStepIndex ? 'complete' : ''
                  }
                  disabled={!available}
                  onClick={() => setActiveStep(step)}
                >
                  <span className="training-step-orb" aria-hidden="true">
                    <TrainingStepIcon step={step} complete={index < activeStepIndex} />
                  </span>
                  <span className="training-step-label">{step}</span>
                </button>
                {index < 2 && <span className="training-step-connector" aria-hidden="true" />}
              </Fragment>
            )
          })}
        </nav>
        <main>
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
          {activeStep === 'curate' ? (
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
                    {selectedCatalog && (
                      <button onClick={cloneCatalogRevision} disabled={exporting}>
                        <span aria-hidden="true">⎇</span> Clone as revision
                      </button>
                    )}
                  </div>
                  {existingCatalogs.map((catalog) => (
                    <button
                      className={
                        selectedCatalog?.catalogName === catalog.catalogName ? 'selected' : ''
                      }
                      key={catalog.catalogName}
                      onClick={() => chooseExistingCatalog(catalog)}
                      disabled={exporting}
                    >
                      <strong>{catalog.catalogName}</strong>
                      <small>
                        {catalog.recordCount} records · {catalog.libraryRecordCount} library ·{' '}
                        {catalog.externalRecordCount} external
                      </small>
                    </button>
                  ))}
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
              <h3>Prepare</h3>
              <p>
                OCTAVE will create a STRUM task view from the selected catalog without reopening
                original packages. Catalog assets and rights remain the only inputs.
              </p>
              {selectedCatalog ? (
                <dl>
                  <div>
                    <dt>Catalog</dt>
                    <dd>{selectedCatalog.catalogName}</dd>
                  </div>
                  <div>
                    <dt>Records</dt>
                    <dd>{selectedCatalog.recordCount}</dd>
                  </div>
                </dl>
              ) : (
                <p>Save or select a catalog in Curate before preparing a training view.</p>
              )}
              <button className="dataset-primary" onClick={() => setActiveStep('train')}>
                Continue to Train
              </button>
            </section>
          ) : (
            <section className="training-step-panel">
              <h3>Train</h3>
              <p>
                Training runs will use the prepared catalog view and record only catalog IDs and
                hashes. STRUM run configuration will be added here next.
              </p>
              <button className="dataset-primary" disabled>
                Training configuration coming next
              </button>
            </section>
          )}
        </main>
        <footer>
          {activeStep === 'curate' ? (
            <>
              <span>
                {allowedLibrarySongs.length} library records allowed; {selectedPackages.size}{' '}
                package sources reviewed
              </span>
              <button
                className="dataset-primary"
                onClick={() => void buildCatalog()}
                disabled={exporting}
              >
                {exporting
                  ? 'Saving…'
                  : saveMode === 'update'
                    ? 'Update catalog'
                    : saveMode === 'clone'
                      ? 'Clone catalog revision'
                      : 'Build source catalog'}{' '}
                <span aria-hidden="true">→</span>
              </button>
            </>
          ) : (
            <>
              <span>Visual mock — this step will support background jobs when configured.</span>
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
