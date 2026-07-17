import { createReadStream, createWriteStream } from 'fs'
import { promises as fs } from 'fs'
import * as path from 'path'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import { SngStream, type SngHeader } from 'parse-sng'
import { createUniqueSongDirectory } from './importPath'

function sanitizeDirName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').trim()
}

function getSongFolderName(metadata: Record<string, string>): string {
  const artist = metadata.artist || 'Unknown Artist'
  const name = metadata.name || 'Unknown Song'
  return sanitizeDirName(`${artist} - ${name}`)
}

export function resolveSngOutputPath(targetDir: string, fileName: string): string {
  const root = path.resolve(targetDir)
  const outputPath = path.resolve(root, fileName)
  if (outputPath !== root && !outputPath.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Unsafe path in SNG package: ${fileName}`)
  }
  return outputPath
}

/**
 * Import a Clone Hero `.sng` package into `libraryDir` as a song folder.
 * Uses the streaming parse-sng parser so large packages are not fully buffered in memory.
 */
export async function importSng(sngFilePath: string, libraryDir: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let settled = false
    let targetDir: string | null = null
    // Serialize file writes: parse-sng emits the next file only after nextFile() is called.
    let writeChain: Promise<void> = Promise.resolve()

    const settle = (fn: () => void): void => {
      if (settled) return
      settled = true
      fn()
    }

    const fail = (error: unknown): void => {
      settle(() => reject(error instanceof Error ? error : new Error(String(error))))
    }

    const webStream = Readable.toWeb(createReadStream(sngFilePath)) as ReadableStream<Uint8Array>
    const sngStream = new SngStream(webStream, { generateSongIni: true })

    sngStream.on('header', (header: SngHeader) => {
      writeChain = writeChain
        .then(async () => {
          const songFolderName = getSongFolderName(header.metadata)
          targetDir = await createUniqueSongDirectory(libraryDir, songFolderName)
        })
        .catch(fail)
    })

    sngStream.on('file', (fileName, fileStream, nextFile) => {
      writeChain = writeChain
        .then(async () => {
          if (!targetDir) {
            throw new Error('SNG file event received before header was parsed.')
          }

          const outputPath = resolveSngOutputPath(targetDir, fileName)
          await fs.mkdir(path.dirname(outputPath), { recursive: true })

          const nodeReadable = Readable.fromWeb(
            fileStream as import('stream/web').ReadableStream<Uint8Array>
          )
          const writeStream = createWriteStream(outputPath)
          await pipeline(nodeReadable, writeStream)

          if (nextFile) {
            nextFile()
          } else {
            settle(() => resolve(targetDir!))
          }
        })
        .catch(fail)
    })

    sngStream.on('error', fail)
    sngStream.start()
  })
}
