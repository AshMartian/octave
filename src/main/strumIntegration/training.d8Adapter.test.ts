import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const scratch = mkdtempSync(join(tmpdir(), 'octave-strum-d8-adapter-'))
const sends: Array<Record<string, unknown>> = []
const requests: Array<Record<string, unknown>> = []
const workerCommands: string[][] = []
let catalogInspectionPayload: Record<string, unknown> = {
  status: 'ready',
  catalog_id: 'approved_catalog',
  record_count: 3,
  allowed_record_count: 2,
  pipeline_id: 'chart_transform.five_lane/v1',
  eligible_count: 2,
  exclusion_reason_counts: { audio_unavailable: 1 },
  audio_policy: { kind: 'not_required', required: false },
  estimated_storage_bytes: 12,
  storage_estimate_capped: false,
  storage_estimate_semantics: 'distinct approved assets',
  eligibility_selection: { mode: 'requested_prepare_options' }
}
const manifestSha = 'a'.repeat(64)
const artifactId = `strum-model-bundle/${'b'.repeat(64)}`

const pipeline = {
  id: 'chart_transform.five_lane/v1',
  display_name: 'Five-lane transform',
  kind: 'chart_to_chart',
  version: 1,
  status: 'catalog_ready',
  preparation_status: 'available',
  training_status: 'available',
  catalog_requirements: { instruments: ['guitar'], source_difficulty: 'expert' },
  prepare_schema: {
    type: 'object',
    properties: {
      instrument: { type: 'string', enum: ['guitar'] },
      target_difficulty: { type: 'string', enum: ['Hard'] },
      calibration_fraction: { type: 'number', default: 0.1, exclusiveMinimum: 0 }
    },
    required: ['instrument', 'target_difficulty']
  },
  train_schema: {
    type: 'object',
    properties: { model_id: { type: 'string' }, epochs: { type: 'integer', default: 3 } },
    required: ['model_id']
  },
  checkpoint_outputs: ['chart_transform'],
  inference_capability: 'difficulty.transform/v1',
  private_request_fields: ['catalog_root', 'parent_bundle'],
  catalog_inspection_option_keys: ['instrument', 'target_difficulty'],
  training_requirements: ['source_disjoint_train_calibration_test/v2'],
  promotion_jobs: [
    {
      id: 'chart-transform.profile-evaluate/v1',
      display_name: 'Evaluate',
      kind: 'evaluation',
      status: 'available',
      options_schema: { type: 'object', properties: {}, required: [] },
      private_request_fields: ['bundle_root', 'dataset_manifest', 'output'],
      optional_private_request_fields: ['catalog_root'],
      output_kind: 'evaluation_report',
      deployment_scope: 'evaluation_evidence_only'
    }
  ]
}

function candidate(): Record<string, unknown> {
  return {
    artifact_id: artifactId,
    model_id: 'five-lane-hard',
    manifest_sha256: manifestSha,
    schema_version: 1,
    compatibility: { manifest_schema: 1, strum_version: '>=1.0.0' },
    components: [{ id: 'chart_transform', sha256: 'c'.repeat(64), byte_length: 42 }],
    profiles: [],
    rejected_profile_count: 0,
    deployment_status: 'not_deployable'
  }
}

vi.mock('electron', () => ({
  app: { getPath: () => scratch, isPackaged: false },
  BrowserWindow: {
    getAllWindows: () => [
      {
        webContents: {
          send: (_channel: string, payload: Record<string, unknown>) => sends.push(payload)
        }
      }
    ]
  },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) }
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
    workerCommands.push(args)
    if (args.includes('probe')) {
      callback(
        null,
        `${JSON.stringify({
          protocol_version: '1.0',
          runtime_id: 'd8-test',
          capabilities: ['dataset_prepare', 'training_start', 'post_train_job_discovery']
        })}\n`
      )
      return
    }
    if (args.includes('pipeline') && args.includes('list')) {
      callback(null, `${JSON.stringify({ pipelines: [pipeline] })}\n`)
      return
    }
    if (args.includes('catalog') && args.includes('inspect')) {
      callback(null, `${JSON.stringify(catalogInspectionPayload)}\n`)
      return
    }
    if (args.includes('checkpoint') && args.includes('inspect')) {
      callback(null, `${JSON.stringify(candidate())}\n`)
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
    child.pid = 123
    child.kill = () => true
    const requestPath = args[args.indexOf('--request') + 1]
    queueMicrotask(() => {
      const request = JSON.parse(readFileSync(requestPath, 'utf8')) as Record<string, unknown>
      requests.push(request)
      const output = request.output as string
      if (args.includes('dataset')) {
        mkdirSync(join(output, '..'), { recursive: true })
        writeFileSync(output, '{}\n')
      } else {
        mkdirSync(output, { recursive: true })
        writeFileSync(join(output, 'strum-model-bundle.json'), '{}\n')
      }
      child.stdout.emit(
        'data',
        Buffer.from(
          `${JSON.stringify({ sequence: 1, stage: 'worker_job', state: 'running', code: 'started' })}\n`
        )
      )
      const result = args.includes('dataset')
        ? {
            status: 'prepared',
            pipeline_id: pipeline.id,
            task_view_id: 'taskviewd8',
            record_count: 2,
            output_name: 'task.json'
          }
        : {
            status: 'completed',
            pipeline_id: pipeline.id,
            bundle_name: 'run',
            manifest_sha256: manifestSha,
            components: [{ id: 'chart_transform', sha256: 'c'.repeat(64), byte_length: 42 }]
          }
      child.stdout.emit(
        'data',
        Buffer.from(
          `${JSON.stringify({
            sequence: 2,
            stage: 'worker_job',
            state: 'succeeded',
            code: 'completed',
            result
          })}\n`
        )
      )
      if (args.includes('train')) {
        child.stdout.emit(
          'data',
          Buffer.from(
            `${JSON.stringify({
              sequence: 3,
              stage: 'worker_job',
              state: 'succeeded',
              code: 'completed',
              result
            })}\n`
          )
        )
      }
      child.emit('close', 0)
    })
    return child
  }
}))

