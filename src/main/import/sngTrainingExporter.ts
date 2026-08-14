import { createHash } from 'crypto'
import { createReadStream, createWriteStream } from 'fs'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'fs/promises'
import * as path from 'path'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import { Midi } from '@tonejs/midi'
import { SngStream, type SngHeader } from 'parse-sng'

const EXPORT_FORMAT = 'octave-sng-midi-export/v1'
const NOTES_MIDI = 'notes.mid'
const EXPORTED_METADATA_KEYS = ['name', 'artist', 'album', 'genre', 'year', 'charter'] as const
const MAX_METADATA_VALUE_LENGTH = 512

export interface SngTrainingExportOptions {
  sngPaths: readonly string[]
  outputDir: string
  datasetId: string
  provenance: string
  license: string
}

interface ExportedSong {
  songId: string
  midi: string
  notesSha256: string
  packageSha256: string
  metadata: Record<string, string>
}

export interface SngTrainingExportResult {
  manifestPath: string
  exported: ExportedSong[]
  skipped: Array<{ sourceIndex: number; reason: string }>
}

function slug(value: string): string {
  const normalized = value
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
  return normalized || 'unknown-song'
}

function sanitizeMetadata(metadata: Record<string, string>): Record<string, string> {
  const sanitized: Record<string, string> = {}
  for (const key of EXPORTED_METADATA_KEYS) {
    const value = metadata[key]
    if (!value) continue
    const withoutControls = Array.from(value, (character) => {
      const codePoint = character.codePointAt(0) ?? 0
      return codePoint <= 0x1f || codePoint === 0x7f ? ' ' : character
    }).join('')
    const normalized = withoutControls.normalize('NFKC').trim().slice(0, MAX_METADATA_VALUE_LENGTH)
    if (normalized) sanitized[key] = normalized
  }
  return sanitized
}

async function hasValidMidiFile(midiPath: string): Promise<boolean> {
  try {
    const midiBytes = await readFile(midiPath)
    if (!hasValidMidiChunkLayout(midiBytes)) return false
    new Midi(midiBytes)
    return true
  } catch {
    return false
  }
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

async function sha256File(filePath: string): Promise<string> {
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) {
    digest.update(chunk)
  }
  return digest.digest('hex')
}

async function drain(fileStream: ReadableStream<Uint8Array>): Promise<void> {
  for await (const chunk of Readable.fromWeb(
    fileStream as import('stream/web').ReadableStream<Uint8Array>
  )) {
    void chunk
  }
}

async function extractNotesMidi(
  sngPath: string,
  temporaryDir: string
): Promise<Record<string, string> | null> {
  return await new Promise<Record<string, string> | null>((resolve, reject) => {
    let settled = false
    let metadata: Record<string, string> | null = null
    let wroteNotesMidi = false
    let writeChain: Promise<void> = Promise.resolve()

    const settle = (callback: () => void): void => {
      if (settled) return
      settled = true
      callback()
    }
    const fail = (error: unknown): void => {
      const normalized = error instanceof Error ? error : new Error(String(error))
      settle(() => reject(normalized))
    }

    const input = createReadStream(sngPath)
    const sngStream = new SngStream(Readable.toWeb(input) as ReadableStream<Uint8Array>, {
      generateSongIni: false
    })

    sngStream.on('header', (header: SngHeader) => {
      metadata = sanitizeMetadata(header.metadata)
      if (header.fileMeta.length === 0) {
        settle(() => resolve(null))
      }
    })
    sngStream.on('file', (fileName, fileStream, nextFile) => {
      writeChain = writeChain
        .then(async () => {
          if (fileName.toLowerCase() === NOTES_MIDI) {
            if (wroteNotesMidi) throw new Error(`Package contains multiple ${NOTES_MIDI} files`)
            await pipeline(
              Readable.fromWeb(fileStream as import('stream/web').ReadableStream<Uint8Array>),
              createWriteStream(path.join(temporaryDir, NOTES_MIDI), { flags: 'wx' })
            )
            wroteNotesMidi = true
          } else {
            await drain(fileStream as ReadableStream<Uint8Array>)
          }

          if (nextFile) {
            nextFile()
          } else {
            settle(() => resolve(wroteNotesMidi && metadata ? metadata : null))
          }
        })
        .catch(fail)
    })
    sngStream.on('error', fail)
    sngStream.start()
  })
}

async function ensureEmptyOutputDir(outputDir: string): Promise<void> {
  try {
    const entries = await readdir(outputDir)
    if (entries.length > 0) {
      throw new Error(`Training export output directory must be empty: ${outputDir}`)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    await mkdir(outputDir, { recursive: true })
  }
}

/**
 * Stream local Clone Hero SNG packages into a MIDI-only training export.
 * The output intentionally omits package paths, audio, and stems; callers must
 * record appropriate source provenance and permission before model training.
 */
export async function exportSngTrainingMidi(
  options: SngTrainingExportOptions
): Promise<SngTrainingExportResult> {
  if (!options.sngPaths.length) throw new Error('At least one SNG package is required')
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
  const temporaryRoot = path.join(outputDir, '.partial')
  await mkdir(songsDir, { recursive: true })
  await mkdir(temporaryRoot, { recursive: true })

  const exported: ExportedSong[] = []
  const skipped: Array<{ sourceIndex: number; reason: string }> = []
  try {
    for (const [sourceIndex, sourcePath] of options.sngPaths.entries()) {
      const temporaryDir = path.join(temporaryRoot, String(sourceIndex))
      await mkdir(temporaryDir)
      try {
        const metadata = await extractNotesMidi(sourcePath, temporaryDir)
        if (!metadata) {
          skipped.push({ sourceIndex, reason: `Package has no ${NOTES_MIDI}` })
          await rm(temporaryDir, { recursive: true, force: true })
          continue
        }
        const notesPath = path.join(temporaryDir, NOTES_MIDI)
        if (!(await hasValidMidiFile(notesPath))) {
          throw new Error(`Invalid ${NOTES_MIDI}`)
        }
        const [notesSha256, packageSha256] = await Promise.all([
          sha256File(notesPath),
          sha256File(sourcePath)
        ])
        const songId = `${slug(`${metadata.artist ?? ''}-${metadata.name ?? ''}`)}-${notesSha256.slice(0, 12)}`
        const songDir = path.join(songsDir, songId)
        try {
          await mkdir(songDir)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
            skipped.push({ sourceIndex, reason: `Duplicate notes.mid: ${songId}` })
            await rm(temporaryDir, { recursive: true, force: true })
            continue
          }
          throw error
        }
        await rename(notesPath, path.join(songDir, NOTES_MIDI))
        await writeFile(
          path.join(songDir, 'source-metadata.json'),
          JSON.stringify({ metadata, notesSha256, packageSha256 }, null, 2) + '\n',
          'utf8'
        )
        exported.push({
          songId,
          midi: path.posix.join('songs', songId, NOTES_MIDI),
          notesSha256,
          packageSha256,
          metadata
        })
        await rm(temporaryDir, { recursive: true, force: true })
      } catch (error) {
        await rm(temporaryDir, { recursive: true, force: true })
        void error
        skipped.push({ sourceIndex, reason: 'Package could not be read or exported' })
      }
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
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
