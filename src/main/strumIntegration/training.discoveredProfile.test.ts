import { mkdtempSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const scratch = mkdtempSync(join(tmpdir(), 'octave-training-profile-test-'))
const manifestA = 'a'.repeat(64)
const manifestB = 'b'.repeat(64)
const artifactA = `strum-model-bundle/${'c'.repeat(64)}`
const artifactB = `strum-model-bundle/${'d'.repeat(64)}`

type CandidateOptions = {
  artifactId: string
  manifestSha256: string
  deploymentStatus?: 'ready' | 'not_deployable'
}

function candidate({
  artifactId,
  manifestSha256,
  deploymentStatus = 'ready'
}: CandidateOptions): Record<string, unknown> {
  return {
    artifact_id: artifactId,
    model_id: 'catalog-guitar-v1',
    manifest_sha256: manifestSha256,
    schema_version: 1,
    compatibility: { protocol_major: 1 },
    components: [{ id: 'chart_transform', sha256: 'e'.repeat(64), byte_length: 42 }],
    profiles: [
      {
        profile_id: 'guitar-hard-v1',
        capability: 'chart.transform/v1',
        instruments: ['guitar'],
        difficulty_policies: ['hard'],
        required_components: ['chart_transform'],
        execution: {
          status: deploymentStatus === 'ready' ? 'available' : 'not_available',
          difficulty_policies: deploymentStatus === 'ready' ? ['hard'] : []
        }
      }
    ],
    rejected_profile_count: 0,
    deployment_status: deploymentStatus
  }
}

let selectedFolder = ''
const inspections = new Map<string, Record<string, unknown>>()

vi.mock('electron', () => ({
  app: { getPath: () => scratch, isPackaged: false },
  BrowserWindow: { getAllWindows: () => [] },
  dialog: {
    showOpenDialog: async () => ({ canceled: false, filePaths: [selectedFolder] })
  }
}))

vi.mock('./runner', () => ({
  resolvePythonCommand: async () => ({ command: 'strum-test-worker', baseArgs: [] })
}))

vi.mock('child_process', () => ({
  execFile: (
    _command: string,
    args: string[],
    _options: unknown,
    callback: (error: Error | null, stdout: string) => void
  ) => {
    const modelRoot = args[args.indexOf('--model-root') + 1]
    const inspection = inspections.get(modelRoot)
    if (args.includes('probe')) {
      callback(
        null,
        `${JSON.stringify({
          protocol_version: '1.0',
          runtime_id: 'test-runtime',
          capabilities: ['chart']
        })}\n`
      )
      return
    }
    if (args.includes('checkpoint') && args.includes('discover') && inspection) {
      callback(
        null,
        `${JSON.stringify({
          format: 'strum-model-bundle-discovery/v1',
          status: 'ready',
          candidate_count: 1,
          profile_count: 1,
          rejected_bundle_count: 0,
          truncated: false,
          candidates: [inspection]
        })}\n`
      )
      return
    }
    if (args.includes('checkpoint') && args.includes('inspect') && inspection) {
      callback(null, `${JSON.stringify(inspection)}\n`)
      return
    }
    if (args.includes('inference') && args.includes('profile') && inspection) {
      callback(
        null,
        `${JSON.stringify({
          status: 'ready',
          profile_id: 'guitar-hard-v1',
          manifest_sha256: inspection.manifest_sha256
        })}\n`
      )
      return
    }
    callback(new Error('unexpected STRUM request'), '')
  }
}))

import {
  chooseCheckpointFolder,
  inspectDiscoveredCheckpoint,
  runDefaultAutoChartProfile,
  saveDiscoveredAutoChartProfile
} from './training'

async function addBundle(folderName: string, inspection: Record<string, unknown>): Promise<string> {
  const root = join(scratch, folderName)
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'strum-model-bundle.json'), '{}\n', 'utf8')
  inspections.set(root, inspection)
  return root
}

async function registry(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(scratch, 'strum-training', 'registry.json'), 'utf8'))
}

beforeEach(async () => {
  await rm(scratch, { recursive: true, force: true })
  await mkdir(scratch, { recursive: true })
  inspections.clear()
  selectedFolder = ''
})

describe('discovered STRUM profile boundaries', () => {
  it('returns a path-redacted public DTO while persisting the private root and manifest identity', async () => {
    selectedFolder = await addBundle(
      'bundle-a',
      candidate({ artifactId: artifactA, manifestSha256: manifestA })
    )
    await chooseCheckpointFolder()

    const saved = await saveDiscoveredAutoChartProfile({
      artifactId: artifactA,
      profileId: 'guitar-hard-v1',
      difficultyPolicy: 'hard'
    })

    expect(saved).toEqual({
      profileId: expect.stringMatching(/^octave-strum-profile-/),
      strumProfileId: 'guitar-hard-v1',
      artifactId: artifactA,
      difficultyPolicy: 'hard',
      pipelineId: 'chart.transform/v1',
      runtimeId: 'test-runtime',
      createdAt: expect.any(String),
      isDefault: true
    })
    expect(JSON.stringify(saved)).not.toContain(selectedFolder)

    const persisted = await registry()
    expect(persisted).toMatchObject({ defaultProfileId: saved.profileId })
    expect(persisted.profiles).toMatchObject([
      { checkpointRoot: selectedFolder, artifactId: artifactA, manifestSha256: manifestA }
    ])
  })

  it('clears artifact bindings from the previous folder selection', async () => {
    selectedFolder = await addBundle(
      'bundle-a',
      candidate({ artifactId: artifactA, manifestSha256: manifestA })
    )
    await chooseCheckpointFolder()
    selectedFolder = await addBundle(
      'bundle-b',
      candidate({ artifactId: artifactB, manifestSha256: manifestB })
    )
    await chooseCheckpointFolder()

    await expect(inspectDiscoveredCheckpoint(artifactA)).rejects.toThrow(
      /Select the checkpoint folder again/
    )
    await expect(inspectDiscoveredCheckpoint(artifactB)).resolves.toMatchObject({
      artifactId: artifactB,
      manifestSha256: manifestB
    })
  })

  it('clears a saved default when its manifest no longer matches re-inspection', async () => {
    const root = await addBundle(
      'bundle-a',
      candidate({ artifactId: artifactA, manifestSha256: manifestA })
    )
    selectedFolder = root
    await chooseCheckpointFolder()
    await saveDiscoveredAutoChartProfile({
      artifactId: artifactA,
      profileId: 'guitar-hard-v1',
      difficultyPolicy: 'hard'
    })
    inspections.set(root, candidate({ artifactId: artifactA, manifestSha256: manifestB }))

    await expect(
      runDefaultAutoChartProfile({
        runId: 'run-1',
        outputDir: join(scratch, 'output'),
        files: [],
        folders: [],
        stemFolders: [],
        urls: []
      })
    ).resolves.toBeNull()

    const persisted = await registry()
    expect(persisted).not.toHaveProperty('defaultProfileId')
    expect(persisted.profiles).toEqual([])
  })

  it('rejects non-deployable bundle profiles before saving a default', async () => {
    selectedFolder = await addBundle(
      'bundle-not-deployable',
      candidate({
        artifactId: artifactA,
        manifestSha256: manifestA,
        deploymentStatus: 'not_deployable'
      })
    )
    await chooseCheckpointFolder()

    await expect(
      saveDiscoveredAutoChartProfile({
        artifactId: artifactA,
        profileId: 'guitar-hard-v1',
        difficultyPolicy: 'hard'
      })
    ).rejects.toThrow(/no executable STRUM Auto Chart profile/)
  })
})
