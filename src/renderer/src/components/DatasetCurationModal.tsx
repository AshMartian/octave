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

type ExistingCatalog = {
  catalogName: string
  catalogId: string
  recordCount: number
  libraryRecordCount: number
  externalRecordCount: number
}

const CATALOG_PARENT_STORAGE_KEY = 'octave.datasetCatalogParent'

function candidateLabel(candidate: SourceCandidate): string {
  const artist = candidate.metadata.artist
  const name = candidate.metadata.name
  return artist && name ? `${artist} — ${name}` : `${candidate.kind} source`
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

export function DatasetCurationModal({
  isOpen,
  onClose
}: {
  isOpen: boolean
  onClose: () => void
}): React.JSX.Element | null {
  const [songs, setSongs] = useState<SourceCandidate[]>([])
  const [packages, setPackages] = useState<SourceCandidate[]>([])
  const [selectedPackages, setSelectedPackages] = useState<Set<string>>(new Set())
  const [catalogParent, setCatalogParent] = useState<{ parentId: string; name: string } | null>(
    null
  )
  const [existingCatalogs, setExistingCatalogs] = useState<ExistingCatalog[]>([])
  const [selectedCatalog, setSelectedCatalog] = useState<ExistingCatalog | null>(null)
  const [saveMode, setSaveMode] = useState<CatalogSaveMode>('create')
  const [catalogName, setCatalogName] = useState('octave-curated-catalog')
  const [catalogId, setCatalogId] = useState('octave-curated-dataset')
  const [provenance, setProvenance] = useState('Curated in Octave')
  const [license, setLicense] = useState('')
  const [loading, setLoading] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{
    records: number
    reviewRequired: number
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
    if (!isOpen || catalogParent) return
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

  const allowedLibrarySongs = useMemo(
    () => songs.filter((song) => song.trainingUse === 'allowed' && song.midiValid),
    [songs]
  )

  const selectableLibrarySongs = useMemo(() => songs.filter((song) => song.midiValid), [songs])
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
    const discovered = await window.api.chooseDatasetPackageFolder()
    setPackages((current) => [...current, ...discovered])
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
    setExporting(true)
    setError(null)
    setResult(null)
    try {
      const response = await window.api.buildSongSourceCatalog({
        candidateIds: [
          ...songs
            .filter((song) => song.midiValid && song.trainingUse === 'allowed')
            .map((song) => song.candidateId),
          ...packages
            .filter((entry) => selectedPackages.has(entry.candidateId))
            .map((entry) => entry.candidateId)
        ],
        parentId: catalogParent.parentId,
        catalogName: catalogName.trim(),
        catalogId: catalogId.trim(),
        provenance: provenance.trim(),
        license: license.trim(),
        mode: saveMode,
        sourceCatalogName: selectedCatalog?.catalogName
      })
      setResult({
        records: response.recordCount,
        reviewRequired: response.reviewRequiredCount,
        skipped: response.skipped.length
      })
    } catch {
      setError('Catalog build failed. Check the catalog name and choose a new destination.')
    } finally {
      setExporting(false)
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
          {candidate.trainingUse.replace('_', ' ')}
          {candidate.isStrumGenerated ? ' · STRUM generated' : ''}
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
    <div className="dataset-curation-overlay" onClick={() => !exporting && onClose()}>
      <section
        className="dataset-curation-modal"
        onClick={(event) => event.stopPropagation()}
        aria-modal="true"
        role="dialog"
      >
        <header>
          <div>
            <h2>Dataset Curation</h2>
            <p>
              Review source summaries and rights; OCTAVE builds the normalized catalog for STRUM.
            </p>
          </div>
          <button
            className="dataset-close"
            onClick={onClose}
            disabled={exporting}
            aria-label="Close"
          >
            ×
          </button>
        </header>
        <main>
          {error && <p className="dataset-message error">{error}</p>}
          {result && (
            <p className="dataset-message success">
              Created {result.records} catalog records ({result.reviewRequired} review required);
              skipped {result.skipped}.
            </p>
          )}
          <section className="dataset-section dataset-details">
            <h3>Catalog editor</h3>
            <label>
              Catalog parent
              <div className="dataset-output">
                <input
                  value={catalogParent?.name ?? ''}
                  readOnly
                  placeholder="Preparing Catalog Parent"
                />
                <button onClick={() => void chooseCatalogParent()} disabled={exporting}>
                  Choose
                </button>
              </div>
            </label>
            <div className="dataset-catalog-picker">
              <div className="dataset-section-actions">
                <button onClick={startNewCatalog} disabled={exporting}>
                  New catalog
                </button>
                {selectedCatalog && (
                  <button onClick={cloneCatalogRevision} disabled={exporting}>
                    Clone as revision
                  </button>
                )}
              </div>
              {existingCatalogs.map((catalog) => (
                <button
                  className={selectedCatalog?.catalogName === catalog.catalogName ? 'selected' : ''}
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
                This catalog contains {selectedCatalog.externalRecordCount} package-backed records.
                Updates retain them; removing them requires a separate confirmed action.
              </p>
            ) : null}
            <label>
              Catalog ID
              <input
                value={catalogId}
                onChange={(event) => setCatalogId(event.target.value)}
                disabled={exporting || saveMode === 'update'}
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
            <label>
              License / permission basis
              <input
                placeholder="e.g. CC BY 4.0 or internal consent record"
                value={license}
                onChange={(event) => setLicense(event.target.value)}
                disabled={exporting}
              />
            </label>
          </section>
          <section className="dataset-section">
            <div className="dataset-section-heading">
              <div>
                <h3>Octave library</h3>
                <p>
                  STRUM-generated songs begin as <code>review_required</code>. Checking a reviewed
                  song stores explicit consent in <code>song.ini</code>.
                </p>
              </div>
              <div className="dataset-section-actions">
                <button
                  onClick={() => void toggleAllLibrarySongs()}
                  disabled={loading || exporting || selectableLibrarySongs.length === 0}
                >
                  {allLibrarySongsSelected ? 'Clear all' : 'Select all'}
                </button>
                <button onClick={() => void refreshLibrary()} disabled={loading || exporting}>
                  Refresh
                </button>
              </div>
            </div>
            <div className="dataset-song-list">
              {songs.map((song) => renderCandidate(song, false))}
              {!loading && songs.length === 0 && (
                <p className="dataset-empty">Open an Octave song library to curate its songs.</p>
              )}
            </div>
          </section>
          <section className="dataset-section">
            <div className="dataset-section-heading">
              <div>
                <h3>Additional packages</h3>
                <p>
                  Choose folders containing <code>.sng</code>, <code>.con</code>,{' '}
                  <code>.rb3con</code>, or <code>.zip</code>. OCTAVE parses and normalizes them in
                  the main process; this UI receives no source locations.
                </p>
              </div>
              <button onClick={() => void addPackageFolder()} disabled={exporting}>
                Add folder
              </button>
            </div>
            <div className="dataset-package-list">
              {packages.map((entry) => renderCandidate(entry, true))}
            </div>
          </section>
        </main>
        <footer>
          <span>
            {allowedLibrarySongs.length} library records allowed; {selectedPackages.size} package
            sources reviewed
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
                  : 'Build source catalog'}
          </button>
        </footer>
      </section>
    </div>
  )
}
