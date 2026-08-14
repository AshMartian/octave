import { existsSync } from 'fs'
import { mkdir, readFile, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { packRb3con } from '../conPacker'
import { packSng } from '../sngPacker'
import { exportSngTrainingMidi, listDatasetLibrarySongs } from './sngTrainingExporter'

describe('exportSngTrainingMidi', () => {
  const testDir = join(__dirname, '../../../out/sng_training_exporter_test_temp')
  const validMidi = Buffer.from([
    0x4d, 0x54, 0x68, 0x64, 0x00, 0x00, 0x00, 0x06, 0x00, 0x01, 0x00, 0x01, 0x01, 0xe0, 0x4d, 0x54,
    0x72, 0x6b, 0x00, 0x00, 0x00, 0x04, 0x00, 0xff, 0x2f, 0x00
  ])
  const truncatedMidi = Buffer.from([
    0x4d, 0x54, 0x68, 0x64, 0x00, 0x00, 0x00, 0x06, 0x00, 0x01, 0x00, 0x01, 0x01, 0xe0, 0x4d, 0x54,
    0x72, 0x6b, 0x00, 0x00, 0x00, 0x04, 0x00, 0xff
  ])

  function emptySngPackage(): Buffer {
    const header = Buffer.alloc(26)
    header.write('SNGPKG')
    header.writeUInt32LE(1, 6)
    const metadata = Buffer.alloc(16)
    metadata.writeBigUInt64LE(8n, 0)
    const fileIndex = Buffer.alloc(16)
    fileIndex.writeBigUInt64LE(8n, 0)
    const payloadLength = Buffer.alloc(8)
    return Buffer.concat([header, metadata, fileIndex, payloadLength])
  }

  beforeAll(async () => {
    await mkdir(testDir, { recursive: true })
  })

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true })
  })

  it('exports notes.mid and metadata without copying audio or source paths', async () => {
    const songDir = join(testDir, 'source-song')
    await mkdir(songDir, { recursive: true })
    await writeFile(join(songDir, 'notes.mid'), validMidi)
    await writeFile(join(songDir, 'guitar.ogg'), 'AUDIO MUST NOT BE EXPORTED')
    const sngPath = join(testDir, 'source.sng')
    await packSng(
      songDir,
      {
        artist: 'Test Artist',
        name: 'Test Song',
        charter: 'Test Charter',
        source_path: '/private/metadata/path'
      },
      sngPath
    )

    const outputDir = join(testDir, 'dataset')
    const result = await exportSngTrainingMidi({
      sngPaths: [sngPath],
      outputDir,
      datasetId: 'test-private-export',
      provenance: 'synthetic test fixture',
      license: 'test-only'
    })

    expect(result.exported).toHaveLength(1)
    expect(result.skipped).toEqual([])
    const [song] = result.exported
    expect(await readFile(join(outputDir, song.midi))).toEqual(validMidi)
    expect(existsSync(join(outputDir, 'songs', song.songId, 'guitar.ogg'))).toBe(false)
    const manifest = await readFile(result.manifestPath, 'utf8')
    expect(manifest).toContain('octave-training-midi-export/v1')
    expect(manifest).not.toContain(sngPath)
    expect(manifest).not.toContain('/private/metadata/path')
    const metadata = await readFile(
      join(outputDir, 'songs', song.songId, 'source-metadata.json'),
      'utf8'
    )
    expect(metadata).not.toContain('/private/metadata/path')
  })

  it('refuses to write into a non-empty output directory', async () => {
    const outputDir = join(testDir, 'non-empty')
    await mkdir(outputDir, { recursive: true })
    await writeFile(join(outputDir, 'keep.txt'), 'keep')

    await expect(
      exportSngTrainingMidi({
        sngPaths: [join(testDir, 'missing.sng')],
        outputDir,
        datasetId: 'test-private-export',
        provenance: 'synthetic test fixture',
        license: 'test-only'
      })
    ).rejects.toThrow('must be empty')
  })

  it('records path-free skips for missing and no-MIDI packages', async () => {
    const chartOnlySong = join(testDir, 'chart-only')
    await mkdir(chartOnlySong, { recursive: true })
    await writeFile(join(chartOnlySong, 'notes.chart'), '[Song]\n{\n  Resolution = 192\n}\n')
    const chartOnlySng = join(testDir, 'chart-only.sng')
    await packSng(chartOnlySong, { artist: 'No Midi', name: 'Chart Only' }, chartOnlySng)
    const missingSng = join(testDir, 'missing-private-package.sng')
    const outputDir = join(testDir, 'skips')

    const result = await exportSngTrainingMidi({
      sngPaths: [chartOnlySng, missingSng],
      outputDir,
      datasetId: 'test-private-export',
      provenance: 'synthetic test fixture',
      license: 'test-only'
    })

    expect(result.exported).toEqual([])
    expect(result.skipped).toEqual([
      { sourceIndex: 0, reason: 'Package has no notes.mid' },
      { sourceIndex: 1, reason: 'Package could not be read or exported' }
    ])
    const manifest = await readFile(result.manifestPath, 'utf8')
    expect(manifest).not.toContain(chartOnlySng)
    expect(manifest).not.toContain(missingSng)
    expect(manifest).not.toContain('missing-private-package.sng')
  })

  it('skips packages with an empty file index without hanging or exposing paths', async () => {
    const emptySng = join(testDir, 'empty-private-package.sng')
    await writeFile(emptySng, emptySngPackage())
    const outputDir = join(testDir, 'empty-package-dataset')

    const result = await exportSngTrainingMidi({
      sngPaths: [emptySng],
      outputDir,
      datasetId: 'test-private-export',
      provenance: 'synthetic test fixture',
      license: 'test-only'
    })

    expect(result.exported).toEqual([])
    expect(result.skipped).toEqual([{ sourceIndex: 0, reason: 'Package has no notes.mid' }])
    expect(await readFile(result.manifestPath, 'utf8')).not.toContain('empty-private-package.sng')
  })

  it('skips packages with malformed notes.mid data, even when the header looks valid', async () => {
    const invalidSong = join(testDir, 'invalid-midi')
    await mkdir(invalidSong, { recursive: true })
    await writeFile(join(invalidSong, 'notes.mid'), truncatedMidi)
    const invalidSng = join(testDir, 'invalid-midi.sng')
    await packSng(invalidSong, { artist: 'Invalid', name: 'Midi' }, invalidSng)
    const outputDir = join(testDir, 'invalid-midi-dataset')

    const result = await exportSngTrainingMidi({
      sngPaths: [invalidSng],
      outputDir,
      datasetId: 'test-private-export',
      provenance: 'synthetic test fixture',
      license: 'test-only'
    })

    expect(result.exported).toEqual([])
    expect(result.skipped).toEqual([
      { sourceIndex: 0, reason: 'Package could not be read or exported' }
    ])
  })

  it('requires an explicit song.ini opt-in before exporting Octave library songs', async () => {
    const optedIn = join(testDir, 'library-opted-in')
    const optedOut = join(testDir, 'library-opted-out')
    await mkdir(optedIn, { recursive: true })
    await mkdir(optedOut, { recursive: true })
    await writeFile(join(optedIn, 'notes.mid'), validMidi)
    await writeFile(join(optedOut, 'notes.mid'), validMidi)
    await writeFile(
      join(optedIn, 'song.ini'),
      '[song]\nname = Reviewed\nartist = Tester\ndataset_opt_in = true\n'
    )
    await writeFile(
      join(optedOut, 'song.ini'),
      '[song]\nname = Generated\nartist = Tester\ncharter = STRUM\nstrum_generated = true\ndataset_opt_in = false\n'
    )

    const librarySongs = await listDatasetLibrarySongs(testDir)
    expect(librarySongs.find((song) => song.path === optedIn)?.datasetOptIn).toBe(true)
    expect(librarySongs.find((song) => song.path === optedOut)).toMatchObject({
      datasetOptIn: false,
      isStrumGenerated: true
    })

    const outputDir = join(testDir, 'library-dataset')
    const result = await exportSngTrainingMidi({
      sngPaths: [],
      librarySongPaths: [optedIn, optedOut],
      outputDir,
      datasetId: 'reviewed-library',
      provenance: 'local review',
      license: 'test-only'
    })

    expect(result.exported).toHaveLength(1)
    expect(result.exported[0].source).toBe('octave-library')
    expect(result.skipped).toEqual([
      { sourceIndex: 1, reason: 'Song is not opted into dataset curation' }
    ])
  })

  it('exports MIDI directly from an explicitly selected RB3CON package', async () => {
    const songDir = join(testDir, 'con-source')
    await mkdir(songDir, { recursive: true })
    await writeFile(join(songDir, 'notes.mid'), validMidi)
    await writeFile(join(songDir, 'song.ogg'), Buffer.from('OggS'))
    const conPath = join(testDir, 'source.rb3con')
    await packRb3con(songDir, { name: 'CON Song', artist: 'CON Artist' }, conPath)

    const result = await exportSngTrainingMidi({
      sngPaths: [],
      conPaths: [conPath],
      outputDir: join(testDir, 'con-dataset'),
      datasetId: 'con-export',
      provenance: 'synthetic test fixture',
      license: 'test-only'
    })

    expect(result.exported).toHaveLength(1)
    expect(result.exported[0]).toMatchObject({ source: 'rb3con', metadata: { name: 'CON Song' } })
    expect(await readFile(join(testDir, 'con-dataset', result.exported[0].midi))).toEqual(validMidi)
  })
})
