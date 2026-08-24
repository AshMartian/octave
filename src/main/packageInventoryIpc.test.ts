import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import AdmZip from 'adm-zip'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type {
  DatasetPackageInventoryOptions,
  DatasetPackageInventorySession,
  DatasetPackageSourceInventory
} from './import/packageSourceInventory'
import { packageEntryIdentity } from './import/packageSourceIdentity'

type IpcHandler = (...args: unknown[]) => unknown

const handlers = new Map<string, IpcHandler>()
const runSession =
  vi.fn<
    (
      session: DatasetPackageInventorySession,
      options: DatasetPackageInventoryOptions
    ) => Promise<DatasetPackageSourceInventory>
  >()
const getReviewEntries = vi.fn()
const scratch = await mkdtemp(join(tmpdir(), 'octave-package-inventory-ipc-test-'))

vi.mock('electron', () => {
  const app = Object.assign(new EventEmitter(), {
    commandLine: { appendSwitch: vi.fn() },
    requestSingleInstanceLock: () => true,
    getPath: () => scratch,
    getVersion: () => 'test',
    isPackaged: false,
    quit: vi.fn(),
    whenReady: () => new Promise<void>(() => undefined)
  })
  return {
    app,
    BrowserWindow: { getAllWindows: () => [], fromWebContents: () => null },
    ipcMain: {
      handle: (channel: string, handler: unknown) => handlers.set(channel, handler as IpcHandler),
      on: vi.fn()
    },
    dialog: { showOpenDialog: vi.fn(async () => ({ canceled: false, filePaths: [scratch] })) },
    protocol: { registerSchemesAsPrivileged: vi.fn() },
    net: { fetch: vi.fn() },
    Menu: { buildFromTemplate: vi.fn(), setApplicationMenu: vi.fn() },
    session: { defaultSession: { webRequest: { onHeadersReceived: vi.fn() } } },
    shell: { openExternal: vi.fn(), openPath: vi.fn() }
  }
})

vi.mock('@electron-toolkit/utils', () => ({
  electronApp: { setAppUserModelId: vi.fn() },
  optimizer: { watchWindowShortcuts: vi.fn() },
  is: { dev: true }
}))

vi.mock('electron-updater', () => ({ autoUpdater: {} }))

vi.mock('fluent-ffmpeg', () => ({ default: { setFfmpegPath: vi.fn() } }))

vi.mock('./import/packageSourceInventory', async () => {
  const actual = await vi.importActual<typeof import('./import/packageSourceInventory')>(
    './import/packageSourceInventory'
  )
  return {
    ...actual,
    runDatasetPackageInventorySession: runSession,
    isDatasetPackageInventorySessionComplete: () => true,
    getDatasetPackageInventorySessionReviewEntries: getReviewEntries
  }
})

class FakeSender extends EventEmitter {
  id = 77
  readonly messages: Array<{ channel: string; payload: unknown }> = []

  isDestroyed(): boolean {
    return false
  }

  send(channel: string, payload: unknown): void {
    this.messages.push({ channel, payload })
  }
}

function inventoryResult(): DatasetPackageSourceInventory {
  return {
    selectedPackageCount: 1,
    inspectedPackageCount: 0,
    packageLimitReachedCount: 0,
    cancelled: true,
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

function vocalMidi(): Buffer {
  const name = Buffer.from('PART VOCALS')
  const events = Buffer.concat([
    Buffer.from([0x00, 0xff, 0x03, name.length]),
    name,
    Buffer.from([0x00, 0x90, 0x3c, 0x40, 0x83, 0x60, 0x80, 0x3c, 0x00, 0x00, 0xff, 0x2f, 0x00])
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
  await writeFile(join(scratch, 'selected-package.zip'), 'fixture')
  await import('./index')
})

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true })
})

