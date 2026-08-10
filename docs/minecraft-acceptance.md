# Minecraft export acceptance matrix

Updated: 2026-08-10

This is the evidence ledger for Knead's Java Edition data-pack and note-block
build exports. It deliberately separates automated consumer-side validation
from tests that must run in Minecraft, Structure Blocks, WorldEdit, or
Litematica. A row marked **not run** is not an in-game compatibility claim.

## Authoritative format boundaries

- Mojang introduced data packs, ZIP installation, `pack.mcmeta`, namespaces,
  and the plural `functions/` layout in
  [17w43b](https://www.minecraft.net/en-us/article/minecraft-snapshot-17w43a).
- Mojang added the `minecraft:load` function tag in
  [18w01a](https://www.minecraft.net/en-us/article/minecraft-snapshot-18w01a).
  Mojang's later [22w46a changelog](https://www.minecraft.net/en-us/article/minecraft-snapshot-22w46a)
  explicitly records the `minecraft:tick` function tag and its ordering after
  `load`.
- Mojang's combined 18w43 changelog records `/schedule function` under the
  [18w43a technical changes](https://feedback.minecraft.net/hc/en-us/articles/360018363512-Minecraft-Java-Edition-Snapshot-18W43C).
- Mojang added `schedule clear` and the `append|replace` suffix in
  [19w38a/b](https://feedback.minecraft.net/hc/en-us/articles/360033496792-Minecraft-Java-Edition-Snapshot-19W38B).
- Mojang renamed `functions` to `function` and `tags/functions` to
  `tags/function` in
  [24w21a/b](https://www.minecraft.net/en-us/article/minecraft-snapshot-24w21a),
  released in [Java 1.21](https://feedback.minecraft.net/hc/en-us/articles/27547857163917-Minecraft-Java-Edition-1-21-Tricky-Trials).
- Mojang made pack formats minor-versioned and introduced `min_format` /
  `max_format` metadata in
  [Java 1.21.9](https://www.minecraft.net/en-us/article/minecraft-java-edition-1-21-9).
- Mojang's release notes record data/resource pack versions 101.1/84 for
  [Java 26.1](https://feedback.minecraft.net/hc/en-us/articles/44551668333837-Minecraft-Java-Edition-26-1),
  107.1/88 for [Java 26.2](https://www.minecraft.net/it-it/article/minecraft-java-edition-26-2),
  and 113.0/94.0 for
  [26.3 Snapshot 6](https://www.minecraft.net/es-es/article/minecraft-26-3-snapshot-6).
- The [Java 1.19 release notes](https://www.minecraft.net/en-us/article/the-wild-update-out-today-java)
  record data-pack format 10.

These primary sources are the compatibility boundaries enforced by the
automated harness. They also exposed and fixed a real defect: Knead previously
emitted Java 1.15-only `schedule clear` / `replace` syntax for 1.13 and 1.14.

## Automated consumer evidence

The independent harness lives in
`src/web/Sub/utils/minecraftAcceptance.ts`. It does not import Knead's
data-pack, NBT, or GZIP writers.

For data packs it:

- validates safe paths and `pack.mcmeta` shape;
- enforces plural/singular directory boundaries;
- parses load/tick tags and every generated function line;
- builds a resource-location dependency graph and rejects missing, foreign,
  unreachable event, or case-mismatched function references;
- enforces the three clock eras below;
- cross-checks the machine-readable report's identity and event count.

For builds it independently gunzips the final bytes, verifies the GZIP
checksum, parses the full big-endian NBT tree with depth/item/byte budgets, and
then validates palette indices, unique/in-bounds positions, note-block states,
declared dimensions, legacy array volumes, tile-entity IDs/coordinates/notes,
and legacy version containers.

| Export target | Automated fixture | Consumer result |
| --- | --- | --- |
| Java 1.13.2 | plural functions + guarded `minecraft:tick` driver, no schedule command | pass |
| Java 1.14.4 | plural functions + bare schedule; same function ID replaces the pending chain | pass |
| Java 1.15.2 | plural functions + `schedule clear` / `replace` | pass |
| Java 1.19.2 | plural functions + exact integer `pack_format` 10 | pass |
| Java 1.20.6 | plural functions + legacy integer `pack_format` | pass |
| Java 1.21.4 | singular functions/tags | pass |
| Java 1.21.11 | singular functions/tags + minor-format metadata | pass |
| Java 26.1 / 26.2 | singular functions/tags + exact minor-format metadata | pass |
| 26.3 Snapshot 6 | singular functions/tags + exact 113.0 metadata | pass |
| 18w42a / 18w43a / 19w37a / 19w38b | exact schedule command boundaries | pass |
| 24w20a / 24w21a | exact plural-to-singular directory boundary | pass |
| Structure Block `.nbt` (within declared size) | independent GZIP/NBT/palette/position cross-read | pass |
| Exact-size Litematica-compatible `.nbt` | independent GZIP/NBT/palette/position cross-read | pass |
| 1.11-1.12 `.schematic` | independent Alpha arrays/tile entities/version cross-read | pass |
| pre-1.11 `.schematic` | independent Alpha arrays/`Music` tile entities/version cross-read | pass |

Mutation fixtures prove that the harness rejects an unresolved function, a
wrong layout, wrong target pack format, report-count drift, Java 1.15 schedule syntax in a 1.14 pack, a
corrupt GZIP checksum, and a block outside its declared Structure size.

Run the focused gate with:

```powershell
npx vitest run src/web/Sub/utils/minecraftAcceptance.test.ts src/web/Sub/utils/commandExport.test.ts src/web/Sub/utils/noteBlockBuild.test.ts --maxWorkers=1
```

## Clock lifecycle contracts

Java 1.13 has no schedule command. Its load hook creates one invisible,
namespace-isolated armor-stand controller without resetting an existing
playback state. The global tick tag calls a driver that enters the scoreboard
runtime only while that controller exists. Stop leaves the controller active
and idles at state 0; uninstall kills it before removing the objective, so the
static tick tag cannot call a removed scoreboard afterward.

Java 1.14 schedules only one function ID. Scheduling that ID again replaces
the pending invocation under the original command semantics, so start/resume
cannot accumulate clock chains. Because `schedule clear` does not yet exist,
uninstall sets cleanup state 3 and schedules that same function once; the next
tick removes the objective and does not reschedule.

Java 1.15 and later retain the existing immediate `schedule clear` lifecycle
and explicit `replace` suffix.

## Manual external-consumer matrix

All rows below remain **not run** until somebody records evidence from the
named external consumer. Automated pass status above must not be copied into
this column.

| Consumer / target | Artifact and procedure | Required evidence | Status |
| --- | --- | --- | --- |
| Vanilla server 1.13.2 | install representative ZIP; `/reload`; start, pause, resume, stop, uninstall; wait two ticks | no function parse errors in `latest.log`; one clock chain; objective/controller absent after uninstall | not run |
| Vanilla server 1.14.4 | same transport sequence; repeat start/resume rapidly; wait two ticks after uninstall | no unknown `clear`/`replace`; no duplicate clock; deferred objective removal | not run |
| Vanilla server 1.15.2 | same sequence | no reload/runtime errors; scheduled tick cleared by stop/uninstall | not run |
| Vanilla server 1.20.6 | play representative loop, Sound Stopper, nearby audience and companion resource pack | audible timing/stop behavior; no reload errors; resource aliases resolve | not run |
| Vanilla client/server 1.21.4 | repeat 1.20.6 scenario with singular layout | same evidence plus pack visible in `/datapack list enabled` | not run |
| Vanilla client/server 1.21.11 | load minor-format metadata pack | no compatibility warning or reload error; transport passes | not run |
| Vanilla 26.1 / 26.2 / 26.3 Snapshot 6 | load each exact-format pack in its matching disposable world | no compatibility warning or reload error; transport passes | not run |
| Structure Block, 1.21.4 | load a <=32 block/axis static `.nbt` into a disposable world | palette, notes, substrates and orientation match report | not run |
| Litematica matching 1.20.6 / 1.21.4 | import exact-size `.nbt` (not native `.litematic`) | import succeeds; bounding box and block counts match report | not run |
| WorldEdit/Schematica 1.11.2 | import 1.11-1.12 `.schematic` | note tile entities and substrates survive paste | not run |
| Legacy consumer 1.10.2 | import pre-1.11 `.schematic` | `Music` tile entities and notes survive paste | not run |
| Vanilla 1.21.4 redstone | place playable fixed-track build and trigger once | measured note onsets match reported 2-game-tick quantization and start latency | not run |

Use a fresh disposable world for every version. Record the artifact SHA-256,
Knead revision/worktree fingerprint, exact game/mod version, Java version,
commands used, relevant `latest.log` excerpt, observed timing/block counts, and
screenshots or video paths. Do not reuse a world across Java versions.

## Known non-acceptance and expected limits

- Structure Block format declares at most 32 blocks per axis. Knead preserves
  the OpenNBS-style warning for larger exported coordinates, but the strict
  consumer harness rejects blocks outside the declared header; use the
  exact-size Litematica-compatible option for those builds. This is not a
  vanilla Structure Block acceptance claim.
- Litematica-compatible `.nbt` is a Structure-style NBT container accepted by
  some import flows, not a native `.litematic` container.
- The automated NBT parser proves container/schema consistency, not placement
  behavior in a particular mod version.
- Playable circuits still quantize to a two-game-tick redstone grid. Loop,
  Sound Stopper circuitry, native `.litematic`, and playable legacy schematic
  output remain outside this acceptance milestone.
