import { mkdtempSync } from 'node:fs'
import { EventEmitter } from 'node:events'
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
  profile?: {
    id: string
    capability: string
    instrument: 'guitar' | 'drums'
    difficultyPolicy: 'expert_only'
  }
}

function candidate({
  artifactId,
  manifestSha256,
  deploymentStatus = 'ready',
  profile = {
    id: 'guitar-hybrid-v2-rule',
    capability: 'guitar.hybrid-v2-rule/v1',
    instrument: 'guitar' as const,
    difficultyPolicy: 'expert_only' as const
  }
}: CandidateOptions): Record<string, unknown> {
  return {
    artifact_id: artifactId,
    model_id: 'catalog-guitar-v1',
    manifest_sha256: manifestSha256,
    schema_version: 1,
    compatibility: { manifest_schema: 1, strum_version: '>=1.0.0' },
    components: [{ id: 'chart_transform', sha256: 'e'.repeat(64), byte_length: 42 }],
    profiles: [
      {
        profile_id: profile.id,
        capability: profile.capability,
        instruments: [profile.instrument],
        difficulty_policies: [profile.difficultyPolicy],
        required_components: ['chart_transform'],
        execution: {
          status: deploymentStatus === 'ready' ? 'available' : 'not_available',
          difficulty_policies: deploymentStatus === 'ready' ? [profile.difficultyPolicy] : []
        }
      }
    ],
    rejected_profile_count: 0,
    deployment_status: deploymentStatus
  }
}

