import { createHash } from 'crypto'
import { createReadStream } from 'fs'
import { mkdir, readFile, readdir, writeFile } from 'fs/promises'
import * as path from 'path'
import { Readable } from 'stream'
import { Midi } from '@tonejs/midi'
import { SngStream, type SngHeader } from 'parse-sng'
import { parseIniFile } from '../../shared/iniFile'
import { StfsParser } from './conImporter'
import { parseDta } from './dtaParser'

const EXPORT_FORMAT = 'octave-training-midi-export/v1'
const NOTES_MIDI = 'notes.mid'
const EXPORTED_METADATA_KEYS = ['name', 'artist', 'album', 'genre', 'year', 'charter'] as const
const MAX_METADATA_VALUE_LENGTH = 512

export interface SngTrainingExportOptions {
  /** Explicitly selected Clone Hero packages. */
  sngPaths: readonly string[]
  /** Explicitly selected Rock Band CON/RB3CON packages. */
  conPaths?: readonly string[]
  /** Octave song folders. Only entries with dataset_opt_in = true are exported. */
  librarySongPaths?: readonly string[]
  outputDir: string
  datasetId: string
  provenance: string
  license: string
}

interface ExportedSong {
  songId: string
  midi: string
  notesSha256: string
  /** Hash of the selected package, when the source is a package. */
  packageSha256?: string
  source: 'octave-library' | 'sng' | 'rb3con'
  metadata: Record<string, string>
}

export interface SngTrainingExportResult {
  manifestPath: string
  exported: ExportedSong[]
  skipped: Array<{ sourceIndex: number; reason: string }>
}

export interface DatasetLibrarySong {
  path: string
  name: string
  artist: string
  charter?: string
  datasetOptIn: boolean
  isStrumGenerated: boolean
  hasNotesMidi: boolean
}

function slug(value: string): string {
  const normalized = value
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
  return normalized || 'unknown-song'
}

function sanitizeMetadata(
  metadata: Record<string, string | number | undefined>
): Record<string, string> {
  const sanitized: Record<string, string> = {}
  for (const key of EXPORTED_METADATA_KEYS) {
    const rawValue = metadata[key]
    if (rawValue === undefined || rawValue === '') continue
    const value = String(rawValue)
    const withoutControls = Array.from(value, (character) => {
      const codePoint = character.codePointAt(0) ?? 0
      return codePoint <= 0x1f || codePoint === 0x7f ? ' ' : character
    }).join('')
    const normalized = withoutControls.normalize('NFKC').trim().slice(0, MAX_METADATA_VALUE_LENGTH)
    if (normalized) sanitized[key] = normalized
  }
  return sanitized
}

function isDatasetOptedIn(value: unknown): boolean {
  return value === true || value === 1 || /^(?:1|true|yes)$/i.test(String(value ?? '').trim())
}

function isStrumGenerated(metadata: Record<string, string | number>): boolean {
  return (
    /^strum$/i.test(String(metadata.charter ?? '').trim()) ||
    /^(?:1|true|yes)$/i.test(String(metadata.strum_generated ?? '').trim())
  )
}

function hasValidMidiChunkLayout(midiBytes: Buffer): boolean {
  if (
    midiBytes.length < 14 ||
    midiBytes.subarray(0, 4).toString('ascii') !== 'MThd' ||
    midiBytes.readUInt32BE(4) !== 6
  ) {
    return false
  }

  const trackCount = midiBytes.readUInt16BE(10)
  if (trackCount === 0) return false
  let offset = 14
  for (let trackIndex = 0; trackIndex < trackCount; trackIndex += 1) {
    if (
      offset + 8 > midiBytes.length ||
      midiBytes.subarray(offset, offset + 4).toString('ascii') !== 'MTrk'
    ) {
      return false
    }
    const trackLength = midiBytes.readUInt32BE(offset + 4)
    offset += 8
    if (trackLength > midiBytes.length - offset) return false
    offset += trackLength
  }
  return offset === midiBytes.length
}

function isValidMidi(midiBytes: Buffer): boolean {
  try {
    return hasValidMidiChunkLayout(midiBytes) && Boolean(new Midi(midiBytes))
  } catch {
    return false
  }
}

function sha256Buffer(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex')
}

async function sha256File(filePath: string): Promise<string> {
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) digest.update(chunk)
  return digest.digest('hex')
}

async function drain(fileStream: ReadableStream<Uint8Array>): Promise<void> {
  for await (const chunk of Readable.fromWeb(
    fileStream as import('stream/web').ReadableStream<Uint8Array>
  )) {
    void chunk
  }
}

