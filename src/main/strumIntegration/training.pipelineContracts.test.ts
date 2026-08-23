import { describe, expect, it, vi } from 'vitest'

let pipelinePayload: unknown[] = []

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/octave-training-contract-test', isPackaged: false },
  BrowserWindow: { getAllWindows: () => [] },
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
    if (args.includes('probe')) {
      callback(
        null,
        `${JSON.stringify({
          protocol_version: '1.0',
          runtime_id: 'test-runtime',
          capabilities: ['dataset_prepare']
        })}\n`
      )
      return
    }
    if (args.includes('pipeline') && args.includes('list')) {
      callback(null, `${JSON.stringify({ pipelines: pipelinePayload })}\n`)
      return
    }
    callback(new Error('unexpected STRUM request'), '')
  }
}))

import { listTrainingPipelines } from './training'

const pipelineId = 'strum.instrument-chart/pro-guitar/v1'

function outputContracts(): Record<string, unknown> {
  return {
    format: 'strum-candidate-checkpoint-output-contracts/v1',
    selector: { training_option: 'candidate_kind', default: 'known_event_attributes/v1' },
    by_candidate_kind: {
      'known_event_attributes/v1': {
        component_outputs: ['pro.guitar.event_attributes'],
        model_outputs: ['string_fret_technique', 'track_variant'],
        preprocessing: {
          id: 'pro-logmel-event-windows/v1',
          input_contract: 'strum-pro-known-reference-event-window/v1'
        },
        candidate_bundle: {
          config_format: 'strum-pro-event-attribute-candidate-config/v1',
          task_kind: 'pro_guitar',
          pipeline_id: pipelineId,
          model_implementation: 'ProEventAttributeCNN/v1',
          input_contract: {
            format: 'strum-pro-known-reference-event-window/v1',
            event_time_source: 'held_out_catalog_label_only',
            free_running_event_proposal: false,
            sequence_decoding: false,
            midi_emission: false
          },
          output_contract: {
            format: 'strum-pro-known-event-attributes/v1',
            outputs: ['string_fret_technique', 'track_variant'],
            free_running_event_proposal: false,
            sequence_decoding: false,
            midi_emission: false
          },
          target_contract: {
            kind: 'pro_string_fret_technique/v1',
            string_count: 6,
            fret_range: [0, 22],
            techniques: ['normal', 'muted'],
            track_variant_head: ['standard', '22_fret']
          },
          component_set: ['pro.guitar.event_attributes'],
          profiles: 'forbidden',
          companions: 'forbidden'
        },
        deployment_scope: {
          status: 'raw_experiment_candidate_only',
          profile: 'not_available',
          chart_execution: 'not_available'
        }
      },
      'free_running_event_proposal/v1': {
        component_outputs: ['pro.guitar.event_proposal'],
        model_outputs: ['audio_event_proposal_scores'],
        preprocessing: {
          id: 'pro-logmel-event-proposal-windows/v1',
          input_contract: 'strum-pro-arbitrary-audio-window/v1',
          negative_policy: 'pro-event-proposal-negative-policy/v1'
        },
        candidate_bundle: {
          config_format: 'strum-pro-event-proposal-candidate-config/v1',
          task_kind: 'pro_guitar',
          pipeline_id: pipelineId,
          model_implementation: 'ProEventProposalCNN/v1',
          input_contract: {
            format: 'strum-pro-arbitrary-audio-window/v1',
            requires_midi_at_inference: false,
            offline_window_scoring: true,
            free_running_event_proposal: true,
            sequence_decoding: false,
            midi_emission: false
          },
          output_contract: {
            format: 'strum-pro-event-proposal-scores/v1',
            event_attributes: false,
            midi_emission: false
          },
          component_set: ['pro.guitar.event_proposal'],
          profiles: 'forbidden',
          companions: 'forbidden'
        },
        deployment_scope: {
          status: 'raw_experiment_candidate_only',
          profile: 'not_available',
          chart_execution: 'not_available'
        }
      }
    }
  }
}

describe('STRUM checkpoint output-contract descriptors', () => {
  it('exposes a selected-candidate map without private paths or deployment authority', async () => {
    pipelinePayload = [{ id: pipelineId, checkpoint_output_contracts: outputContracts() }]

    const [pipeline] = await listTrainingPipelines()
    expect(pipeline.checkpoint_output_contracts).toEqual({
      format: 'strum-candidate-checkpoint-output-contracts/v1',
      selector: { training_option: 'candidate_kind', default: 'known_event_attributes/v1' },
      by_candidate_kind: expect.objectContaining({
        'known_event_attributes/v1': expect.objectContaining({
          component_outputs: ['pro.guitar.event_attributes'],
          deployment_scope: {
            status: 'raw_experiment_candidate_only',
            profile: 'not_available',
            chart_execution: 'not_available'
          }
        }),
        'free_running_event_proposal/v1': expect.objectContaining({
          component_outputs: ['pro.guitar.event_proposal']
        })
      })
    })
    expect(JSON.stringify(pipeline.checkpoint_output_contracts)).not.toMatch(
      /[/\\](home|tmp|run)[/\\]/
    )
  })

  it('rejects a descriptor with an unknown candidate field instead of passing it through', async () => {
    const contracts = outputContracts()
    const candidates = contracts.by_candidate_kind as Record<string, Record<string, unknown>>
    candidates['known_event_attributes/v1'].unsafe_path = '/private/checkpoint'
    pipelinePayload = [{ id: pipelineId, checkpoint_output_contracts: contracts }]

    await expect(listTrainingPipelines()).resolves.toEqual([])
  })

  it('keeps existing descriptors that do not use candidate output contracts', async () => {
    pipelinePayload = [
      {
        id: 'guitar.onset-fret/v1',
        display_name: 'Guitar onset + fret',
        checkpoint_outputs: ['guitar.onset', 'guitar.fret']
      }
    ]

    await expect(listTrainingPipelines()).resolves.toEqual(pipelinePayload)
  })
})
