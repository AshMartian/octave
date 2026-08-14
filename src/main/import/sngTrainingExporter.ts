import { createHash, randomUUID } from 'crypto'
import { createReadStream } from 'fs'
import {
  cp,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  writeFile
} from 'fs/promises'
import * as path from 'path'
import { Readable } from 'stream'
import { Midi } from '@tonejs/midi'
import AdmZip from 'adm-zip'
import Ajv2020 from 'ajv/dist/2020'
import { SngStream, type SngHeader } from 'parse-sng'
import { parseIniFile } from '../../shared/iniFile'
import catalogSchema from '../../../docs/reference/song-source-catalog.schema.json'
import { StfsParser } from './conImporter'
import { parseDta } from './dtaParser'
import { decryptMoggBuffer } from './moggDecrypt'

const EXPORT_FORMAT = 'octave-training-midi-export/v1'
const NOTES_MIDI = 'notes.mid'
const EXPORTED_METADATA_KEYS = ['name', 'artist', 'album', 'genre', 'year', 'charter'] as const
const MAX_METADATA_VALUE_LENGTH = 512
const MAX_ZIP_ENTRIES = 2_000
const MAX_ZIP_ENTRY_BYTES = 64 * 1024 * 1024
const MAX_AUDIO_ASSET_BYTES = 512 * 1024 * 1024
const AUDIO_EXTENSIONS = ['ogg', 'mp3', 'opus', 'wav', 'flac'] as const
const CATALOG_SCHEMA_ID =
  'https://octavestudio.tools/schemas/song-source-catalog/v1/catalog.schema.json'
const catalogAjv = new Ajv2020({ allErrors: true, strict: false })
const validateCatalogManifestSchema = catalogAjv.compile(catalogSchema)
const validateCatalogRecordSchema = catalogAjv.compile({
  $ref: `${CATALOG_SCHEMA_ID}#/$defs/record`
})

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

export type DatasetSourceKind = 'octave-library' | 'sng' | 'rb3con' | 'zip'

/** Source locations stay in the main process and are never rendered or written to a catalog. */
export interface DatasetCatalogSource {
  kind: DatasetSourceKind
  sourcePath: string
  /**
   * Opaque, content-addressed selection for one song contained in a multi-song
   * package. This is kept in the main process and is never written to a catalog.
   */
  entryId?: string
}

export interface DatasetSourceSummary {
  kind: DatasetSourceKind
  songCount: number
  metadata: Record<string, string>
  midiValid: boolean
  instruments: Record<
    string,
    { status: 'present' | 'absent'; difficulties: string[]; trackNames: string[] }
  >
  trainingUse: 'allowed' | 'review_required'
  warnings: Array<{ code: string }>
  isStrumGenerated: boolean
}

interface CatalogCandidate {
  kind: DatasetSourceKind
  midi: Buffer
  metadata: Record<string, string>
  audio: Partial<Record<CatalogAudioRole, CatalogAudioInput>>
  isStrumGenerated: boolean
  containerSha256?: string
  /** Main-process UI admission state; never serialized to a catalog record. */
  requiresOptIn: boolean
}

type CatalogAudioRole = 'mix' | 'drums' | 'guitar' | 'bass' | 'keys' | 'vocals' | 'other'

interface CatalogAudioInput {
  bytes: Buffer
  extension: (typeof AUDIO_EXTENSIONS)[number]
  mediaType: string
}

interface CatalogAsset {
  asset_id: string
  sha256: string
  relative_path: string
  byte_length: number
  media_type: string
}

export interface SongSourceCatalogResult {
  catalogPath: string
  recordCount: number
  skipped: Array<{ sourceIndex: number; reason: string }>
}

/** A renderer-safe per-song summary for a selected package. */
export interface DatasetSourceEntrySummary extends DatasetSourceSummary {
  /** Opaque content hash used only by OCTAVE to keep a multi-song selection stable. */
  entryId: string
}

export type SongSourceCatalogWriteMode = 'create' | 'update' | 'clone'

export interface SongSourceCatalogSummary {
  catalogName: string
  catalogId: string
  recordCount: number
  libraryRecordCount: number
  externalRecordCount: number
}

