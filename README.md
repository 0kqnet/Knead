# Knead
Minecraftの`/playsound`コマンドを容易にするためのデスクトップアプリ

A desktop app that lets you easily create Minecraft `/playsound` commands

## Ultimate Studio

Studio can arrange sounds on a multi-track timeline with cached waveforms, an
arrangement navigator, track and per-marker pan, volume/pitch automation,
looping, metronome playback, and deterministic audio export. Mixes and stems can
be written as WAV, Ogg Vorbis, MP3, AIFF, or FLAC; WAV/AIFF/FLAC accept integer
sample rates from 8,000 through 384,000 Hz, while Ogg and MP3 use their codec
limits. A project can also
embed portable WAV/OGG reference tracks with zoomable waveforms, offset,
gain/pan, mute/solo, seek/loop synchronization, and independent stems. It can
be exported as a ready-to-install Minecraft Java data pack ZIP. NBS v0-v6 songs
open as ordinary tabs, retain their source version through direct save/save-as,
drag/drop and recent-file workflows, and can also be exported as any
target-correct NBS version from v0 through v6. Lossy plain-NBS saves show a
bounded confirmation first, including affected marker IDs where available.
This covers v6 trumpet down-save, editable song credits and finite-loop
playback/export semantics.
OpenNBS Sound Stopper notes are editable first-class events with exact layer
ranges, live playback and offline mix/stem voice-tail stopping, NBS/NBP
round-trips, and data-pack output.
OpenNBS Tempo Changer notes become piecewise conductor events with the official
four-source-ticks-per-quarter clock, same-column layer precedence, and v4+
functional-note re-export; meter numerators remain independent N/4 metadata.
OpenNBS zipped songs preserve custom OGG/WAV samples for playback, waveforms,
mix/stem export, deterministic bundle re-export, and portable `.kp` v10 saves.
The Custom Instrument Studio edits stable sound IDs, NBS file/source-key,
press-key and default pitch, attaches verified samples, and applies definition,
marker and asset changes as one undoable operation.
OpenNBS NBP v1/v2 patterns can be inserted or exported, and all 15 editing
macros show a bounded before/after preview before one undoable transform;
Tremolo remains editable automation.
Layered Java resource packs can be loaded with `sounds.json` precedence,
weighted variants, pitch/volume metadata, and only relevant audio inflated.
Data-pack export can also write a separate, deterministic Ogg/Vorbis companion
resource-pack ZIP. Generated Knead aliases isolate base-game namespaces and
preserve fixed or seeded variants without overwriting `assets/minecraft`.
Standard MIDI format 0/1 import preserves tempo maps, note-off gate lengths, GM
programs, drums, and pitch bend as project provenance. A bounded preview lets
you choose quantization, gate/single-shot behavior, and per-channel mappings
before one explicit apply, including audible vanilla note-block mappings. Web
MIDI keyboards record
overlapping notes, pitch wheel, note-off timing and sustain-pedal release even
while the playhead is stopped. The built-in extension API ships with
deterministic Humanize and chord/arpeggio tools behind validated permissions
and undoable transforms. Third-party tools can be installed as code-free,
permission-reviewed declarative JSON packages, then enabled, disabled, exported,
or removed in the Extension Manager; see the
[Extension Package SDK](docs/extensions-sdk.md).
Dirty projects are atomically autosaved to bounded recovery snapshots and can
be restored or discarded on the next launch. A first-class tempo/meter
conductor map drives the ruler, beat snapping, metronome, Minecraft-range Piano
Roll, and blackout Player Mode without changing the deterministic 20 TPS audio
clock. Ctrl/Cmd+K opens a searchable command palette with categories, recent
actions, shortcut discovery, and host-owned callbacks only.
Up to eight `.kp` or `.nbs` songs can stay open in independent tabs with
per-song undo history, dirty/save state, crash recovery, native path ownership,
bounded recent files, and safe close confirmation. Cross-song copy/paste carries
every referenced custom-instrument definition and audio variant atomically,
resolves sound/file/definition collisions deterministically, and remaps
track-dependent Sound Stopper ranges.