import {
  inspectTrainingCatalog,
  listTrainingArtifacts,
  startTrainingPrepare,
  startTrainingRun
} from './training'

async function settled(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 15))
}

afterEach(() => {
  sends.length = 0
  requests.length = 0
  workerCommands.length = 0
  catalogInspectionPayload = {
    status: 'ready',
    catalog_id: 'approved_catalog',
    record_count: 3,
    allowed_record_count: 2,
    pipeline_id: pipeline.id,
    eligible_count: 2,
    exclusion_reason_counts: { audio_unavailable: 1 },
    audio_policy: { kind: 'not_required', required: false },
    estimated_storage_bytes: 12,
    storage_estimate_capped: false,
    storage_estimate_semantics: 'distinct approved assets',
    eligibility_selection: { mode: 'requested_prepare_options' }
  }
})

describe('STRUM d8 training adapter', () => {
  it('uses strict d8 request/result DTOs and keeps candidate roots private', async () => {
    const catalogRoot = join(scratch, 'private-catalog')
    mkdirSync(catalogRoot, { recursive: true })
    const inspection = await inspectTrainingCatalog(catalogRoot, pipeline.id, {
      instrument: 'guitar',
      target_difficulty: 'Hard',
      calibration_fraction: 0.1
    })
    expect(inspection).toMatchObject({
      eligibleCount: 2,
      excluded: { audio_unavailable: 1 },
      audioPolicy: { kind: 'not_required' }
    })
    expect(workerCommands.find((command) => command.includes('catalog'))).toEqual(
      expect.arrayContaining([
        '--catalog-root',
        catalogRoot,
        '--options',
        JSON.stringify({ instrument: 'guitar', target_difficulty: 'Hard' })
      ])
    )

    const prepared = await startTrainingPrepare({
      catalogRoot,
      catalogId: 'catalog',
      catalogName: 'Approved songs',
      pipelineId: pipeline.id,
      prepare: { instrument: 'guitar', target_difficulty: 'Hard' }
    })
    await settled()
    expect(Object.keys(requests[0]).sort()).toEqual([
      'catalog_root',
      'options',
      'output',
      'pipeline_id'
    ])
    expect(requests[0]).toMatchObject({ catalog_root: catalogRoot, pipeline_id: pipeline.id })

    await startTrainingRun({
      taskViewId: prepared.taskViewId,
      pipelineId: pipeline.id,
      train: { model_id: 'five-lane-hard' }
    })
    await settled()
    expect(Object.keys(requests[1]).sort()).toEqual([
      'catalog_root',
      'options',
      'output',
      'pipeline_id',
      'task_view'
    ])
    const artifacts = await listTrainingArtifacts()
    expect(artifacts.runs).toEqual([
      expect.objectContaining({ artifactId, checkpointManifestHash: manifestSha })
    ])
    expect(JSON.stringify(artifacts)).not.toContain(scratch)
    expect(sends).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ state: 'running', code: 'started' }),
        expect.objectContaining({ state: 'succeeded', message: 'Completed locally.' })
      ])
    )
    expect(sends.filter((event) => event.state === 'succeeded')).toHaveLength(2)
    expect(existsSync(join(scratch, 'strum-training', 'registry.json'))).toBe(true)
    const registry = readFileSync(join(scratch, 'strum-training', 'registry.json'), 'utf8')
    expect(registry).toContain('candidateBinding')
    expect(registry).toContain(catalogRoot)
  })

  it('rejects malformed, wrong-pipeline, and path-bearing catalog summaries', async () => {
    const catalogRoot = join(scratch, 'strict-private-catalog')
    mkdirSync(catalogRoot, { recursive: true })
    const baseline = {
      status: 'ready',
      catalog_id: 'approved_catalog',
      record_count: 3,
      allowed_record_count: 2,
      pipeline_id: pipeline.id,
      eligible_count: 2,
      exclusion_reason_counts: { audio_unavailable: 1 },
      audio_policy: { kind: 'not_required', required: false },
      estimated_storage_bytes: 12,
      storage_estimate_capped: false,
      storage_estimate_semantics: 'distinct approved assets',
      eligibility_selection: { mode: 'requested_prepare_options' }
    }
    catalogInspectionPayload = { ...baseline, pipeline_id: 'wrong.pipeline/v1' }
    await expect(
      inspectTrainingCatalog(catalogRoot, pipeline.id, {
        instrument: 'guitar',
        target_difficulty: 'Hard'
      })
    ).rejects.toThrow('invalid catalog inspection')
    catalogInspectionPayload = {
      ...baseline,
      exclusion_reason_counts: { '/private/catalog/secret': 1 }
    }
    await expect(
      inspectTrainingCatalog(catalogRoot, pipeline.id, {
        instrument: 'guitar',
        target_difficulty: 'Hard'
      })
    ).rejects.toThrow('invalid catalog inspection')
    catalogInspectionPayload = {
      ...baseline,
      storage_estimate_semantics: 'diagnostic at /private/catalog'
    }
    await expect(
      inspectTrainingCatalog(catalogRoot, pipeline.id, {
        instrument: 'guitar',
        target_difficulty: 'Hard'
      })
    ).rejects.toThrow('invalid catalog inspection')
  })
})