export interface SongSourceCatalogProgress {
  phase: 'normalizing' | 'materializing' | 'validating'
  completed: number
  total: number
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

function isCatalogAudioExtension(value: string): value is (typeof AUDIO_EXTENSIONS)[number] {
  return (AUDIO_EXTENSIONS as readonly string[]).includes(value)
}

function catalogAudioInput(
  fileName: string,
  bytes: Buffer
): [CatalogAudioRole, CatalogAudioInput] | null {
  if (bytes.length > MAX_AUDIO_ASSET_BYTES) throw new Error('Audio asset is too large.')
  const normalized = fileName.replace(/\\/g, '/')
  const baseName = normalized.slice(normalized.lastIndexOf('/') + 1).toLowerCase()
  const match = /^(.+)\.(ogg|mp3|opus|wav|flac)$/.exec(baseName)
  if (!match) return null
  const [, stem, extension] = match
  if (!isCatalogAudioExtension(extension)) return null
  const role: CatalogAudioRole | undefined =
    stem === 'song' || stem === 'backing'
      ? 'mix'
      : stem === 'drums' || stem === 'drum'
        ? 'drums'
        : stem === 'guitar'
          ? 'guitar'
          : stem === 'bass'
            ? 'bass'
            : stem === 'keys' || stem === 'key'
              ? 'keys'
              : stem === 'vocals' || /^vocals_[0-9]+$/.test(stem)
                ? 'vocals'
                : stem === 'other'
                  ? 'other'
                  : undefined
  if (!role) return null
  const mediaType =
    extension === 'ogg'
      ? 'audio/ogg'
      : extension === 'opus'
        ? 'audio/opus'
        : extension === 'mp3'
          ? 'audio/mpeg'
          : extension === 'wav'
            ? 'audio/wav'
            : 'audio/flac'
  return [role, { bytes, extension, mediaType }]
}

async function readCatalogAudioFromFolder(
  sourcePath: string
): Promise<Partial<Record<CatalogAudioRole, CatalogAudioInput>>> {
  const audio: Partial<Record<CatalogAudioRole, CatalogAudioInput>> = {}
  const entries = await readdir(sourcePath, { withFileTypes: true })
  for (const entry of entries
    .filter((candidate) => candidate.isFile() && /\.(ogg|mp3|opus|wav|flac)$/i.test(candidate.name))
    .sort((a, b) => a.name.localeCompare(b.name))) {
    const bytes = await readFile(path.join(sourcePath, entry.name))
    const input = catalogAudioInput(entry.name, bytes)
    if (input && !audio[input[0]]) audio[input[0]] = input[1]
  }
  return audio
}

async function extractSngNotesMidi(
  sngPath: string,
  includeAudio = true
): Promise<{
  midi: Buffer
  metadata: Record<string, string>
  audio: Partial<Record<CatalogAudioRole, CatalogAudioInput>>
  isStrumGenerated: boolean
} | null> {
  return await new Promise((resolve, reject) => {
    let settled = false
    let metadata: Record<string, string> | null = null
    let generatedByStrum = false
    let notesMidi: Buffer | null = null
    const audio: Partial<Record<CatalogAudioRole, CatalogAudioInput>> = {}
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
      generatedByStrum = isStrumGenerated(header.metadata)
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
        } else if (includeAudio && /\.(ogg|mp3|opus|wav|flac)$/i.test(fileName)) {
          const chunks: Buffer[] = []
          let byteLength = 0
          for await (const chunk of Readable.fromWeb(
            fileStream as import('stream/web').ReadableStream<Uint8Array>
          )) {
            byteLength += chunk.length
            if (byteLength > MAX_AUDIO_ASSET_BYTES) throw new Error('Package audio is too large.')
            chunks.push(Buffer.from(chunk))
          }
          const input = catalogAudioInput(fileName, Buffer.concat(chunks))
          if (input && !audio[input[0]]) audio[input[0]] = input[1]
        } else {
          await drain(fileStream as ReadableStream<Uint8Array>)
        }
        if (nextFile) nextFile()
        else
          settle(() =>
            resolve(
              notesMidi && metadata
                ? { midi: notesMidi, metadata, audio, isStrumGenerated: generatedByStrum }
                : null
            )
          )
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

function findConMogg(
  entries: Record<string, Buffer>,
  shortname: string,
  allowGlobalFallback: boolean
): Buffer | null {
  const short = shortname.toLowerCase()
  for (const [entryPath, value] of Object.entries(entries)) {
    const normalized = entryPath.toLowerCase().replace(/\\/g, '/')
    if (normalized === `${short}.mogg` || normalized.endsWith(`/${short}.mogg`)) return value
  }
  if (!allowGlobalFallback) return null
  for (const [entryPath, value] of Object.entries(entries)) {
    if (entryPath.toLowerCase().endsWith('.mogg')) return value
  }
  return null
}

async function extractConNotesMidi(
  conPath: string,
  includeAudio = true
): Promise<
  Array<{
    midi: Buffer
    metadata: Record<string, string>
    audio: Partial<Record<CatalogAudioRole, CatalogAudioInput>>
    isStrumGenerated: boolean
  }>
> {
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
    const mogg = findConMogg(entries, song.shortname, isSingleSongPack)
    let audio: Partial<Record<CatalogAudioRole, CatalogAudioInput>> = {}
    if (mogg && includeAudio) {
      try {
        const ogg = decryptMoggBuffer(mogg)
        const input = catalogAudioInput('song.ogg', ogg)
        if (input) audio = { [input[0]]: input[1] }
      } catch {
        // A catalog can contain a valid chart without an audio mix.
      }
    }
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
        }),
        audio,
        isStrumGenerated: false
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

function redactLocationText(value: string, fallback = 'Unknown'): string {
  const normalized = Array.from(value.normalize('NFKC'), (character) => {
    const codePoint = character.codePointAt(0) ?? 0
    return codePoint <= 0x1f || codePoint === 0x7f ? ' ' : character
  })
    .join('')
    .replace(/(?:https?|smb|file):\/\/\S+/gi, '[redacted]')
    .replace(/(?:^|\s)(?:~?\/|[A-Za-z]:[\\/]|\\\\)[^\s]*/g, ' [redacted]')
    .replace(/\\/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_METADATA_VALUE_LENGTH)
  return normalized || fallback
}

function redactMetadata(metadata: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(metadata).map(([key, value]) => [key, redactLocationText(value)])
  )
}

const TRACK_INSTRUMENTS: Array<[string, string]> = [
  ['PART DRUMS', 'drums'],
  ['PART GUITAR', 'guitar'],
  ['PART BASS', 'bass'],
  ['PART KEYS', 'keys'],
  ['PART VOCALS', 'vocals'],
  ['PART REAL_KEYS', 'pro_keys'],
  ['PART REAL_GUITAR', 'pro_guitar'],
  ['PART REAL_BASS', 'pro_bass']
]

function discoverInstrumentCoverage(midiBytes: Buffer): DatasetSourceSummary['instruments'] {
  const coverage: DatasetSourceSummary['instruments'] = {}
  const midi = new Midi(midiBytes)
  for (const track of midi.tracks) {
    const trackName = track.name.trim()
    const mapped = TRACK_INSTRUMENTS.find(([prefix]) => trackName.toUpperCase().startsWith(prefix))
    if (!mapped || track.notes.length === 0) continue
    const safeTrackName = redactLocationText(trackName, mapped[0])
    const [, instrument] = mapped
    const difficulties = new Set<string>()
    for (const note of track.notes) {
      if (note.midi >= 60 && note.midi <= 66) difficulties.add('easy')
      else if (note.midi >= 72 && note.midi <= 78) difficulties.add('medium')
      else if (note.midi >= 84 && note.midi <= 90) difficulties.add('hard')
      else if (note.midi >= 96 && note.midi <= 102) difficulties.add('expert')
    }
    // Vocal and pro tracks do not use the five-lane difficulty note ranges;
    // catalog v1 still requires a non-empty coverage level when present.
    if (difficulties.size === 0) difficulties.add('expert')
    coverage[instrument] = {
      status: 'present',
      difficulties: [...difficulties],
      trackNames: [...new Set([...(coverage[instrument]?.trackNames ?? []), safeTrackName])]
    }
  }
  return coverage
}

function safeZipEntryName(entryName: string): string | null {
  const normalized = entryName.replace(/\\/g, '/')
  if (
    !normalized ||
    normalized.startsWith('/') ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.split('/').some((part) => part === '..')
  ) {
    return null
  }
  return normalized
}

function extractZipNotesMidi(
  sourcePath: string,
  includeAudio = true
): Array<{
  midi: Buffer
  metadata: Record<string, string>
  audio: Partial<Record<CatalogAudioRole, CatalogAudioInput>>
  isStrumGenerated: boolean
}> {
  const archive = new AdmZip(sourcePath)
  const entries = archive.getEntries()
  if (entries.length > MAX_ZIP_ENTRIES) throw new Error('ZIP archive has too many entries.')
  const files = new Map<string, AdmZip.IZipEntry>()
  for (const entry of entries) {
    const name = safeZipEntryName(entry.entryName)
    if (!name || entry.isDirectory) continue
    if (!Number.isSafeInteger(entry.header.size) || entry.header.size > MAX_ZIP_ENTRY_BYTES) {
      throw new Error('ZIP archive entry is too large.')
    }
    files.set(name.toLowerCase(), entry)
  }

  const candidates: Array<{
    midi: Buffer
    metadata: Record<string, string>
    audio: Partial<Record<CatalogAudioRole, CatalogAudioInput>>
    isStrumGenerated: boolean
  }> = []
  for (const [name, entry] of files) {
    if (!name.endsWith(`/${NOTES_MIDI}`) && name !== NOTES_MIDI) continue
    const midi = entry.getData()
    if (midi.length > MAX_ZIP_ENTRY_BYTES) throw new Error('ZIP archive entry is too large.')
    const directory = name.slice(0, -NOTES_MIDI.length)
    const songIni = files.get(`${directory}song.ini`)
    const rawMetadata = songIni ? parseIniFile(songIni.getData().toString('utf8')) : {}
    const metadata = sanitizeMetadata(rawMetadata)
    const audio: Partial<Record<CatalogAudioRole, CatalogAudioInput>> = {}
    if (includeAudio) {
      for (const [entryName, audioEntry] of files) {
        const childName = entryName.slice(directory.length)
        if (!childName || childName.includes('/')) continue
        if (!/\.(ogg|mp3|opus|wav|flac)$/i.test(childName)) continue
        const bytes = audioEntry.getData()
        const input = catalogAudioInput(childName, bytes)
        if (input && !audio[input[0]]) audio[input[0]] = input[1]
      }
    }
    candidates.push({ midi, metadata, audio, isStrumGenerated: isStrumGenerated(rawMetadata) })
  }
  return candidates
}

async function inspectDatasetSource(
  source: DatasetCatalogSource,
  includeAudio = true
): Promise<CatalogCandidate[]> {
  if (source.kind === 'sng') {
    const extracted = await extractSngNotesMidi(source.sourcePath, includeAudio)
    if (!extracted) return []
    const candidates = [
      {
        kind: source.kind,
        midi: extracted.midi,
        metadata: redactMetadata(extracted.metadata),
        audio: extracted.audio,
        isStrumGenerated: extracted.isStrumGenerated,
        containerSha256: await sha256File(source.sourcePath),
        requiresOptIn: false
      }
    ]
    return selectCatalogEntries(candidates, source.entryId)
  }
  if (source.kind === 'rb3con') {
    const containerSha256 = await sha256File(source.sourcePath)
    const candidates = (await extractConNotesMidi(source.sourcePath, includeAudio)).map(
      (candidate) => ({
        kind: source.kind,
        midi: candidate.midi,
        metadata: redactMetadata(candidate.metadata),
        audio: candidate.audio,
        isStrumGenerated: candidate.isStrumGenerated,
        containerSha256,
        requiresOptIn: false
      })
    )
    return selectCatalogEntries(candidates, source.entryId)
  }
  if (source.kind === 'zip') {
    const containerSha256 = await sha256File(source.sourcePath)
    const candidates = extractZipNotesMidi(source.sourcePath, includeAudio).map((candidate) => ({
      kind: source.kind,
      midi: candidate.midi,
      metadata: redactMetadata(candidate.metadata),
      audio: candidate.audio,
      isStrumGenerated: candidate.isStrumGenerated,
      containerSha256,
      requiresOptIn: false
    }))
    return selectCatalogEntries(candidates, source.entryId)
  }
  const metadata = parseIniFile(await readFile(path.join(source.sourcePath, 'song.ini'), 'utf8'))
  const candidates = [
    {
      kind: source.kind,
      midi: await readFile(path.join(source.sourcePath, NOTES_MIDI)),
      metadata: redactMetadata(sanitizeMetadata(metadata)),
      audio: includeAudio ? await readCatalogAudioFromFolder(source.sourcePath) : {},
      isStrumGenerated: isStrumGenerated(metadata),
      requiresOptIn: !isDatasetOptedIn(metadata.dataset_opt_in)
    }
  ]
  return selectCatalogEntries(candidates, source.entryId)
}

function catalogEntryId(candidate: CatalogCandidate, entryIndex: number): string {
  // Content alone is not sufficient here: a multi-song package can legally
  // contain two songs with byte-identical MIDI. Bind the opaque selection to
  // its stable package order as well, without exposing its entry name/path.
  return sha256Buffer(
    Buffer.from(
      `${candidate.kind}\u0000${candidate.containerSha256 ?? ''}\u0000${entryIndex}\u0000${sha256Buffer(candidate.midi)}`,
      'utf8'
    )
  )
}

function selectCatalogEntries(
  candidates: CatalogCandidate[],
  entryId: string | undefined
): CatalogCandidate[] {
  if (!entryId) return candidates
  if (!/^[a-f0-9]{64}$/.test(entryId)) return []
  return candidates.filter(
    (candidate, entryIndex) => catalogEntryId(candidate, entryIndex) === entryId
  )
}

function summarizeCatalogCandidate(candidate: CatalogCandidate): DatasetSourceSummary {
  const midiValid = isValidMidi(candidate.midi)
  return {
    kind: candidate.kind,
    songCount: 1,
    metadata: candidate.metadata,
    midiValid,
    instruments: midiValid ? discoverInstrumentCoverage(candidate.midi) : {},
    // This is a UI-only review state. Catalog records always serialize allowed.
    trainingUse: candidate.requiresOptIn ? 'review_required' : 'allowed',
    warnings: midiValid ? [] : [{ code: 'invalid_notes_midi' }],
    isStrumGenerated: candidate.isStrumGenerated
  }
}

/**
 * Returns one opaque, safe summary per contained song. In particular, ZIP
 * archives are deliberately not collapsed to their first song.
 */
export async function summarizeDatasetSourceEntries(
  source: DatasetCatalogSource
): Promise<DatasetSourceEntrySummary[]> {
  try {
    return (await inspectDatasetSource(source, false)).map((candidate, entryIndex) => ({
      ...summarizeCatalogCandidate(candidate),
      entryId: catalogEntryId(candidate, entryIndex)
    }))
  } catch {
    return []
  }
}

/** Returns a renderer-safe summary; original source locations and parser errors never leave main. */
export async function summarizeDatasetSource(
  source: DatasetCatalogSource
): Promise<DatasetSourceSummary> {
  try {
    const candidates = await inspectDatasetSource(source, false)
    const first = candidates[0]
    if (!first) {
      return {
        kind: source.kind,
        songCount: 0,
        metadata: {},
        midiValid: false,
        instruments: {},
        trainingUse: 'review_required',
        warnings: [{ code: 'missing_notes_midi' }],
        isStrumGenerated: false
      }
    }
    const midiValid = candidates.every((candidate) => isValidMidi(candidate.midi))
    return {
      kind: source.kind,
      songCount: candidates.length,
      metadata: first.metadata,
      midiValid,
      instruments: midiValid ? discoverInstrumentCoverage(first.midi) : {},
      trainingUse: summarizeCatalogCandidate(first).trainingUse,
      warnings: midiValid ? [] : [{ code: 'invalid_notes_midi' }],
      isStrumGenerated: first.isStrumGenerated
    }
  } catch {
    return {
      kind: source.kind,
      songCount: 0,
      metadata: {},
      midiValid: false,
      instruments: {},
      trainingUse: 'review_required',
      warnings: [{ code: 'source_unavailable' }],
      isStrumGenerated: false
    }
  }
}

function validateCatalogName(name: string): string {
  const normalized = name.trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(normalized)) {
    throw new Error(
      'Catalog names may contain letters, numbers, dots, underscores, and dashes only.'
    )
  }
  return normalized
}