The generated data pack preserves timeline timing, retriggers, Mute/Solo state,
volume/pitch curves, Sound Stoppers, opt-in listener-relative stereo, and seven
bounded visualizer modes; run its displayed `/function` command after placing
the ZIP in the world's `datapacks` folder and using `/reload`. Unknown sounds in
plain `.nbs` exports are references only; choose the song-and-sounds ZIP action
when the custom audio must travel with the file.
Every data-pack ZIP includes a deterministic `knead-export-report.json` that
classifies preserved, baked, degraded, and omitted features with stable codes
and bounded marker/track references; see the
[export report schema](docs/export-report.md).
An independent consumer-side harness now cross-reads the 1.13 tick-tag,
1.14 bare-schedule, and 1.15+ clear/replace clock eras, both function-directory
layouts, and the generated NBT containers. Actual game/mod runs remain tracked
separately in the [Minecraft acceptance matrix](docs/minecraft-acceptance.md).
Note-block builds can be exported in OpenNBS-compatible container schemas as
Structure Block `.nbt`, Litematica-compatible exact-size Structure `.nbt`, or
either legacy `.schematic` profile. Static fixed-track/wrapped layouts remain
available, while modern fixed-track `.nbt` can generate a structurally validated,
OpenNBS-style control/repeater/wire circuit intended for one-pass playback on a
two-game-tick grid. Target-version Minecraft/Litematica acceptance remains part
of the release matrix rather than an unverified compatibility claim.
The physical circuit plays one pass; loop and Sound Stopper semantics remain in
the data-pack backend. The Litematica-compatible option is deliberately labeled
`.nbt`: it is not a native `.litematic` file.
See the [Note Block Studio parity audit](docs/note-block-studio-parity.md) for
the verified compatibility matrix and remaining roadmap.

