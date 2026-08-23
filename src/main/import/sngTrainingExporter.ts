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

type CatalogAudioRole =
  | 'mix'
  | 'drums'
  | 'guitar'
  | 'bass'
  | 'keys'
  | 'vocals'
  | 'harm1'
  | 'harm2'
  | 'harm3'
  | 'other'

type HarmonyTrackName = 'HARM1' | 'HARM2' | 'HARM3'
type HarmonyAudioRole = 'harm1' | 'harm2' | 'harm3'

const HARMONY_TRACK_AUDIO_ROLE: Record<HarmonyTrackName, HarmonyAudioRole> = {
  HARM1: 'harm1',
  HARM2: 'harm2',
  HARM3: 'harm3'
}
const HARMONY_SOURCE_POLICY_FILENAME = 'vocal-harmony-sources.json'
const HARMONY_SOURCE_POLICY_FORMAT = 'octave-vocal-harmony-source-policy/v1'
const HARMONY_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}$/
const HARMONY_SHA256_PATTERN = /^[a-f0-9]{64}$/

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

export interface CatalogHarmonyTarget {
  sourceId: string
  label: string
  tracks: HarmonyTrackName[]
  configuredTracks: HarmonyTrackName[]
}

export interface MaterializeCatalogHarmonySourceOptions {
  parentDir: string
  catalogName: string
  sourceId: string
  trackName: HarmonyTrackName
  sourceAudioPath: string
  provenance:
    | {
        kind: 'isolated_source_stem/v1'
        attestationId: string
      }
    | {
        kind: 'isolated_separation_output/v1'
        separator: {
          id: string
          version: string
          modelSha256: string
          configurationSha256: string
        }
      }
}

export interface MaterializeCatalogHarmonySourceResult {
  sourceId: string
  trackName: HarmonyTrackName
  configuredTracks: HarmonyTrackName[]
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
  provenance: string
  license: string
  recordCount: number
  libraryRecordCount: number
  externalRecordCount: number
}

