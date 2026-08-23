# OCTAVE ↔ STRUM orchestration contract

## Purpose

OCTAVE is the local curation, catalog, job-control, and deployment surface. STRUM is the versioned ML runtime that owns task definitions, dataset views, preprocessing, training, evaluation, checkpoints, and inference execution.

The boundary supports STRUM as a family of models rather than one model. A user can select Guitar audio-to-chart, Drums, learned chart-to-chart difficulty transforms, or future Vocal/Pro-instrument pipelines from one approved OCTAVE catalog.

The first proof is complete: OCTAVE created a 58-record allowed catalog; STRUM selected 31 Guitar-eligible records; catalog-aware preprocessing and both Guitar model stages completed on CUDA. Those smoke checkpoints are validation artifacts, not deployable quality models.

## Ownership boundary

| Concern                    | OCTAVE owns                                                                     | STRUM owns                                                    |
| -------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Source packages and rights | Safe import, consent/review, catalog materialization                            | Never parses source packages or infers rights                 |
| Source catalog             | Writes path-free `octave-song-source-catalog/v1`; emitted records are `allowed` | Strict validation and consumption                             |
| Task views                 | Pipeline selection and eligibility presentation                                 | Requirements, split assignment, view building and validation  |
| Training                   | User intent, local job lifecycle, progress, cancellation, storage               | Preprocess, train, evaluate, experiment/checkpoint metadata   |
| Deployment                 | Selects a compatible local auto-chart profile/default                           | Declares checkpoint capabilities and loads bundles            |
| Model behavior             | Never implements labels/tokens or deterministic difficulty reduction            | Architecture, labels, learned transforms, inference semantics |

OCTAVE must not reopen original package/folder sources after catalog materialization. STRUM must never receive original locations through catalogs, task views, renderer state, logs, or errors.

## Stable STRUM runtime interface

OCTAVE must invoke a versioned, machine-consumable STRUM worker/CLI. It must not call source-tree `scripts/*.py`, import STRUM internals, or infer support from a checkout layout.

Initial interface:

```text
strum-worker probe --json
strum-worker pipeline list --json
strum-worker catalog inspect --catalog-root <catalog-root> --pipeline <id> --json
strum-worker dataset prepare --request <owned-json> --json-events
strum-worker train start --request <owned-json> --json-events
strum-worker checkpoint inspect --model-root <path> --json
strum-worker inference profile validate --model-root <path> --profile <id> --difficulty-policy <policy> --json
strum-worker chart preflight --request <owned-json> --json
strum-worker chart run --request <owned-json> --json
```

`dataset prepare --json-events` and `train start --json-events` emit line-delimited JSON events with a job ID, monotonic sequence number, stage, progress, safe message/code, and terminal state (`succeeded` or `failed`). Human stdout/stderr is diagnostic only. OCTAVE's main process owns spawning, cancellation, and private paths; it cancels the worker process group rather than asking a separate STRUM daemon to retain a private-path job ID. Its renderer receives only safe IDs, names, capabilities, progress, and errors.

`probe` must report a protocol version, STRUM release and source revision, dirty state, Python/platform requirements, advertised capabilities, pipeline IDs, device support, and supported model/checkpoint manifest schema versions. OCTAVE rejects an unknown major protocol, unsupported pipeline, missing command, or incompatible schema before work begins.

The current `resources/strum/strum_worker.py` is an OCTAVE-specific temporary adapter. Its direct imports and source-tree discovery are not the long-term boundary. Keep it only behind a compatibility mode while STRUM gains the worker interface.

## Runtime kinds and trust

| Runtime kind         | Intended user       | Source of truth                                                | Training support                               |
| -------------------- | ------------------- | -------------------------------------------------------------- | ---------------------------------------------- |
| `bundled_inference`  | Release user        | App-packaged, pinned worker/runtime                            | Only explicitly shipped inference capabilities |
| `managed_checkout`   | Local-training user | OCTAVE-managed pinned STRUM revision plus isolated environment | Advertised capabilities only                   |
| `developer_override` | Contributor         | Explicit local checkout/worker and interpreter                 | Advertised capabilities after acknowledgement  |
| `installed_runtime`  | Advanced user       | Explicit compatible installed `strum-worker` executable        | Advertised capabilities only                   |

Release OCTAVE must not clone arbitrary GitHub branches to auto-chart. It continues to use its shipped inference runtime. "Install STRUM training runtime" is an explicit setup action: choose an official release/tag/immutable commit, verify published hash/signature, stage atomically, provision an isolated environment, probe it, and write a lock manifest. Never fetch `main`/`master`, run `git pull`, or automatically download a runtime because an override was absent.

The developer setting is a **STRUM runtime**, not only a Python path. It contains a canonical main-process-only source root or executable, interpreter/environment where needed, resolved runtime ID, protocol/capability snapshot, revision/dirty state, and validation timestamp. The renderer stores an opaque runtime ID/display name, never an absolute path.

