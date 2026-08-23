import { existsSync } from 'fs'
import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import AdmZip from 'adm-zip'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { packRb3con } from '../conPacker'
import { packSng } from '../sngPacker'
import {
  buildSongSourceCatalog,
  exportSngTrainingMidi,
  listCatalogHarmonyTargets,
  listDatasetLibrarySongs,
  listSongSourceCatalogs,
  materializeCatalogHarmonySource,
  summarizeDatasetSource,
  summarizeDatasetSourceEntries
} from './sngTrainingExporter'

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

  function guitarMidi(trackName = 'PART GUITAR'): Buffer {
    const events = Buffer.concat([
      Buffer.from([0x00, 0xff, 0x03, trackName.length]),
      Buffer.from(trackName),
      Buffer.from([0x00, 0x90, 0x60, 0x40, 0x83, 0x60, 0x80, 0x60, 0x00, 0x00, 0xff, 0x2f, 0x00])
    ])
    const header = Buffer.from([
      0x4d, 0x54, 0x68, 0x64, 0x00, 0x00, 0x00, 0x06, 0x00, 0x00, 0x00, 0x01, 0x01, 0xe0
    ])
    const track = Buffer.alloc(8 + events.length)
    track.write('MTrk', 0)
    track.writeUInt32BE(events.length, 4)
    events.copy(track, 8)
    return Buffer.concat([header, track])
  }

  function namedTracksMidi(trackNames: string[]): Buffer {
    const tracks = trackNames.map((trackName) => {
      const events = Buffer.concat([
        Buffer.from([0x00, 0xff, 0x03, trackName.length]),
        Buffer.from(trackName),
        Buffer.from([0x00, 0x90, 0x3c, 0x40, 0x83, 0x60, 0x80, 0x3c, 0x00, 0x00, 0xff, 0x2f, 0x00])
      ])
      const track = Buffer.alloc(8 + events.length)
      track.write('MTrk', 0)
      track.writeUInt32BE(events.length, 4)
      events.copy(track, 8)
      return track
    })
    const header = Buffer.alloc(14)
    header.write('MThd', 0)
    header.writeUInt32BE(6, 4)
    header.writeUInt16BE(1, 8)
    header.writeUInt16BE(tracks.length, 10)
    header.writeUInt16BE(480, 12)
    return Buffer.concat([header, ...tracks])
  }

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

  it('materializes a path-free atomically created source catalog for STRUM', async () => {
    const songDir = join(testDir, 'catalog-library-song')
    const parentDir = join(testDir, 'catalog-parent')
    await mkdir(songDir, { recursive: true })
    await mkdir(parentDir, { recursive: true })
    await writeFile(join(songDir, 'notes.mid'), validMidi)
    await writeFile(join(songDir, 'song.ogg'), Buffer.from('OggS catalog audio'))
    await writeFile(
      join(songDir, 'song.ini'),
      '[song]\nname = Catalog Song\nartist = Catalog Artist\ndataset_opt_in = true\n'
    )

    const progress: Array<{ phase: string; completed: number; total: number }> = []
    const result = await buildSongSourceCatalog({
      sources: [{ kind: 'octave-library', sourcePath: songDir }],
      parentDir,
      catalogName: 'strum-reviewed',
      catalogId: 'strum-reviewed',
      provenance: 'Reviewed local collection',
      license: 'test-only',
      octaveVersion: 'test',
      onProgress: (update) => progress.push(update)
    })

    expect(result).toMatchObject({ recordCount: 1, skipped: [] })
    const catalogPath = join(parentDir, 'strum-reviewed')
    const catalog = await readFile(join(catalogPath, 'catalog.json'), 'utf8')
    const records = await readFile(join(catalogPath, 'records.jsonl'), 'utf8')
    expect(catalog).toContain('octave-song-source-catalog/v1')
    expect(catalog).not.toContain(songDir)
    expect(records).not.toContain(songDir)
    expect(records).toContain('"training_use":"allowed"')
    const record = JSON.parse(records) as {
      chart: { notes_midi: { relative_path: string } }
      audio: { mix: { relative_path: string; media_type: string } }
    }
    expect(await readFile(join(catalogPath, record.chart.notes_midi.relative_path))).toEqual(
      validMidi
    )
    expect(await readFile(join(catalogPath, record.audio.mix.relative_path), 'utf8')).toBe(
      'OggS catalog audio'
    )
    expect(record.audio.mix.media_type).toBe('audio/ogg')
    expect(existsSync(join(parentDir, '.strum-reviewed.staging'))).toBe(false)
    expect(progress).toEqual([
      { phase: 'normalizing', completed: 0, total: 1 },
      { phase: 'materializing', completed: 1, total: 1 },
      { phase: 'validating', completed: 1, total: 1 }
    ])
  })

  it('serializes only allowed catalog records even when called directly for unreviewed STRUM output', async () => {
    const songDir = join(testDir, 'catalog-strum-song')
    const parentDir = join(testDir, 'catalog-strum-parent')
    await mkdir(songDir, { recursive: true })
    await mkdir(parentDir, { recursive: true })
    await writeFile(join(songDir, 'notes.mid'), validMidi)
    await writeFile(
      join(songDir, 'song.ini'),
      '[song]\nname = Generated\nartist = STRUM\nstrum_generated = true\ndataset_opt_in = false\n'
    )

    const result = await buildSongSourceCatalog({
      sources: [{ kind: 'octave-library', sourcePath: songDir }],
      parentDir,
      catalogName: 'strum-catalog',
      catalogId: 'strum-catalog',
      provenance: 'Reviewed local collection',
      license: 'test-only',
      octaveVersion: 'test'
    })

    expect(result).toMatchObject({ recordCount: 1 })
    expect(await readFile(join(parentDir, 'strum-catalog', 'records.jsonl'), 'utf8')).toContain(
      '"training_use":"allowed"'
    )
  })

  it('writes schema-shaped instrument coverage with track_names', async () => {
    const songDir = join(testDir, 'catalog-guitar-song')
    const parentDir = join(testDir, 'catalog-guitar-parent')
    await mkdir(songDir, { recursive: true })
    await mkdir(parentDir, { recursive: true })
    await writeFile(join(songDir, 'notes.mid'), guitarMidi())
    await writeFile(join(songDir, 'song.ini'), '[song]\nname = Guitar\ndataset_opt_in = true\n')

    await buildSongSourceCatalog({
      sources: [{ kind: 'octave-library', sourcePath: songDir }],
      parentDir,
      catalogName: 'guitar-coverage',
      catalogId: 'guitar-coverage',
      provenance: 'Reviewed',
      license: 'test-only',
      octaveVersion: 'test'
    })

    const record = JSON.parse(
      await readFile(join(parentDir, 'guitar-coverage', 'records.jsonl'), 'utf8')
    ) as { chart: { instruments: { guitar: Record<string, unknown> } } }
    expect(record.chart.instruments.guitar).toMatchObject({
      status: 'present',
      difficulties: ['expert'],
      track_names: ['PART GUITAR']
    })
    expect(record.chart.instruments.guitar).not.toHaveProperty('trackNames')
  })

  it('redacts parser-derived locations from catalog metadata and track names', async () => {
    const songDir = join(testDir, 'catalog-redaction-song')
    const parentDir = join(testDir, 'catalog-redaction-parent')
    await mkdir(songDir, { recursive: true })
    await mkdir(parentDir, { recursive: true })
    await writeFile(
      join(songDir, 'notes.mid'),
      guitarMidi('PART GUITAR https://example.invalid/private')
    )
    await writeFile(
      join(songDir, 'song.ini'),
      '[song]\nname = file:///private/song\nartist = \\\\\\\\server\\share\ncharter = C:\\\\private\\\\charter\ndataset_opt_in = true\n'
    )

    await buildSongSourceCatalog({
      sources: [{ kind: 'octave-library', sourcePath: songDir }],
      parentDir,
      catalogName: 'redacted-catalog',
      catalogId: 'redacted-catalog',
      provenance: 'https://example.invalid/provenance',
      license: 'file:///private/license',
      octaveVersion: 'test'
    })

    const serialized = await readFile(join(parentDir, 'redacted-catalog', 'records.jsonl'), 'utf8')
    expect(serialized).not.toMatch(/https?:\/\/|file:\/\/|C:\\\\/)
    expect(serialized).not.toContain('private')
    expect(serialized).not.toContain('server')
    expect(serialized).toContain('[redacted]')
  })

  it('normalizes selected ZIP sources in the main-process catalog service', async () => {
    const archivePath = join(testDir, 'catalog-source.zip')
    const parentDir = join(testDir, 'catalog-zip-parent')
    const archive = new AdmZip()
    archive.addFile('song/notes.mid', validMidi)
    archive.addFile(
      'song/song.ini',
      Buffer.from('[song]\nname = ZIP Song\ncharter = STRUM\nstrum_generated = true\n')
    )
    archive.writeZip(archivePath)
    await mkdir(parentDir, { recursive: true })

    await expect(
      summarizeDatasetSource({ kind: 'zip', sourcePath: archivePath })
    ).resolves.toMatchObject({ isStrumGenerated: true })

    const result = await buildSongSourceCatalog({
      sources: [{ kind: 'zip', sourcePath: archivePath }],
      parentDir,
      catalogName: 'zip-catalog',
      catalogId: 'zip-catalog',
      provenance: 'Reviewed',
      license: 'test-only',
      octaveVersion: 'test'
    })

    expect(result).toMatchObject({ recordCount: 1 })
    expect(await readFile(join(parentDir, 'zip-catalog', 'records.jsonl'), 'utf8')).toContain(
      '"kind":"zip"'
    )
  })

  it('returns independently selectable summaries for every song in a ZIP package', async () => {
    const archivePath = join(testDir, 'multi-song-source.zip')
    const archive = new AdmZip()
    archive.addFile('approved/notes.mid', validMidi)
    archive.addFile('approved/song.ini', Buffer.from('[song]\nname = Approved\nartist = Tester\n'))
    // Byte-identical charts must still be independently selectable when they
    // belong to different songs in the same package.
    archive.addFile('strum/notes.mid', validMidi)
    archive.addFile(
      'strum/song.ini',
      Buffer.from('[song]\nname = STRUM Song\nartist = Tester\ncharter = STRUM\n')
    )
    archive.writeZip(archivePath)

    const entries = await summarizeDatasetSourceEntries({ kind: 'zip', sourcePath: archivePath })

    expect(entries).toHaveLength(2)
    expect(entries.map((entry) => entry.entryId)).toEqual(
      expect.arrayContaining([expect.stringMatching(/^[a-f0-9]{64}$/)])
    )
    expect(new Set(entries.map((entry) => entry.entryId)).size).toBe(2)
    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          metadata: expect.objectContaining({ name: 'STRUM Song' }),
          isStrumGenerated: true
        }),
        expect.objectContaining({
          metadata: expect.objectContaining({ name: 'Approved' }),
          isStrumGenerated: false
        })
      ])
    )

    const strumEntry = entries.find((entry) => entry.isStrumGenerated)
    expect(strumEntry).toBeDefined()
    if (!strumEntry) throw new Error('Expected STRUM ZIP entry fixture')
    const parentDir = join(testDir, 'multi-song-catalog-parent')
    await mkdir(parentDir, { recursive: true })
    await buildSongSourceCatalog({
      sources: [{ kind: 'zip', sourcePath: archivePath, entryId: strumEntry.entryId }],
      parentDir,
      catalogName: 'selected-entry',
      catalogId: 'selected-entry',
      provenance: 'Reviewed',
      license: 'test-only',
      octaveVersion: 'test'
    })
    const record = JSON.parse(
      await readFile(join(parentDir, 'selected-entry', 'records.jsonl'), 'utf8')
    ) as { metadata: { name: string }; rights: { training_use: string } }
    expect(record).toMatchObject({
      metadata: { name: 'STRUM Song' },
      rights: { training_use: 'allowed' }
    })
  })

  it('returns only a safe code for parser failures and cleans failed staging directories', async () => {
    const packagePath = join(testDir, 'private-broken-package.sng')
    const parentDir = join(testDir, 'catalog-failure-parent')
    await writeFile(packagePath, Buffer.from('not an sng package'))
    await mkdir(parentDir, { recursive: true })

    await expect(summarizeDatasetSource({ kind: 'sng', sourcePath: packagePath })).resolves.toEqual(
      expect.objectContaining({ warnings: [{ code: 'source_unavailable' }] })
    )
    await expect(
      buildSongSourceCatalog({
        sources: [{ kind: 'sng', sourcePath: packagePath }],
        parentDir,
        catalogName: 'failed-catalog',
        catalogId: 'failed-catalog',
        provenance: 'Reviewed',
        license: 'test-only',
        octaveVersion: 'test'
      })
    ).rejects.toThrow('No valid source records')
    expect(await readdir(parentDir)).toEqual([])
  })

  it('refuses an existing empty catalog destination', async () => {
    const songDir = join(testDir, 'catalog-existing-song')
    const parentDir = join(testDir, 'catalog-existing-parent')
    const destination = join(parentDir, 'existing-catalog')
    await mkdir(songDir, { recursive: true })
    await mkdir(destination, { recursive: true })
    await writeFile(join(songDir, 'notes.mid'), validMidi)
    await writeFile(join(songDir, 'song.ini'), '[song]\ndataset_opt_in = true\n')

    await expect(
      buildSongSourceCatalog({
        sources: [{ kind: 'octave-library', sourcePath: songDir }],
        parentDir,
        catalogName: 'existing-catalog',
        catalogId: 'existing-catalog',
        provenance: 'Reviewed',
        license: 'test-only',
        octaveVersion: 'test'
      })
    ).rejects.toThrow('already exists')
    expect(await readdir(destination)).toEqual([])
  })

  it('updates a selected catalog in place and clones it as a revision', async () => {
    const parentDir = join(testDir, 'catalog-editor-parent')
    const firstSong = join(testDir, 'catalog-editor-first')
    const secondSong = join(testDir, 'catalog-editor-second')
    await mkdir(parentDir, { recursive: true })
    await mkdir(firstSong, { recursive: true })
    await mkdir(secondSong, { recursive: true })
    await writeFile(join(firstSong, 'notes.mid'), validMidi)
    await writeFile(join(secondSong, 'notes.mid'), guitarMidi())
    await writeFile(join(firstSong, 'song.ini'), '[song]\nname = First\ndataset_opt_in = true\n')
    await writeFile(join(secondSong, 'song.ini'), '[song]\nname = Second\ndataset_opt_in = true\n')

    await buildSongSourceCatalog({
      sources: [{ kind: 'octave-library', sourcePath: firstSong }],
      parentDir,
      catalogName: 'editable-catalog',
      catalogId: 'editable-catalog',
      provenance: 'Reviewed',
      license: 'test-only',
      octaveVersion: 'test'
    })
    const updated = await buildSongSourceCatalog({
      sources: [{ kind: 'octave-library', sourcePath: secondSong }],
      parentDir,
      catalogName: 'editable-catalog',
      catalogId: 'ignored-when-updating',
      provenance: 'Reviewed',
      license: 'test-only',
      octaveVersion: 'test',
      mode: 'update'
    })
    expect(updated).toMatchObject({ recordCount: 2 })
    expect(await listSongSourceCatalogs(parentDir)).toEqual([
      expect.objectContaining({
        catalogName: 'editable-catalog',
        provenance: 'Reviewed',
        license: 'test-only',
        recordCount: 2
      })
    ])
    const updatedManifest = JSON.parse(
      await readFile(join(parentDir, 'editable-catalog', 'catalog.json'), 'utf8')
    ) as { curation: { provenance: string; license: string } }
    expect(updatedManifest.curation).toEqual({ provenance: 'Reviewed', license: 'test-only' })

    const clone = await buildSongSourceCatalog({
      sources: [{ kind: 'octave-library', sourcePath: secondSong }],
      parentDir,
      catalogName: 'editable-catalog-revision',
      catalogId: 'editable-catalog-revision',
      provenance: 'Reviewed',
      license: 'test-only',
      octaveVersion: 'test',
      mode: 'clone',
      sourceCatalogName: 'editable-catalog'
    })
    expect(clone).toMatchObject({ recordCount: 2 })
  })

  it('materializes only an explicit isolated HARM stem into a hash-bound policy sidecar', async () => {
    const parentDir = join(testDir, 'harmony-stem-parent')
    const songDir = join(testDir, 'harmony-stem-song')
    const explicitStem = join(testDir, 'private-source-harm1.wav')
    await mkdir(parentDir, { recursive: true })
    await mkdir(songDir, { recursive: true })
    await writeFile(join(songDir, 'notes.mid'), namedTracksMidi(['PART VOCALS', 'HARM1']))
    await writeFile(join(songDir, 'song.ogg'), Buffer.from('catalog mix'))
    await writeFile(join(songDir, 'vocals.ogg'), Buffer.from('catalog shared vocals'))
    await writeFile(
      join(songDir, 'song.ini'),
      '[song]\nname = Harmony Song\nartist = Tester\ndataset_opt_in = true\n'
    )
    await writeFile(explicitStem, Buffer.from('isolated harm one'))
    await buildSongSourceCatalog({
      sources: [{ kind: 'octave-library', sourcePath: songDir }],
      parentDir,
      catalogName: 'harmony-stem-catalog',
      catalogId: 'harmony-stem-catalog',
      provenance: 'Reviewed',
      license: 'test-only',
      octaveVersion: 'test'
    })

    const initialTargets = await listCatalogHarmonyTargets(parentDir, 'harmony-stem-catalog')
    expect(initialTargets).toEqual([
      expect.objectContaining({ tracks: ['HARM1'], configuredTracks: [] })
    ])
    const sourceId = initialTargets[0].sourceId
    await expect(
      materializeCatalogHarmonySource({
        parentDir,
        catalogName: 'harmony-stem-catalog',
        sourceId,
        trackName: 'HARM1',
        sourceAudioPath: explicitStem,
        provenance: { kind: 'isolated_source_stem/v1', attestationId: 'licensed-stem-001' }
      })
    ).resolves.toEqual({ sourceId, trackName: 'HARM1', configuredTracks: ['HARM1'] })

    const catalogRoot = join(parentDir, 'harmony-stem-catalog')
    const record = JSON.parse(await readFile(join(catalogRoot, 'records.jsonl'), 'utf8')) as {
      audio: { harm1: { relative_path: string; sha256: string; asset_id: string } }
    }
    expect(await readFile(join(catalogRoot, record.audio.harm1.relative_path))).toEqual(
      Buffer.from('isolated harm one')
    )
    const policyText = await readFile(join(catalogRoot, 'vocal-harmony-sources.json'), 'utf8')
    const policy = JSON.parse(policyText) as {
      catalog_control_sha256: string
      records: Array<{
        track_name: string
        audio: { role: string; sha256: string }
        provenance: { kind: string }
      }>
    }
    expect(policy.catalog_control_sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(policy.records).toEqual([
      expect.objectContaining({
        source_id: sourceId,
        track_name: 'HARM1',
        audio: expect.objectContaining({ role: 'harm1', sha256: record.audio.harm1.sha256 }),
        provenance: expect.objectContaining({ kind: 'isolated_source_stem/v1' })
      })
    ])
    expect(policyText).not.toContain(explicitStem)
    expect((await listCatalogHarmonyTargets(parentDir, 'harmony-stem-catalog'))[0]).toMatchObject({
      configuredTracks: ['HARM1']
    })
    await buildSongSourceCatalog({
      sources: [],
      parentDir,
      catalogName: 'harmony-stem-catalog',
      catalogId: 'ignored-for-update',
      provenance: 'Reviewed',
      license: 'test-only',
      octaveVersion: 'test',
      mode: 'update'
    })
    await expect(
      readFile(join(catalogRoot, 'vocal-harmony-sources.json'), 'utf8')
    ).rejects.toThrow()
  })

  it('requires pinned catalog mix and separator identities for a separation output', async () => {
    const parentDir = join(testDir, 'harmony-separation-parent')
    const songDir = join(testDir, 'harmony-separation-song')
    const separatedOutput = join(testDir, 'private-separated-harm2.flac')
    await mkdir(parentDir, { recursive: true })
    await mkdir(songDir, { recursive: true })
    await writeFile(join(songDir, 'notes.mid'), namedTracksMidi(['PART VOCALS', 'HARM2']))
    await writeFile(join(songDir, 'song.ogg'), Buffer.from('catalog separation mix'))
    await writeFile(
      join(songDir, 'song.ini'),
      '[song]\nname = Separation Song\ndataset_opt_in = true\n'
    )
    await writeFile(separatedOutput, Buffer.from('isolated harm two'))
    await buildSongSourceCatalog({
      sources: [{ kind: 'octave-library', sourcePath: songDir }],
      parentDir,
      catalogName: 'harmony-separation-catalog',
      catalogId: 'harmony-separation-catalog',
      provenance: 'Reviewed',
      license: 'test-only',
      octaveVersion: 'test'
    })
    const sourceId = (await listCatalogHarmonyTargets(parentDir, 'harmony-separation-catalog'))[0]
      .sourceId
    await materializeCatalogHarmonySource({
      parentDir,
      catalogName: 'harmony-separation-catalog',
      sourceId,
      trackName: 'HARM2',
      sourceAudioPath: separatedOutput,
      provenance: {
        kind: 'isolated_separation_output/v1',
        separator: {
          id: 'demucs',
          version: 'v4',
          modelSha256: 'a'.repeat(64),
          configurationSha256: 'b'.repeat(64)
        }
      }
    })
    const catalogRoot = join(parentDir, 'harmony-separation-catalog')
    const record = JSON.parse(await readFile(join(catalogRoot, 'records.jsonl'), 'utf8')) as {
      audio: { mix: { asset_id: string; sha256: string } }
    }
    const policy = JSON.parse(
      await readFile(join(catalogRoot, 'vocal-harmony-sources.json'), 'utf8')
    ) as {
      records: Array<{
        provenance: {
          input: { asset_id: string; sha256: string }
          separator: { model_sha256: string }
        }
      }>
    }
    expect(policy.records[0].provenance.input).toEqual({
      asset_id: record.audio.mix.asset_id,
      sha256: record.audio.mix.sha256
    })
    expect(policy.records[0].provenance.separator.model_sha256).toBe('a'.repeat(64))
  })

  it('refuses shared catalog mix or vocals as a Harmony source and leaves the catalog untouched', async () => {
    const parentDir = join(testDir, 'harmony-no-fallback-parent')
    const songDir = join(testDir, 'harmony-no-fallback-song')
    await mkdir(parentDir, { recursive: true })
    await mkdir(songDir, { recursive: true })
    const sharedMix = Buffer.from('shared catalog mix')
    await writeFile(join(songDir, 'notes.mid'), namedTracksMidi(['PART VOCALS', 'HARM3']))
    await writeFile(join(songDir, 'song.ogg'), sharedMix)
    await writeFile(join(songDir, 'vocals.ogg'), Buffer.from('shared catalog vocals'))
    await writeFile(
      join(songDir, 'song.ini'),
      '[song]\nname = No Fallback\ndataset_opt_in = true\n'
    )
    const sharedSource = join(testDir, 'private-copy-of-mix.wav')
    await writeFile(sharedSource, sharedMix)
    await buildSongSourceCatalog({
      sources: [{ kind: 'octave-library', sourcePath: songDir }],
      parentDir,
      catalogName: 'harmony-no-fallback-catalog',
      catalogId: 'harmony-no-fallback-catalog',
      provenance: 'Reviewed',
      license: 'test-only',
      octaveVersion: 'test'
    })
    const catalogRoot = join(parentDir, 'harmony-no-fallback-catalog')
    const before = await readFile(join(catalogRoot, 'records.jsonl'), 'utf8')
    const sourceId = (await listCatalogHarmonyTargets(parentDir, 'harmony-no-fallback-catalog'))[0]
      .sourceId
    await expect(
      materializeCatalogHarmonySource({
        parentDir,
        catalogName: 'harmony-no-fallback-catalog',
        sourceId,
        trackName: 'HARM3',
        sourceAudioPath: sharedSource,
        provenance: { kind: 'isolated_source_stem/v1', attestationId: 'not-a-fallback' }
      })
    ).rejects.toThrow('must not duplicate')
    expect(await readFile(join(catalogRoot, 'records.jsonl'), 'utf8')).toBe(before)
    await expect(
      readFile(join(catalogRoot, 'vocal-harmony-sources.json'), 'utf8')
    ).rejects.toThrow()
  })

  it('keeps moved, deleted, and unreadable Harmony selections path-safe', async () => {
    const parentDir = join(testDir, 'harmony-private-source-errors-parent')
    const songDir = join(testDir, 'harmony-private-source-errors-song')
    await mkdir(parentDir, { recursive: true })
    await mkdir(songDir, { recursive: true })
    await writeFile(join(songDir, 'notes.mid'), namedTracksMidi(['PART VOCALS', 'HARM1']))
    await writeFile(
      join(songDir, 'song.ini'),
      '[song]\nname = Private source test\ndataset_opt_in = true\n'
    )
    await buildSongSourceCatalog({
      sources: [{ kind: 'octave-library', sourcePath: songDir }],
      parentDir,
      catalogName: 'harmony-private-source-errors',
      catalogId: 'harmony-private-source-errors',
      provenance: 'Reviewed',
      license: 'test-only',
      octaveVersion: 'test'
    })
    const sourceId = (
      await listCatalogHarmonyTargets(parentDir, 'harmony-private-source-errors')
    )[0].sourceId
    const materialize = async (sourceAudioPath: string): Promise<Error> => {
      try {
        await materializeCatalogHarmonySource({
          parentDir,
          catalogName: 'harmony-private-source-errors',
          sourceId,
          trackName: 'HARM1',
          sourceAudioPath,
          provenance: { kind: 'isolated_source_stem/v1', attestationId: 'private-source-test' }
        })
      } catch (error) {
        expect(error).toBeInstanceOf(Error)
        return error as Error
      }
      throw new Error('Expected Harmony materialization to reject the selected source.')
    }
    const expectUnavailable = async (sourceAudioPath: string): Promise<void> => {
      const error = await materialize(sourceAudioPath)
      expect(error.message).toBe('Selected Harmony audio is unavailable or unsupported.')
      expect(error.message).not.toContain(sourceAudioPath)
      expect(error.message).not.toContain('private-harmony-source')
    }

    const deleted = join(testDir, 'private-harmony-source-deleted.wav')
    await writeFile(deleted, 'deleted audio')
    await rm(deleted)
    await expectUnavailable(deleted)

    const moved = join(testDir, 'private-harmony-source-moved.wav')
    await writeFile(moved, 'moved audio')
    await rename(moved, join(testDir, 'moved-private-harmony-source.wav'))
    await expectUnavailable(moved)

    const unreadable = join(testDir, 'private-harmony-source-unreadable.wav')
    await writeFile(unreadable, 'unreadable audio')
    await chmod(unreadable, 0o000)
    try {
      await expectUnavailable(unreadable)
    } finally {
      await chmod(unreadable, 0o600)
    }
  })

  it('shares one catalog mutation reservation across Harmony and generic catalog updates/clones', async () => {
    const parentDir = join(testDir, 'harmony-mutation-reservation-parent')
    const songDir = join(testDir, 'harmony-mutation-reservation-song')
    const harmonySource = join(testDir, 'private-harmony-mutation.wav')
    await mkdir(parentDir, { recursive: true })
    await mkdir(songDir, { recursive: true })
    await writeFile(join(songDir, 'notes.mid'), namedTracksMidi(['PART VOCALS', 'HARM1']))
    await writeFile(
      join(songDir, 'song.ini'),
      '[song]\nname = Reservation\ndataset_opt_in = true\n'
    )
    await writeFile(harmonySource, 'isolated harmony')
    await buildSongSourceCatalog({
      sources: [{ kind: 'octave-library', sourcePath: songDir }],
      parentDir,
      catalogName: 'harmony-mutation-reservation',
      catalogId: 'harmony-mutation-reservation',
      provenance: 'Reviewed',
      license: 'test-only',
      octaveVersion: 'test'
    })
    const sourceId = (await listCatalogHarmonyTargets(parentDir, 'harmony-mutation-reservation'))[0]
      .sourceId
    const catalogRoot = join(parentDir, 'harmony-mutation-reservation')
    const beforeRecords = await readFile(join(catalogRoot, 'records.jsonl'), 'utf8')
    const reservationPath = join(parentDir, '.harmony-mutation-reservation.mutation-reservation')
    await writeFile(reservationPath, 'active mutation')
    try {
      const results = await Promise.allSettled([
        materializeCatalogHarmonySource({
          parentDir,
          catalogName: 'harmony-mutation-reservation',
          sourceId,
          trackName: 'HARM1',
          sourceAudioPath: harmonySource,
          provenance: { kind: 'isolated_source_stem/v1', attestationId: 'reservation-stem' }
        }),
        buildSongSourceCatalog({
          sources: [],
          parentDir,
          catalogName: 'harmony-mutation-reservation',
          catalogId: 'ignored-update-id',
          provenance: 'Reviewed',
          license: 'test-only',
          octaveVersion: 'test',
          mode: 'update'
        }),
        buildSongSourceCatalog({
          sources: [{ kind: 'octave-library', sourcePath: songDir }],
          parentDir,
          catalogName: 'harmony-mutation-reservation-clone',
          catalogId: 'harmony-mutation-reservation-clone',
          provenance: 'Reviewed',
          license: 'test-only',
          octaveVersion: 'test',
          mode: 'clone',
          sourceCatalogName: 'harmony-mutation-reservation'
        })
      ])
      for (const result of results) {
        expect(result.status).toBe('rejected')
        if (result.status === 'rejected') {
          expect((result.reason as Error).message).toBe(
            'A catalog mutation with that name is already in progress.'
          )
        }
      }
      expect(await readFile(join(catalogRoot, 'records.jsonl'), 'utf8')).toBe(beforeRecords)
      await expect(
        readFile(join(catalogRoot, 'vocal-harmony-sources.json'), 'utf8')
      ).rejects.toThrow()
    } finally {
      await rm(reservationPath, { force: true })
    }

    const cloneReservationPath = join(
      parentDir,
      '.harmony-mutation-reservation-clone.mutation-reservation'
    )
    await writeFile(cloneReservationPath, 'active mutation')
    try {
      await expect(
        buildSongSourceCatalog({
          sources: [{ kind: 'octave-library', sourcePath: songDir }],
          parentDir,
          catalogName: 'harmony-mutation-reservation-clone',
          catalogId: 'harmony-mutation-reservation-clone',
          provenance: 'Reviewed',
          license: 'test-only',
          octaveVersion: 'test',
          mode: 'clone',
          sourceCatalogName: 'harmony-mutation-reservation'
        })
      ).rejects.toThrow('A catalog mutation with that name is already in progress.')
      expect(await readFile(join(catalogRoot, 'records.jsonl'), 'utf8')).toBe(beforeRecords)
    } finally {
      await rm(cloneReservationPath, { force: true })
    }
  })
})
