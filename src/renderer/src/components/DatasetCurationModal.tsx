import { useCallback, useEffect, useMemo, useState } from 'react'
import './DatasetCurationModal.css'

type SourceCandidate = {
  candidateId: string
  kind: 'octave-library' | 'sng' | 'rb3con'
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

function candidateLabel(candidate: SourceCandidate): string {
  const artist = candidate.metadata.artist
  const name = candidate.metadata.name
  return artist && name ? `${artist} — ${name}` : `${candidate.kind} source`
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

  const allowedLibrarySongs = useMemo(
    () => songs.filter((song) => song.trainingUse === 'allowed' && song.midiValid),
    [songs]
  )

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

  const addPackageFolder = async (): Promise<void> => {
    const discovered = await window.api.chooseDatasetPackageFolder()
    setPackages((current) => [...current, ...discovered])
    setSelectedPackages(
      (current) => new Set([...current, ...discovered.map((entry) => entry.candidateId)])
    )
  }

  const chooseCatalogParent = async (): Promise<void> => {
    const selected = await window.api.chooseDatasetCatalogParent()
    if (selected) setCatalogParent(selected)
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
    setExporting(true)
    setError(null)
    setResult(null)
    try {
      const response = await window.api.buildSongSourceCatalog({
        candidateIds: [
          ...songs.filter((song) => song.midiValid).map((song) => song.candidateId),
          ...packages
            .filter((entry) => selectedPackages.has(entry.candidateId))
            .map((entry) => entry.candidateId)
        ],
        parentId: catalogParent.parentId,
        catalogName: catalogName.trim(),
        catalogId: catalogId.trim(),
        provenance: provenance.trim(),
        license: license.trim()
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
            setSelectedPackages((current) => {
              const next = new Set(current)
              next.has(candidate.candidateId)
                ? next.delete(candidate.candidateId)
                : next.add(candidate.candidateId)
              return next
            })
          } else {
            void toggleSong(candidate)
          }
        }}
      />
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
          <section className="dataset-section">
            <div className="dataset-section-heading">
              <div>
                <h3>Octave library</h3>
                <p>
                  STRUM-generated songs begin as <code>review_required</code>. Checking a reviewed
                  song stores explicit consent in <code>song.ini</code>.
                </p>
              </div>
              <button onClick={() => void refreshLibrary()} disabled={loading || exporting}>
                Refresh
              </button>
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
                  Choose folders containing <code>.sng</code>, <code>.con</code>, or{' '}
                  <code>.rb3con</code>. OCTAVE parses and normalizes them in the main process; this
                  UI receives no source locations.
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
          <section className="dataset-section dataset-details">
            <h3>New source catalog</h3>
            <label>
              Catalog ID
              <input
                value={catalogId}
                onChange={(event) => setCatalogId(event.target.value)}
                disabled={exporting}
              />
            </label>
            <label>
              Catalog name
              <input
                value={catalogName}
                onChange={(event) => setCatalogName(event.target.value)}
                disabled={exporting}
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
            <label>
              Catalog parent
              <div className="dataset-output">
                <input
                  value={catalogParent?.name ?? ''}
                  readOnly
                  placeholder="Choose a parent directory"
                />
                <button onClick={() => void chooseCatalogParent()} disabled={exporting}>
                  Choose
                </button>
              </div>
            </label>
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
            {exporting ? 'Building…' : 'Build source catalog'}
          </button>
        </footer>
      </section>
    </div>
  )
}
