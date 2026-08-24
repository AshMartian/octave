import { mkdir, rm } from 'fs/promises'
import { join } from 'path'
import AdmZip from 'adm-zip'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { inventoryDatasetPackageSources } from './packageSourceInventory'

describe('inventoryDatasetPackageSources', () => {
  const testDir = join(__dirname, '../../../out/package_source_inventory_test_temp')

  function midiWithTrack(trackName: string, note = 60): Buffer {
    const name = Buffer.from(trackName)
    const events = Buffer.concat([
      Buffer.from([0x00, 0xff, 0x03, name.length]),
      name,
      Buffer.from([0x00, 0x90, note, 0x40, 0x83, 0x60, 0x80, note, 0x00, 0x00, 0xff, 0x2f, 0x00])
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

  beforeAll(async () => {
    await mkdir(testDir, { recursive: true })
  })

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true })
  })

  it('returns aggregate-only bounded preparation counts for selected package sources', async () => {
    const archive = new AdmZip()
    archive.addFile('guitar/notes.mid', midiWithTrack('PART GUITAR'))
    archive.addFile('vocals/notes.mid', midiWithTrack('PART VOCALS'))
    archive.addFile('chart-only/notes.chart', Buffer.from('[Song]\n{\n  Resolution = 192\n}\n'))
    archive.addFile('invalid/notes.mid', Buffer.from('not a midi'))
    const packagePath = join(testDir, 'private-collection.zip')
    archive.writeZip(packagePath)

    const inventory = await inventoryDatasetPackageSources([
      { kind: 'zip', sourcePath: packagePath },
      { kind: 'zip', sourcePath: packagePath },
      { kind: 'sng', sourcePath: join(testDir, 'missing-private-source.sng') }
    ])

    expect(inventory).toMatchObject({
      selectedPackageCount: 3,
      inspectedPackageCount: 3,
      readablePackageCount: 2,
      readableHeaderCount: 2,
      unreadablePackageCount: 1,
      inspectedChartCount: 8,
      validNotesMidiCount: 4,
      invalidOrMissingNotesMidiCount: 4,
      chartOnlyCount: 2,
      exactExpertPartVocalsCount: 2,
      duplicateMidiCount: 2,
      duplicateContainerCount: 1,
      decodeTimeoutCount: 0,
      decodeFailureCount: 1
    })
    const serialized = JSON.stringify(inventory)
    expect(serialized).not.toContain(packagePath)
    expect(serialized).not.toContain('private-collection')
    expect(serialized).not.toContain('missing-private-source')
  })

  it('does not treat a similarly named Vocal track as canonical STRUM lead vocals', async () => {
    const archive = new AdmZip()
    archive.addFile('alt/notes.mid', midiWithTrack('PART VOCALS ALT'))
    const packagePath = join(testDir, 'alternate-vocals.zip')
    archive.writeZip(packagePath)

    await expect(
      inventoryDatasetPackageSources([{ kind: 'zip', sourcePath: packagePath }])
    ).resolves.toMatchObject({
      validNotesMidiCount: 1,
      exactExpertPartVocalsCount: 0
    })
  })

  it('fails closed when channel-event data is not a valid seven-bit MIDI value', async () => {
    const malformed = midiWithTrack('PART VOCALS')
    // The first note-on pitch is byte 0xff rather than a seven-bit data byte.
    const noteOn = malformed.indexOf(Buffer.from([0x90, 0x3c, 0x40]))
    malformed[noteOn + 1] = 0xff
    const archive = new AdmZip()
    archive.addFile('bad/notes.mid', malformed)
    const packagePath = join(testDir, 'invalid-channel-data.zip')
    archive.writeZip(packagePath)

    await expect(
      inventoryDatasetPackageSources([{ kind: 'zip', sourcePath: packagePath }])
    ).resolves.toMatchObject({
      validNotesMidiCount: 0,
      invalidOrMissingNotesMidiCount: 1,
      exactExpertPartVocalsCount: 0
    })
  })
})