async function extractSngNotesMidi(
  sngPath: string
): Promise<{ midi: Buffer; metadata: Record<string, string> } | null> {
  return await new Promise((resolve, reject) => {
    let settled = false
    let metadata: Record<string, string> | null = null
    let notesMidi: Buffer | null = null
    const settle = (callback: () => void): void => {
      if (settled) return
      settled = true
      callback()
    }
    const fail = (error: unknown): void =>
      settle(() => reject(error instanceof Error ? error : new Error(String(error))))
    const input = createReadStream(sngPath)
    const sngStream = new SngStream(Readable.toWeb(input) as ReadableStream<Uint8Array>, {
      generateSongIni: false
    })

    sngStream.on('header', (header: SngHeader) => {
      metadata = sanitizeMetadata(header.metadata)
      if (header.fileMeta.length === 0) settle(() => resolve(null))
    })
    sngStream.on('file', (fileName, fileStream, nextFile) => {
      void (async () => {
        if (fileName.toLowerCase() === NOTES_MIDI) {
          if (notesMidi) throw new Error(`Package contains multiple ${NOTES_MIDI} files`)
          const chunks: Buffer[] = []
          for await (const chunk of Readable.fromWeb(
            fileStream as import('stream/web').ReadableStream<Uint8Array>
          )) {
            chunks.push(Buffer.from(chunk))
          }
          notesMidi = Buffer.concat(chunks)
        } else {
          await drain(fileStream as ReadableStream<Uint8Array>)
        }
        if (nextFile) nextFile()
        else settle(() => resolve(notesMidi && metadata ? { midi: notesMidi, metadata } : null))
      })().catch(fail)
    })
    sngStream.on('error', fail)
    sngStream.start()
  })
}

function findConMidi(
  entries: Record<string, Buffer>,
  shortname: string,
  allowGlobalFallback: boolean
): Buffer | null {
  const short = shortname.toLowerCase()
  for (const [entryPath, value] of Object.entries(entries)) {
    const normalized = entryPath.toLowerCase().replace(/\\/g, '/')
    if (normalized === `${short}.mid` || normalized.endsWith(`/${short}.mid`)) return value
  }
  if (!allowGlobalFallback) return null
  for (const [entryPath, value] of Object.entries(entries)) {
    if (entryPath.toLowerCase().endsWith('.mid')) return value
  }
  return null
}

async function extractConNotesMidi(
  conPath: string
): Promise<Array<{ midi: Buffer; metadata: Record<string, string> }>> {
  const parser = new StfsParser(await readFile(conPath))
  const { entries } = parser.parse()
  const dta = Object.entries(entries).find(([entryPath]) =>
    entryPath.toLowerCase().endsWith('songs/songs.dta')
  )?.[1]
  if (!dta) throw new Error('Could not find songs.dta in the STFS container.')
  const songs = Object.values(parseDta(dta.toString('latin1')))
  const isSingleSongPack = songs.length === 1
  return songs.flatMap((song) => {
    const midi = findConMidi(entries, song.shortname, isSingleSongPack)
    if (!midi) return []
    return [
      {
        midi,
        metadata: sanitizeMetadata({
          name: song.name,
          artist: song.artist,
          album: song.album,
          genre: song.genre,
          year: song.year,
          charter: 'C3'
        })
      }
    ]
  })
}

async function ensureEmptyOutputDir(outputDir: string): Promise<void> {
  try {
    if ((await readdir(outputDir)).length > 0)
      throw new Error(`Training export output directory must be empty: ${outputDir}`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    await mkdir(outputDir, { recursive: true })
  }
}

export async function listDatasetLibrarySongs(libraryDir: string): Promise<DatasetLibrarySong[]> {
  const entries = await readdir(libraryDir, { withFileTypes: true })
  const songs = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const songPath = path.join(libraryDir, entry.name)
        try {
          const metadata = parseIniFile(await readFile(path.join(songPath, 'song.ini'), 'utf8'))
          let hasNotesMidi = true
          try {
            await readFile(path.join(songPath, NOTES_MIDI))
          } catch {
            hasNotesMidi = false
          }
          return {
            path: songPath,
            name: String(metadata.name ?? entry.name),
            artist: String(metadata.artist ?? 'Unknown Artist'),
            charter: typeof metadata.charter === 'string' ? metadata.charter : undefined,
            datasetOptIn: isDatasetOptedIn(metadata.dataset_opt_in),
            isStrumGenerated: isStrumGenerated(metadata),
            hasNotesMidi
          }
        } catch {
          return null
        }
      })
  )
  return songs.filter((song) => song !== null) as DatasetLibrarySong[]
}

type Candidate = {
  source: ExportedSong['source']
  midi: Buffer
  metadata: Record<string, string>
  packageSha256?: string
}

/**
 * Export reviewed MIDI only. Library songs are deliberately consent-gated by
 * `dataset_opt_in = true`; package sources are explicit selections made in the
 * curation UI and never carry source paths into the export.
 */
