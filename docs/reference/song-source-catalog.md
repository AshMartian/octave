# Song Source Catalog

`octave-song-source-catalog/v1` is OCTAVE's canonical, local-first intake
format for chart sources. It is the boundary between package import and model
training: import adapters understand `.sng`, `.con`/`.rb3con`, ZIP archives,
and song folders; STRUM consumes normalized catalog records and never parses
those containers directly.

The normative schema is [song-source-catalog.schema.json](./song-source-catalog.schema.json).

## Layout

```text
my-catalog/
├── catalog.json             # `octave-song-source-catalog/v1` manifest
├── records.jsonl            # one validated source record per song
└── assets/
    └── sha256/<hash>/...    # OCTAVE-managed materialized MIDI/audio assets
```

`catalog.json.records` is a relative JSONL path. A catalog record contains a
stable `source_id`, content hashes, normalized metadata, chart coverage, a
rights decision, and references only to materialized assets under `assets/`.
It never contains the original package path, SMB path, URL, user home path, or
raw parser error.

```json
{
  "source_id": "octave-src-4fa0a8d2",
  "import": {
    "kind": "sng",
    "adapter_version": "octave-sng/1",
    "container_sha256": "…",
    "warnings": [{ "code": "missing_optional_artwork" }]
  },
  "rights": {
    "training_use": "allowed",
    "provenance": "Reviewed local collection",
    "license": "Permission recorded by catalog owner"
  },
  "chart": {
    "notes_midi": {
      "asset_id": "sha256:…",
      "sha256": "…",
      "relative_path": "assets/sha256/…/notes.mid",
      "byte_length": 12345,
      "media_type": "audio/midi"
    },
    "instruments": {
      "guitar": {
        "status": "present",
        "difficulties": ["easy", "medium", "hard", "expert"],
        "track_names": ["PART GUITAR"]
      }
    }
  }
}
```

## Ownership boundary

### OCTAVE owns

- Adapter selection, archive parsing, safe extraction, and import warnings.
- Metadata normalization, MIDI validation, instrument/difficulty discovery,
  hashing, duplicate handling, and catalog materialization.
- The user-facing curation gate. A source may be unselected or need explicit
  consent in the UI, but every record that reaches a catalog has already been
  approved and is written as `training_use: allowed`.
- Private original-location bookkeeping, if needed for refresh or reveal in
  the file browser. That resolver is a local OCTAVE sidecar and is neither a
  catalog asset nor a training artifact.

### STRUM owns

- Reading allowed catalog records and creating task-specific views.
- Converting catalog chart/audio assets into model examples, windows, tokens,
  targets, splits, and evaluation manifests.
- Recording catalog `source_id`s and input hashes in experiment metadata.
- Rejecting records with missing assets, hash mismatches, or a training right
  other than `allowed`.

STRUM must not infer rights, persist source locations, or add SNG/RB3CON/ZIP
parsers. OCTAVE must not encode STRUM model tokens or prescribe a model
architecture.

## Task views, not new source formats

One catalog can produce many STRUM datasets without duplicating source
metadata:

| STRUM task           | Catalog inputs                      | Derived view                           |
| -------------------- | ----------------------------------- | -------------------------------------- |
| Audio to chart       | `audio` + `chart.notes_midi`        | instrument-specific onset/lane targets |
| Difficulty transform | `chart.notes_midi`                  | source/target difficulty event pairs   |
| Vocal model          | `chart.notes_midi` + `audio.vocals` | phrase, lyric, and pitch targets       |
| Pro instrument model | `chart.notes_midi` + stem/mix       | string/fret or chromatic-key targets   |

Views contain `source_id`, selected asset hashes, view-builder version, and
their own split assignment. They do not copy rights text or absolute paths.

## Mandatory safety validation

Schema validation is necessary but not sufficient. The catalog service must
perform these semantic checks before writing a record or returning a UI result:

- Run `redactLocationText` on every metadata, provenance, license, warning,
  log, and error value that crosses an import boundary. It replaces filesystem
  locations and URLs with `[redacted]`, removes control characters, normalizes
  Unicode, and applies the schema's safe-text limits. Never persist raw parser
  exceptions; `import.warnings` contains stable safe codes only.
- Require `asset_id` to equal `sha256:` plus the asset's declared SHA-256, then
  hash the materialized file and compare it to both values. Require the
  `assets/sha256/<hash>/` directory component to equal that same declared
  SHA-256; a correct file under a different hash directory is invalid.
- Accept only `assets/sha256/<64-lowercase-hex>/<safe-filename>` paths. Before
  every write or read, resolve/realpath the asset and prove it remains under
  the real catalog root. Reject absolute paths, drive-qualified paths,
  backslashes, symlinks escaping the root, and every traversal attempt.
- Treat `audio` as a keyed role map. A record has at most one asset for each
  role, so STRUM can deterministically choose `audio.guitar`, `audio.vocals`,
  or `audio.mix`.
- Require coverage consistency: `present` has non-empty difficulties and track
  names; `absent` and `unsupported` have neither. Display violations to the
  curator as a safe validation code, never as a raw source path.

These checks must have fixture tests for POSIX paths, Windows drive/UNC paths,
URLs, path-bearing parser exceptions, mismatched asset IDs/hashes, duplicate
audio roles, and partial catalog directories.

## UI handoff: Dataset Curation

The Dataset Curation UI is a review and selection surface, not a second
importer or tokenization layer.

1. Let the user select packages/folders through the existing trusted file
   dialogs, or select songs from the open OCTAVE library.
2. Show the normalized candidate summary supplied by the catalog service:
   source kind, sanitized metadata, MIDI validity, instrument coverage,
   duplicate status, import warnings, and rights status.
3. Require an explicit provenance and license/permission basis before a source
   can be included. STRUM-charted library songs require saved explicit consent;
   STRUM-charted external packages are shown per contained song and require an
   explicit selection. OCTAVE then materializes only those approved sources,
   with `training_use: allowed`; unresolved review states are never exported.
4. Ask the user for a parent directory and a new catalog name. The final
   `<parent>/<name>` destination must not already exist; an existing empty
   directory is not an atomic destination. Materialize approved assets through
   a sibling `<parent>/.<name>.staging-<random>` directory on the same volume.
   Hash and validate every staged asset, write and validate `records.jsonl` and
   `catalog.json`, then atomically rename the staging directory to the new
   destination. On failure, remove the staging directory and leave no catalog
   marker at the destination.
5. Hand STRUM the catalog directory. Do not hand it the original package paths
   or put those paths in renderer state, exported manifests, logs, or errors.

STRUM rejects a catalog without both root files, with a staging marker, or with
any asset/hash validation failure. It never tries to repair an incomplete
catalog.

The current MIDI-only export is a transitional projection. It should become a
catalog projection: the UI calls one catalog build operation, and the existing
MIDI exporter reads allowed catalog records rather than re-parsing source
packages.

## Validation and evolution

- Validate `catalog.json` against the schema and each JSONL record against
  `#/$defs/record` before STRUM sees the catalog.
- Resolve every asset path relative to the catalog root, reject traversal, and
  verify the declared SHA-256 before use.
- Deduplicate by canonical materialized asset hashes, not display metadata.
- Add fields only in a backward-compatible minor revision; publish a new
  `.../v2` format for breaking changes. Consumers reject unknown major formats.