describe('dataset package inventory IPC lifecycle', () => {
  it('maps private reviewed entries to opaque safe candidates only after completion', async () => {
    const choose = handlers.get('dataset:choosePackageFolder')
    const inspect = handlers.get('dataset:inspectPackageGroup')
    const approve = handlers.get('dataset:setPackageApproved')
    expect(choose).toBeTypeOf('function')
    expect(inspect).toBeTypeOf('function')
    expect(approve).toBeTypeOf('function')
    const sender = new FakeSender()
    const group = (await choose!({ sender } as unknown)) as { groupId: string }
    const privatePath = join(scratch, 'selected-package.zip')
    getReviewEntries.mockReturnValueOnce([
      {
        source: { kind: 'zip', sourcePath: privatePath },
        containerSha256: 'a'.repeat(64),
        midiSha256: 'b'.repeat(64),
        entryLocator: 'private/song/',
        entryId: 'c'.repeat(64),
        exactExpertPartVocals: true,
        duplicateMidi: false
      }
    ])
    runSession.mockResolvedValueOnce({ ...inventoryResult(), cancelled: false })

    const response = (await inspect!({ sender } as unknown, group.groupId)) as {
      reviewCandidates: Array<{ candidateId: string; canonicalVocalMidi: boolean }>
    }
    expect(response.reviewCandidates).toEqual([
      expect.objectContaining({ canonicalVocalMidi: true, candidateId: expect.any(String) })
    ])
    const serialized = JSON.stringify(response)
    for (const privateValue of [privatePath, 'a'.repeat(64), 'b'.repeat(64), 'private/song/']) {
      expect(serialized).not.toContain(privateValue)
    }
    expect(
      approve!({ sender } as unknown, response.reviewCandidates[0].candidateId, true) as boolean
    ).toBe(true)
  })

  it('materializes a reviewed root-level ZIP chart through an opaque approval', async () => {
    const choose = handlers.get('dataset:choosePackageFolder')
    const inspect = handlers.get('dataset:inspectPackageGroup')
    const approve = handlers.get('dataset:setPackageApproved')
    const chooseParent = handlers.get('dataset:chooseCatalogParent')
    const exportCatalog = handlers.get('dataset:export')
    expect(choose).toBeTypeOf('function')
    expect(inspect).toBeTypeOf('function')
    expect(approve).toBeTypeOf('function')
    expect(chooseParent).toBeTypeOf('function')
    expect(exportCatalog).toBeTypeOf('function')
    const midi = vocalMidi()
    const archive = new AdmZip()
    archive.addFile('notes.mid', midi)
    const packagePath = join(scratch, 'root-review-source.zip')
    archive.writeZip(packagePath)
    const containerSha256 = createHash('sha256')
      .update(await readFile(packagePath))
      .digest('hex')
    const midiSha256 = createHash('sha256').update(midi).digest('hex')
    const entryId = packageEntryIdentity('zip', containerSha256, '', midiSha256)
    const sender = new FakeSender()
    const group = (await choose!({ sender } as unknown)) as { groupId: string }
    getReviewEntries.mockReturnValueOnce([
      {
        source: { kind: 'zip', sourcePath: packagePath },
        containerSha256,
        midiSha256,
        entryLocator: '',
        entryId,
        exactExpertPartVocals: true,
        duplicateMidi: false
      }
    ])
    runSession.mockResolvedValueOnce({ ...inventoryResult(), cancelled: false })
    const inspection = (await inspect!({ sender } as unknown, group.groupId)) as {
      reviewCandidates: Array<{ candidateId: string }>
    }
    const candidateId = inspection.reviewCandidates[0]?.candidateId
    expect(candidateId).toEqual(expect.any(String))
    expect(approve!({ sender } as unknown, candidateId, true) as boolean).toBe(true)
    const parent = (await chooseParent!({ sender } as unknown)) as { parentId: string }
    await expect(
      exportCatalog!({ sender } as unknown, {
        candidateIds: [candidateId],
        parentId: parent.parentId,
        catalogName: 'root-review-catalog',
        catalogId: 'root-review-catalog',
        provenance: 'Reviewed',
        license: 'test-only',
        mode: 'create'
      })
    ).resolves.toMatchObject({ recordCount: 1 })
    const record = JSON.parse(
      await readFile(join(scratch, 'root-review-catalog', 'records.jsonl'), 'utf8')
    ) as { import: { container_sha256: string }; chart: { instruments: Record<string, unknown> } }
    expect(record.import.container_sha256).toBe(containerSha256)
    expect(record.chart.instruments).toHaveProperty('vocals')
  })

  it('aborts and revokes an active inventory when its group is removed', async () => {
    const choose = handlers.get('dataset:choosePackageFolder')
    const inspect = handlers.get('dataset:inspectPackageGroup')
    const remove = handlers.get('dataset:removePackageGroup')
    const approve = handlers.get('dataset:setPackageApproved')
    expect(choose).toBeTypeOf('function')
    expect(inspect).toBeTypeOf('function')
    expect(remove).toBeTypeOf('function')
    expect(approve).toBeTypeOf('function')

    const sender = new FakeSender()
    const group = (await choose!({ sender } as unknown)) as {
      groupId: string
      candidates: Array<{ candidateId: string }>
    }
    let resolveInventory: ((value: DatasetPackageSourceInventory) => void) | null = null
    let inventoryOptions: DatasetPackageInventoryOptions | null = null
    const activeOptions = (): DatasetPackageInventoryOptions => {
      if (!inventoryOptions) throw new Error('Inventory job did not start.')
      return inventoryOptions
    }
    const finishInventory = (): void => {
      if (!resolveInventory) throw new Error('Inventory job cannot finish.')
      resolveInventory(inventoryResult())
    }
    runSession.mockImplementationOnce(
      (_session: DatasetPackageInventorySession, options: DatasetPackageInventoryOptions) => {
        inventoryOptions = options
        return new Promise<DatasetPackageSourceInventory>((resolve) => {
          resolveInventory = resolve
        })
      }
    )

    const activeInspection = inspect!({ sender } as unknown, group.groupId) as Promise<unknown>
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(activeOptions().signal?.aborted).toBe(false)

    await (remove!(
      { sender } as unknown,
      group.candidates.map((candidate) => candidate.candidateId),
      group.groupId
    ) as Promise<unknown>)
    expect(activeOptions().signal?.aborted).toBe(true)
    finishInventory()

    await expect(activeInspection).resolves.toBeNull()
    expect(approve!({ sender } as unknown, group.candidates[0].candidateId, true) as boolean).toBe(
      false
    )
  })
})
