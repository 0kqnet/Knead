import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MASTER,
  DEFAULT_SETTINGS,
  createDefaultTrack,
  type Marker,
  type TimelineState,
} from '../types/timeline'
import {
  DEFAULT_COMMAND_EXPORT_OPTIONS,
  generateCommandDatapack,
  inferPackFormat,
} from './commandExport'
import {
  verifyCommandDatapack,
  verifyNoteBlockBuild,
  type AcceptedBuildFormat,
  type AcceptedClockMode,
} from './minecraftAcceptance'
import { exportNoteBlockBuild } from './noteBlockBuild'

function marker(
  id: string,
  soundId = 'block.note_block.harp',
  tick = 2,
  pitch = 1,
): Marker {
  return {
    id,
    trackId: 'track',
    tick,
    soundId,
    variantIndex: -1,
    volume: 0.8,
    pitch,
    pan: 0,
  }
}

function project(targetVersion: string, markers: Marker[] = [marker('note')]): TimelineState {
  return {
    projectId: 'minecraft-acceptance',
    randomSeed: 0x1234,
    targetVersion,
    lengthTicks: 40,
    settings: structuredClone(DEFAULT_SETTINGS),
    master: { ...DEFAULT_MASTER, limiterEnabled: false },
    tracks: [createDefaultTrack('track')],
    markers,
    referenceAudio: [],
    customAudio: [],
  }
}

function dataPack(targetVersion: string) {
  const source = project(targetVersion)
  return generateCommandDatapack(source, {
    ...DEFAULT_COMMAND_EXPORT_OPTIONS,
    namespace: 'acceptance_show',
    packFormat: inferPackFormat(targetVersion),
  })
}

