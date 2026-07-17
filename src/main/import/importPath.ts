import { promises as fs } from 'fs'
import * as path from 'path'

export async function createUniqueSongDirectory(
  libraryDir: string,
  folderName: string
): Promise<string> {
  for (let suffix = 1; ; suffix += 1) {
    const candidateName = suffix === 1 ? folderName : `${folderName} (${suffix})`
    const candidate = path.join(libraryDir, candidateName)
    try {
      await fs.mkdir(candidate)
      return candidate
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
}