function catalogRecord(
  candidate: CatalogCandidate,
  notesAsset: CatalogAsset,
  notesSha256: string,
  audio: Partial<Record<CatalogAudioRole, CatalogAsset>>
): Record<string, unknown> {
  const sourceId = `octave-src-${notesSha256.slice(0, 24)}`
  const importRecord: Record<string, unknown> = {
    kind: candidate.kind === 'octave-library' ? 'song_folder' : candidate.kind,
    adapter_version:
      candidate.kind === 'sng'
        ? 'octave-sng/1'
        : candidate.kind === 'rb3con'
          ? 'octave-rb3con/1'
          : candidate.kind === 'zip'
            ? 'octave-zip/1'
            : 'octave-song-folder/1'
  }
  if (candidate.containerSha256) importRecord.container_sha256 = candidate.containerSha256
  return {
    source_id: sourceId,
    import: importRecord,
    rights: { training_use: 'allowed', provenance: '', license: '' },
    metadata: candidate.metadata,
    chart: {
      notes_midi: notesAsset,
      instruments: Object.fromEntries(
        Object.entries(discoverInstrumentCoverage(candidate.midi)).map(([instrument, coverage]) => [
          instrument,
          {
            status: coverage.status,
            difficulties: coverage.difficulties,
            track_names: coverage.trackNames
          }
        ])
      )
    },
    ...(Object.keys(audio).length ? { audio } : {})
  }
}

