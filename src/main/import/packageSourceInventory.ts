import { createHash } from 'crypto'
import { createReadStream } from 'fs'
import { open, stat } from 'fs/promises'
import { Readable } from 'stream'
import { Midi } from '@tonejs/midi'
import AdmZip from 'adm-zip'
import { SngStream, type SngHeader } from 'parse-sng'
import { StfsParser } from './conImporter'
import { parseDta } from './dtaParser'
import type { DatasetCatalogSource } from './sngTrainingExporter'

const NOTES_MIDI = 'notes.mid'
const NOTES_CHART = 'notes.chart'
const MAX_PACKAGE_BYTES = 2 * 1024 * 1024 * 1024
const MAX_MIDI_BYTES = 64 * 1024 * 1024
const MAX_ZIP_ENTRIES = 2_000
const MAX_ZIP_ENTRY_BYTES = 64 * 1024 * 1024
const MAX_PACKAGE_COUNT = 1_000
const PACKAGE_TIMEOUT_MS = 15_000

export interface DatasetPackageSourceInventory {
  /** Packages requested by the opaque selection, before the bounded work limit. */
  selectedPackageCount: number
  /** Packages actually inspected; further selections are reported but not opened. */
  inspectedPackageCount: number
  packageLimitReachedCount: number
  /** A package file could be opened and was within the bounded input limit. */
  readablePackageCount: number
  /** The container parser reached its package/header representation. */
  readableHeaderCount: number
  unreadablePackageCount: number
  /** Per-song/package chart candidates represented by a MIDI or notes.chart entry. */
  inspectedChartCount: number
  validNotesMidiCount: number
  /** Includes chart-only inputs; `chartOnlyCount` is the useful subset. */
  invalidOrMissingNotesMidiCount: number
  /** Has notes.chart but no MIDI that safely parses as a Standard MIDI File. */
  chartOnlyCount: number
  /** Exactly one canonical PART VOCALS track with observed Vocal label events. */
  exactExpertPartVocalsCount: number
  /** Later instances of a MIDI content hash; no hashes or source identities leave main. */
  duplicateMidiCount: number
  /** Later instances of a bounded container content hash; no hashes leave main. */
  duplicateContainerCount: number
  containerIdentityUnavailableCount: number
  decodeTimeoutCount: number
  decodeFailureCount: number
}

interface InventoryChart {
  midi: Buffer | null
  midiCount: number
  hasChart: boolean
}

interface PackageInspection {
  headerReadable: boolean
  charts: InventoryChart[]
}

function emptyInventory(selectedPackageCount: number): DatasetPackageSourceInventory {
  return {
    selectedPackageCount,
    inspectedPackageCount: 0,
    packageLimitReachedCount: 0,
    readablePackageCount: 0,
    readableHeaderCount: 0,
    unreadablePackageCount: 0,
    inspectedChartCount: 0,
    validNotesMidiCount: 0,
    invalidOrMissingNotesMidiCount: 0,
    chartOnlyCount: 0,
    exactExpertPartVocalsCount: 0,
    duplicateMidiCount: 0,
    duplicateContainerCount: 0,
    containerIdentityUnavailableCount: 0,
    decodeTimeoutCount: 0,
    decodeFailureCount: 0
  }
}

function normalizedEntryName(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase()
}

function entryDirectory(value: string): string {
  const normalized = normalizedEntryName(value)
  const slash = normalized.lastIndexOf('/')
  return slash === -1 ? '' : normalized.slice(0, slash + 1)
}

function safeZipEntryName(entryName: string): string | null {
  const normalized = normalizedEntryName(entryName)
  if (
    !normalized ||
    normalized.startsWith('/') ||
    /^[a-z]:\//i.test(normalized) ||
    normalized.split('/').some((part) => part === '..')
  ) {
    return null
  }
  return normalized
}

function validMidiChunkLayout(midi: Buffer): boolean {
  if (
    midi.length < 14 ||
    midi.subarray(0, 4).toString('ascii') !== 'MThd' ||
    midi.readUInt32BE(4) !== 6
  ) {
    return false
  }
  const trackCount = midi.readUInt16BE(10)
  if (trackCount === 0) return false
  let offset = 14
  for (let index = 0; index < trackCount; index += 1) {
    if (
      offset + 8 > midi.length ||
      midi.subarray(offset, offset + 4).toString('ascii') !== 'MTrk'
    ) {
      return false
    }
    const trackLength = midi.readUInt32BE(offset + 4)
    offset += 8
    if (trackLength > midi.length - offset) return false
    offset += trackLength
  }
  return offset === midi.length
}