export async function exportSngTrainingMidi(
  options: SngTrainingExportOptions
): Promise<SngTrainingExportResult> {
  const sourceCount =
    options.sngPaths.length +
    (options.conPaths?.length ?? 0) +
    (options.librarySongPaths?.length ?? 0)
  if (!sourceCount) throw new Error('At least one package or library song is required')
  for (const [name, value] of Object.entries({
    datasetId: options.datasetId,
    provenance: options.provenance,
    license: options.license
  })) {
    if (!value.trim()) throw new Error(`${name} must be non-empty`)
  }

  const outputDir = path.resolve(options.outputDir)
  await ensureEmptyOutputDir(outputDir)
  const songsDir = path.join(outputDir, 'songs')
  await mkdir(songsDir, { recursive: true })
  const exported: ExportedSong[] = []
  const skipped: Array<{ sourceIndex: number; reason: string }> = []
  const seenMidi = new Set<string>()
  let sourceIndex = 0

  const exportCandidate = async (candidate: Candidate, index: number): Promise<void> => {
    if (!isValidMidi(candidate.midi)) {
      skipped.push({ sourceIndex: index, reason: 'Package could not be read or exported' })
      return
    }
    const notesSha256 = sha256Buffer(candidate.midi)
    if (seenMidi.has(notesSha256)) {
      skipped.push({
        sourceIndex: index,
        reason: `Duplicate notes.mid: ${notesSha256.slice(0, 12)}`
      })
      return
    }
    const songId = `${slug(`${candidate.metadata.artist ?? ''}-${candidate.metadata.name ?? ''}`)}-${notesSha256.slice(0, 12)}`
    const songDir = path.join(songsDir, songId)
    await mkdir(songDir)
    await writeFile(path.join(songDir, NOTES_MIDI), candidate.midi)
    await writeFile(
      path.join(songDir, 'source-metadata.json'),
      JSON.stringify(
        {
          source: candidate.source,
          metadata: candidate.metadata,
          notesSha256,
          packageSha256: candidate.packageSha256
        },
        null,
        2
      ) + '\n',
      'utf8'
    )
    seenMidi.add(notesSha256)
    exported.push({
      songId,
      midi: path.posix.join('songs', songId, NOTES_MIDI),
      notesSha256,
      packageSha256: candidate.packageSha256,
      source: candidate.source,
      metadata: candidate.metadata
    })
  }

  for (const sngPath of options.sngPaths) {
    const index = sourceIndex++
    try {
      const extracted = await extractSngNotesMidi(sngPath)
      if (!extracted) {
        skipped.push({ sourceIndex: index, reason: `Package has no ${NOTES_MIDI}` })
        continue
      }
      await exportCandidate(
        { ...extracted, source: 'sng', packageSha256: await sha256File(sngPath) },
        index
      )
    } catch {
      skipped.push({ sourceIndex: index, reason: 'Package could not be read or exported' })
    }
  }
  for (const conPath of options.conPaths ?? []) {
    const index = sourceIndex++
    try {
      const packageSha256 = await sha256File(conPath)
      const candidates = await extractConNotesMidi(conPath)
      if (!candidates.length) {
        skipped.push({ sourceIndex: index, reason: `Package has no ${NOTES_MIDI}` })
        continue
      }
      for (const candidate of candidates)
        await exportCandidate({ ...candidate, source: 'rb3con', packageSha256 }, index)
    } catch {
      skipped.push({ sourceIndex: index, reason: 'Package could not be read or exported' })
    }
  }
  for (const songPath of options.librarySongPaths ?? []) {
    const index = sourceIndex++
    try {
      const metadata = parseIniFile(await readFile(path.join(songPath, 'song.ini'), 'utf8'))
      if (!isDatasetOptedIn(metadata.dataset_opt_in)) {
        skipped.push({ sourceIndex: index, reason: 'Song is not opted into dataset curation' })
        continue
      }
      await exportCandidate(
        {
          source: 'octave-library',
          midi: await readFile(path.join(songPath, NOTES_MIDI)),
          metadata: sanitizeMetadata(metadata)
        },
        index
      )
    } catch {
      skipped.push({ sourceIndex: index, reason: 'Package could not be read or exported' })
    }
  }

  const manifestPath = path.join(outputDir, 'source-manifest.json')
  await writeFile(
    manifestPath,
    JSON.stringify(
      {
        schemaVersion: 1,
        format: EXPORT_FORMAT,
        datasetId: options.datasetId,
        provenance: options.provenance,
        license: options.license,
        exported,
        skipped
      },
      null,
      2
    ) + '\n',
    'utf8'
  )
  return { manifestPath, exported, skipped }
}
