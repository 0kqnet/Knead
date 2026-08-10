# Knead Ultimate checkpoint

Checkpoint: 2026-08-10 13:28 JST

This file is a restart handoff for the ongoing “Note Block Studio superset +
DAW-grade playsound authoring” goal. It is not a release-completion claim.

## Repository state

- Branch: `feat/ultimate`
- Base commit: `9ce4ad3a26e3`
- Worktree: intentionally dirty; 165 tracked/untracked entries after writing
  this checkpoint
- No checkpoint commit or staging was created.
- Active goal usage at checkpoint: 4,433,550 tokens / 29,209 seconds
- Do not reset, checkout, clean, or overwrite the worktree. The accumulated
  changes are the implementation.

## What is implemented

### Core DAW workflow

- Multi-track timeline with mute, solo, lock, gain, pan, marker velocity,
  per-marker pan, pitch, duration, retriggering, gate length, variants, curves,
  loop, finite-loop metadata, metronome, mixer, limiter, and meters.
- Multi-resolution cached waveforms for timeline clips, pitch-aware duration,
  selection/mute/retrigger visualization, navigator, arrangement overview,
  piano roll, tempo/time-signature map, and player mode.
- Reference WAV/OGG audio lanes with waveform, offset drag, mute/solo,
  playback, mix/stem export, persistence, privacy-safe paths, and bounded asset
  storage.
- Audio export to WAV, OGG, MP3, AIFF, and FLAC, including stems and offline
  Sound Stopper/gate handling. Lossless formats support 8 kHz–384 kHz within
  codec and memory limits.
- Multiple song tabs with document-scoped native paths, revision-safe save
  points, recent files, recovery snapshots, clipboard isolation, close prompts,
  native open queues, and dirty-document handling.

### Note Block Studio compatibility

- NBS v0–v6 parsing and version-aware writing/down-saving, official v6
  instrument boundary, metadata/provenance, custom instruments, raw-note reuse,
  loop fields, panning law, Sound Stopper semantics, and strict parser budgets.
- Official NBS fixture interoperability tests using OpenNBS `Nyan Cat.nbs` and
  pinned `@nbsjs/core`, plus generated round trips and mutation/truncation fuzz.
- Correct NBS meter semantics: the header byte is the `N/4` numerator while a
  quarter note is always four NBS ticks. Tempo and meter are no longer mixed.
- Exact-name `Tempo Changer` functional instrument support. Import performs
  piecewise source-time integration; export encodes later tempo events for v4+
  and emits explicit downgrade/loss diagnostics.
- NBP v1/v2 import/export, including Sound Stopper and Tempo Changer behavior.
- All 15 OpenNBS-style macros with bounded preview. Fade uses the official
  relative velocity behavior and keeps non-zero endpoints.
- Direct `.nbs` document tabs, target-version-preserving save, atomic native
  writes, snapshot-safe loss confirmation, recent files, and `.nbs` file
  association.
- Deterministic NBS custom-audio bundle ZIP support and portable embedded custom
  audio in `.kp`.

### Minecraft outputs

- Data-pack exporter with start, pause, resume, stop, uninstall, loop controls,
  runtime scheduling, nearby/out-of-range handling, Sound Stopper conversion,
  diagnostics, and reports.
- Separate companion Java resource-pack ZIP for embedded Ogg/Vorbis custom
  sounds. It uses an isolated generated namespace, preserves variant metadata,
  rewrites commands to generated aliases, validates codecs natively, and writes
  a deterministic report.
- Structure Block NBT, OpenNBS exact-size NBT, and two legacy schematic
  containers. Static placement and a modern playable-redstone phase are
  implemented with explicit quantization/compatibility warnings and strict NBT
  validation.
- Seven visualization modes and a controlled full-screen player presentation.

### MIDI and extensibility

- Bounded SMF 0/1 parser with tempo/meter maps, running status, program/channel,
  drums, pitch bend, note pairing, provenance, deterministic IDs, and 20 TPS
  integration.