/** Reject malformed channel data that permissive MIDI readers can silently normalize. */
function hasStrictMidiEventData(midi: Buffer): boolean {
  const readVariableLength = (end: number, start: number): number | null => {
    let offset = start
    for (let count = 0; count < 4; count += 1) {
      if (offset >= end) return null
      const value = midi[offset++]
      if ((value & 0x80) === 0) return offset
    }
    return null
  }
  let offset = 14
  const tracks = midi.readUInt16BE(10)
  for (let track = 0; track < tracks; track += 1) {
    const trackLength = midi.readUInt32BE(offset + 4)
    const end = offset + 8 + trackLength
    offset += 8
    let runningStatus = 0
    while (offset < end) {
      const afterDelta = readVariableLength(end, offset)
      if (afterDelta === null || afterDelta >= end) return false
      offset = afterDelta
      let status = midi[offset]
      let dataStart = offset + 1
      if (status < 0x80) {
        if (runningStatus < 0x80 || runningStatus > 0xef) return false
        status = runningStatus
        dataStart = offset
      } else if (status >= 0x80 && status <= 0xef) {
        runningStatus = status
      } else {
        runningStatus = 0
      }
      if (status >= 0x80 && status <= 0xef) {
        const dataLength = (status & 0xf0) === 0xc0 || (status & 0xf0) === 0xd0 ? 1 : 2
        if (dataStart + dataLength > end) return false
        for (let index = 0; index < dataLength; index += 1) {
          if (midi[dataStart + index] >= 0x80) return false
        }
        offset = dataStart + dataLength
        continue
      }
      if (status === 0xff) {
        if (dataStart >= end) return false
        const payloadStart = readVariableLength(end, dataStart + 1)
        if (payloadStart === null) return false
        let length = 0
        for (let index = dataStart + 1; index < payloadStart; index += 1) {
          length = (length << 7) | (midi[index] & 0x7f)
        }
        offset = payloadStart + length
        if (offset > end) return false
        continue
      }
      if (status === 0xf0 || status === 0xf7) {
        const payloadStart = readVariableLength(end, dataStart)
        if (payloadStart === null) return false
        let length = 0
        for (let index = dataStart; index < payloadStart; index += 1) {
          length = (length << 7) | (midi[index] & 0x7f)
        }
        offset = payloadStart + length
        if (offset > end) return false
        continue
      }
      const systemDataLength = status === 0xf1 || status === 0xf3 ? 1 : status === 0xf2 ? 2 : 0
      if (![0xf1, 0xf2, 0xf3, 0xf6, 0xf8, 0xf9, 0xfa, 0xfb, 0xfc, 0xfd, 0xfe].includes(status)) {
        return false
      }
      if (dataStart + systemDataLength > end) return false
      for (let index = 0; index < systemDataLength; index += 1) {
        if (midi[dataStart + index] >= 0x80) return false
      }
      offset = dataStart + systemDataLength
    }
    if (offset !== end) return false
  }
  return true
}

function parseSafeMidi(midi: Buffer): Midi | null {
  if (
    midi.length > MAX_MIDI_BYTES ||
    !validMidiChunkLayout(midi) ||
    !hasStrictMidiEventData(midi)
  ) {
    return null
  }
  try {
    return new Midi(midi)
  } catch {
    return null
  }
}

function hasExactExpertPartVocals(midi: Midi): boolean {
  const tracks = midi.tracks.filter((track) => track.name === 'PART VOCALS')
  if (tracks.length !== 1) return false
  // Vocal parts do not use the five-lane difficulty bands. OCTAVE records
  // their present coverage as Expert; verify the canonical lead track has an
  // actual sung-pitch (36..84) or talky (96) label rather than a name alone.
  return tracks[0].notes.some((note) => (note.midi >= 36 && note.midi <= 84) || note.midi === 96)
}

async function readLimitedFile(filePath: string, maxBytes: number): Promise<Buffer> {
  const handle = await open(filePath, 'r')
  try {
    const info = await handle.stat()
    if (info.size > maxBytes) throw new Error('Package entry is too large.')
    const bytes = Buffer.alloc(info.size)
    await handle.read(bytes, 0, bytes.length, 0)
    return bytes
  } finally {
    await handle.close()
  }
}

