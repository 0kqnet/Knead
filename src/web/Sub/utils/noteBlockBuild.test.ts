import { gunzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MASTER,
  DEFAULT_SETTINGS,
  createDefaultTrack,
  type Marker,
  type TimelineState,
  type Track,
} from '../types/timeline'
import {
  NOTE_BLOCK_BUILD_LIMITS,
  defaultNoteBlockBuildFormat,
  exportNoteBlockBuild,
  validateNoteBlockBuildTarget,
  type NoteBlockBuildFormat,
} from './noteBlockBuild'

interface NbtCompoundValue {
  [key: string]: NbtValue
}

interface NbtListValue extends Array<NbtValue> {
  readonly __nbtListBrand?: never
}

type NbtValue = number | string | Uint8Array | NbtListValue | NbtCompoundValue

class IndependentNbtReader {
  private readonly view: DataView
  private readonly bytes: Uint8Array
  private offset = 0
  private readonly decoder = new TextDecoder()

  constructor(data: Uint8Array) {
    this.bytes = data
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  }

  private require(count: number): void {
    if (count < 0 || this.offset + count > this.bytes.byteLength) throw new Error('Truncated test NBT')
  }

  private u8(): number {
    this.require(1)
    return this.view.getUint8(this.offset++)
  }

  private i16(): number {
    this.require(2)
    const value = this.view.getInt16(this.offset, false)
    this.offset += 2
    return value
  }

  private u16(): number {
    this.require(2)
    const value = this.view.getUint16(this.offset, false)
    this.offset += 2
    return value
  }

  private i32(): number {
    this.require(4)
    const value = this.view.getInt32(this.offset, false)
    this.offset += 4
    return value
  }

  private string(): string {
    const length = this.u16()
    this.require(length)
    const value = this.decoder.decode(this.bytes.subarray(this.offset, this.offset + length))
    this.offset += length
    return value
  }

  private payload(type: number, depth: number): NbtValue {
    if (depth > 64) throw new Error('Excessive test NBT nesting')
    if (type === 1) return this.u8()
    if (type === 2) return this.i16()
    if (type === 3) return this.i32()
    if (type === 7) {
      const length = this.i32()
      this.require(length)
      const value = this.bytes.slice(this.offset, this.offset + length)
      this.offset += length
      return value
    }
    if (type === 8) return this.string()
    if (type === 9) {
      const elementType = this.u8()
      const length = this.i32()
      if (length < 0 || length > 1_000_000) throw new Error('Invalid test NBT list')
      return Array.from({ length }, () => this.payload(elementType, depth + 1))
    }
    if (type === 10) {
      const result: Record<string, NbtValue> = {}
      while (true) {
        const childType = this.u8()
        if (childType === 0) return result
        const name = this.string()
        if (Object.hasOwn(result, name)) throw new Error(`Duplicate NBT name ${name}`)
        result[name] = this.payload(childType, depth + 1)
      }
    }
    throw new Error(`Unsupported test NBT tag ${type}`)
  }

  root(): { name: string, value: Record<string, NbtValue> } {
    const type = this.u8()
    if (type !== 10) throw new Error('Test NBT root is not a compound')
    const name = this.string()
    const value = this.payload(type, 0) as Record<string, NbtValue>
    if (this.offset !== this.bytes.byteLength) throw new Error('Trailing test NBT bytes')
    return { name, value }
  }
}

function readExport(data: Uint8Array) {
  return new IndependentNbtReader(new Uint8Array(gunzipSync(data))).root()
}

function track(id: string, locked = false): Track {
  return { ...createDefaultTrack(id), locked }
}

function marker(
  id: string,
  trackId: string,
  soundId: string,
  pitch = 1,
  tick = 2,
): Marker {
  return {
    id,
    trackId,
    tick,
    soundId,
    variantIndex: -1,
    volume: 1,
    pitch,
    pan: 0,
  }
}