type CatalogCuration = {
  provenance: string
  license: string
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

const HARMONY_TRACK_NAMES: readonly HarmonyTrackName[] = ['HARM1', 'HARM2', 'HARM3']

function discoverInstrumentCoverage(midiBytes: Buffer): DatasetSourceSummary['instruments'] {
  const coverage: DatasetSourceSummary['instruments'] = {}
  const midi = new Midi(midiBytes)
  for (const track of midi.tracks) {
    const trackName = track.name.trim()
    const harmonyTrack = HARMONY_TRACK_NAMES.find((name) => name === trackName.toUpperCase())
    const mapped = harmonyTrack
      ? ([harmonyTrack, 'vocals'] as const)
      : TRACK_INSTRUMENTS.find(([prefix]) => trackName.toUpperCase().startsWith(prefix))
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

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value)
  }
  if (typeof value === 'string') {
    // Python's ``ensure_ascii=True`` is part of STRUM's catalog-control
    // fingerprint. Keep the producer byte-for-byte compatible with it.
    return JSON.stringify(value).replace(/[\u0080-\u{10ffff}]/gu, (character) =>
      character
        .split('')
        .map((codeUnit) => `\\u${codeUnit.charCodeAt(0).toString(16).padStart(4, '0')}`)
        .join('')
    )
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${canonicalJson(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`
  }
  throw new Error('Catalog control data is invalid.')
}

function catalogControlSha256(catalog: Record<string, unknown>, recordsText: string): string {
  return sha256Buffer(Buffer.from(canonicalJson({ catalog, records_jsonl: recordsText }), 'utf8'))
}

function isHarmonyTrackName(value: unknown): value is HarmonyTrackName {
  return typeof value === 'string' && HARMONY_TRACK_NAMES.includes(value as HarmonyTrackName)
}

function validateHarmonyIdentifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !HARMONY_IDENTIFIER_PATTERN.test(value)) {
    throw new Error(`Harmony ${label} is invalid.`)
  }
  return value
}

function validateHarmonySha256(value: unknown, label: string): string {
  if (typeof value !== 'string' || !HARMONY_SHA256_PATTERN.test(value)) {
    throw new Error(`Harmony ${label} must be a SHA-256.`)
  }
  return value
}

function mediaTypeForAudioExtension(extension: (typeof AUDIO_EXTENSIONS)[number]): string {
  switch (extension) {
    case 'ogg':
      return 'audio/ogg'
    case 'opus':
      return 'audio/opus'
    case 'mp3':
      return 'audio/mpeg'
    case 'wav':
      return 'audio/wav'
    case 'flac':
      return 'audio/flac'
  }
}

async function readExplicitHarmonyAudio(sourcePath: string): Promise<CatalogAudioInput> {
  let sourceInfo: Awaited<ReturnType<typeof lstat>>
  try {
    sourceInfo = await lstat(sourcePath)
  } catch {
    // The chooser's location is private main-process state. In particular,
    // an ENOENT/EACCES error includes it in Node's message, so never let that
    // diagnostic escape through the Dataset Curation IPC handler.
    throw new Error('Selected Harmony audio is unavailable or unsupported.')
  }
  if (
    !sourceInfo.isFile() ||
    sourceInfo.isSymbolicLink() ||
    (sourceInfo.mode & 0o444) === 0 ||
    sourceInfo.size > MAX_AUDIO_ASSET_BYTES
  ) {
    throw new Error('Selected Harmony audio is unavailable or unsupported.')
  }
  const extension = path.extname(sourcePath).slice(1).toLowerCase()
  if (!isCatalogAudioExtension(extension)) {
    throw new Error('Select an OGG, MP3, Opus, WAV, or FLAC Harmony source.')
  }
  let bytes: Buffer
  try {
    bytes = await readFile(sourcePath)
  } catch {
    // Protect against deletion, relocation, permission changes, and other
    // read failures after lstat. Those errors also include source locations.
    throw new Error('Selected Harmony audio is unavailable or unsupported.')
  }
  if (bytes.length !== sourceInfo.size || bytes.length > MAX_AUDIO_ASSET_BYTES) {
    throw new Error('Selected Harmony audio is unavailable or unsupported.')
  }
  return { bytes, extension, mediaType: mediaTypeForAudioExtension(extension) }
}

async function readExactHarmonyTracks(
  catalogRoot: string,
  record: Record<string, unknown>
): Promise<HarmonyTrackName[]> {
  const chart = record.chart as { notes_midi?: CatalogAsset }
  const notes = chart.notes_midi
  if (!notes) throw new Error('Catalog source is missing notes MIDI.')
  await validateMaterializedAsset(catalogRoot, notes)
  const midi = new Midi(
    await readFile(path.resolve(catalogRoot, ...notes.relative_path.split('/')))
  )
  const tracks = new Set(
    midi.tracks.map((track) => track.name.trim().toUpperCase()).filter(isHarmonyTrackName)
  )
  return HARMONY_TRACK_NAMES.filter((track) => tracks.has(track))
}

function harmonySourceLabel(record: Record<string, unknown>): string {
  const metadata = (record.metadata ?? {}) as Record<string, unknown>
  const artist = typeof metadata.artist === 'string' ? metadata.artist : ''
  const name = typeof metadata.name === 'string' ? metadata.name : ''
  return redactLocationText(
    artist && name ? `${artist} — ${name}` : name || artist || 'Catalog source',
    'Catalog source'
  )
}

type HarmonyPolicyRecord = {
  source_id: string
  track_name: HarmonyTrackName
  audio: { role: HarmonyAudioRole; asset_id: string; sha256: string }
  provenance:
    | {
        kind: 'isolated_source_stem/v1'
        timeline: 'same-master-timeline/v1'
        attestation_id: string
      }
    | {
        kind: 'isolated_separation_output/v1'
        timeline: 'same-master-timeline/v1'
        input: { asset_id: string; sha256: string }
        separator: {
          id: string
          version: string
          model_sha256: string
          configuration_sha256: string
        }
      }
}

function catalogAssetIdentity(asset: CatalogAsset): { asset_id: string; sha256: string } {
  return { asset_id: asset.asset_id, sha256: asset.sha256 }
}

function validateExistingHarmonyPolicy(
  raw: unknown,
  catalog: Record<string, unknown>,
  records: readonly Record<string, unknown>[],
  controlSha256: string
): { policyId: string; records: HarmonyPolicyRecord[] } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Existing Harmony source policy is invalid.')
  }
  const policy = raw as Record<string, unknown>
  if (
    Object.keys(policy).length !== 6 ||
    policy.schema_version !== 1 ||
    policy.format !== HARMONY_SOURCE_POLICY_FORMAT ||
    policy.catalog_id !== catalog.catalog_id ||
    policy.catalog_control_sha256 !== controlSha256 ||
    !Array.isArray(policy.records)
  ) {
    throw new Error('Existing Harmony source policy does not match this catalog.')
  }
  const policyId = validateHarmonyIdentifier(policy.policy_id, 'policy ID')
  const bySourceId = new Map(records.map((record) => [String(record.source_id), record]))
  const seen = new Set<string>()
  const validRows: HarmonyPolicyRecord[] = []
  for (const value of policy.records) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Existing Harmony source policy is invalid.')
    }
    const row = value as Record<string, unknown>
    if (Object.keys(row).length !== 4 || !isHarmonyTrackName(row.track_name)) {
      throw new Error('Existing Harmony source policy is invalid.')
    }
    const sourceId = validateHarmonyIdentifier(row.source_id, 'source ID')
    const key = `${sourceId}:${row.track_name}`
    if (seen.has(key)) throw new Error('Existing Harmony source policy is invalid.')
    seen.add(key)
    const record = bySourceId.get(sourceId)
    if (!record) throw new Error('Existing Harmony source policy is invalid.')
    const expectedRole = HARMONY_TRACK_AUDIO_ROLE[row.track_name]
    const audio = row.audio as Record<string, unknown> | undefined
    const recordAudio = (record.audio ?? {}) as Partial<Record<CatalogAudioRole, CatalogAsset>>
    const asset = recordAudio[expectedRole]
    if (
      !asset ||
      !audio ||
      Object.keys(audio).length !== 3 ||
      audio.role !== expectedRole ||
      audio.asset_id !== asset.asset_id ||
      audio.sha256 !== asset.sha256
    ) {
      throw new Error('Existing Harmony source policy is invalid.')
    }
    const provenance = row.provenance as Record<string, unknown> | undefined
    if (!provenance || provenance.timeline !== 'same-master-timeline/v1') {
      throw new Error('Existing Harmony source policy is invalid.')
    }
    if (provenance.kind === 'isolated_source_stem/v1') {
      if (Object.keys(provenance).length !== 3)
        throw new Error('Existing Harmony source policy is invalid.')
      validRows.push({
        source_id: sourceId,
        track_name: row.track_name,
        audio: { role: expectedRole, ...catalogAssetIdentity(asset) },
        provenance: {
          kind: 'isolated_source_stem/v1',
          timeline: 'same-master-timeline/v1',
          attestation_id: validateHarmonyIdentifier(provenance.attestation_id, 'attestation ID')
        }
      })
      continue
    }
    if (
      provenance.kind !== 'isolated_separation_output/v1' ||
      Object.keys(provenance).length !== 4
    ) {
      throw new Error('Existing Harmony source policy is invalid.')
    }
    const mix = recordAudio.mix
    const input = provenance.input as Record<string, unknown> | undefined
    const separator = provenance.separator as Record<string, unknown> | undefined
    if (
      !mix ||
      !input ||
      Object.keys(input).length !== 2 ||
      input.asset_id !== mix.asset_id ||
      input.sha256 !== mix.sha256 ||
      !separator ||
      Object.keys(separator).length !== 4
    ) {
      throw new Error('Existing Harmony source policy is invalid.')
    }
    validRows.push({
      source_id: sourceId,
      track_name: row.track_name,
      audio: { role: expectedRole, ...catalogAssetIdentity(asset) },
      provenance: {
        kind: 'isolated_separation_output/v1',
        timeline: 'same-master-timeline/v1',
        input: catalogAssetIdentity(mix),
        separator: {
          id: validateHarmonyIdentifier(separator.id, 'separator ID'),
          version: validateHarmonyIdentifier(separator.version, 'separator version'),
          model_sha256: validateHarmonySha256(separator.model_sha256, 'separator model hash'),
          configuration_sha256: validateHarmonySha256(
            separator.configuration_sha256,
            'separator configuration hash'
          )
        }
      }
    })
  }
  return { policyId, records: validRows }
}

async function readExistingHarmonyPolicy(
  catalogRoot: string,
  catalog: Record<string, unknown>,
  records: readonly Record<string, unknown>[],
  controlSha256: string
): Promise<{ policyId: string; records: HarmonyPolicyRecord[] } | null> {
  const policyPath = path.join(catalogRoot, HARMONY_SOURCE_POLICY_FILENAME)
  try {
    const policyInfo = await lstat(policyPath)
    if (!policyInfo.isFile() || policyInfo.isSymbolicLink()) {
      throw new Error('Existing Harmony source policy is invalid.')
    }
    return validateExistingHarmonyPolicy(
      JSON.parse(await readFile(policyPath, 'utf8')),
      catalog,
      records,
      controlSha256
    )
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function replaceCatalogAtomically(
  parentDir: string,
  catalogName: string,
  stagingPath: string
): Promise<void> {
  const catalogPath = path.join(parentDir, catalogName)
  const backupPath = path.join(parentDir, `.${catalogName}.backup-${randomUUID()}`)
  await rename(catalogPath, backupPath)
  try {
    await rename(stagingPath, catalogPath)
  } catch (error) {
    await rename(backupPath, catalogPath)
    throw error
  }
  await rm(backupPath, { recursive: true, force: true }).catch(() => undefined)
}

type CatalogMutationReservation = {
  path: string
  handle: Awaited<ReturnType<typeof open>>
}

/**
 * Mutating operations replace a complete catalog directory after staging. A
 * single catalog-level reservation therefore protects both the generic
 * create/update/clone flow and Harmony materialization from lost replacements.
 */
async function reserveCatalogMutation(
  parentDir: string,
  catalogName: string
): Promise<CatalogMutationReservation> {
  const reservationPath = path.join(parentDir, `.${catalogName}.mutation-reservation`)
  try {
    return { path: reservationPath, handle: await open(reservationPath, 'wx') }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error('A catalog mutation with that name is already in progress.')
    }
    // fs errors expose the parent directory. It is private main-process state.
    throw new Error('The catalog mutation could not be started.')
  }
}

async function releaseCatalogMutation(reservation: CatalogMutationReservation): Promise<void> {
  await reservation.handle.close().catch(() => undefined)
  await unlink(reservation.path).catch(() => undefined)
}

async function reserveCatalogMutations(
  parentDir: string,
  catalogNames: readonly string[]
): Promise<CatalogMutationReservation[]> {
  const names = [...new Set(catalogNames)].sort((left, right) => left.localeCompare(right))
  const reservations: CatalogMutationReservation[] = []
  try {
    for (const catalogName of names) {
      reservations.push(await reserveCatalogMutation(parentDir, catalogName))
    }
    return reservations
  } catch (error) {
    for (const reservation of reservations.reverse()) await releaseCatalogMutation(reservation)
    throw error
  }
}

async function releaseCatalogMutations(
  reservations: readonly CatalogMutationReservation[]
): Promise<void> {
  for (const reservation of [...reservations].reverse()) await releaseCatalogMutation(reservation)
}

export async function listCatalogHarmonyTargets(
  parentDir: string,
  requestedCatalogName: string
): Promise<CatalogHarmonyTarget[]> {
  const catalogName = validateCatalogName(requestedCatalogName)
  const catalogRoot = path.join(path.resolve(parentDir), catalogName)
  await validateStagedCatalog(catalogRoot)
  const catalog = JSON.parse(
    await readFile(path.join(catalogRoot, 'catalog.json'), 'utf8')
  ) as Record<string, unknown>
  const records = await readCatalogRecords(catalogRoot)
  const policy = await readExistingHarmonyPolicy(
    catalogRoot,
    catalog,
    records,
    catalogControlSha256(catalog, await readFile(path.join(catalogRoot, 'records.jsonl'), 'utf8'))
  )
  const configured = new Map<string, Set<HarmonyTrackName>>()
  for (const row of policy?.records ?? []) {
    const tracks = configured.get(row.source_id) ?? new Set<HarmonyTrackName>()
    tracks.add(row.track_name)
    configured.set(row.source_id, tracks)
  }
  const targets = await Promise.all(
    records.map(async (record) => ({
      record,
      tracks: await readExactHarmonyTracks(catalogRoot, record)
    }))
  )
  return targets
    .filter(
      ({ record, tracks }) =>
        (record.rights as { training_use?: string }).training_use === 'allowed' && tracks.length
    )
    .map(({ record, tracks }) => ({
      sourceId: String(record.source_id),
      label: harmonySourceLabel(record),
      tracks,
      configuredTracks: HARMONY_TRACK_NAMES.filter((track) =>
        configured.get(String(record.source_id))?.has(track)
      )
    }))
}

export async function materializeCatalogHarmonySource(
  options: MaterializeCatalogHarmonySourceOptions
): Promise<MaterializeCatalogHarmonySourceResult> {
  const catalogName = validateCatalogName(options.catalogName)
  const sourceId = validateHarmonyIdentifier(options.sourceId, 'source ID')
  if (!isHarmonyTrackName(options.trackName)) throw new Error('Harmony track is invalid.')
  const parentDir = path.resolve(options.parentDir)
  const catalogPath = path.join(parentDir, catalogName)
  const reservation = await reserveCatalogMutation(parentDir, catalogName)
  const stagingPath = path.join(parentDir, `.${catalogName}.harmony-staging-${randomUUID()}`)
  try {
    await validateStagedCatalog(catalogPath)
    const sourceAudio = await readExplicitHarmonyAudio(options.sourceAudioPath)
    const catalog = JSON.parse(
      await readFile(path.join(catalogPath, 'catalog.json'), 'utf8')
    ) as Record<string, unknown>
    const existingRecords = await readCatalogRecords(catalogPath)
    const recordsText = await readFile(path.join(catalogPath, 'records.jsonl'), 'utf8')
    const existingPolicy = await readExistingHarmonyPolicy(
      catalogPath,
      catalog,
      existingRecords,
      catalogControlSha256(catalog, recordsText)
    )
    const target = existingRecords.find((record) => record.source_id === sourceId)
    if (!target || (target.rights as { training_use?: string }).training_use !== 'allowed') {
      throw new Error('Choose an allowed catalog source for Harmony materialization.')
    }
    const availableTracks = await readExactHarmonyTracks(catalogPath, target)
    if (!availableTracks.includes(options.trackName)) {
      throw new Error('The selected catalog source does not contain that exact HARM track.')
    }
    const targetAudio = (target.audio ?? {}) as Partial<Record<CatalogAudioRole, CatalogAsset>>
    const role = HARMONY_TRACK_AUDIO_ROLE[options.trackName]
    const forbiddenHashes = new Set(
      [targetAudio.mix?.sha256, targetAudio.vocals?.sha256].filter(Boolean)
    )
    const sourceSha256 = sha256Buffer(sourceAudio.bytes)
    if (forbiddenHashes.has(sourceSha256)) {
      throw new Error('Harmony audio must not duplicate the catalog mix or shared vocals asset.')
    }
    let provenance: HarmonyPolicyRecord['provenance']
    if (options.provenance.kind === 'isolated_source_stem/v1') {
      provenance = {
        kind: 'isolated_source_stem/v1',
        timeline: 'same-master-timeline/v1',
        attestation_id: validateHarmonyIdentifier(
          options.provenance.attestationId,
          'attestation ID'
        )
      }
    } else if (options.provenance.kind === 'isolated_separation_output/v1') {
      const mix = targetAudio.mix
      if (!mix) throw new Error('Pinned separation output requires a catalog mix asset.')
      provenance = {
        kind: 'isolated_separation_output/v1',
        timeline: 'same-master-timeline/v1',
        input: catalogAssetIdentity(mix),
        separator: {
          id: validateHarmonyIdentifier(options.provenance.separator.id, 'separator ID'),
          version: validateHarmonyIdentifier(
            options.provenance.separator.version,
            'separator version'
          ),
          model_sha256: validateHarmonySha256(
            options.provenance.separator.modelSha256,
            'separator model hash'
          ),
          configuration_sha256: validateHarmonySha256(
            options.provenance.separator.configurationSha256,
            'separator configuration hash'
          )
        }
      }
    } else {
      throw new Error('Harmony provenance is invalid.')
    }
    await cp(catalogPath, stagingPath, {
      recursive: true,
      errorOnExist: true,
      verbatimSymlinks: true
    })
    const stagingRoot = await realpath(stagingPath)
    const stagedRecords = await readCatalogRecords(stagingRoot)
    const stagedTarget = stagedRecords.find((record) => record.source_id === sourceId)
    if (!stagedTarget) throw new Error('Catalog source is unavailable.')
    const asset = await materializeCatalogAsset(
      stagingRoot,
      sourceAudio.bytes,
      `${role}.${sourceAudio.extension}`,
      sourceAudio.mediaType
    )
    const stagedAudio = (stagedTarget.audio ??= {}) as Partial<
      Record<CatalogAudioRole, CatalogAsset>
    >
    stagedAudio[role] = asset
    for (const record of stagedRecords) validateCatalogRecord(record)
    const stagedRecordsText = `${stagedRecords.map((record) => JSON.stringify(record)).join('\n')}\n`
    await writeFile(path.join(stagingRoot, 'records.jsonl'), stagedRecordsText, 'utf8')
    const stagedCatalog = JSON.parse(
      await readFile(path.join(stagingRoot, 'catalog.json'), 'utf8')
    ) as Record<string, unknown>
    const updatedRows = (existingPolicy?.records ?? []).filter(
      (row) => row.source_id !== sourceId || row.track_name !== options.trackName
    )
    updatedRows.push({
      source_id: sourceId,
      track_name: options.trackName,
      audio: { role, ...catalogAssetIdentity(asset) },
      provenance
    })
    updatedRows.sort((left, right) =>
      `${left.source_id}:${left.track_name}`.localeCompare(`${right.source_id}:${right.track_name}`)
    )
    const policy = {
      schema_version: 1,
      format: HARMONY_SOURCE_POLICY_FORMAT,
      policy_id: existingPolicy?.policyId ?? `octave-harmony-${randomUUID()}`,
      catalog_id: stagedCatalog.catalog_id,
      catalog_control_sha256: catalogControlSha256(stagedCatalog, stagedRecordsText),
      records: updatedRows
    }
    // Read back through the strict policy validator before replacing the live
    // catalog. That proves every retained row still binds to catalog assets.
    await writeFile(
      path.join(stagingRoot, HARMONY_SOURCE_POLICY_FILENAME),
      `${JSON.stringify(policy, null, 2)}\n`,
      'utf8'
    )
    await validateStagedCatalog(stagingRoot)
    await readExistingHarmonyPolicy(
      stagingRoot,
      stagedCatalog,
      stagedRecords,
      catalogControlSha256(stagedCatalog, stagedRecordsText)
    )
    await replaceCatalogAtomically(parentDir, catalogName, stagingRoot)
    return {
      sourceId,
      trackName: options.trackName,
      configuredTracks: HARMONY_TRACK_NAMES.filter((track) =>
        updatedRows.some((row) => row.source_id === sourceId && row.track_name === track)
      )
    }
  } catch (error) {
    await rm(stagingPath, { recursive: true, force: true })
    throw error
  } finally {
    await releaseCatalogMutation(reservation)
  }
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
          // v1 catalogs created before catalog-level curation metadata keep
          // their rights on every record. Preserve that compatibility while
          // preferring the durable catalog-wide values for the editor.
          const legacyRights = records[0].rights as CatalogCuration
          const curation = catalog.curation as CatalogCuration | undefined
          const rights = curation ?? legacyRights
          const libraryRecordCount = records.filter(
            (record) => (record.import as { kind?: string }).kind === 'song_folder'
          ).length
          return {
            catalogName: entry.name,
            catalogId: String(catalog.catalog_id),
            provenance: rights.provenance,
            license: rights.license,
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
  const reservations = await reserveCatalogMutations(
    parentDir,
    mode === 'clone' ? [catalogName, sourceCatalogName] : [catalogName]
  )
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
    await releaseCatalogMutations(reservations)
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
    // A copied policy is valid only for its exact catalog-control identity.
    // Catalog edits below can change records, rights, or catalog_id, so never
    // carry a stale Harmony admission policy into an update/clone. A curator
    // can explicitly recreate rows through the dedicated Harmony flow.
    if (mode === 'update' || mode === 'clone') {
      await unlink(path.join(stagingRoot, HARMONY_SOURCE_POLICY_FILENAME)).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      })
    }
    if (mode === 'update' || mode === 'clone') {
      const existingRecords = await readCatalogRecords(stagingRoot)
      if (mode === 'update' || mode === 'clone') {
        for (const record of existingRecords) {
          record.rights = { training_use: 'allowed', provenance, license }
          validateCatalogRecord(record)
        }
      }
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
      curation: { provenance, license },
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
    throw error
  } finally {
    await releaseCatalogMutations(reservations)
  }
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