async function inspectSng(sourcePath: string): Promise<PackageInspection> {
  return await new Promise((resolve, reject) => {
    const input = createReadStream(sourcePath)
    let settled = false
    let headerReadable = false
    let expectedFiles: number | null = null
    let completedFiles = 0
    let notesMidi: Buffer | null = null
    let notesMidiCount = 0
    let hasChart = false
    let active: ReadableStream<Uint8Array> | null = null
    const timeout = setTimeout(
      () => fail(new Error('Package decode timed out.')),
      PACKAGE_TIMEOUT_MS
    )
    const stop = (): void => {
      if (active) void active.cancel().catch(() => undefined)
      if (!input.destroyed) input.destroy()
    }
    const settle = (callback: () => void, stopStreams = false): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (stopStreams) stop()
      callback()
    }
    const fail = (error: unknown): void =>
      settle(() => reject(error instanceof Error ? error : new Error(String(error))), true)
    input.on('error', () => undefined)
    const parser = new SngStream(Readable.toWeb(input) as ReadableStream<Uint8Array>, {
      generateSongIni: false
    })
    parser.on('header', (header: SngHeader) => {
      headerReadable = true
      expectedFiles = header.fileMeta.length
      if (expectedFiles === 0) settle(() => resolve({ headerReadable, charts: [] }), true)
    })
    parser.on('file', (fileName, fileStream, nextFile) => {
      void (async () => {
        if (settled) return
        if (expectedFiles === null || completedFiles >= expectedFiles) {
          throw new Error('Invalid SNG file sequence.')
        }
        active = fileStream as ReadableStream<Uint8Array>
        const name = normalizedEntryName(fileName)
        if (name === NOTES_MIDI) {
          notesMidiCount += 1
          const chunks: Buffer[] = []
          let byteLength = 0
          for await (const chunk of Readable.fromWeb(
            fileStream as import('stream/web').ReadableStream<Uint8Array>
          )) {
            byteLength += chunk.length
            if (byteLength > MAX_MIDI_BYTES) throw new Error('MIDI entry is too large.')
            chunks.push(Buffer.from(chunk))
          }
          notesMidi = Buffer.concat(chunks)
        } else {
          if (name === NOTES_CHART) hasChart = true
          for await (const chunk of Readable.fromWeb(
            fileStream as import('stream/web').ReadableStream<Uint8Array>
          )) {
            void chunk
          }
        }
        active = null
        completedFiles += 1
        if (completedFiles === expectedFiles) {
          settle(
            () =>
              resolve({
                headerReadable,
                charts: [
                  {
                    midi: notesMidiCount === 1 ? notesMidi : null,
                    midiCount: notesMidiCount,
                    hasChart
                  }
                ]
              }),
            true
          )
          return
        }
        if (!nextFile) throw new Error('SNG package ended before all files were read.')
        nextFile()
      })().catch(fail)
    })
    parser.on('error', fail)
    parser.start()
  })
}

function inspectZip(sourcePath: string): PackageInspection {
  const archive = new AdmZip(sourcePath)
  const entries = archive.getEntries()
  if (entries.length > MAX_ZIP_ENTRIES) throw new Error('ZIP archive has too many entries.')
  const charts = new Map<string, InventoryChart>()
  for (const entry of entries) {
    if (entry.isDirectory) continue
    const name = safeZipEntryName(entry.entryName)
    if (
      !name ||
      !Number.isSafeInteger(entry.header.size) ||
      entry.header.size > MAX_ZIP_ENTRY_BYTES
    ) {
      throw new Error('ZIP archive entry is unsafe or too large.')
    }
    const base = name.slice(name.lastIndexOf('/') + 1)
    if (base !== NOTES_MIDI && base !== NOTES_CHART) continue
    const directory = entryDirectory(name)
    const chart = charts.get(directory) ?? { midi: null, midiCount: 0, hasChart: false }
    if (base === NOTES_CHART) chart.hasChart = true
    else {
      chart.midiCount += 1
      chart.midi = chart.midiCount === 1 ? entry.getData() : null
    }
    charts.set(directory, chart)
  }
  return { headerReadable: true, charts: [...charts.values()] }
}

function findConMidi(
  entries: Record<string, Buffer>,
  shortname: string,
  allowGlobalFallback: boolean
): Buffer | null {
  const short = shortname.toLowerCase()
  for (const [entryPath, value] of Object.entries(entries)) {
    const normalized = normalizedEntryName(entryPath)
    if (normalized === `${short}.mid` || normalized.endsWith(`/${short}.mid`)) return value
  }
  if (!allowGlobalFallback) return null
  return (
    Object.entries(entries).find(([entryPath]) =>
      normalizedEntryName(entryPath).endsWith('.mid')
    )?.[1] ?? null
  )
}

