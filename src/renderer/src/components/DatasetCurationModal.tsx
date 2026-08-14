import { useCallback, useEffect, useMemo, useState } from 'react'
import { getSongStore, useProjectStore } from '../stores'
import './DatasetCurationModal.css'

type LibrarySong = {
  path: string
  name: string
  artist: string
  charter?: string
  datasetOptIn: boolean
  isStrumGenerated: boolean
  hasNotesMidi: boolean
}

type PackageFile = { path: string; name: string }

export function DatasetCurationModal({
  isOpen,
  onClose
}: {
  isOpen: boolean
  onClose: () => void
}): React.JSX.Element | null {
  const activeSongId = useProjectStore((state) => state.activeSongId)
  const [songs, setSongs] = useState<LibrarySong[]>([])
  const [packages, setPackages] = useState<PackageFile[]>([])
  const [selectedPackages, setSelectedPackages] = useState<Set<string>>(new Set())
  const [outputDir, setOutputDir] = useState('')
  const [datasetId, setDatasetId] = useState('octave-curated-dataset')
  const [provenance, setProvenance] = useState('Curated in Octave')
  const [license, setLicense] = useState('')
  const [loading, setLoading] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{
    exported: number
    skipped: number
    manifestPath: string
  } | null>(null)

  const refreshLibrary = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      setSongs(await window.api.scanDatasetLibrary())
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not scan the current library.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (isOpen) void refreshLibrary()
  }, [isOpen, refreshLibrary])

  const eligibleLibrarySongs = useMemo(
    () => songs.filter((song) => song.datasetOptIn && song.hasNotesMidi),
    [songs]
  )

  if (!isOpen) return null

  const toggleSong = async (song: LibrarySong): Promise<void> => {
    const next = !song.datasetOptIn
    setError(null)
    setSongs((current) =>
      current.map((entry) => (entry.path === song.path ? { ...entry, datasetOptIn: next } : entry))
    )
    if (!(await window.api.setDatasetSongOptIn(song.path, next))) {
      setSongs((current) =>
        current.map((entry) =>
          entry.path === song.path ? { ...entry, datasetOptIn: song.datasetOptIn } : entry
        )
      )
      setError('Could not save that song’s dataset consent setting.')
      return
    }
    if (activeSongId) {
      const songStore = getSongStore(activeSongId)
      if (songStore.getState().song.folderPath === song.path) {
        songStore.getState().updateMetadata({ dataset_opt_in: next ? 'true' : 'false' })
      }
    }
  }

  const addPackageFolder = async (): Promise<void> => {
    const discovered = await window.api.chooseDatasetPackageFolder()
    setPackages((current) => {
      const next = new Map(current.map((entry) => [entry.path, entry]))
      for (const entry of discovered) next.set(entry.path, entry)
      return [...next.values()]
    })
    setSelectedPackages(
      (current) => new Set([...current, ...discovered.map((entry) => entry.path)])
    )
  }

  const chooseOutput = async (): Promise<void> => {
    const selected = await window.api.chooseDatasetOutputFolder()
    if (selected) setOutputDir(selected)
  }

  const exportDataset = async (): Promise<void> => {
    if (!outputDir || !datasetId.trim() || !provenance.trim() || !license.trim()) {
      setError('Dataset ID, provenance, license, and an empty output folder are required.')
      return
    }
    setExporting(true)
    setError(null)
    setResult(null)
    try {
      const response = await window.api.exportTrainingDataset({
        packagePaths: packages
          .filter((entry) => selectedPackages.has(entry.path))
          .map((entry) => entry.path),
        librarySongPaths: eligibleLibrarySongs.map((song) => song.path),
        outputDir,
        datasetId: datasetId.trim(),
        provenance: provenance.trim(),
        license: license.trim()
      })
      setResult({
        exported: response.exported.length,
        skipped: response.skipped.length,
        manifestPath: response.manifestPath
      })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Dataset export failed.')
    } finally {
      setExporting(false)
    }
  }

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
              Only MIDI and approved metadata are exported. Audio, stems, artwork, and source paths
              stay out.
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
              Exported {result.exported} songs; skipped {result.skipped}. Manifest:{' '}
              {result.manifestPath}
            </p>
          )}

          <section className="dataset-section">
            <div className="dataset-section-heading">
              <div>
                <h3>Octave library</h3>
                <p>
                  Consent is stored in each song’s <code>song.ini</code>. STRUM output is opted out
                  until you review it.
                </p>
              </div>
              <button onClick={() => void refreshLibrary()} disabled={loading || exporting}>
                Refresh
              </button>
            </div>
            <div className="dataset-song-list">
              {songs.map((song) => (
                <label className={!song.hasNotesMidi ? 'disabled' : ''} key={song.path}>
                  <input
                    type="checkbox"
                    checked={song.datasetOptIn}
                    disabled={!song.hasNotesMidi || exporting}
                    onChange={() => void toggleSong(song)}
                  />
                  <span>
                    <strong>
                      {song.artist} — {song.name}
                    </strong>
                    <small>
                      {song.isStrumGenerated
                        ? 'STRUM generated · review required'
                        : song.charter || 'No charter'}
                      {!song.hasNotesMidi ? ' · no notes.mid' : ''}
                    </small>
                  </span>
                </label>
              ))}
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
                  Add folders containing <code>.sng</code>, <code>.con</code>, or{' '}
                  <code>.rb3con</code> files. Select the packages you have permission to include.
                </p>
              </div>
              <button onClick={() => void addPackageFolder()} disabled={exporting}>
                Add folder
              </button>
            </div>
            <div className="dataset-package-list">
              {packages.map((entry) => (
                <label key={entry.path}>
                  <input
                    type="checkbox"
                    checked={selectedPackages.has(entry.path)}
                    disabled={exporting}
                    onChange={() =>
                      setSelectedPackages((current) => {
                        const next = new Set(current)
                        next.has(entry.path) ? next.delete(entry.path) : next.add(entry.path)
                        return next
                      })
                    }
                  />{' '}
                  {entry.name}
                </label>
              ))}
            </div>
          </section>

          <section className="dataset-section dataset-details">
            <h3>Export record</h3>
            <label>
              Dataset ID
              <input
                value={datasetId}
                onChange={(event) => setDatasetId(event.target.value)}
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
              Empty output folder
              <div className="dataset-output">
                <input value={outputDir} readOnly placeholder="Choose a folder" />
                <button onClick={() => void chooseOutput()} disabled={exporting}>
                  Choose
                </button>
              </div>
            </label>
          </section>
        </main>
        <footer>
          <span>
            {eligibleLibrarySongs.length} library songs and {selectedPackages.size} packages
            selected
          </span>
          <button
            className="dataset-primary"
            onClick={() => void exportDataset()}
            disabled={exporting}
          >
            {exporting ? 'Exporting…' : 'Export curated MIDI'}
          </button>
        </footer>
      </section>
    </div>
  )
}
