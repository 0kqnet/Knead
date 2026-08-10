# Knead Declarative Extension Package SDK v1

Knead can install a local `.knead-extension.json` file without executing extension
code. A package describes commands and marker/track transform pipelines using a
small, versioned operation language. Knead validates the complete document, asks the
user to approve permissions, registers it disabled, and only runs it after the user
selects **Enable**.

## Minimal package

```json
{
  "format": "knead-extension-package",
  "schemaVersion": 1,
  "manifest": {
    "apiVersion": "1",
    "id": "example.octave-echo",
    "name": "Octave Echo",
    "version": "1.0.0",
    "description": "Duplicates selected notes one octave higher.",
    "author": "Example author",
    "homepage": "https://example.com/octave-echo",
    "permissions": {
      "required": [
        "timeline.read",
        "timeline.transform",
        "selection.read"
      ],
      "optional": []
    },
    "capabilities": ["markerTransforms"]
  },
  "contributes": {
    "markerTransforms": [
      {
        "kind": "markerTransform",
        "id": "octave-echo",
        "name": "Octave Echo",
        "description": "Keep the note and add a quieter octave after five ticks.",
        "requiredPermissions": [
          "timeline.read",
          "timeline.transform",
          "selection.read"
        ],
        "steps": [
          {
            "op": "duplicate",
            "copies": 1,
            "intervalTicks": 5,
            "semitoneStep": 12,
            "volumeDecay": 0.65
          }
        ]
      }
    ]
  }
}
```

Paste the JSON into **Studio Extensions → Declarative Extension Packages**, or use
**Import File**. Review every permission, install, then enable it. **Export** writes
the normalized package back to a local JSON file. A package ID may not collide with
a built-in or installed package. v1 intentionally rejects in-place upgrades: export
or retain the original, remove it, then install the replacement.

## Manifest

`format`, `schemaVersion`, and `manifest.apiVersion` are exact compatibility gates.
`manifest.id` is a lowercase namespaced ID such as `vendor.tool`; `version` is
semantic versioning. `capabilities` must exactly match the non-empty contribution
arrays. Unknown fields are errors, including fields named `script`, `entrypoint`, or
`code`.

Permissions:

| Permission | Data or action exposed |
| --- | --- |
| `timeline.read` | Frozen project snapshot supplied to the contribution |
| `timeline.transform` | Replace only the explicitly selected markers/tracks |
| `selection.read` | Marker and track IDs in the current selection |
| `notifications` | Display a local, length-limited notification |

Every transform contribution must require the first three permissions. A command
must require the permission needed by each action it contains. Required and optional
grants are stored per package. Changing a grant disables the package before applying
the new grant set. Revoking a required grant is allowed, but the package cannot be
enabled until it is granted again.

## Command actions

A `command` has a non-empty `actions` array (maximum 64):

- `{ "op": "projectSummary" }` produces track, marker, and length counts and
  requires `timeline.read`.
- `{ "op": "selectionSummary" }` produces selected marker/track counts and
  requires `selection.read`.
- `{ "op": "notify", "level": "success", "message": "Done" }` emits a local
  `info`, `success`, `warning`, or `error` notice and requires `notifications`.

Actions run in order and return their messages to the Manager. They cannot start a
process, fetch a URL, open a file, or mutate a project.

## Marker transform operations

A `markerTransform` has a non-empty `steps` array. Steps run left-to-right on the
current result:

| Operation | Fields and limits | Effect |
| --- | --- | --- |
| `shiftTicks` | `ticks`: integer −1,000,000…1,000,000 | Move and clamp at tick 0 |
| `quantizeTicks` | `step`: 1…100,000; `strength`: 0…1 | Blend toward the nearest grid tick |
| `transpose` | `semitones`: −48…48 | Multiply pitch, clamped to Knead's 0.5…2 range |
| `scaleVolume` | `factor`: 0…4 | Scale and clamp volume to 0…1 |
| `setPan` | `pan`: −1…1 | Set per-marker stereo position |
| `setLane` | `lane`: 0…1 | Set normalized lane position |
| `setSound` | `soundId`; optional `variantIndex`: −1…10,000 | Select a dotted or namespaced sound ID |
| `duplicate` | `copies`: 1…16; `intervalTicks`: 0…1,000,000; `semitoneStep`: −48…48; `volumeDecay`: 0…1 | Keep each input and create deterministic collision-free copies |

Provenance metadata is removed from changed results so an NBS/MIDI exporter never
mistakes transformed values for untouched source data. One invocation may produce at
most 25,000 markers even when multiple duplicate steps are composed.

## Track transform operations

| Operation | Fields and limits | Effect |
| --- | --- | --- |
| `adjustGainDb` | `decibels`: −72…72 | Add and clamp gain to −60…12 dB |
| `setPan` | `pan`: −1…1 | Set track pan |
| `prefixName` | `prefix`: 1…80 characters | Prefix the track name |
| `setMuted` | `value`: boolean | Set mute |
| `setSolo` | `value`: boolean | Set solo |
| `setLocked` | `value`: boolean | Set edit lock |

## Budgets and persistence

- One imported package: at most 256 KiB UTF-8.
- Installed packages: at most 32; the persisted envelope has a corresponding 8 MiB
  upper bound.
- Contributions per package: at most 64 total.
- Actions or steps per contribution: at most 64.
- Registry project limits, structured-clone checks, current `.kp` parser validation,
  selected-ID replacement rules, and execution timeout reporting still apply.

Installed normalized packages, grants, and enabled flags are persisted in the local
Knead setting `studioDeclarativeExtensionPackages`. Loading is per-record: one bad,
duplicate, over-budget, or incompatible record is ignored/disabled while valid
records continue loading. Contribution failures are reported on that package card
and do not run another package.

## Security boundary (important)

Declarative packages are safe by construction because package-owned executable code
does not exist. The interpreter recognizes only the operations above. JSON cannot
access the DOM, WebAudio, network, filesystem, clipboard, processes, Tauri commands,
workers, or JavaScript globals.

This is not a general-purpose JavaScript sandbox:

- Statically bundled TypeScript built-ins are trusted application code running in
  the renderer realm. Registry permissions constrain host data, but are not an OS
  sandbox for a malicious bundled module.
- Promise timeouts report/contain asynchronous failures; JavaScript cannot preempt a
  malicious infinite synchronous loop. Third-party JSON avoids that class entirely,
  while operation and output budgets bound the host interpreter's own work.
- v1 packages are local and unsigned. The author/homepage strings are metadata, not
  proof of identity. There is no remote marketplace, automatic update, signature
  verification, custom DSP, custom UI, or arbitrary audio/file/network capability.

Those omissions are intentional. Future capabilities require new schema/API
versions and an explicit review of their real isolation boundary.
