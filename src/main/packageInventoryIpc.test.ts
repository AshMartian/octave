import { EventEmitter } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type {
  DatasetPackageInventoryOptions,
  DatasetPackageInventorySession,
  DatasetPackageSourceInventory
} from './import/packageSourceInventory'

type IpcHandler = (...args: unknown[]) => unknown

const handlers = new Map<string, IpcHandler>()
const runSession =
  vi.fn<
    (
      session: DatasetPackageInventorySession,
      options: DatasetPackageInventoryOptions
    ) => Promise<DatasetPackageSourceInventory>
  >()
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
  return { ...actual, runDatasetPackageInventorySession: runSession }
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

beforeAll(async () => {
  await writeFile(join(scratch, 'selected-package.zip'), 'fixture')
  await import('./index')
})

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true })
})

describe('dataset package inventory IPC lifecycle', () => {
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