function project(targetVersion: string, markers: Marker[], tracks: Track[] = [track('track')]): TimelineState {
  return {
    projectId: 'build-test',
    randomSeed: 1,
    targetVersion,
    lengthTicks: 200,
    settings: structuredClone(DEFAULT_SETTINGS),
    master: { ...DEFAULT_MASTER },
    tracks,
    markers,
    referenceAudio: [],
    customAudio: [],
  }
}

function compound(value: NbtValue): Record<string, NbtValue> {
  return value as Record<string, NbtValue>
}

function list(value: NbtValue): NbtValue[] {
  return value as NbtValue[]
}

function modernNoteStates(root: Record<string, NbtValue>) {
  return list(root.palette)
    .map(compound)
    .filter(state => state.Name === 'minecraft:note_block')
    .map(state => compound(state.Properties))
}

function modernBlockRecords(root: Record<string, NbtValue>) {
  const palette = list(root.palette).map(compound)
  return list(root.blocks).map(compound).map(block => ({
    pos: block.pos as NbtValue[],
    state: palette[block.state as number],
  }))
}

function modernStateAt(root: Record<string, NbtValue>, pos: readonly number[]) {
  return modernBlockRecords(root).find(block => (
    block.pos.length === pos.length && block.pos.every((value, index) => value === pos[index])
  ))?.state
}

function legacyCell(root: Record<string, NbtValue>, x: number, y: number, z: number): number {
  const width = root.Width as number
  const length = root.Length as number
  return (root.Blocks as Uint8Array)[y * length * width + z * width + x]
}