async function inspectCon(sourcePath: string): Promise<PackageInspection> {
  const parser = new StfsParser(await readLimitedFile(sourcePath, MAX_PACKAGE_BYTES))
  const { entries } = parser.parse()
  const dta = Object.entries(entries).find(([entryPath]) =>
    normalizedEntryName(entryPath).endsWith('songs/songs.dta')
  )?.[1]
  if (!dta) return { headerReadable: true, charts: [] }
  const songs = Object.values(parseDta(dta.toString('latin1')))
  const allowGlobalFallback = songs.length === 1
  return {
    headerReadable: true,
    charts: songs.map((song) => ({
      midi: findConMidi(entries, song.shortname, allowGlobalFallback),
      midiCount: 1,
      hasChart: false
    }))
  }
}

async function inspectPackage(source: DatasetCatalogSource): Promise<PackageInspection> {
  if (source.kind === 'sng') return await inspectSng(source.sourcePath)
  if (source.kind === 'zip') return inspectZip(source.sourcePath)
  if (source.kind === 'rb3con') return await inspectCon(source.sourcePath)
  throw new Error('Only externally selected package sources may be inventoried.')
}

async function hashContainer(sourcePath: string): Promise<string | null> {
  const info = await stat(sourcePath)
  if (info.size > MAX_PACKAGE_BYTES) return null
  const digest = createHash('sha256')
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(sourcePath)
    const timeout = setTimeout(() => {
      stream.destroy(new Error('Package identity read timed out.'))
    }, PACKAGE_TIMEOUT_MS)
    stream.on('data', (chunk: string | Buffer) => digest.update(chunk))
    stream.on('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    stream.on('end', () => {
      clearTimeout(timeout)
      resolve()
    })
  })
  return digest.digest('hex')
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && /timed out/i.test(error.message)
}

/**
 * Inspect main-process package sources without producing catalog candidates.
 * The returned object is aggregate-only: no locations, entry names, metadata,
 * hashes, errors, or opaque IDs are present in this renderer-safe result.
 */
export async function inventoryDatasetPackageSources(
  sources: readonly DatasetCatalogSource[]
): Promise<DatasetPackageSourceInventory> {
  const inventory = emptyInventory(sources.length)
  const midiHashes = new Set<string>()
  const containerHashes = new Set<string>()
  const boundedSources = sources.slice(0, MAX_PACKAGE_COUNT)
  inventory.packageLimitReachedCount = sources.length - boundedSources.length
  for (const source of boundedSources) {
    inventory.inspectedPackageCount += 1
    try {
      const info = await stat(source.sourcePath)
      if (!info.isFile() || info.size > MAX_PACKAGE_BYTES)
        throw new Error('Package is unavailable or too large.')
      inventory.readablePackageCount += 1
      let containerHash: string | null = null
      try {
        containerHash = await hashContainer(source.sourcePath)
      } catch (error) {
        if (isTimeout(error)) inventory.decodeTimeoutCount += 1
        else inventory.containerIdentityUnavailableCount += 1
      }
      if (containerHash === null) inventory.containerIdentityUnavailableCount += 1
      else if (containerHashes.has(containerHash)) inventory.duplicateContainerCount += 1
      else containerHashes.add(containerHash)

      const inspected = await inspectPackage(source)
      if (inspected.headerReadable) inventory.readableHeaderCount += 1
      for (const chart of inspected.charts) {
        inventory.inspectedChartCount += 1
        const midi = chart.midiCount === 1 && chart.midi ? parseSafeMidi(chart.midi) : null
        if (!midi || !chart.midi) {
          inventory.invalidOrMissingNotesMidiCount += 1
          if (chart.hasChart) inventory.chartOnlyCount += 1
          continue
        }
        inventory.validNotesMidiCount += 1
        if (hasExactExpertPartVocals(midi)) inventory.exactExpertPartVocalsCount += 1
        const midiHash = createHash('sha256').update(chart.midi).digest('hex')
        if (midiHashes.has(midiHash)) inventory.duplicateMidiCount += 1
        else midiHashes.add(midiHash)
      }
    } catch (error) {
      inventory.unreadablePackageCount += 1
      if (isTimeout(error)) inventory.decodeTimeoutCount += 1
      else inventory.decodeFailureCount += 1
    }
  }
  return inventory
}