- Bounded pre-import preview with quantization, channel mappings, note-off gate
  choice, warnings, and a single explicit Apply operation.
- Live Web MIDI recording with overlapping-note FIFO ownership, pitch bend,
  sustain-pedal state, real-time timestamp-derived gates, locking checks, and
  transaction-safe undo behavior.
- Versioned declarative extension package schema, permission grants, persistent
  installed records, no-eval host DSL, lifecycle registry, failure isolation,
  package import/export, manager UI, SDK documentation, Humanize, and Note Block
  Composer built-ins.
- Command palette, shortcuts view, recent commands, generation-safe async runs,
  modal focus management, and scroll-following keyboard selection.

## Work completed immediately before this checkpoint

The following three branches of work stopped after a bounded green QA pass and
did not start new scope:

1. Plain `.nbs` sibling custom sounds
   - Document-ID-bound native resolution only; the renderer cannot supply an
     arbitrary filesystem path.
   - Resolves portable names only under sibling `Sounds/` or `sounds/`.
   - Canonical containment, symlink/reparse/TOCTOU checks, OGG/WAV signatures,
     32 MiB per asset, 96 MiB total, and warning-only missing assets.
   - Frontend 54/54, Rust 59/59, TypeScript, scoped ESLint, rustfmt, and
     diff-check passed.

2. Extended pitch
   - Proposed persisted range: `1/512..256` (-108..+96 semitones), with old
     `.kp` versions still validated against their historical `0.5..2` range.
   - Exact Web Audio/Rust playback, waveform/UI support, checked offline
     allocation, Minecraft command clamping diagnostics, and a 250,000-marker
     bound are implemented.

3. MIDI tail fade
   - OpenNBS beta-3 behavior is represented by deterministic alternating stereo
     tail markers while keeping the gated head note unchanged.
   - Start/end velocity controls, melodic-only behavior, marker budget, and
     approximation diagnostics are implemented.

The final section below records the exact worker QA and deliberate limitations.

## Verification already obtained during this milestone

These are focused results reported before the final checkpoint run:

- NBS codec/interop/bundle/dialog/direct-file groups: 87 passing tests.
- NBP groups: 16 passing tests.
- NBS macro groups: 17 passing tests.
- MIDI preview/import groups: 34 passing tests before tail-fade follow-up.
- Companion resource-pack/direct-NBS groups: 62 passing tests.
- Rust library: 55 passing tests before plain-NBS resolver additions; the
  resolver later reported 59/59.
- Multiple intermediate `npm run typecheck`, scoped ESLint, `cargo fmt --check`,
  production build, and `git diff --check` runs passed.

These focused results do not replace a clean final full-suite run after all
three finishing changes stop mutating the shared worktree.

## Known remaining work

Highest-value remaining items, in suggested order:

1. Run a large-project browser stress row that keeps Worker generation alive
   long enough to click Cancel/Retry; the automated cancellation tests and
   ordinary browser generation smoke are green.
2. Give the shared desktop sample picker an instrument-specific title. The
   `.kp` v10 authoring UI and cross-tab definition/audio transfer are complete.
3. Extend the cancellable worker path beyond Command Data Pack and Note Block
   Build to NBS/NBP, NBS bundles, and resource-pack ZIP work. Also move the
   post-worker Note Block Build Base64 conversion off the main thread and add
   cancellation around native ZIP saving.
4. Complete the manual half of external-consumer acceptance: automated
   consumer-side validation now covers representative 1.13.2-1.21.11 data-pack
   eras and all four build containers, but actual Structure/Litematica import,
   `/reload` load, and redstone playback rows in `docs/minecraft-acceptance.md`
   are still explicitly not run.
5. Complete physical-build gaps: native `.litematic`, legacy playable circuits,
   physical loop/Sound Stopper limitations, and documented redstone timing
   quantization.
6. Hardware MIDI latency/calibration acceptance. Unit tests use mocked Web MIDI.
7. Do a final copy/claim audit so README and parity tables never imply
   losslessness where 20 TPS quantization or a target format cannot represent a
   feature.