describe('independent Minecraft data-pack acceptance harness', () => {
  it.each([
    ['1.13.2', 'plural', 'tick-tag'],
    ['1.14.4', 'plural', 'schedule-basic'],
    ['1.15.2', 'plural', 'schedule-clear-replace'],
    ['1.19.2', 'plural', 'schedule-clear-replace'],
    ['1.20.6', 'plural', 'schedule-clear-replace'],
    ['1.21.4', 'singular', 'schedule-clear-replace'],
    ['1.21.11', 'singular', 'schedule-clear-replace'],
    ['26.1', 'singular', 'schedule-clear-replace'],
    ['26.2', 'singular', 'schedule-clear-replace'],
  ] satisfies [string, 'plural' | 'singular', AcceptedClockMode][]) (
    'cross-reads a representative Java %s data pack (%s, %s)',
    (targetVersion, layout, clockMode) => {
      const generated = dataPack(targetVersion)
      const accepted = verifyCommandDatapack(generated.files, {
        targetVersion,
        namespace: 'acceptance_show',
      })
      expect(accepted).toMatchObject({
        layout,
        clockMode,
        eventCommandCount: generated.eventCount,
      })
      expect(accepted.functionCount).toBeGreaterThanOrEqual(11)
      expect(accepted.functionReferenceCount).toBeGreaterThan(5)
      expect(accepted.reachableFunctionCount).toBeGreaterThanOrEqual(accepted.functionCount - 1)
    },
  )

  it.each([
    ['18w42a', 'plural', 'tick-tag'],
    ['18w43a', 'plural', 'schedule-basic'],
    ['19w37a', 'plural', 'schedule-basic'],
    ['19w38b', 'plural', 'schedule-clear-replace'],
    ['24w20a', 'plural', 'schedule-clear-replace'],
    ['24w21a', 'singular', 'schedule-clear-replace'],
    ['26.3-snapshot-6', 'singular', 'schedule-clear-replace'],
  ] satisfies [string, 'plural' | 'singular', AcceptedClockMode][]) (
    'honors the official snapshot boundary at %s',
    (targetVersion, layout, clockMode) => {
      const generated = dataPack(targetVersion)
      expect(verifyCommandDatapack(generated.files, {
        targetVersion,
        namespace: 'acceptance_show',
      })).toMatchObject({ layout, clockMode })
    },
  )

  it('proves the 1.13 tick tag is guarded, idempotent, and schedule-free', () => {
    const generated = dataPack('1.13.2')
    const output = Object.values(generated.files).join('\n')
    expect(generated.files['data/minecraft/tags/functions/tick.json']).toContain(
      'acceptance_show:runtime/tick_driver',
    )
    expect(generated.files['data/acceptance_show/functions/install.mcfunction']).toContain(
      'execute unless entity',
    )
    expect(generated.files['data/acceptance_show/functions/uninstall.mcfunction']).toContain(
      'scoreboard objectives remove',
    )
    expect(output).not.toMatch(/\bschedule\b/u)
  })

  it('proves 1.14 uses one replace-by-ID chain and deferred uninstall cleanup', () => {
    const generated = dataPack('1.14.4')
    const output = Object.values(generated.files).join('\n')
    const install = generated.files['data/acceptance_show/functions/install.mcfunction']
    const uninstall = generated.files['data/acceptance_show/functions/uninstall.mcfunction']
    const tick = generated.files['data/acceptance_show/functions/runtime/tick.mcfunction']
    expect(output).toContain('schedule function acceptance_show:runtime/tick 1t')
    expect(output).not.toMatch(/schedule clear|schedule function[^\n]+\s(?:append|replace)(?:\n|$)/u)
    expect(uninstall).toMatch(/scoreboard players set #state \S+ 3/u)
    expect(tick).toMatch(/matches 3 run scoreboard objectives remove/u)
    expect(install).toMatch(/matches 3 run scoreboard players set #state \S+ 0/u)
  })

  it('rejects unresolved references, wrong layouts, invalid reports, and newer schedule syntax', () => {
    const modern = dataPack('1.21.4')
    const missing = { ...modern.files }
    delete missing['data/acceptance_show/function/events/tick_2.mcfunction']
    expect(() => verifyCommandDatapack(missing, {
      targetVersion: '1.21.4',
      namespace: 'acceptance_show',
    })).toThrow(/references missing function/u)

    const wrongLayout = { ...modern.files }
    const start = wrongLayout['data/acceptance_show/function/start.mcfunction']
    delete wrongLayout['data/acceptance_show/function/start.mcfunction']
    wrongLayout['data/acceptance_show/functions/start.mcfunction'] = start
    expect(() => verifyCommandDatapack(wrongLayout, {
      targetVersion: '1.21.4',
      namespace: 'acceptance_show',
    })).toThrow(/contains functions/u)

    const badReport = { ...modern.files }
    badReport['knead-export-report.json'] = badReport['knead-export-report.json']
      .replace('"eventCount": 1', '"eventCount": 99')
    expect(() => verifyCommandDatapack(badReport, {
      targetVersion: '1.21.4',
      namespace: 'acceptance_show',
    })).toThrow(/event count 99/u)

    const wrongFormat = { ...modern.files, 'pack.mcmeta': modern.files['pack.mcmeta']
      .replace('"pack_format": 61', '"pack_format": 60') }
    expect(() => verifyCommandDatapack(wrongFormat, {
      targetVersion: '1.21.4',
      namespace: 'acceptance_show',
    })).toThrow(/does not match 1\.21\.4/u)

    const basic = dataPack('1.14.4')
    const badSchedule = { ...basic.files }
    badSchedule['data/acceptance_show/functions/start.mcfunction'] = badSchedule[
      'data/acceptance_show/functions/start.mcfunction'
    ].replace('runtime/tick 1t', 'runtime/tick 1t replace')
    expect(() => verifyCommandDatapack(badSchedule, {
      targetVersion: '1.14.4',
      namespace: 'acceptance_show',
    })).toThrow(/Java 1\.15 schedule syntax/u)
  })

  it('refuses targets that predate Java data packs', () => {
    const generated = dataPack('1.12.2')
    expect(() => verifyCommandDatapack(generated.files, {
      targetVersion: '1.12.2',
      namespace: 'acceptance_show',
    })).toThrow(/predates Java data packs/u)
  })
})

describe('independent Minecraft NBT acceptance harness', () => {
  it.each([
    ['structure-block-nbt', '1.21.4'],
    ['litematica-compatible-nbt', '1.21.4'],
    ['schematic-1.11-1.12', '1.12.2'],
    ['schematic-pre-1.11', '1.10.2'],
  ] satisfies [AcceptedBuildFormat, string][]) (
    'gunzips and cross-reads %s without using Knead NBT helpers',
    (format, targetVersion) => {
      const source = project(targetVersion, [
        marker('harp', 'block.note_block.harp', 0, 1),
        marker('bass', 'block.note_block.bass', 2, 0.5),
      ])
      const generated = exportNoteBlockBuild(source, { format })
      const accepted = verifyNoteBlockBuild(generated.data, {
        format,
        expectedDimensions: generated.dimensions,
      })
      expect(accepted).toMatchObject({
        format,
        dimensions: generated.dimensions,
        noteBlockCount: generated.noteBlockCount,
      })
      expect(accepted.blockCount).toBe(generated.blockCount)
      expect(accepted.decodedBytes).toBeGreaterThan(32)
    },
  )

  it('rejects a Structure NBT whose serialized block lies outside its capped size header', () => {
    const generated = exportNoteBlockBuild(
      project('1.21.4', [marker('late', 'block.note_block.harp', 40)]),
      { format: 'structure-block-nbt' },
    )
    expect(generated.dimensions.x).toBe(41)
    expect(() => verifyNoteBlockBuild(generated.data, {
      format: 'structure-block-nbt',
    })).toThrow(/outside the declared size/u)
  })

  it('rejects a corrupt GZIP checksum before trusting NBT contents', () => {
    const generated = exportNoteBlockBuild(project('1.21.4'), {
      format: 'litematica-compatible-nbt',
    })
    const corrupt = generated.data.slice()
    corrupt[corrupt.length - 1] ^= 0xff
    expect(() => verifyNoteBlockBuild(corrupt, {
      format: 'litematica-compatible-nbt',
    })).toThrow(/GZIP payload or checksum is invalid/u)
  })
})
