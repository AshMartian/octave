# Local STRUM training

OCTAVE curates approved local songs and supervises STRUM. STRUM owns task eligibility, labels, training, evaluation, model packaging, and chart execution. A completed training run produces a candidate; only a compatible profile that passes its STRUM quality policy can become an Auto-Chart default.

## Set up a developer runtime

Use a STRUM checkout containing the versioned worker and Python 3.11 or 3.12. Create an isolated environment in that checkout and install STRUM there:

```sh
python3.12 -m venv .venv
.venv/bin/python -m pip install '.[dev]'
.venv/bin/python -m src.worker probe --json
```

On Windows, use `.venv\Scripts\python.exe`. GPU support depends on the installed PyTorch build. The optional STRUM `pitch` extra is required for mapper preparation; ordinary chart-transform training does not need it.

Open OCTAVE's Training window and explicitly select the developer runtime. OCTAVE validates the worker protocol and advertised capabilities before allowing work. An installed `strum-worker` executable can also be selected. Runtime paths and catalog locations stay in the main process; the renderer receives opaque identities and display names.

The release installer does not yet ship a verified training runtime. Managed release acquisition requires an immutable STRUM release and published verification metadata. Selecting a developer checkout is not equivalent to installing an official release.

## Curate, prepare, and train

1. In **Curate**, select local library songs or inspect package sources. Review training inclusion and publish a catalog revision. Recognized STRUM-generated charts are excluded until OCTAVE can verify meaningful manual edits and approval against a preserved original revision; a consent checkbox or metadata change is insufficient. Package inventory is bounded and resumable; inspection alone does not approve a source.
2. In **Prepare**, choose a catalog and a STRUM pipeline. Eligibility and controls come from the worker descriptor. Prepare writes an immutable task view whose content identity is retained with the run.
3. In **Train**, select a prepared task and the declared training options. For a supported fine-tune mode, select a completed parent candidate. OCTAVE revalidates its artifact identity and resolves its private bundle location; STRUM checks model compatibility. Fine-tuning starts a new run and does not resume an interrupted optimizer session.
4. Wait for completion. OCTAVE accepts success only after a terminal worker event and a successful process exit, then re-inspects the resulting bundle. Cancellation terminates the worker process tree. Interrupted jobs remain visible after restart; retry from a prepared task when appropriate.
5. Select the candidate's advertised evaluation action. A failed quality gate is a valid evaluation outcome. Packaging requires the canonical policy, held-out evidence, matching task/checkpoint identities, and any pipeline-specific requirements.
6. In **Deploy**, discover and inspect the packaged profile, validate its difficulty policy, and explicitly select it as the default. Training never activates a candidate automatically. Existing profiles remain available for switching back. For a learned difficulty transform, use **Transform MIDI** in Deploy to select an Expert source chart and an output folder. Enable aligned audio when the profile is audio-conditioned. Audio-only Auto-Chart input cannot substitute for the source MIDI chart.

Catalog updates do not rewrite already prepared snapshots. Audio enrichment creates a reviewed revision. Harmony materialization requires explicit isolated assets and declared track bindings; shared vocals or a mix are not an isolated Harmony source.

## Capability limits

| Pipeline                                          | Training and promotion boundary                                                                                                                                                         |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Five-lane difficulty transforms                   | Train, fine-tune, evaluate, package and execute learned transforms for supported instruments; audio conditioning is optional and catalog-bound.                                         |
| Guitar, Bass, Keys onset/fret                     | Train distinct candidates; Expert profile promotion requires profile-grade source admission and complete Test evaluation.                                                               |
| Drums onset classifier                            | Train and evaluate candidates. Its prepared-window evaluator is not an audio-to-chart profile; the separate V14 runtime remains a distinct inference path.                              |
| Vocal components, mapper, section, Pro candidates | Only descriptor-advertised tasks execute. Component or experiment artifacts do not imply a composed deployable chart profile. Planned composition and quality gates remain unavailable. |

Five-lane policy V2 rejects historical validation-only promotion reports. Use a profile-grade task and newly bound Test evidence; do not lower policy thresholds or relabel smoke artifacts to migrate old candidates.

## Acceptance and review

The repository's `scripts/acceptance/strum_pipeline.py` runs actual worker processes and retains a path-free report. Its synthetic corpus tests software execution; even a passing synthetic profile is not evidence of useful musical output. Real approved-catalog runs must be reported separately, including failed quality gates.

Review the acceptance runbook beside that script, the catalog contract, and `plans/strum-orchestration-contract.md` for exact ownership and artifact requirements. A software acceptance pass does not establish production model quality or validate an untested operating system.
