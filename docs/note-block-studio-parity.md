# Note Block Studio parity audit

Audit date: 2026-08-10 (Asia/Tokyo)

This is a source audit and implementation checklist, not a claim about a
released Knead build. The Knead snapshot is commit
`9ce4ad3a26e3a2cd334ea6a7f44c64a5a3665f99` plus the uncommitted worktree that
was present during the audit. Items marked **in flight** therefore need normal
integration and release verification.

## Official baseline

The production repository describes the stable program as feature-complete and
points to a separate Qt rewrite for future development. Stable 3.11.0 was
released on 2024-12-15. The newest official build at audit time is the
3.12.0-beta.5 prerelease from 2026-08-05.

- [Production repository and status](https://github.com/OpenNBS/NoteBlockStudio)
- [Stable 3.11.0 release](https://github.com/OpenNBS/NoteBlockStudio/releases/tag/v3.11.0)
- [3.12.0 beta 1](https://github.com/OpenNBS/NoteBlockStudio/releases/tag/v3.12.0-beta.1)
- [3.12.0 beta 2](https://github.com/OpenNBS/NoteBlockStudio/releases/tag/v3.12.0-beta.2)
- [3.12.0 beta 3](https://github.com/OpenNBS/NoteBlockStudio/releases/tag/v3.12.0-beta.3)
- [3.12.0 beta 4](https://github.com/OpenNBS/NoteBlockStudio/releases/tag/v3.12.0-beta.4)
- [3.12.0 beta 5](https://github.com/OpenNBS/NoteBlockStudio/releases/tag/v3.12.0-beta.5)

The latest beta is used for parity unless noted. Two stable-only features were
explicitly removed in beta 1: `.schematic` import and branch export. Supporting
them remains useful for a superset of both current stable and current beta, but
they are not requirements for beta-5 parity.

## Authoritative NBS format

The published specification currently documents NBS v0 through v5:
[The NBS format](https://noteblock.studio/nbs). Official reference
implementations include [pynbs](https://github.com/OpenNBS/pynbs) and
[nbs.js](https://github.com/OpenNBS/nbs.js).

The file is little-endian and has four ordered parts:

1. Header (required)
2. Delta-encoded notes (required)
3. Layers (optional)
4. Custom instruments (optional)

Important compatibility details:

- A zero first short identifies the modern format; it is followed by the NBS
  version and the vanilla-instrument count. Classic v0 instead starts with song
  length and assumes 10 vanilla instruments.
- Strings are an `int32` byte length followed by that many encoded bytes.
- Notes use jumps from tick `-1` and layer `-1`, terminated by zero jumps.
- v1 added the format version and vanilla-instrument count.
- v2 added layer panning.
- v3 restored song length in the header.
- v4 added loop settings, layer lock, and note velocity/panning/fine pitch.
- v5 did not change the binary layout; it raised the custom-instrument limit to
  240 and allowed slash characters in custom-sound paths.
- Header tempo is song ticks per second multiplied by 100. The time-signature
  byte is independently the numerator of N/4 (2 through 8); OpenNBS always
  draws a quarter-note beat every four song ticks. Treating this byte as a
  ticks-per-beat value corrupts both meter and BPM.
- The latest development code writes v6. Its binary layout is otherwise the
  v5 layout, but its vanilla-instrument count is 20. IDs 16-19 are Trumpet,
  Exposed Trumpet, Weathered Trumpet, and Oxidized Trumpet.
- Note instrument IDs remain one byte. Consequently v5 can address 240 custom
  IDs (16-255), while an unchanged v6 layout can address only 236 (20-255).
  The beta UI still appears to use the old 240 limit, so a robust writer should
  reject or remap the four unaddressable v6 entries rather than wrap their IDs.
  This is a constraint inferred from the official layout and development code;
  v6 is not yet covered by the published specification.
- When saving v0-v5, the official writer declares 16 vanilla instruments. If a
  song uses the v6 trumpets, it serializes those four instruments as custom
  instruments before user instruments; otherwise it shifts user custom IDs
  down by four. See the official
  [v6/down-save implementation](https://github.com/OpenNBS/NoteBlockStudio/blob/abbf7d52c279e08ce8f12799495bfbfb882280c2/scripts/save_song/save_song.gml).
- Effective note volume is `(layer volume * note velocity) / 100`.
- Centered layer panning leaves note panning unchanged; otherwise NBS averages
  the layer and note panning values.
- Key, fine pitch, and a custom instrument's source key all affect effective
  playback pitch.
- A custom instrument named exactly `Tempo Changer` is functional rather than
  audible. The current beta
  [applies `max(0.25, floor(abs(finePitch)) / 15)` song ticks per second](https://github.com/OpenNBS/NoteBlockStudio/blob/abbf7d52c279e08ce8f12799495bfbfb882280c2/scripts/control_step/control_step.gml#L231-L263)
  beginning with that source column's following interval. Changers in one
  column are processed by ascending layer, so the highest unlocked layer wins.
  Knead maps this piecewise clock onto its fixed 20 TPS wall-time axis and
  re-encodes later tempo events as v4+ Tempo Changer notes.

A complete codec should parse v0-v6, preserve all header/note/layer/instrument
fields, tolerate the two optional trailing sections, reject truncation and
unsupported future versions clearly, and write every advertised target version
with target-correct instrument IDs. Tests should include official v6 demo songs
from the [development song fixtures](https://github.com/OpenNBS/NoteBlockStudio/tree/abbf7d52c279e08ce8f12799495bfbfb882280c2/datafiles/Songs)
and cross-read Knead output with an official library.

Interop audit completed 2026-08-10: Knead matched all 1,022 notes, 36 layers,
three custom instruments and header fields in OpenNBS's development
`Nyan Cat.nbs` v6 fixture when compared with `@nbsjs/core` 7 alpha. A Knead v5
down-save and a synthetic v5 edge-case file were also read back field-for-field
by `@nbsjs/core` 6. The audit exposed and corrected the inclusive-last-tick song
length boundary. Committed licensed fixtures and per-version goldens still remain.

The official zipped-song implementation establishes a separate container
contract: [`song.nbs` is read from the ZIP root and custom sounds from
`sounds/`](https://github.com/OpenNBS/NoteBlockStudio/blob/79b22ad890631a39196d45b9c27881599f9b04ab/scripts/open_song_zip/open_song_zip.gml),
while the saver copies every custom instrument's NBS-relative filename beneath
[`sounds/` before archiving](https://github.com/OpenNBS/NoteBlockStudio/blob/79b22ad890631a39196d45b9c27881599f9b04ab/scripts/save_song_zip/save_song_zip.gml).
OpenNBS first resolves that bundle-specific directory and then falls back to
the global Sounds directory in its
[instrument loader](https://github.com/OpenNBS/NoteBlockStudio/blob/79b22ad890631a39196d45b9c27881599f9b04ab/scripts/instrument_load/instrument_load.gml).
Knead follows the portable half of that contract without extracting to disk.

## Current Note Block Studio feature set

### Composition and editing

- Note grid with ticks, layers, instruments and keys (0-87), including notes
  outside Minecraft's normal two-octave range.
- Per-note velocity, panning and fine pitch; per-layer name, lock, solo, volume
  and panning.
- Song name, author, original author, description, import source, tempo, time
  signature, loop enable/count/start/end, and work/edit statistics.
- 20 vanilla instruments in NBS v6. The published v5 format supports up to 240
  custom instruments; the unchanged one-byte v6 instrument ID leaves 236
  addressable custom slots. A custom instrument stores its name, OGG/WAV file,
  source key and piano-key behavior.
- Undo/redo, selection tools, layer add/remove/reorder, transpose, expand and
  compress.
- Macros: Tremolo, Stereo, Arpeggio, Portamento, Vibrato, Stagger, Chorus,
  Volume LFO, Fade in/out, Replace key, Set velocity/panning/pitch, and Reset all
  properties. The list is visible in the official
  [editor menu source](https://github.com/OpenNBS/NoteBlockStudio/blob/abbf7d52c279e08ce8f12799495bfbfb882280c2/scripts/control_draw/control_draw.gml).
- Tempo Changer and Sound Stopper functional instruments. Sound Stopper can
  stop all sounds or a layer range. Tempo changes work in playback, audio
  export, and MIDI import.
- Multiple song tabs and cross-tab copy/paste; beta 3 also carries required
  custom instruments across tabs.
- Player mode, blackout mode, note chart, piano-key controls, autosave and crash
  recovery.

### Inputs and imports

- NBS v0-v6 and ZIP song bundles containing `song.nbs` plus custom sounds.
- MIDI `.mid`/`.midi` import with GM/percussion mappings, tempo-change import,
  velocity, timing precision, Minecraft-range conversion, maximum channel
  height, and optional duration tails with a configurable velocity fade. The
  controls are in the official
  [MIDI import source](https://github.com/OpenNBS/NoteBlockStudio/blob/abbf7d52c279e08ce8f12799495bfbfb882280c2/scripts/draw_window_midi_import/draw_window_midi_import.gml).
- Live MIDI devices with instrument mapping, velocity, pitch wheel and pedal
  handling.
- Note Block Pattern `.nbp` v1 import and v2 import/export. V2 embeds the custom
  instrument definitions used by the pattern.
- OGG Vorbis or WAV reference audio with offset, volume, mute, solo and seek
  synchronization.
- OGG/WAV custom instruments, resource-pack loading, and optional
  resource-pack `sounds.json` path/pitch resolution.
- Minecraft Java sound import assistant; 3.12 can download the required game
  data rather than requiring a prior local launch.
- `.nbs` file association, drag/drop where supported, `nbs://` player links,
  and Note Block World download/open integration.
- `.schematic` import exists in stable 3.11 but was explicitly removed in the
  3.12 beta line as outdated.

No MIDI export was found in the production menus or source.

### Outputs and exports

- NBS save/down-save and ZIP bundles with custom sounds.
- NBP v2 pattern export.
- Audio: MP3, WAV, AIFF and FLAC; 8,000 through 384,000 Hz; mono or stereo; and
  optional locked layers. OGG is present but commented out in the current
  [audio export UI source](https://github.com/OpenNBS/NoteBlockStudio/blob/abbf7d52c279e08ce8f12799495bfbfb882280c2/scripts/draw_window_audio_export/draw_window_audio_export.gml).
- Data pack as ZIP or folder, with `play`, `pause`, `stop`, and `uninstall`
  functions; Java 1.13-1.20.6 or 1.21+ layout; ten sound categories; locked or
  out-of-range notes; extra-note resource pack; nearby-listening radius; loop
  and loop start. See the official
  [data-pack options](https://github.com/OpenNBS/NoteBlockStudio/blob/abbf7d52c279e08ce8f12799495bfbfb882280c2/scripts/draw_window_datapack_export/draw_window_datapack_export.gml)
  and [generated functions](https://github.com/OpenNBS/NoteBlockStudio/blob/abbf7d52c279e08ce8f12799495bfbfb882280c2/scripts/datapack_export/datapack_export.gml).
- Optional in-game data-pack visualizers: Arc, Fall, Rise, Bounce, Piano Roll,
  Fountain, and Rittai Onkyou, with glow and placement controls.
- Schematic and fixed track export in four formats: `.nbt` (Structure Block),
  `.nbt` (Litematica-compatible exact dimensions), `.schematic` for 1.11-1.12,
  and `.schematic` for pre-1.11. See
  [schematic export](https://github.com/OpenNBS/NoteBlockStudio/blob/abbf7d52c279e08ce8f12799495bfbfb882280c2/scripts/draw_window_schematic_export/draw_window_schematic_export.gml)
  and [track export](https://github.com/OpenNBS/NoteBlockStudio/blob/abbf7d52c279e08ce8f12799495bfbfb882280c2/scripts/draw_window_track_export/draw_window_track_export.gml).
- Schematic options include layouts, repeaters per row, layer compression,
  locked layers, minecart track/chest, loop lever, command blocks for a wider
  pitch range, glass floor, custom blocks/instrument mappings, and selected
  note-block tempos.

### Extensions/plugins

No public, user-installable extension API could be verified in the production
README, release notes, menus or source. The repository's `extensions` directory
contains bundled native/platform dependencies and should not be mistaken for a
plugin ecosystem. The separate
[NewNoteBlockStudio roadmap](https://github.com/OpenNBS/NewNoteBlockStudio)
lists an "Instrument effect API" as future work, alongside future `.nbproj` and
`.nbseq` formats. Therefore an extension system is a Knead advantage, not an
existing NBS API that must be cloned. This conclusion is an inference from the
official sources, not an explicit NBS statement that plugins are forbidden.

## Knead parity matrix

Legend: **yes** = verified; **partial** = usable overlap but not parity;
**in flight** = present only in the audited worktree and still needs integration;
**no** = not found.

| Capability | Knead | Parity note |
| --- | --- | --- |
| Multi-track editing, selection, drag, copy/paste, duplicate, undo/redo | yes | Strong general-purpose timeline workflow |
| Track name/color/reorder/duplicate/lock/mute/solo | yes | NBS-compatible concepts plus color/collapse |
| Track gain/pan, master gain/limiter, live meters | yes | More DAW-like than NBS |
| Arbitrary Minecraft sound-event IDs and versioned asset browser | yes | Major Knead advantage |
| Download Mojang assets without a local Minecraft install | yes | Major Knead advantage |
| Marker volume/pitch, duration, retrigger and Bézier automation | yes | Major Knead advantage |
| Deterministic random variants in playback/audio rendering | yes | Major Knead advantage; the optional companion pack preserves fixed custom variants and resolves seeded variants per firing through isolated aliases |
| Loop, metronome, snap, ticks/seconds/bars, time signature | yes | First-class tempo/meter map drives the ruler, snapping and metronome; editable finite repeat counts share OpenNBS semantics in live playback, NBS exchange and data-pack loop playback |
| `.kp` v10 project open/save and desktop handoff | yes | v1-v9 migrate forward; normalized NBS/MIDI provenance, first-class authored custom instruments, note gates, song metadata, finite loops, tempo maps, Sound Stopper events and bounded portable audio persist |
| NBS v0-v6 parser | yes | Desktop UI, strict budgets, malformed-file diagnostics, an official v6 fixture and independent nbs.js cross-reads are integrated |
| NBS writer/down-save | yes | Explicit v0-v6 targets, classic limits, trumpet down-save, N/4 meter, piecewise Tempo Changer clocks, warning diagnostics and baked retrigger/automation firings |
| Lossless NBS song/note/layer/instrument model | partial | Header/statistics, finite loops, custom definitions and raw source fields persist in `.kp`; the canonical editor still quantizes non-20-TPS positions and clamps extended playback pitch, so edited saves are not advertised as byte-lossless |
| NBS custom sounds resolved, authored and played | yes | Content-addressed project registry feeds playback, waveforms and offline mix/stems; `.kp` v10 persists ordered definitions plus bounded audio, with one-undo name/sound-ID/file/source-key/press-key/default-pitch editing |
| Song-with-custom-sounds ZIP | yes | Exact OpenNBS layout, deterministic output, stored/deflate input, CRC/path/duplicate/symlink/ZIP64 and expanded-size defenses |
| NBP v1/v2 | yes | Official v1 fixture plus safe v1/v2 import, insert, new-project open, selection export and portable v2 Sound Stopper and Tempo Changer events |
| MIDI import | yes | Safe SMF 0/1 parser, tempo integration, velocity, pitch bend and deterministic IDs; bounded pre-apply preview controls quantization, note-off gates/single shots and per-channel audible mappings |
| Live MIDI | partial | Device/channel/root/sound selection, velocity, pitch wheel, overlapping-note FIFO, note-off gates and sustain-pedal release work even on a stopped playhead; placement-latency calibration and hardware CI remain |
| Tempo map / Tempo Changer | yes | Bounded BPM/meter conductor events drive ruler, snap, metronome, Piano Roll and Player Mode; exact-name NBS/NBP functional notes use OpenNBS piecewise timing and same-column layer precedence |
| Sound Stopper functional instrument | yes | First-class one-based inclusive track ranges, dedicated UI, live playback and offline mix/stem voice-tail stopping, `.kp` v10, NBS/NBP raw-field round-trips and data-pack `stopsound` diagnostics |
| Reference audio track | yes | Portable bounded WAV/OGG tracks have cached waveforms, offset drag, gain/pan, mute/solo, meters, exact play/seek/loop sync, mix and independent stems |
| Marker waveform rendering and arrangement overview | yes | Multi-resolution cached marker/reference waveforms and a seekable project minimap |
| Resource-pack loading and `sounds.json` resolution | yes | Layered Java packs, wrapper folders, event references, replace/weight/pitch/volume and bounded OGG/WAV assets are resolved |
| Minecraft sound import assistant | partial | Knead already downloads/browses vanilla sounds; it does not create NBS custom instruments |
| NBS editing macros | yes | All 15 actions are bounded, previewed and undoable; Fade uses OpenNBS integer-velocity rounding with a minimum of one, while Tremolo remains editable retrigger/volume automation |
| Song tabs and cross-song copy | yes | Up to eight resident songs keep independent undo/save/recovery state and native path ownership; atomic paste carries referenced custom-instrument definitions plus audio variants, deterministically remaps sound/file/definition collisions, and remaps track-dependent Sound Stopper ranges |
| Autosave/crash recovery | yes | Debounced bounded atomic snapshots, startup restore/discard UI, TTL cleanup and corrupt-file rejection |
| Player mode / Note Block World / `nbs://` | partial | Blackout presentation Player Mode has transport, seek, loop, meters, focus trapping and wake lock; Note Block World and `nbs://` remain absent |
| Piano Roll | yes | Minecraft C3-C5 range, cents, rectangle selection, drag/keyboard edits, velocity/pan/duration/retrigger controls and tempo-map grid |
| Command palette / shortcut discovery | yes | Ctrl/Cmd+K locale-aware search, categories, recent commands, disabled reasons, focus trap and host-owned callbacks only |
| Audio mixdown | yes | WAV, AIFF and FLAC use 16/24/32-bit mono/stereo at integer rates from 8,000 through 384,000 Hz; Ogg Vorbis is capped at 200,000 Hz and MP3 accepts valid MPEG rate/bitrate pairs |
| Audio stems | yes | Every supported codec shares the mix renderer, including limiter, automation, reference audio and Sound Stopper tails; note and reference tracks can also render independently |
| NBS audio format/rate/channel breadth | yes | WAV/AIFF/FLAC cover NBS's listed 8,000–384,000 Hz and mono/stereo breadth; MP3 is deliberately limited to valid MPEG combinations, while Ogg remains an additional Knead format |
| Data-pack ZIP | yes | Arbitrary sounds, safe audiences/position/source, min volume, project/loop range, mute/solo, curves, balanced runtime dispatch and a deterministic bounded `knead-export-report.json`; an independent consumer harness cross-reads representative 1.13.2 through 1.21.11 layouts |
| Data-pack pause/resume/uninstall/loop | yes | Versioned clocks use a guarded tick tag on 1.13, bare replace-by-ID scheduling on 1.14, and clear/replace on 1.15+; resume-safe cursor, stop, uninstall and OpenNBS-compatible finite/infinite repeat counts are covered by dependency/lifecycle checks |
| Data-pack panning/stereo | yes | Opt-in Java 1.13+ listener-relative local coordinates combine and clamp track/marker pan per listener; world-position mode and older targets retain explicit degradation warnings |
| Nearby listening/out-of-range pack/resource pack | partial | Position-centered nearby radius and a separate deterministic Ogg/Vorbis companion pack with isolated Knead aliases are supported; automatic extra-note substitution remains |
| Seven in-game visualizers | yes | Arc, Fall, Rise, Bounce, Piano Roll, Fountain and Rittai Onkyou use bounded data-only geometry, isolated cleanup tags and a legacy particle fallback |
| Schematic/Structure/Litematica/track export | partial | An independent bounded GZIP/NBT consumer cross-reads all four deterministic schemas and rejects out-of-header coordinates; actual Minecraft/Litematica import, circular/partial loops, Sound Stopper circuitry, native `.litematic` and playable legacy schematics remain in the manual acceptance matrix |
| Extension contracts and runtime registry | yes | Versioned manifest, permissions, lifecycle, typed commands/transforms, limits and failure isolation |
| Install/load/manage/sandbox third-party extensions | partial | Local code-free JSON packages have strict schemas, explicit grants, persistence, enable/disable/remove/export UI, failure isolation and an SDK; signed remote packages and arbitrary-code sandboxes are intentionally absent |
| Japanese and English UI | yes | Knead advantage; current NBS source primarily exposes English and Chinese |

## Complete-superset checklist

### P0: Interchange correctness and canonical model

- [x] Define a canonical song model that can represent NBS metadata, note key,
  velocity, note panning, fine pitch, layer properties, custom-instrument source
  key/file, loop count, tempo changes, and current Knead automation without
  destructive conversion.
- [x] Parse NBS v0-v6, including optional trailing sections and invalid/truncated
  file diagnostics.
- [x] Write v0-v6 with explicit target selection and correct v6 trumpet/custom
  down-save behavior.
- [x] Add a committed official v6 fixture, v0-v6 golden boundaries, independent
  nbs.js v5/v6 cross-reads, malformed/truncation/budget fuzz cases and semantic
  round trips.
- [ ] Preserve every source field through edited save without canonical loss.
  Raw source values persist in `.kp` and unchanged notes have guarded reuse,
  but non-20-TPS positions and extended pitch remain quantized/clamped in the
  interactive editor.
- [x] Version `.kp` forward-compatibly and add migrations for the richer model.
- [x] Put stable importer/exporter/instrument/effect registry seams into this
  model now; do not freeze a public plugin ABI until the model settles.

### P1: Real file workflow and custom assets

- [x] Integrate `.nbs` open/save/save-as, drag/drop, recent files and desktop
  association alongside `.kp`.
- [x] Show conversion and unsupported-feature warnings before destructive save.
- [x] Resolve all 20 vanilla instruments, plain-file `/Sounds`, bundled custom
  OGG/WAV instruments, and first-class authored definition/sample editing.
- [x] Import/export NBS ZIP bundles with path traversal, size, codec and duplicate
  validation.
- [x] Add song metadata, layer/note property editing and finite loop-count controls.

### P2: Music-production import parity

- [x] MIDI import with mappings, percussion, velocity, tempo changes, duration
  tails/fades, quantization and preview. Safe parsing, note-off gates, bounded
  pre-apply preview, channel overrides and OpenNBS-style tail-fade controls are
  integrated.
- [ ] Live MIDI device selection, latency handling, velocity, pitch wheel and
  sustain pedal. Timestamp-based note gates, overlapping voices and pedal-up
  release are integrated; explicit placement-latency calibration and automated
  hardware coverage remain.
- [x] Tempo/time-signature maps and first-class Tempo Changer events.
- [x] Add a first-class Sound Stopper timeline event with live and offline
  mix/stem voice-tail stopping.
- [x] Reference OGG/WAV track with waveform, offset, gain/pan, mute/solo,
  seek/loop sync, portable bounded persistence and offline mix/stems.
- [x] User resource packs and `sounds.json` pitch/path/variant resolution.

### P3: Editing parity

- [x] NBP v1/v2 import and v1/v2 export with embedded custom definitions.
- [x] Implement the 15 NBS macro actions as bounded, previewable, undoable commands.
- [x] Add note/instrument/key-aware piano-roll views without weakening Knead's
  arbitrary-sound timeline.
- [x] Song tabs, cross-song clipboard and custom-instrument dependency copying.
- [x] Autosave, atomic recovery snapshots and restore UI.

### P4: Minecraft-output parity

- [x] Add data-pack `play`, `pause`, `stop`, `uninstall`, resume-safe scheduling
  and finite/infinite loop behavior.
- [x] Preserve or explicitly degrade panning, fixed variants, tempo changes,
  pitch range and automation; include machine-readable export diagnostics.
- [ ] Finish extra-note substitution and locked-layer policies. Nearby listening
  and a separate deterministic Ogg/Vorbis companion resource pack are complete.
- [x] Implement the seven NBS visualizers behind reusable visualizer contracts.
- [x] Export static note-block/substrate layouts in Structure `.nbt`, exact-dimension
  Litematica-compatible `.nbt`, and both legacy `.schematic` container schemas.
- [x] Generate bounded OpenNBS-style repeater, wire, control and delay-equalized
  transmission circuitry for modern fixed-track `.nbt` builds, with structural
  validation and explicit 2-game-tick quantization diagnostics.
- [ ] Add a target-version Minecraft/Litematica acceptance matrix before calling
  those generated circuits universally reliable or directly playable.
- [ ] Add physical circular/partial loops, Sound Stopper semantics and playable
  legacy-schematic circuitry; keep exact 20 TPS output in the data-pack backend.
- [ ] Optionally restore stable-3.11 `.schematic` import after export coverage is
  reliable.

### P5: Audio and usability breadth

- [x] AIFF and FLAC export, mono, and the NBS sampling-rate range where the codec
  stack supports it safely.
- [x] Keep Knead's OGG, stems, deterministic variants, limiter and automation.
- [x] Player/presentation mode with blackout, transport keyboard controls,
  focus trapping, meters and wake lock.
- [x] Searchable command palette and shortcut discovery with bounded recents,
  disabled reasons and host-owned callbacks.
- [ ] Finish app-wide accessibility/validation reports and non-blocking
  progress/cancel for every long export.
- [ ] Optional Note Block World and `nbs://` integration only after URL/download
  validation and explicit trust boundaries are in place.

### P6: Extension platform beyond NBS

- [x] Versioned JSON package manifest/API gates and semantic-version validation.
  Cross-version migration/negotiation remains future work.
- [x] Capability/permission model for timeline reads/transforms, selection and
  notifications. Filesystem, network, audio/MIDI, assets and custom UI are not
  exposed to third-party packages yet.
- [x] Registries and a composable fixed DSL for commands and marker/track
  transforms. Importers, exporters, instruments, effects, visualizers and panels
  remain future capability versions.
- [x] A clear third-party containment boundary: packages contain no executable
  code and only invoke host-owned, budgeted operations. Bundled TypeScript
  extensions remain trusted renderer code rather than an OS sandbox.
- [x] Local install, permission review, persistence, enable/disable, export,
  two-stage uninstall, diagnostics and per-package failure isolation. In-place
  updates, signatures/checksums, remote distribution and safe mode remain.
- [x] Public schema/operation SDK, complete example, strict conformance tests and
  normalized reproducible JSON export. API migration tooling remains future work.

## Recommended implementation order

1. **Canonical model and NBS codec.** Every later feature depends on preserving
   NBS meaning. Retrofitting tempo maps, custom instruments or note panning after
   importers and plugins ship would create migrations and data-loss traps.
2. **Desktop NBS workflow and custom assets.** Make real songs open, play and
   save safely before adding breadth.
3. **MIDI, tempo map, reference audio and resource packs.** These unlock the
   largest musician workflow gap and validate the canonical model.
4. **NBP, macros and tabs.** High daily-use value with lower binary/export risk.
5. **Minecraft export parity.** Build pause/loop/resource-pack correctness first,
   then schematic formats and visualizers.
6. **Audio breadth and recovery/presentation polish.** Retain Knead's stronger
   DAW features while closing format and reliability gaps.
7. **Public extension SDK.** Keep internal registry seams from P0, but publish
   the ABI only after the data model and security boundary are stable.

The resulting product should not merely copy NBS. Its durable differentiators
are arbitrary version-aware Minecraft sounds, Mojang asset acquisition without
a local install, automation curves, duration/retrigger events, deterministic
rendering, a mixer/master bus, OGG and stems, waveform-assisted editing,
granular modern pack-format targeting, and Japanese-first usability.