function validateCatalogRecord(record: Record<string, unknown>): void {
  if (!validateCatalogRecordSchema(record)) throw new Error('Catalog record validation failed.')
  const sourceId = record.source_id
  const rights = record.rights as { training_use?: string; provenance?: string; license?: string }
  const chart = record.chart as {
    notes_midi?: CatalogAsset
    instruments?: Record<
      string,
      { status?: string; difficulties?: unknown[]; track_names?: unknown[] }
    >
  }
  if (typeof sourceId !== 'string' || !/^octave-src-[a-z0-9][a-z0-9-]{7,127}$/.test(sourceId)) {
    throw new Error('Catalog record validation failed.')
  }
  if (!rights || rights.training_use !== 'allowed') {
    throw new Error('Catalog record validation failed.')
  }
  for (const value of [rights.provenance, rights.license]) {
    if (
      !value ||
      value.length > MAX_METADATA_VALUE_LENGTH ||
      /(?:https?:|smb:|file:|[A-Za-z]:[\\/])|(?:^|\s)\//i.test(value)
    ) {
      throw new Error('Catalog record validation failed.')
    }
  }
  for (const value of Object.values((record.metadata ?? {}) as Record<string, unknown>)) {
    if (
      typeof value !== 'string' ||
      !value ||
      value.length > MAX_METADATA_VALUE_LENGTH ||
      /(?:https?:|smb:|file:|[A-Za-z]:[\\/])|(?:^|\s)\//i.test(value)
    ) {
      throw new Error('Catalog record validation failed.')
    }
  }
  const notes = chart?.notes_midi
  const audio = record.audio as Partial<Record<CatalogAudioRole, CatalogAsset>> | undefined
  for (const asset of [notes, ...Object.values(audio ?? {})]) {
    if (
      !asset ||
      asset.asset_id !== `sha256:${asset.sha256}` ||
      !/^[a-f0-9]{64}$/.test(asset.sha256) ||
      !new RegExp(`^assets/sha256/${asset.sha256}/[A-Za-z0-9._-]+$`).test(asset.relative_path)
    ) {
      throw new Error('Catalog record validation failed.')
    }
  }
  for (const coverage of Object.values(chart.instruments ?? {})) {
    if (
      coverage.status !== 'present' ||
      !coverage.difficulties?.length ||
      !coverage.track_names?.length
    ) {
      throw new Error('Catalog record validation failed.')
    }
  }
}