## Safe resume procedure

1. Read this file, `docs/note-block-studio-parity.md`, and
   `docs/export-report.md`.
2. Run `git status --short`; preserve all existing changes.
3. Confirm there are no still-running workers or dev servers.
4. Run the gates sequentially to avoid the known parallel UI-test timeouts:

   ```powershell
   npm run typecheck
   npm test -- --maxWorkers=1
   npm run selfcheck
   npm run build
   Push-Location src-tauri
   cargo test --lib
   cargo fmt --check
   Pop-Location
   git diff --check
   ```

5. Run ESLint without `--fix` during audit so it cannot mechanically rewrite
   the shared checkpoint.
6. If the full suite is green, perform a browser smoke test of direct `.kp` and
   `.nbs` open/save, waveform playback, MIDI preview, resource/data-pack export,
   extension transforms, tab close/recovery, and loss-confirmation flows.
7. Only after that decide whether to commit, split commits, or continue the
   remaining roadmap. Nothing has been staged for the user.

## Final worker handoff

### Plain `.nbs` sibling sounds: complete

- Document-bound native resolver, secure sibling lookup, content-addressed
  hydration, warning-only failure, stale-operation cleanup, and clean save-point
  behavior are implemented.
- Focused frontend 54/54, Rust 59/59, TypeScript, scoped ESLint, rustfmt, and
  diff-check passed.
- Deliberate limit: only sibling `Sounds/` or `sounds/` is searched. Save As
  does not copy those files, so the plain-NBS portability warning remains.

### MIDI tail fade: complete

- OpenNBS beta-3-style 50%/50% defaults, unchanged gated head, melodic-only
  alternating-pan tails, linear editable curves, preview controls, marker
  budget, and explicit approximation/omission warnings are implemented.
- Focused Vitest 41/41, TypeScript, scoped ESLint, and diff-check passed.
- Deliberate difference: OpenNBS floors every intermediate velocity to an
  integer; Knead keeps editable curve precision. The sub-1% difference is
  reported in the preview.

### Extended pitch

- Persisted/editor/playback range is now `1/512..256`; `.kp` v1–v8 keep the
  historical `0.5..2` validator while v9 accepts the expanded range.
- Web Audio, waveform rendering, curves, NBS/NBP/MIDI import, and Rust offline
  mix/stems preserve the expanded value. Minecraft commands clamp each firing
  to `0.5..2` with a dedicated diagnostic, and physical builds warn about the
  target limitation.
- Rust validates checked frame/sample allocations and caps interleaved f32 PCM
  at 256 MiB per mix/stem. `.kp` and MIDI share a 250,000-marker limit.
- Focused frontend 11 files / 192 tests, MIDI 2 files / 21 tests, Rust audio
  export 27 tests, TypeScript, scoped ESLint, rustfmt, and scoped diff-check
  passed.

All three workers stopped after these bounded QA passes. No worker started a
new feature, staged files, or created a commit. A repository-wide test/build run
was initially deferred to honor the requested pause. A subsequent read-only
gate continuation produced the results below.

## Read-only repository gate results

- `git diff --check`: passed; only expected LF-to-CRLF notices were printed.
- `cargo test --lib`: 61 passed / 0 failed.
- `cargo fmt --check`: passed.
- `cargo clippy --lib -- -D warnings`: the initial run found five mechanical
  style lints. They were corrected, and the follow-up strict Clippy run passed.
- `npm run typecheck`: passed.
- `npm run selfcheck`: passed (all six checks).
- `npm run build`: passed. Webpack reported three size warnings: the 1.44 MiB
  `app.js` and entrypoint exceed its 244 KiB recommendation, and code splitting
  is recommended.
- No-fix ESLint initially reported 0 errors / 12 unused-variable warnings plus
  a missing React-version setting. Those source warnings and the setting were
  corrected. The newest bounded changes passed scoped no-fix ESLint; a final
  repository-wide lint remains part of the resume gate.
- `npm test -- --maxWorkers=1`: 63 files / 514 tests passed in 145.73 seconds.