describe('OpenNBS-compatible note-block build export', () => {
  it.each([
    'structure-block-nbt',
    'litematica-compatible-nbt',
  ] satisfies NoteBlockBuildFormat[])('cross-reads %s as big-endian Structure NBT', (format) => {
    const source = project('1.21.4', [
      marker('harp', 'track', 'block.note_block.harp', 1, 0),
      marker('pling', 'track', 'block.note_block.pling', 2, 2),
    ])
    const exported = exportNoteBlockBuild(source, { format })
    const parsed = readExport(exported.data)
    expect(parsed.name).toBe('')
    expect(parsed.value.DataVersion).toBe(1519)
    expect(parsed.value.size).toEqual([3, 2, 1])
    expect(exported.dimensions).toEqual({ x: 3, y: 2, z: 1 })
    expect(exported.blockCount).toBe(4)
    expect(exported.noteBlockCount).toBe(2)
    expect(modernNoteStates(parsed.value)).toEqual(expect.arrayContaining([
      { instrument: 'harp', note: '12', powered: 'false' },
      { instrument: 'pling', note: '24', powered: 'false' },
    ]))
    const palette = list(parsed.value.palette).map(compound)
    expect(palette.map(state => state.Name)).toEqual(expect.arrayContaining([
      'minecraft:dirt', 'minecraft:glowstone', 'minecraft:note_block',
    ]))
    expect(list(parsed.value.blocks)).toHaveLength(4)
  })

  it('writes exact dimensions deterministically and labels the Litematica-compatible NBT honestly', () => {
    const source = project('1.21.4', [marker('late', 'track', 'block.note_block.bell', 1, 40)])
    const structure = exportNoteBlockBuild(source, { format: 'structure-block-nbt' })
    const structureNbt = readExport(structure.data).value
    expect(structure.dimensions).toEqual({ x: 41, y: 2, z: 1 })
    expect(structureNbt.size).toEqual([32, 2, 1])
    expect(list(structureNbt.blocks).map(compound).map(block => block.pos)).toContainEqual([40, 1, 0])
    expect(structure.warnings.join(' ')).toMatch(/caps only its size header at 32/)
    const first = exportNoteBlockBuild(source, { format: 'litematica-compatible-nbt' })
    const second = exportNoteBlockBuild(source, { format: 'litematica-compatible-nbt' })
    expect(first.data).toEqual(second.data)
    expect(first.extension).toBe('.nbt')
    expect(first.data.slice(0, 10)).toEqual(new Uint8Array([
      0x1f, 0x8b, 0x08, 0, 0, 0, 0, 0, 0, 0xff,
    ]))
    expect(first.warnings.join(' ')).toMatch(/not native \.litematic/)
    expect(readExport(first.data).value.size).toEqual([41, 2, 1])
  })

  it('cross-reads 1.11–1.12 Alpha schematic blocks, instrument substrates, and note tile entities', () => {
    const exported = exportNoteBlockBuild(
      project('1.12.2', [marker('bell', 'track', 'block.note_block.bell', 1, 2)]),
      { format: 'schematic-1.11-1.12' },
    )
    const parsed = readExport(exported.data)
    expect(parsed.name).toBe('Schematic')
    expect(parsed.value).toMatchObject({ Width: 3, Height: 2, Length: 1, Materials: 'Alpha' })
    expect(legacyCell(parsed.value, 2, 0, 0)).toBe(41)
    expect(legacyCell(parsed.value, 2, 1, 0)).toBe(25)
    expect(list(parsed.value.TileEntities).map(compound)).toEqual([{
      id: 'minecraft:noteblock', x: 2, y: 1, z: 0, note: 12,
    }])
    expect(compound(parsed.value.Version)).toMatchObject({ Id: 922, Name: '1.11.2' })
  })

  it('cross-reads pre-1.11 Alpha schematic with classic Music tile IDs', () => {
    const exported = exportNoteBlockBuild(
      project('1.10.2', [marker('bass', 'track', 'block.note_block.bass', 0.5, 2)]),
      { format: 'schematic-pre-1.11' },
    )
    const parsed = readExport(exported.data)
    expect(legacyCell(parsed.value, 2, 0, 0)).toBe(5)
    expect(legacyCell(parsed.value, 2, 1, 0)).toBe(25)
    expect(list(parsed.value.TileEntities).map(compound)).toEqual([{
      id: 'Music', x: 2, y: 1, z: 0, note: 0,
    }])
    expect(compound(parsed.value.Version)).toMatchObject({ Name: '1.8', Snapshot: 0 })
  })

  it('resolves historical asset sound IDs before applying instrument availability gates', () => {
    const legacy18 = exportNoteBlockBuild(project('1.8.9', [
      marker('harp', 'track', 'note.harp', 1, 0),
      marker('kick', 'track', 'note.bd', 1, 1),
    ]), { format: 'schematic-pre-1.11' })
    expect(legacy18.noteBlockCount).toBe(2)
    const legacy18Nbt = readExport(legacy18.data).value
    expect(legacyCell(legacy18Nbt, 0, 0, 0)).toBe(3)
    expect(legacyCell(legacy18Nbt, 1, 0, 0)).toBe(4)

    expect(exportNoteBlockBuild(project('1.10.2', [
      marker('harp', 'track', 'block.note.harp', 1, 0),
      marker('kick', 'track', 'block.note.basedrum', 1, 1),
    ]), { format: 'schematic-pre-1.11' }).noteBlockCount).toBe(2)
    expect(exportNoteBlockBuild(project('1.12.2', [
      marker('bell', 'track', 'block.note.bell', 1, 0),
      marker('xylo', 'track', 'block.note.xylophone', 1, 1),
    ]), { format: 'schematic-1.11-1.12' }).noteBlockCount).toBe(2)

    const unavailablePling = exportNoteBlockBuild(project('1.11', [
      marker('harp', 'track', 'block.note.harp', 1, 0),
      marker('pling', 'track', 'block.note.pling', 1, 1),
    ]), { format: 'schematic-1.11-1.12' })
    expect(unavailablePling.noteBlockCount).toBe(1)
    expect(unavailablePling.warnings.join(' ')).toMatch(/block\.note\.pling.*unavailable/)
  })

  it('explicitly reports extended DAW pitch degradation at physical note-block bounds', () => {
    const exported = exportNoteBlockBuild(project('1.21.4', [
      marker('low', 'track', 'block.note_block.harp', 0.125, 0),
      marker('high', 'track', 'block.note_block.harp', 8, 1),
    ]))
    expect(exported.noteBlockCount).toBe(2)
    expect(exported.warnings.join(' ')).toMatch(/2 DAW pitch value.*physical note-block 0\.5\.\.2.*clamped/)
  })

  it('uses fixed track lanes, honors locked tracks, and explicitly warns for unknown sounds', () => {
    const tracks = [track('one'), track('locked', true)]
    const stopper = marker('stop', 'one', '', 1, 1)
    stopper.action = { type: 'sound-stop', scope: 'all' }
    const source = project('1.21.4', [
      marker('one', 'one', 'block.note_block.harp', 1, 1),
      marker('unknown', 'one', 'custom:laser', 1, 1),
      marker('locked', 'locked', 'block.note_block.bass', 1, 1),
      stopper,
    ], tracks)
    const excluded = exportNoteBlockBuild(source)
    expect(excluded.noteBlockCount).toBe(1)
    expect(excluded.warnings.join(' ')).toMatch(/locked tracks were excluded/)
    expect(excluded.warnings.join(' ')).toMatch(/unknown note-block sound "custom:laser"/)
    expect(excluded.warnings.join(' ')).toMatch(/Sound Stopper marker.*cannot be represented/)
    expect(excluded.warnings.join(' ')).not.toMatch(/unknown note-block sound ""/)
    const included = exportNoteBlockBuild(source, { includeLockedTracks: true })
    expect(included.noteBlockCount).toBe(2)
    expect(included.dimensions.z).toBe(3)
  })

  it('wraps absolute timeline ticks into a deterministic schematic grid', () => {
    const source = project('1.21.4', [
      marker('first', 'track', 'block.note_block.harp', 1, 0),
      marker('wrapped', 'track', 'block.note_block.harp', 1, 5),
    ])
    const exported = exportNoteBlockBuild(source, {
      layout: 'schematic-grid',
      notesPerRow: 5,
    })
    expect(exported.dimensions).toEqual({ x: 5, y: 2, z: 4 })
    expect(exported.warnings.join(' ')).toMatch(/does not synthesize redstone timing circuitry/)
  })

  it('builds a deterministic OpenNBS-style playable circuit without changing display defaults', () => {
    const source = project('1.21.4', [marker('first', 'track', 'block.note_block.harp', 1, 0)])
    const display = exportNoteBlockBuild(source, { notesPerRow: 5 })
    expect(display.circuit).toBe('display')
    expect(display.timing).toBeUndefined()
    expect(display.dimensions).toEqual({ x: 1, y: 2, z: 1 })

    const first = exportNoteBlockBuild(source, {
      circuit: 'playable-redstone',
      notesPerRow: 5,
    })
    const second = exportNoteBlockBuild(source, {
      circuit: 'playable-redstone',
      notesPerRow: 5,
    })
    expect(first.data).toEqual(second.data)
    expect(first.circuit).toBe('playable-redstone')
    expect(first.timing).toEqual({
      quantumTicks: 2,
      startLatencyTicks: 2,
      delayNodeCount: 1,
      quantizedNoteCount: 0,
      collapsedRetriggerCount: 0,
      trackSlotCount: 1,
    })
    expect(first.dimensions).toEqual({ x: 13, y: 7, z: 5 })
    expect(first.blockCount).toBe(13 * 7 * 5)
    expect(first.noteBlockCount).toBe(1)
    expect(first.warnings.join(' ')).toMatch(/two-game-tick timing grid/)

    const root = readExport(first.data).value
    expect(root.size).toEqual([13, 7, 5])
    expect(list(root.blocks)).toHaveLength(13 * 7 * 5)
    expect(modernStateAt(root, [9, 1, 2])).toMatchObject({
      Name: 'minecraft:note_block',
      Properties: { instrument: 'harp', note: '12', powered: 'false' },
    })
    expect(modernStateAt(root, [9, 0, 2])).toMatchObject({ Name: 'minecraft:dirt' })
    expect(modernStateAt(root, [9, 2, 2])).toMatchObject({ Name: 'minecraft:air' })
    expect(modernStateAt(root, [11, 2, 3])).toMatchObject({
      Name: 'minecraft:repeater',
      Properties: { delay: '1', facing: 'east', locked: 'false', powered: 'false' },
    })
    expect(modernBlockRecords(root).some(block => block.state.Name === 'minecraft:stone_button')).toBe(true)
  })

  it('matches the source-derived repeater delay decomposition and reverses at row turns', () => {
    const timing = exportNoteBlockBuild(project('1.21.4', [
      marker('zero', 'track', 'block.note_block.harp', 1, 0),
      marker('two', 'track', 'block.note_block.harp', 1, 2),
      marker('ten', 'track', 'block.note_block.harp', 1, 10),
      marker('twelve', 'track', 'block.note_block.harp', 1, 12),
    ]), { circuit: 'playable-redstone', notesPerRow: 5 })
    expect(timing.timing?.delayNodeCount).toBe(4)
    const timingRoot = readExport(timing.data).value
    expect([11, 9, 7, 5].map(x => (
      compound(modernStateAt(timingRoot, [x, 2, 3])!.Properties).delay
    ))).toEqual(['1', '1', '4', '1'])

    const sparse = exportNoteBlockBuild(project('1.21.4', [
      marker('late', 'track', 'block.note_block.harp', 1, 20),
    ]), { circuit: 'playable-redstone', notesPerRow: 5 })
    const sparseRoot = readExport(sparse.data).value
    expect([11, 9, 7].map(x => (
      compound(modernStateAt(sparseRoot, [x, 2, 3])!.Properties).delay
    ))).toEqual(['4', '4', '3'])

    const turningMarkers = Array.from({ length: 6 }, (_, index) => (
      marker(`turn-${index}`, 'track', 'block.note_block.harp', 1, index * 2)
    ))
    const turning = exportNoteBlockBuild(project('1.21.4', turningMarkers), {
      circuit: 'playable-redstone', notesPerRow: 5,
    })
    const turningRoot = readExport(turning.data).value
    expect(turning.dimensions).toEqual({ x: 13, y: 7, z: 8 })
    expect(modernStateAt(turningRoot, [1, 2, 6])).toMatchObject({
      Name: 'minecraft:repeater',
      Properties: { delay: '1', facing: 'west' },
    })
  })

  it('preserves the quantized onset as the sum of every main-line repeater delay', () => {
    for (let tick = 0; tick <= 64; tick++) {
      const exported = exportNoteBlockBuild(project('1.21.4', [
        marker(`tick-${tick}`, 'track', 'block.note_block.harp', 1, tick),
      ]), { circuit: 'playable-redstone', notesPerRow: 5 })
      const root = readExport(exported.data).value
      const mainRepeaters = modernBlockRecords(root).filter(block => (
        block.pos[1] === 2
        && (block.pos[2] as number) >= 3
        && block.state.Name === 'minecraft:repeater'
      ))
      const delays = mainRepeaters.map(block => Number(compound(block.state.Properties).delay))
      expect(delays.every(delay => Number.isInteger(delay) && delay >= 1 && delay <= 4)).toBe(true)
      expect(delays).toHaveLength(exported.timing!.delayNodeCount)
      expect(delays.reduce((total, delay) => total + delay, 0)).toBe(Math.round(tick / 2) + 1)
    }
  })

  it('allocates four fixed slots per vertical layer and collapses only same-marker retriggers', () => {
    const chord = Array.from({ length: 5 }, (_, index) => (
      marker(`voice-${index}`, 'track', 'block.note_block.harp', 1, 0)
    ))
    const polyphonic = exportNoteBlockBuild(project('1.21.4', chord), {
      circuit: 'playable-redstone', notesPerRow: 5,
    })
    expect(polyphonic.noteBlockCount).toBe(5)
    expect(polyphonic.timing?.trackSlotCount).toBe(5)
    expect(polyphonic.dimensions).toEqual({ x: 13, y: 10, z: 5 })

    const retrigger = marker('repeat', 'track', 'block.note_block.harp', 1, 1)
    retrigger.duration = 2
    retrigger.retriggerInterval = 1
    const quantized = exportNoteBlockBuild(project('1.21.4', [retrigger]), {
      circuit: 'playable-redstone', notesPerRow: 5,
    })
    expect(quantized.noteBlockCount).toBe(2)
    expect(quantized.timing).toMatchObject({
      quantizedNoteCount: 2,
      collapsedRetriggerCount: 1,
      delayNodeCount: 2,
    })
    expect(quantized.warnings.join(' ')).toMatch(/quantized to the two-tick/)
    expect(quantized.warnings.join(' ')).toMatch(/retrigger firing.*collapsed/)
  })

  it('rejects unsafe playable targets and reports loop and stopper omissions', () => {
    const source = project('1.21.4', [marker('note', 'track', 'block.note_block.harp', 1, 0)])
    expect(() => exportNoteBlockBuild(source, {
      circuit: 'playable-redstone',
      format: 'schematic-1.11-1.12',
    })).toThrow(/modern Structure/)
    expect(() => exportNoteBlockBuild(source, {
      circuit: 'playable-redstone',
      layout: 'schematic-grid',
    })).toThrow(/fixed-tracks/)
    expect(() => exportNoteBlockBuild(source, {
      circuit: 'playable-redstone',
      format: 'structure-block-nbt',
      notesPerRow: 15,
    })).toThrow(/32x32x32/)
    expect(exportNoteBlockBuild(source, {
      circuit: 'playable-redstone',
      format: 'structure-block-nbt',
      notesPerRow: 14,
    }).dimensions.x).toBe(31)

    const narrowTracks = Array.from({ length: 21 }, (_, index) => track(`narrow-${index}`))
    const narrow = project('1.21.4', [
      marker('narrow-note', narrowTracks[20].id, 'block.note_block.harp', 1, 0),
    ], narrowTracks)
    expect(() => exportNoteBlockBuild(narrow, {
      circuit: 'playable-redstone', notesPerRow: 5,
    })).toThrow(/Increase delay nodes per row/)

    const tallTracks = Array.from({ length: 37 }, (_, index) => track(`tall-${index}`))
    const tall = project('1.21.4', [
      marker('tall-note', tallTracks[36].id, 'block.note_block.harp', 1, 0),
    ], tallTracks)
    expect(() => exportNoteBlockBuild(tall, {
      circuit: 'playable-redstone', format: 'structure-block-nbt', notesPerRow: 14,
    })).toThrow(/32x32x32/)

    const looped = project('1.21.4', [marker('note', 'track', 'block.note_block.harp', 1, 0)])
    looped.settings.loop = { enabled: true, startTick: 0, endTick: 20 }
    const stopper = marker('stop', 'track', '', 1, 2)
    stopper.action = { type: 'sound-stop', scope: 'all' }
    looped.markers.push(stopper)
    const exported = exportNoteBlockBuild(looped, {
      circuit: 'playable-redstone', notesPerRow: 5,
    })
    expect(exported.warnings.join(' ')).toMatch(/Sound Stopper marker.*omitted/)
    expect(exported.warnings.join(' ')).toMatch(/loop is not synthesized/)
  })

  it('preserves modern block-state details and warns for unrepresentable marker controls', () => {
    const controlled = marker('controlled', 'track', 'block.note_block.xylophone', 1, 0)
    controlled.variantIndex = 0
    controlled.volumeCurve = {
      keyframes: [{ tick: 0, value: 0.5, interpolation: 'linear' }],
    }
    const exported = exportNoteBlockBuild(project('1.21.4', [controlled]))
    const palette = list(readExport(exported.data).value.palette).map(compound)
    expect(palette.find(state => state.Name === 'minecraft:bone_block')).toMatchObject({
      Properties: { axis: 'y' },
    })
    expect(exported.warnings.join(' ')).toMatch(/volume automation/)
    expect(exported.warnings.join(' ')).toMatch(/pin a sound variant/)
  })

  it('enforces target gates and strict expansion/dimension budgets', () => {
    expect(validateNoteBlockBuildTarget('structure-block-nbt', '1.12.2')).toMatch(/incompatible/)
    expect(validateNoteBlockBuildTarget('schematic-1.11-1.12', '1.21.4')).toMatch(/incompatible/)
    expect(defaultNoteBlockBuildFormat('1.10.2')).toBe('schematic-pre-1.11')
    expect(defaultNoteBlockBuildFormat('1.12.2')).toBe('schematic-1.11-1.12')
    expect(defaultNoteBlockBuildFormat('1.21.4')).toBe('litematica-compatible-nbt')
    const durationBomb = marker('bomb', 'track', 'block.note_block.harp')
    durationBomb.duration = 100_001
    expect(() => exportNoteBlockBuild(project('1.21.4', [durationBomb]))).toThrow(/Expanded note count/)
    expect(NOTE_BLOCK_BUILD_LIMITS.maxHorizontalDimension).toBe(1_999)
    expect(NOTE_BLOCK_BUILD_LIMITS.maxHeight).toBe(255)
    expect(exportNoteBlockBuild(
      project('1.21.4', [marker('edge', 'track', 'block.note_block.harp', 1, 1_998)]),
    ).dimensions.x).toBe(1_999)
    expect(() => exportNoteBlockBuild(
      project('1.21.4', [marker('far', 'track', 'block.note_block.harp', 1, 1_999)]),
    )).toThrow(/dimensions/)
    expect(() => exportNoteBlockBuild(
      project('1.21.4', [marker('bad', 'missing', 'block.note_block.harp')]),
    )).toThrow(/unknown track/)
  })

  it('uses the exact Minecraft snapshot boundaries for formats and instruments', () => {
    const noteCount = (
      targetVersion: string,
      format: NoteBlockBuildFormat,
      soundId: string,
    ) => exportNoteBlockBuild(project(targetVersion, [
      marker('harp', 'track', 'block.note_block.harp', 1, 0),
      marker('boundary', 'track', soundId, 1, 1),
    ]), { format }).noteBlockCount

    expect(noteCount('17w16b', 'schematic-1.11-1.12', 'block.note_block.guitar')).toBe(1)
    expect(noteCount('17w17a', 'schematic-1.11-1.12', 'block.note_block.guitar')).toBe(2)
    expect(defaultNoteBlockBuildFormat('17w42a')).toBe('schematic-1.11-1.12')
    expect(defaultNoteBlockBuildFormat('17w43a')).toBe('litematica-compatible-nbt')
    expect(noteCount('18w42a', 'litematica-compatible-nbt', 'block.note_block.iron_xylophone')).toBe(1)
    expect(noteCount('18w43a', 'litematica-compatible-nbt', 'block.note_block.iron_xylophone')).toBe(2)
    expect(noteCount('26.1-snapshot-6', 'litematica-compatible-nbt', 'block.note_block.trumpet')).toBe(1)
    expect(noteCount('26.1-snapshot-7', 'litematica-compatible-nbt', 'block.note_block.trumpet')).toBe(2)
  })
})
