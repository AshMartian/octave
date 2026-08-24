import { mkdir, rm, truncate, writeFile } from 'fs/promises'
import { join } from 'path'
import AdmZip from 'adm-zip'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  hashContainerInWorker,
  inspectPackageInWorker,
  inventoryDatasetPackageSources,
  type DatasetPackageInventoryOptions
} from './packageSourceInventory'

describe('inventoryDatasetPackageSources', () => {
  const testDir = join(__dirname, '../../../out/package_source_inventory_test_temp')
  const localInspection: DatasetPackageInventoryOptions = {
    inspectInIsolation: async (source) => ({
      containerHash: await hashContainerInWorker(source.sourcePath),
      inspection: await inspectPackageInWorker(source)
    })
  }

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

    const inventory = await inventoryDatasetPackageSources(
      [
        { kind: 'zip', sourcePath: packagePath },
        { kind: 'zip', sourcePath: packagePath },
        { kind: 'sng', sourcePath: join(testDir, 'missing-private-source.sng') }
      ],
      localInspection
    )

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
      inventoryDatasetPackageSources([{ kind: 'zip', sourcePath: packagePath }], localInspection)
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
      inventoryDatasetPackageSources([{ kind: 'zip', sourcePath: packagePath }], localInspection)
    ).resolves.toMatchObject({
      validNotesMidiCount: 0,
      invalidOrMissingNotesMidiCount: 1,
      exactExpertPartVocalsCount: 0
    })
  })

  it.each(['sng', 'zip', 'rb3con'] as const)(
    'records a bounded timeout without parsing %s on the main process',
    async (kind) => {
      const packagePath = join(testDir, `timeout-${kind}.${kind === 'rb3con' ? 'rb3con' : kind}`)
      await writeFile(packagePath, 'fixture')
      const inventory = await inventoryDatasetPackageSources([{ kind, sourcePath: packagePath }], {
        inspectInIsolation: async () => {
          throw new Error('Package decode timed out.')
        }
      })
      expect(inventory).toMatchObject({
        inspectedPackageCount: 1,
        unreadablePackageCount: 1,
        decodeTimeoutCount: 1,
        decodeFailureCount: 0,
        cancelled: false
      })
    }
  )

  it.each(['sng', 'zip', 'rb3con'] as const)(
    'cancels isolated %s inspection without counting it as a decode failure',
    async (kind) => {
      const packagePath = join(testDir, `cancel-${kind}.${kind === 'rb3con' ? 'rb3con' : kind}`)
      await writeFile(packagePath, 'fixture')
      const controller = new AbortController()
      const inventoryPromise = inventoryDatasetPackageSources([{ kind, sourcePath: packagePath }], {
        signal: controller.signal,
        inspectInIsolation: async (_source, signal) =>
          await new Promise((_, reject) => {
            signal.addEventListener(
              'abort',
              () => reject(new Error('Package inventory cancelled.')),
              { once: true }
            )
            setTimeout(() => controller.abort(), 0)
          })
      })
      await expect(inventoryPromise).resolves.toMatchObject({
        inspectedPackageCount: 1,
        unreadablePackageCount: 1,
        decodeTimeoutCount: 0,
        decodeFailureCount: 0,
        cancelled: true
      })
    }
  )

  it('applies the safe input limit to SNG, ZIP, and RB3CON before inspection', async () => {
    const sources = await Promise.all(
      (['sng', 'zip', 'rb3con'] as const).map(async (kind) => {
        const packagePath = join(testDir, `oversize-${kind}.${kind === 'rb3con' ? 'rb3con' : kind}`)
        await writeFile(packagePath, '')
        await truncate(packagePath, 256 * 1024 * 1024 + 1)
        return { kind, sourcePath: packagePath }
      })
    )
    let isolationCalls = 0
    const inventory = await inventoryDatasetPackageSources(sources, {
      inspectInIsolation: async () => {
        isolationCalls += 1
        throw new Error('must not inspect oversized package')
      }
    })
    expect(isolationCalls).toBe(0)
    expect(inventory).toMatchObject({
      inspectedPackageCount: 3,
      readablePackageCount: 0,
      unreadablePackageCount: 3,
      decodeFailureCount: 3
    })
  })

  it('counts an unavailable container identity exactly once', async () => {
    const packagePath = join(testDir, 'identity-unavailable.zip')
    await writeFile(packagePath, 'fixture')
    const inventory = await inventoryDatasetPackageSources(
      [{ kind: 'zip', sourcePath: packagePath }],
      {
        inspectInIsolation: async () => ({
          containerHash: null,
          inspection: { headerReadable: true, charts: [] }
        })
      }
    )
    expect(inventory).toMatchObject({
      readablePackageCount: 1,
      readableHeaderCount: 1,
      containerIdentityUnavailableCount: 1,
      decodeFailureCount: 0
    })
  })
})