The functional TypeScript, frontend build, Vitest, Rust, formatting, strict
Clippy, and diff-check gates reached green before the final bounded feature
batch. The Studio route was subsequently split into a lazy chunk, reducing the
initial app bundle from roughly 1.44 MiB to 943 KiB; webpack still reports size
guidance. A complete post-batch gate remains intentionally deferred.

## Browser smoke test

A local production-shaped development session was exercised in the in-app
browser after the repository gates:

- Studio route loaded with no Studio runtime exception.
- Reference preview WAV was added; its waveform was visibly rendered in both
  the reference lane and navigator.
- Transport advanced from `0t` to `7t / 0.38s`, then Stop returned it to
  `0t / 0.00s`.
- Mixer exposed independent timeline, reference, and master channels.
- Player mode exposed transport, seek, tempo/meter position, and all meters.
- Tempo Map, Song Metadata/finite loop, MIDI preview/tail-fade, NBS, audio
  export, data-pack/resource-pack, static/playable build, extension manager,
  and command-palette dialogs all opened with their expected controls.
- A second song tab was created and closed without altering the first tab.
- Undo removed the reference track and restored the initial clean document.
- The only pre-existing console error came from the main-window
  `CommitNumberInput`/`Tooltip` ref warning, before entering Studio. The input
  now forwards its ref and has a focused regression test; a browser re-smoke of
  that particular fix remains deferred. Locale HMR requested a full reload as
  expected; the post-reload Studio view had no new Studio runtime error.

The smoke test found one stale claim: the NBS dialog still said import supported
only one tempo. English and Japanese copy now describe N/4 meter, header tempo,
Tempo Changer events, extended/fine pitch, looping, and resolvable samples.
Both locale JSON files parse, the focused NBS dialog suite passes 3/3, and the
updated copy was verified after a full browser reload.

## Pause handoff: 2026-08-10 13:22 JST

The user requested a usage-conscious pause. No new scope was started after the
request. The three in-flight tasks were brought to testable boundaries, all
workers stopped editing, and nothing was staged or committed.

### First-class custom-instrument studio

- `.kp` is now v10 and migrates v1-v9 projects to bounded first-class custom
  instrument definitions.
- The editor supports display name, stable sound ID, NBS filename/source key,
  press-key, default pitch, and verified WAV/Ogg attachment or replacement.
- Renaming updates markers and embedded assets atomically in one undoable edit;
  referenced deletion is blocked. Exact functional names `Sound Stopper` and
  `Tempo Changer` are protected.
- Unsafe absolute/UNC/traversal/reserved paths are rejected, and asynchronous
  picker results are generation/project guarded against tab switches and
  unmounts.
- NBS bundle export prefers authored sound IDs. NBP v2 imports/exports authored
  definitions, bakes default pitch, and diagnoses collisions and its 255-entry
  bound.
- Focused QA: 7 files / 107 tests passed; TypeScript and diff-check passed. The
  last scoped ESLint indentation finding was fixed; the pause-boundary scoped
  lint rerun below passed.

Known follow-ups: plain NBS/NBP cannot preserve Knead's stable sound ID and
derives it from the filename on reopen; the shared desktop picker title still
says reference audio.

### Cancellable generation worker

- A typed one-job-per-Worker protocol now owns Command Data Pack preview/export
  and Note Block Build generation.
- Abort terminates the Worker; monotonic bounded progress, generation ownership,
  stale/foreign result rejection, crash/clone cleanup, cancel/retry UI, and
  current-generation-only saving are implemented.
- Note Block Build uses the shared modal focus/Escape contract. Instrumented and
  direct generators are asserted to produce identical output.
- Focused QA: 6 files / 82 tests, plus the post-modal 4 files / 19 tests passed;
  scoped ESLint and production build passed. Webpack emitted the dedicated
  `knead-studio-export.js` worker at 60.4 KiB.

Known follow-ups: Base64 conversion and native ZIP save are not cancellable;
the no-Worker fallback cannot interrupt after synchronous computation starts;
NBS/NBP and large bundle/resource-pack jobs remain on the main thread.