Existing `OCTAVE_STRUM_SOURCE_DIR` and `OCTAVE_STRUM_PYTHON` remain development bootstrap inputs, but must feed the same validator. A bare interpreter override is insufficient. Current development Python selection also needs to align with STRUM's declared Python minimum before the interface is enabled.

## Pipeline descriptors

`pipeline list` is STRUM-owned and is the only source of controls displayed in OCTAVE Prepare and Train.

```json
{
  "id": "guitar.onset-fret/v1",
  "display_name": "Guitar onset + fret",
  "kind": "audio_to_chart",
  "catalog_requirements": {
    "instrument": "guitar",
    "difficulties": ["expert"],
    "audio_roles": ["guitar", "mix"],
    "audio_policy": "prefer:guitar,fallback:mix"
  },
  "prepare_schema": { "type": "object" },
  "train_schema": { "type": "object" },
  "checkpoint_outputs": ["guitar_onset", "guitar_fret"],
  "inference_capability": "guitar.audio_to_chart/v1"
}
```

Future descriptors follow the same shape: `drums.onset-velocity/v*`, `bass.onset-fret/v*`, `vocals.pitch-lyrics/v*`, Pro-instrument pipelines, and `difficulty.transform/v*`. The difficulty transform is a learned STRUM pipeline; OCTAVE may request it and display provenance/confidence but must not own the deterministic Expert-to-lower-difficulty strategy.

### Current training coverage

The catalog-aware Guitar and Drums paths revalidate `allowed` catalog assets and create path-free task views. The first OCTAVE catalog proved 31 Guitar-eligible and 52 Drums-eligible records. Five-lane chart-pair difficulty transforms are catalog-backed and worker-trainable for Guitar, Bass, Keys, and Drums. Bass, Keys, Vocals, Pro instruments, section, and mapper families also have catalog task views; their missing learned trainer architectures remain explicitly `planned` rather than falling back to raw folder scans.

Each new adapter must select only `allowed` records, revalidate catalog hashes at use time, derive labels within STRUM, assign and persist song-disjoint splits, and write catalog ID, task-view hash, source IDs, input hashes, and audio/MIDI alignment provenance into its cache, experiment, and checkpoint manifests. Audio-to-chart descriptors must state whether OCTAVE materializes timeline-aligned audio or STRUM derives and records an alignment offset.

## Immutable handoff artifacts

### Catalog

OCTAVE writes `octave-song-source-catalog/v1`. Curation exclusions happen before export; all produced records have `rights.training_use: "allowed"`. `review_required` is a UI decision state, not a record STRUM is expected to consume.

### Task view

STRUM writes a pipeline-specific, path-free view containing catalog ID and manifest hash; pipeline ID/version and runtime ID; selected source IDs and asset hashes; safe eligibility counts; split algorithm/version/seed; preprocessing configuration/hash; and a task-view content hash. The current `strum-guitar-catalog-manifest/v1` is the first implementation and revalidates managed assets at use time.

### Experiment manifest

Before training, STRUM writes `experiment.json` with run ID; task-view hash; pipeline/runtime IDs; normalized configuration/hash; checkpoint mode (`fresh`, `resume`, `fine_tune`); validated parent; requested/resolved device, precision, workers, and seed; lifecycle/metric summary; and output checkpoint bundle hashes. This removes hidden assumptions in YAML paths and directory names.

### Checkpoint manifest

Every checkpoint or inseparable bundle has a sidecar manifest with schema version/hash; producer runtime/pipeline; architecture, label, and preprocessing fingerprint; parent/fine-tune provenance; task-view/catalog identity; metrics/evaluation split; and inference capabilities/required companions. Guitar deployment is a validated onset + fret bundle, never one arbitrary `.pt` file.

## Auto-chart model-bundle contract

Auto-chart selection needs a STRUM-owned `model-bundle.json` at a validated model root. It is separate from the STRUM runtime selection: choosing a model folder must not select source code, and choosing a runtime must not silently choose arbitrary checkpoints.

The bundle manifest contains schema version; bundle ID; compatible STRUM runtime range; component IDs; relative file paths; SHA-256 and byte lengths; required/optional status; architecture and preprocessing fingerprints; thresholds; and dependent runtime versions such as Demucs, Basic Pitch, and Whisper. Component IDs cover the actual auto-chart graph: separation, drums/ensemble heads, Guitar/Bass onset and mapper, Vocals, Keys, sections, tempo/chart assembly, and any learned difficulty model.

Before a chart run, STRUM performs:

```text
strum-worker inference preflight --model-root <validated-root> --request <owned-json> --json
strum-worker chart --request <owned-json> --json-events
```

Preflight validates bundle schema, file hashes/sizes, model state/config/shape compatibility, device availability, requested instruments, required stems, companion models, and the selected difficulty policy. It returns an immutable resolved plan. Loading an arbitrary user-selected `.pt` with unsafe deserialization is never an OCTAVE feature; only a trusted, verified bundle is eligible.

The chart request names a model bundle/profile, requested instruments, typed backend choices, device/network policy, and an explicit `difficulty_policy`:

- `expert_only`: preserve only model-produced Expert output and defer lower difficulties;
- `deterministic-v1`: an explicitly requested transitional legacy behavior; or
- `learned:<component-id>`: a validated learned STRUM transform.

The result records per-instrument status, resolved model IDs/hashes, stems and fallbacks, exact runtime configuration, output identities, safe warnings/errors, and the chosen difficulty policy. A partial result is never silently presented as a complete deployment result; OCTAVE can display it only when the user explicitly accepts the declared fallback policy.

This removes current gaps where auto-chart loaders use CWD-relative hard-coded checkpoint/config locations, individual models have divergent compatibility rules, optional components silently fall back, and full-pipeline output can report success despite per-instrument failures. It also gives OCTAVE the required checkpoint-folder support without reproducing STRUM internals.

## OCTAVE step plan

### Learn

Show the selected runtime kind/version, capabilities, accelerator support, estimated disk use, and the difference between catalog, task view, experiment, checkpoint, and deployed profile. Explain that a release inference runtime may not have training support. Offer explicit training-runtime setup only when required.

**STRUM calls:** `probe`, `pipeline list`.

### Curate

OCTAVE parses sources in the main process, applies rights and STRUM-charted-song inclusion policy, materializes safe assets, validates the catalog, and writes only allowed records. STRUM may provide a read-only compatibility preview but cannot alter rights or source selection.

**STRUM call:** optional `catalog inspect`.

### Prepare

OCTAVE lists only pipelines advertised by the selected runtime. It sends the catalog root only from the main process and displays eligible count, missing requirement counts, audio-role policy, split seed, and estimated storage/time. STRUM creates and returns the immutable task view plus safe exclusions.

**STRUM calls:** `catalog inspect`, `dataset prepare`.

**First implementation:** `guitar.onset-fret/v1`, Expert Guitar, prefer `audio.guitar`, fall back to `audio.mix`, then catalog-aware preprocessing. Prepare becomes a real job rather than a transition button.

### Train

OCTAVE renders only fields declared by a pipeline's `train_schema`: fresh/resume/fine-tune mode, compatible parent, epochs/steps, batch size, device/precision, seed, output location, and approved augmentation/evaluation choices. It supervises the worker state machine `queued → validating → provisioning → running → cancelling → terminal`, relays JSON progress, and stores a safe job summary.

**STRUM calls:** `train start --json-events`, `train cancel`.

The first templates are a clearly labelled non-deployable Guitar smoke run and a normal local run. STRUM must reject incompatible resume/fine-tune parents.

Cancellation must signal the worker, wait for exit, then terminate its process group/job object after a grace period so child Demucs/yt-dlp processes cannot survive. Request/staging cleanup must be idempotent and occur only after terminal exit.

### Deploy

OCTAVE discovers manifests through STRUM, groups required companions, displays pipeline/runtime/dataset/metric provenance, and asks for confirmation before changing a local default. It retains the shipped profile as fallback.

**STRUM calls:** `checkpoint inspect`, `inference profile validate`.

An auto-chart request resolves a profile ID to a compatible bundle in the main process, records profile/runtime IDs in the result manifest, and fails closed to the shipped profile if validation fails.

## Auto-chart readiness requirements

The existing integration already launches the packaged worker, resolves CUDA/MPS/CPU, provisions Demucs/Whisper helpers, reports progress, and supports cancellation. Training orchestration must retain these behaviors while replacing brittle source discovery.

Before deployment, STRUM must state for each checkpoint: the inference stage it serves; expected audio/stem/sample-rate/alignment requirements; companion model fingerprints; supported auto-chart instrument toggles; fallback behavior; and evaluation evidence. Until that capability manifest exists, a training checkpoint remains an experiment artifact and is not an OCTAVE auto-chart option.

## Delivery order

1. STRUM: versioned worker protocol, `probe`, pipeline descriptors, release manifest, and fixture worker; no model behavior change.
2. OCTAVE: runtime resolver with `bundled_inference` and `developer_override`, explicit probe validation, opaque settings, and legacy-wrapper compatibility flag.
3. OCTAVE: robust background job/process-group lifecycle and idempotent cleanup.
4. STRUM: model-bundle manifest, inference preflight, typed chart request/result, explicit difficulty policy, and no-silent-fallback reporting.
5. STRUM: Guitar `dataset prepare`, `train`, experiment/checkpoint manifests, and compatibility checks.
6. OCTAVE: real Guitar Prepare/Train/Deploy screens using the contract and bundle/profile validation.
7. STRUM/OCTAVE: opt-in managed pinned-release acquisition, verification, locking, update/rollback, and offline behavior.
8. STRUM: Drums, Bass, Keys, Vocals, Pro instruments, mapper/section data, and learned difficulty-transform descriptors on the unchanged catalog boundary.

Every delivery needs shared protocol fixtures and a real-catalog smoke test. Integration tests must prove that no original source path crosses into a task view, experiment/checkpoint manifest, renderer payload, progress event, log, or user-visible error.