let selectedFolder = ''
const inspections = new Map<string, Record<string, unknown>>()
const preflightRequests: Record<string, unknown>[] = []
const chartRunRequests: Record<string, unknown>[] = []

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
          capabilities: ['chart'],
          device_support: ['cpu']
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
          profile_id: args[args.indexOf('--profile') + 1],
          manifest_sha256: inspection.manifest_sha256
        })}\n`
      )
      return
    }
    if (args.includes('chart') && args.includes('preflight')) {
      const requestPath = args[args.indexOf('--request') + 1]
      void readFile(requestPath, 'utf8').then((text) => {
        const request = JSON.parse(text) as Record<string, unknown>
        preflightRequests.push(request)
        callback(
          null,
          `${JSON.stringify({
            format: 'strum-chart-preflight/v1',
            status: 'ready',
            execution: 'available',
            profile_id: request.profile_id,
            difficulty_policy: request.difficulty_policy,
            instruments: request.instruments,
            device: request.device
          })}\n`
        )
      })
      return
    }
    callback(new Error('unexpected STRUM request'), '')
  },
  spawn: (_command: string, args: string[]) => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter
      stderr: EventEmitter
      pid: number
      kill: () => boolean
    }
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.pid = 1234
    child.kill = () => true
    const requestPath = args[args.indexOf('--request') + 1]
    void readFile(requestPath, 'utf8').then((text) => {
      const request = JSON.parse(text) as Record<string, unknown>
      chartRunRequests.push(request)
      const preflight = preflightRequests.at(-1) ?? {}
      child.stdout.emit(
        'data',
        Buffer.from(
          `${JSON.stringify({
            format: 'strum-chart-run/v1',
            status: 'completed',
            profile_id: preflight.profile_id,
            run_manifest_name: 'run.json',
            output_name: 'notes.mid'
          })}\n`
        )
      )
      child.emit('close', 0)
    })
    return child
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
  preflightRequests.length = 0
  chartRunRequests.length = 0
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
      profileId: 'guitar-hybrid-v2-rule',
      difficultyPolicy: 'expert_only'
    })

    expect(saved).toEqual({
      profileId: expect.stringMatching(/^octave-strum-profile-/),
      strumProfileId: 'guitar-hybrid-v2-rule',
      artifactId: artifactA,
      difficultyPolicy: 'expert_only',
      pipelineId: 'guitar.hybrid-v2-rule/v1',
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
      profileId: 'guitar-hybrid-v2-rule',
      difficultyPolicy: 'expert_only'
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
        profileId: 'guitar-hybrid-v2-rule',
        difficultyPolicy: 'expert_only'
      })
    ).rejects.toThrow(/no executable STRUM Auto Chart profile/)
  })

  it('rejects path-bearing compatibility metadata before checkpoint discovery reaches IPC', async () => {
    const inspection = candidate({ artifactId: artifactA, manifestSha256: manifestA })
    inspection.compatibility = {
      manifest_schema: 1,
      strum_version: '>=1.0.0',
      strum_revision: 'source:/private/bundle'
    }
    selectedFolder = await addBundle('bundle-path-metadata', inspection)
    await expect(chooseCheckpointFolder()).rejects.toThrow('valid checkpoint discovery response')
  })

  it('preserves a null STRUM dirty-state as an unknown, safe compatibility value', async () => {
    const inspection = candidate({ artifactId: artifactA, manifestSha256: manifestA })
    inspection.compatibility = {
      manifest_schema: 1,
      strum_version: '>=1.0.0',
      strum_source_dirty: null
    }
    selectedFolder = await addBundle('bundle-unknown-dirty-state', inspection)
    await expect(chooseCheckpointFolder()).resolves.toMatchObject({
      candidates: [
        expect.objectContaining({
          compatibility: expect.objectContaining({ strum_source_dirty: null })
        })
      ]
    })
  })

  it.each([
    {
      name: 'Guitar',
      profile: {
        id: 'guitar-hybrid-v2-rule',
        capability: 'guitar.hybrid-v2-rule/v1',
        instrument: 'guitar' as const,
        difficultyPolicy: 'expert_only' as const
      }
    },
    {
      name: 'Drums',
      profile: {
        id: 'drums-v14-expert',
        capability: 'drums.v14-expert/v1',
        instrument: 'drums' as const,
        difficultyPolicy: 'expert_only' as const
      }
    }
  ])(
    'runs $name through the current STRUM preflight and typed chart-result boundary',
    async ({ profile }) => {
      selectedFolder = await addBundle(
        `bundle-${profile.instrument}`,
        candidate({ artifactId: artifactA, manifestSha256: manifestA, profile })
      )
      const audioPath = join(scratch, `${profile.instrument}.wav`)
      const outputDir = join(scratch, `${profile.instrument}-output`)
      await writeFile(audioPath, 'local-audio')
      await chooseCheckpointFolder()
      await saveDiscoveredAutoChartProfile({
        artifactId: artifactA,
        profileId: profile.id,
        difficultyPolicy: profile.difficultyPolicy
      })

      await expect(
        runDefaultAutoChartProfile({
          runId: `run-${profile.instrument}`,
          outputDir,
          files: [audioPath],
          folders: [],
          stemFolders: [],
          urls: []
        })
      ).resolves.toEqual({ success: true, outputDir, songFolders: [], errors: [] })

      expect(preflightRequests).toEqual([
        {
          model_root: selectedFolder,
          profile_id: profile.id,
          difficulty_policy: 'expert_only',
          instruments: [profile.instrument],
          device: 'cpu'
        }
      ])
      expect(chartRunRequests).toHaveLength(1)
      expect(chartRunRequests[0]).toMatchObject({
        audio_path: audioPath,
        output_dir: outputDir,
        preflight_request: expect.stringMatching(/-preflight\.json$/)
      })
      expect(JSON.stringify(chartRunRequests[0])).not.toContain(selectedFolder)
    }
  )

  it('rejects URL and raw/nonexecutable bundle paths before any chart run starts', async () => {
    selectedFolder = await addBundle(
      'raw-candidate',
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
        profileId: 'guitar-hybrid-v2-rule',
        difficultyPolicy: 'expert_only'
      })
    ).rejects.toThrow(/no executable STRUM Auto Chart profile/)

    selectedFolder = await addBundle(
      'guitar-candidate',
      candidate({ artifactId: artifactA, manifestSha256: manifestA })
    )
    await chooseCheckpointFolder()
    await saveDiscoveredAutoChartProfile({
      artifactId: artifactA,
      profileId: 'guitar-hybrid-v2-rule',
      difficultyPolicy: 'expert_only'
    })
    await expect(
      runDefaultAutoChartProfile({
        runId: 'url-run',
        outputDir: join(scratch, 'output'),
        files: [],
        folders: [],
        stemFolders: [],
        urls: ['https://example.invalid/video']
      })
    ).rejects.toThrow(/exactly one local audio file/)
    expect(preflightRequests).toEqual([])
    expect(chartRunRequests).toEqual([])
  })
})