### Independent Minecraft acceptance and command-era fixes

- Java 1.13 uses a tick-tag clock, 1.14 uses bare `schedule`, and 1.15+ uses
  `schedule clear` plus replace semantics. Cleanup and duplicate-chain behavior
  are version-specific.
- Java 1.19 and 26.x data/resource pack-format inference was corrected through
  the documented 26.3 Snapshot 6 boundary.
- An independent bounded consumer harness validates function graphs, directory
  layouts, command eras, exact representative pack metadata, GZIP, and modern
  plus legacy NBT containers without importing the writers under test.
- Focused QA: 3 files / 90 tests passed; TypeScript, scoped ESLint, and scoped
  diff-check passed. Primary sources, verified CI scope, and manual matrix are
  recorded in `docs/minecraft-acceptance.md`.

Known follow-ups: no real Minecraft, Structure Block, Litematica, or WorldEdit
consumer run has been performed. Exact-size `.nbt` is not native `.litematic`;
1.14 cleanup needs one tick before pack removal; compatibility beyond the
documented future snapshot boundary is not claimed.

### Pause-boundary integration and release gate

- `npm run typecheck`: passed.
- `npm test -- --maxWorkers=1`: 68 files / 577 tests passed.
- `npm run selfcheck`: all six self-checks passed.
- `npm run build`: passed; the dedicated Worker is 60.6 KiB. Webpack retains
  two non-fatal size recommendations for the 956 KiB entry and 556 KiB Studio
  chunk.
- Repository-wide no-fix ESLint: passed with no findings.
- `cargo test --lib`: 61 tests passed.
- `cargo fmt --check`: passed.
- `cargo clippy --lib -- -D warnings`: passed.
- English and Japanese locale JSON: parsed successfully.
- `git diff --check`: passed; only the repository's expected LF/CRLF notices
  were printed.

The complete automated matrix was repeated after the final batch and is green.

### Final browser smoke after the v10/Worker batch

- Studio loaded after the lazy-route split with no runtime exception.
- Custom Instrument Studio created a definition and exposed name, stable sound
  ID, NBS file, source key, default pitch, press-key, attachment, ordering, and
  delete controls.
- The exact reserved name `Sound Stopper` produced an accessible validation
  alert and disabled Apply. `../escape.ogg` likewise produced the portable-path
  error and disabled Apply; a safe nested relative Ogg path restored validity.
- The Build dialog exposed static/playable mode and the explicit exact-size
  `.nbt` versus native `.litematic` limitation.
- Data Pack preview regenerated through the Worker after an editor change. Its
  previous result was cleared, then replaced with the expected one-event
  function/diagnostics, demonstrating generation ownership rather than stale
  reuse.
- The tested tab reported no console warning or error. Browser tabs and the
  local development server were cleaned up afterward.

The one-event smoke project completed generation in under the observation
window, so an actual browser click on Cancel/Retry was not possible. Their hard
cancel, stale-generation, and retry behavior remains covered by the dedicated
task/dialog tests; retain a large-project interactive cancellation row for a
future stress/acceptance matrix.

### Cross-tab custom-instrument dependencies

- Clipboard v1 remains backward-compatible and now optionally carries only the
  authored audio definitions and embedded variants referenced by the selected
  markers. Source provenance and protected functional definitions are excluded.
- Paste resolves sound ID, definition, definition ID, asset and NFKC/case-folded
  NBS file collisions as one deterministic bundle. Repeating the same paste
  reuses the first remap instead of producing rename chains.
- Definitions, assets and markers are applied in one history action and undo
  together. Legacy derived definitions are materialized rather than discarded.
- Preflight rejects combined projects above 255 definitions, 256 assets, the
  shared 96 MiB reference/custom-audio budget, or 250,000 markers before any
  destination mutation.
- Independent pause-boundary QA: Clipboard/Timeline/Workspace 3 files / 56
  tests, TypeScript and scoped ESLint passed.