function assertPathWithinCatalogRoot(catalogRoot: string, candidatePath: string): void {
  const relative = path.relative(catalogRoot, candidatePath)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Catalog asset validation failed.')
  }
}

async function validateMaterializedAsset(catalogRoot: string, asset: CatalogAsset): Promise<void> {
  if (!new RegExp(`^assets/sha256/${asset.sha256}/[A-Za-z0-9._-]+$`).test(asset.relative_path)) {
    throw new Error('Catalog asset validation failed.')
  }
  const assetPath = path.resolve(catalogRoot, ...asset.relative_path.split('/'))
  assertPathWithinCatalogRoot(catalogRoot, assetPath)
  const assetInfo = await lstat(assetPath)
  if (assetInfo.isSymbolicLink() || !assetInfo.isFile() || assetInfo.size !== asset.byte_length) {
    throw new Error('Catalog asset validation failed.')
  }
  const realAssetPath = await realpath(assetPath)
  assertPathWithinCatalogRoot(catalogRoot, realAssetPath)
  const bytes = await readFile(realAssetPath)
  if (sha256Buffer(bytes) !== asset.sha256 || asset.asset_id !== `sha256:${asset.sha256}`) {
    throw new Error('Catalog asset validation failed.')
  }
}

async function materializeCatalogAsset(
  catalogRoot: string,
  bytes: Buffer,
  fileName: string,
  mediaType: string
): Promise<CatalogAsset> {
  const sha256 = sha256Buffer(bytes)
  const relativePath = path.posix.join('assets', 'sha256', sha256, fileName)
  const assetPath = path.resolve(catalogRoot, ...relativePath.split('/'))
  assertPathWithinCatalogRoot(catalogRoot, assetPath)
  await mkdir(path.dirname(assetPath), { recursive: true })
  const realAssetDir = await realpath(path.dirname(assetPath))
  assertPathWithinCatalogRoot(catalogRoot, realAssetDir)
  try {
    await writeFile(assetPath, bytes, { flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  const asset: CatalogAsset = {
    asset_id: `sha256:${sha256}`,
    sha256,
    relative_path: relativePath,
    byte_length: bytes.length,
    media_type: mediaType
  }
  await validateMaterializedAsset(catalogRoot, asset)
  return asset
}

async function validateStagedCatalog(catalogRoot: string): Promise<void> {
  const catalog = JSON.parse(
    await readFile(path.join(catalogRoot, 'catalog.json'), 'utf8')
  ) as Record<string, unknown>
  if (!validateCatalogManifestSchema(catalog)) {
    throw new Error('Catalog manifest validation failed.')
  }
  const lines = (await readFile(path.join(catalogRoot, 'records.jsonl'), 'utf8'))
    .split('\n')
    .filter(Boolean)
  if (!lines.length) throw new Error('Catalog manifest validation failed.')
  for (const line of lines) {
    const record = JSON.parse(line) as Record<string, unknown>
    validateCatalogRecord(record)
    const chart = record.chart as { notes_midi: CatalogAsset }
    await validateMaterializedAsset(catalogRoot, chart.notes_midi)
    for (const asset of Object.values(
      (record.audio ?? {}) as Partial<Record<CatalogAudioRole, CatalogAsset>>
    )) {
      if (asset) await validateMaterializedAsset(catalogRoot, asset)
    }
  }
}

async function readCatalogRecords(catalogRoot: string): Promise<Record<string, unknown>[]> {
  const lines = (await readFile(path.join(catalogRoot, 'records.jsonl'), 'utf8'))
    .split('\n')
    .filter(Boolean)
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>)
}

export async function listSongSourceCatalogs(
  parentDir: string
): Promise<SongSourceCatalogSummary[]> {
  const entries = await readdir(parentDir, { withFileTypes: true })
  const summaries = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map(async (entry) => {
        try {
          const catalogRoot = path.join(parentDir, entry.name)
          const catalog = JSON.parse(
            await readFile(path.join(catalogRoot, 'catalog.json'), 'utf8')
          ) as Record<string, unknown>
          if (!validateCatalogManifestSchema(catalog)) return null
          await validateStagedCatalog(catalogRoot)
          const records = await readCatalogRecords(catalogRoot)
          const libraryRecordCount = records.filter(
            (record) => (record.import as { kind?: string }).kind === 'song_folder'
          ).length
          return {
            catalogName: entry.name,
            catalogId: String(catalog.catalog_id),
            recordCount: records.length,
            libraryRecordCount,
            externalRecordCount: records.length - libraryRecordCount
          }
        } catch {
          return null
        }
      })
  )
  return summaries
    .filter((summary): summary is SongSourceCatalogSummary => summary !== null)
    .sort((left, right) => left.catalogName.localeCompare(right.catalogName))
}

/**
 * Main-process catalog service. It is intentionally the sole adapter boundary
 * between package/folder sources and STRUM; its returned catalog is path-free.
 */
export async function buildSongSourceCatalog(options: {
  sources: readonly DatasetCatalogSource[]
  parentDir: string
  catalogName: string
  catalogId: string
  provenance: string
  license: string
  octaveVersion: string
  mode?: SongSourceCatalogWriteMode
  sourceCatalogName?: string
  onProgress?: (progress: SongSourceCatalogProgress) => void
}): Promise<SongSourceCatalogResult> {
  if (!options.sources.length && options.mode !== 'update') {
    throw new Error('Select at least one reviewed source.')
  }
  const mode = options.mode ?? 'create'
  const catalogName = validateCatalogName(options.catalogName)
  const catalogId = redactLocationText(options.catalogId, 'octave-catalog').slice(0, 128)
  const provenance = redactLocationText(options.provenance, 'Reviewed in Octave')
  const license = redactLocationText(options.license, 'Permission recorded by catalog owner')
  const parentDir = path.resolve(options.parentDir)
  const catalogPath = path.join(parentDir, catalogName)
  const sourceCatalogName = options.sourceCatalogName
    ? validateCatalogName(options.sourceCatalogName)
    : catalogName
  const sourceCatalogPath = path.join(parentDir, sourceCatalogName)
  const reservationPath = path.join(parentDir, `.${catalogName}.catalog-reservation`)
  let reservation: Awaited<ReturnType<typeof open>>
  try {
    reservation = await open(reservationPath, 'wx')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error('A catalog build with that name is already in progress.')
    }
    throw error
  }
  try {
    if (mode === 'update' || mode === 'clone') {
      try {
        await stat(sourceCatalogPath)
        await validateStagedCatalog(sourceCatalogPath)
      } catch {
        throw new Error('The selected catalog is unavailable or invalid.')
      }
    }
    if (mode !== 'update') {
      try {
        await stat(catalogPath)
        throw new Error('A catalog with that name already exists.')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
  } catch (error) {
    await reservation.close()
    await unlink(reservationPath)
    throw error
  }

  const stagingPath = path.join(parentDir, `.${catalogName}.staging-${randomUUID()}`)
  const records: Record<string, unknown>[] = []
  const skipped: SongSourceCatalogResult['skipped'] = []
  const seenMidi = new Set<string>()
  try {
    if (mode === 'update' || mode === 'clone') {
      await cp(sourceCatalogPath, stagingPath, {
        recursive: true,
        errorOnExist: true,
        verbatimSymlinks: true
      })
    } else {
      await mkdir(stagingPath)
    }
    const stagingRoot = await realpath(stagingPath)
    await mkdir(path.join(stagingRoot, 'assets', 'sha256'), { recursive: true })
    if (mode === 'update' || mode === 'clone') {
      const existingRecords = await readCatalogRecords(stagingRoot)
      records.push(...existingRecords)
      for (const record of existingRecords) {
        const notes = (record.chart as { notes_midi: CatalogAsset }).notes_midi
        seenMidi.add(notes.sha256)
      }
    }
    for (const [sourceIndex, source] of options.sources.entries()) {
      options.onProgress?.({
        phase: 'normalizing',
        completed: sourceIndex,
        total: options.sources.length
      })
      let candidates: CatalogCandidate[]
      try {
        candidates = await inspectDatasetSource(source)
      } catch {
        skipped.push({ sourceIndex, reason: 'Source could not be normalized' })
        continue
      }
      if (!candidates.length) {
        skipped.push({ sourceIndex, reason: 'Source has no notes.mid' })
        continue
      }
      for (const candidate of candidates) {
        if (!isValidMidi(candidate.midi)) {
          skipped.push({ sourceIndex, reason: 'Source has invalid notes.mid' })
          continue
        }
        const notesSha256 = sha256Buffer(candidate.midi)
        if (seenMidi.has(notesSha256)) {
          skipped.push({ sourceIndex, reason: 'Duplicate MIDI asset' })
          continue
        }
        const notesAsset = await materializeCatalogAsset(
          stagingRoot,
          candidate.midi,
          NOTES_MIDI,
          'audio/midi'
        )
        const audio = Object.fromEntries(
          await Promise.all(
            Object.entries(candidate.audio).map(async ([role, input]) => [
              role,
              await materializeCatalogAsset(
                stagingRoot,
                input.bytes,
                `${role}.${input.extension}`,
                input.mediaType
              )
            ])
          )
        ) as Partial<Record<CatalogAudioRole, CatalogAsset>>
        options.onProgress?.({
          phase: 'materializing',
          completed: sourceIndex + 1,
          total: options.sources.length
        })
        const record = catalogRecord(candidate, notesAsset, notesSha256, audio) as {
          rights: { training_use: string; provenance: string; license: string }
        }
        // OCTAVE curation is the admission gate. A materialized catalog is
        // therefore a trainable artifact and can never carry an unresolved
        // review state, including when this service is called directly.
        record.rights = { training_use: 'allowed', provenance, license }
        validateCatalogRecord(record)
        records.push(record)
        seenMidi.add(notesSha256)
      }
    }
    const recordsPath = path.join(stagingPath, 'records.jsonl')
    await writeFile(
      recordsPath,
      records.map((record) => JSON.stringify(record)).join('\n') + (records.length ? '\n' : ''),
      'utf8'
    )
    const existingCatalog =
      mode === 'update'
        ? (JSON.parse(await readFile(path.join(stagingRoot, 'catalog.json'), 'utf8')) as Record<
            string,
            unknown
          >)
        : null
    const catalog = {
      schema_version: 1,
      format: 'octave-song-source-catalog/v1',
      catalog_id: existingCatalog?.catalog_id ?? catalogId,
      records: 'records.jsonl',
      created_by: { product: 'octave', version: options.octaveVersion }
    }
    if (!records.length) throw new Error('No valid source records were available for the catalog.')
    await writeFile(
      path.join(stagingPath, 'catalog.json'),
      JSON.stringify(catalog, null, 2) + '\n',
      'utf8'
    )
    options.onProgress?.({
      phase: 'validating',
      completed: options.sources.length,
      total: options.sources.length
    })
    await validateStagedCatalog(stagingRoot)
    if (mode === 'update') {
      const backupPath = path.join(parentDir, `.${catalogName}.backup-${randomUUID()}`)
      await rename(catalogPath, backupPath)
      try {
        await rename(stagingRoot, catalogPath)
      } catch (error) {
        await rename(backupPath, catalogPath)
        throw error
      }
      await rm(backupPath, { recursive: true, force: true })
    } else {
      try {
        await stat(catalogPath)
        throw new Error('A catalog with that name already exists.')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      await rename(stagingRoot, catalogPath)
    }
  } catch (error) {
    await rm(stagingPath, { recursive: true, force: true })
    await reservation.close()
    await unlink(reservationPath)
    throw error
  }
  await reservation.close()
  await unlink(reservationPath)
  return {
    catalogPath,
    recordCount: records.length,
    skipped
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