Studioでは、マルチトラック編集、波形、全体ナビゲータ、トラック／マーカーPan、
音量・ピッチカーブ、ループ、メトロノーム、音声書き出しに対応しています。mix/stemは
WAV、Ogg Vorbis、MP3、AIFF、FLACへ書き出せます。WAV/AIFF/FLACは
8,000〜384,000 Hzの整数サンプルレート、Ogg/MP3は各codecの対応範囲を使用します。
WAV/OGG参照音源をプロジェクトへ安全に埋め込み、波形、offset、gain/pan、
mute/solo、seek/loop同期、mix/stem書き出しに利用できます。
NBS v0〜v6を通常タブとして開き、元versionを保った直接保存・別名保存、
drag/drop、最近のファイルに対応します。plain NBSで表現できない機能は、
影響するmarker IDを含む上限付き警告を保存前に表示します。曲名・作者・説明・制作統計、
正しい音源IDと有限ループ回数も保持します。有限ループは通常再生と
データパックでも同じ回数で停止します。Sound Stopperも停止範囲付きの正式イベントとして再生・編集でき、通常再生と
offline mix/stemで既発voiceのtailを停止し、NBS/NBP・データパックへ往復できます。
Tempo Changerは公式の4 source tick／四分音符と同列layer優先順位でテンポマップへ変換し、
NBS v4以降へ機能noteとして再出力します。拍子のN/4分子とは独立して扱います。
OpenNBS音源同梱ZIPではカスタムOGG/WAVを通常再生・波形・mix/stem・
再ZIP出力に利用し、`.kp` v10へポータブルに保持できます。カスタム楽器Studioでは
stable sound ID、NBS file/source-key、press-key、既定pitchと検証済み音源を編集し、
定義・marker・assetを1回のUndo可能な操作で更新できます。MIDI format 0/1のtempo map・GM音色・ドラム・pitch bend・
note-off Gateを読み込み、適用前previewでquantize、Gate／単発、channel別mappingを選べます。
Web MIDIでは同音重複、note-off、sustain pedalを再生停止中でも
実時間の音長としてライブ録音できます。権限検証とUndoに対応した
拡張APIから、Humanizeとコード／アルペジオも利用できます。
NBP v1/v2の挿入・書き出し、OpenNBSの15マクロ、複数Javaリソースパックの
`sounds.json`優先順位・weighted variant・pitch/volume解決にも対応しています。
データパックとは別に、Ogg/Vorbisカスタム音源をKnead専用aliasへ隔離した
決定論的なcompanion resource-pack ZIPも出力できます。
15マクロは変更件数と主要プロパティのbefore/afterを上限制御付きで確認してから、
1回のUndo可能な操作として適用します。
第三者ツールは任意JavaScriptを実行しない宣言的JSONパッケージとして、権限を確認して
インストール・有効化・無効化・書き出し・削除できます。タイムラインは
Minecraft Java用データパックZIPとして直接書き出し、`/reload`後に画面の
`/function`コマンドで演出を再生できます。Java 1.13以降では各リスナーの向きを
基準にした安全な左右定位も選べます。未対応差分は
[Note Block Studio互換監査](docs/note-block-studio-parity.md)に明記しています。
各データパックZIPには `knead-export-report.json` を同梱し、保持・焼き込み・縮退・
省略した機能をstable codeと上限制御済みmarker/track参照で機械可読に記録します。
1.13のtick tag、1.14の旧schedule、1.15以降のclear/replace、2種類のdirectory layout、
生成NBTは独立consumer harnessでもcross-readします。実ゲーム／modでの確認状況は
[Minecraft受入matrix](docs/minecraft-acceptance.md)に自動検証と分けて記録します。
未保存変更は容量・件数・期限を制限したatomic recovery snapshotへ自動保存され、
次回起動時に復元または破棄できます。20 TPSの決定論的な実時間を保ったまま、
テンポ／拍子マップをルーラー、拍スナップ、メトロノーム、Minecraft音域の
Piano Roll、暗転Player Modeで共有します。Ctrl/Cmd+Kのコマンドパレットから、
カテゴリ検索・最近使った操作・ショートカット一覧を安全に呼び出せます。
最大8曲の`.kp` / `.nbs`を独立したタブで開き、曲ごとのUndo履歴・未保存状態・保存先・自動復旧と
容量制限付きの最近のファイルを
安全に管理できます。曲間コピー／貼り付けでは必要なカスタム楽器定義と音源の全variantも
一緒に移し、sound/file/definition衝突を決定論的に解決して、トラック依存の
Sound Stopper範囲を貼り付け先へ再割り当てします。
音ブロック建築はOpenNBS互換のコンテナschemaで、Structure Block `.nbt`、
Litematicaへ読み込める実寸Structure `.nbt`、1.11–1.12／1.11より前の
`.schematic`へ書き出せます。静的なトラック固定／折り返し配置に加え、modern `.nbt`の
固定トラックではOpenNBS式の制御・repeater・wire回路を2 game-tick刻みで生成します。
構造検証は自動化済みですが、Minecraft/Litematica各targetでの受入確認はrelease matrixで行います。
loopとSound Stopperの物理回路化はデータパック側を利用します。
Litematica互換出力はnative `.litematic`ではありません。

<div style="display: flex;">
<img src="image.png" width="45%" />
<img src="image-1.png" width="45%" />
</div>


# Supported
### 大感謝　　　Thank you so so so so so much
### [@ChenCMD](https://github.com/ChenCMD)
### [@saluf](https://github.com/5qlufz-1536)


# Feedback

[Create Issue](https://github.com/nea-c/Knead/issues/new)

## Development / 開発

Knead is a Tauri v2 desktop application. Install Node.js, Rust, and the
[Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your platform first.
Windows builds use Microsoft Edge WebView2. CI uses Node.js 24.18.0.

Minecraft本体がインストールされていない環境でも、バージョン選択時にMojangの
公式配信元から必要な音声アセットを取得して利用できます。ダウンロードした
メタデータ、asset index、音声は標準の `.minecraft` キャッシュ形式で保存されます。

Knead can also be used without a local Minecraft installation. Selecting a
version downloads the required sound assets from Mojang's official services
and stores them in the standard `.minecraft` cache layout.

```sh
npm ci
npm run dev
```

Type checking, utility self-checks, and a production frontend build:

```sh
npx tsc --noEmit
npm run selfcheck
npm run build
```

Create an installer for the current platform:

```sh
npm run package:win
npm run package:mac
npm run package:linux
```

Application settings are stored in Tauri's application config directory.
On first launch, existing `settings.json` and `ratingStar.json` files from the
former Knead data directory are copied automatically.
