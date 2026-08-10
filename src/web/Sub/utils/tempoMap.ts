import {
  DEFAULT_SETTINGS,
  MAX_TEMPO_MAP_EVENTS,
  type TempoMapEvent,
  type TimelineMeter,
  type TimelineSettings,
} from '../types/timeline'

export const TIMELINE_TICKS_PER_SECOND = 20
export const MIN_TEMPO_BPM = 20
export const MAX_TEMPO_BPM = 300

export type TempoMapFallback = Pick<TimelineSettings, 'bpm' | 'timeSignature'>

export interface TempoMapValidationOptions {
  maxTick?: number
  requireTickZero?: boolean
  requireSortedUnique?: boolean
}

export interface ResolvedTempoMapSegment {
  tick: number
  bpm: number
  meter: TimelineMeter
  /** Integrated metrical beats at this segment boundary. */
  startBeat: number
  /** Integrated measures at this segment boundary. */
  startBar: number
}

export interface TempoMapModel {
  events: readonly TempoMapEvent[]
  segments: readonly ResolvedTempoMapSegment[]
}

export interface MusicalPosition {
  /** One-based bar number. */
  bar: number
  /** One-based beat number within the displayed bar. */
  beat: number
  /** Fractional progress through the current beat. */
  beatFraction: number
  bpm: number
  meter: TimelineMeter
}

export interface TempoGridLine extends MusicalPosition {
  tick: number
  major: boolean
}

const DENOMINATORS = [2, 4, 8, 16] as const
const EPSILON = 1e-8

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sameMeter(left: TimelineMeter, right: TimelineMeter): boolean {
  return left.numerator === right.numerator && left.denominator === right.denominator
}

function cloneMeter(meter: TimelineMeter): TimelineMeter {
  return { numerator: meter.numerator, denominator: meter.denominator }
}

function validateFallback(fallback: TempoMapFallback): string | null {
  if (!Number.isFinite(fallback.bpm) || fallback.bpm < MIN_TEMPO_BPM || fallback.bpm > MAX_TEMPO_BPM) {
    return `Fallback BPM must be between ${MIN_TEMPO_BPM} and ${MAX_TEMPO_BPM}`
  }
  if (!Number.isInteger(fallback.timeSignature.numerator)
    || fallback.timeSignature.numerator < 1
    || fallback.timeSignature.numerator > 16) {
    return 'Fallback meter numerator must be between 1 and 16'
  }
  if (!DENOMINATORS.includes(fallback.timeSignature.denominator)) {
    return 'Fallback meter denominator must be 2, 4, 8, or 16'
  }
  return null
}

/** Strict validation for untrusted .kp data and dialog drafts. */
export function validateTempoMap(
  value: unknown,
  fallback: TempoMapFallback = DEFAULT_SETTINGS,
  options: TempoMapValidationOptions = {},
): string | null {
  const fallbackError = validateFallback(fallback)
  if (fallbackError) return fallbackError
  if (!Array.isArray(value)) return 'Tempo map must be an array'
  if (value.length > MAX_TEMPO_MAP_EVENTS) {
    return `Tempo map exceeds ${MAX_TEMPO_MAP_EVENTS} events`
  }
  const maxTick = options.maxTick ?? Number.MAX_SAFE_INTEGER
  let previousTick = -1
  const ticks = new Set<number>()
  for (let index = 0; index < value.length; index++) {
    const event = value[index]
    if (!isRecord(event)) return `Tempo event ${index + 1} must be an object`
    const rawTick = event.tick
    if (!Number.isInteger(rawTick) || (rawTick as number) < 0 || (rawTick as number) > maxTick) {
      return `Tempo event ${index + 1} tick must be an integer between 0 and ${maxTick}`
    }
    if (!Number.isFinite(event.bpm) || (event.bpm as number) < MIN_TEMPO_BPM
      || (event.bpm as number) > MAX_TEMPO_BPM) {
      return `Tempo event ${index + 1} BPM must be between ${MIN_TEMPO_BPM} and ${MAX_TEMPO_BPM}`
    }
    if (event.meter !== undefined) {
      const numerator = isRecord(event.meter) ? event.meter.numerator : undefined
      if (!isRecord(event.meter)
        || !Number.isInteger(numerator)
        || (numerator as number) < 1
        || (numerator as number) > 16) {
        return `Tempo event ${index + 1} meter numerator must be between 1 and 16`
      }
      if (!DENOMINATORS.includes(event.meter.denominator as typeof DENOMINATORS[number])) {
        return `Tempo event ${index + 1} meter denominator must be 2, 4, 8, or 16`
      }
    }
    const tick = event.tick as number
    if (options.requireSortedUnique && tick <= previousTick) {
      return tick === previousTick
        ? `Tempo map contains more than one event at tick ${tick}`
        : 'Tempo map events must be sorted by tick'
    }
    if (!options.requireSortedUnique && ticks.has(tick)) {
      // Duplicate ticks are intentionally accepted by normalizeTempoMap, where the last wins.
    }
    ticks.add(tick)
    previousTick = tick
  }
  if (options.requireTickZero && (!value.length || (value[0] as Record<string, unknown>).tick !== 0)) {
    return 'Tempo map must begin at tick 0'
  }
  return null
}

/**
 * Canonicalizes editor/import data: sort by tick, use the last duplicate, add
 * tick zero, make its meter explicit, and omit later no-op meter repetitions.
 */
export function normalizeTempoMap(
  events: readonly TempoMapEvent[] | undefined,
  fallback: TempoMapFallback = DEFAULT_SETTINGS,
  maxTick = Number.MAX_SAFE_INTEGER,
): TempoMapEvent[] {
  const error = validateTempoMap(events ?? [], fallback, { maxTick })
  if (error) throw new Error(error)
  const byTick = new Map<number, TempoMapEvent>()
  for (const event of events ?? []) {
    byTick.set(event.tick, {
      tick: event.tick,
      bpm: event.bpm,
      ...(event.meter === undefined ? {} : { meter: cloneMeter(event.meter) }),
    })
  }
  if (!byTick.has(0)) {
    byTick.set(0, {
      tick: 0,
      bpm: fallback.bpm,
      meter: cloneMeter(fallback.timeSignature),
    })
  }
  if (byTick.size > MAX_TEMPO_MAP_EVENTS) {
    throw new Error(`Tempo map exceeds ${MAX_TEMPO_MAP_EVENTS} events after adding tick zero`)
  }
  const sorted = [...byTick.values()].sort((left, right) => left.tick - right.tick)
  let inheritedMeter = cloneMeter(fallback.timeSignature)
  return sorted.map((event, index) => {
    const nextMeter = event.meter ? cloneMeter(event.meter) : inheritedMeter
    const includeMeter = index === 0 || !sameMeter(nextMeter, inheritedMeter)
    inheritedMeter = nextMeter
    return {
      tick: event.tick,
      bpm: event.bpm,
      ...(includeMeter ? { meter: cloneMeter(nextMeter) } : {}),
    }
  })
}

function ticksPerBeatValues(bpm: number, meter: TimelineMeter): number {
  return (TIMELINE_TICKS_PER_SECOND * 60 / bpm) * (4 / meter.denominator)
}

function nextMusicalBoundary(value: number): number {
  const nearest = Math.round(value)
  return Math.abs(value - nearest) <= EPSILON ? nearest : Math.ceil(value)
}

/** Precomputes the piecewise integrals used by all ruler/metronome conversions. */
export function buildTempoMap(
  events: readonly TempoMapEvent[] | undefined,
  fallback: TempoMapFallback = DEFAULT_SETTINGS,
  maxTick = Number.MAX_SAFE_INTEGER,
): TempoMapModel {
  const normalized = normalizeTempoMap(events, fallback, maxTick)
  const segments: ResolvedTempoMapSegment[] = []
  let bpm = fallback.bpm
  let meter = cloneMeter(fallback.timeSignature)
  let previousTick = 0
  let startBeat = 0
  let startBar = 0
  for (const event of normalized) {
    const elapsed = event.tick - previousTick
    const beatTicks = ticksPerBeatValues(bpm, meter)
    startBeat += elapsed / beatTicks
    startBar += elapsed / (beatTicks * meter.numerator)
    const nextMeter = event.meter ? cloneMeter(event.meter) : meter
    if (event.tick > 0 && !sameMeter(nextMeter, meter)) {
      // A meter change begins a new measure, like a DAW conductor track. Any
      // partial old measure is closed at the event tick; tempo-only changes stay continuous.
      startBeat = nextMusicalBoundary(startBeat)
      startBar = nextMusicalBoundary(startBar)
    }
    bpm = event.bpm
    meter = nextMeter
    segments.push({
      tick: event.tick,
      bpm,
      meter: cloneMeter(meter),
      startBeat,
      startBar,
    })
    previousTick = event.tick
  }
  return { events: normalized, segments }
}

function findTickSegment(model: TempoMapModel, tick: number): ResolvedTempoMapSegment {
  let low = 0
  let high = model.segments.length - 1
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (model.segments[middle].tick <= tick) low = middle
    else high = middle - 1
  }
  return model.segments[low]
}

function findAxisSegment(
  model: TempoMapModel,
  value: number,
  axis: 'startBeat' | 'startBar',
): ResolvedTempoMapSegment {
  let low = 0
  let high = model.segments.length - 1
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (model.segments[middle][axis] <= value) low = middle
    else high = middle - 1
  }
  return model.segments[low]
}

function nonNegativeFinite(value: number, name: string): number {
  if (!Number.isFinite(value)) throw new Error(`${name} must be finite`)
  return Math.max(0, value)
}

export function tempoAtTick(tick: number, model: TempoMapModel): Pick<ResolvedTempoMapSegment, 'bpm' | 'meter'> {
  const segment = findTickSegment(model, nonNegativeFinite(tick, 'Tick'))
  return { bpm: segment.bpm, meter: cloneMeter(segment.meter) }
}

export function tickToSeconds(tick: number): number {
  return nonNegativeFinite(tick, 'Tick') / TIMELINE_TICKS_PER_SECOND
}

export function secondsToTick(seconds: number): number {
  return nonNegativeFinite(seconds, 'Seconds') * TIMELINE_TICKS_PER_SECOND
}

export function tickToMusicalBeat(tick: number, model: TempoMapModel): number {
  const safeTick = nonNegativeFinite(tick, 'Tick')
  const segment = findTickSegment(model, safeTick)
  return segment.startBeat + (safeTick - segment.tick) / ticksPerBeatValues(segment.bpm, segment.meter)
}

export function musicalBeatToTick(beat: number, model: TempoMapModel): number {
  const safeBeat = nonNegativeFinite(beat, 'Beat')
  const segment = findAxisSegment(model, safeBeat, 'startBeat')
  const tick = segment.tick + (safeBeat - segment.startBeat) * ticksPerBeatValues(segment.bpm, segment.meter)
  const index = model.segments.indexOf(segment)
  const next = model.segments[index + 1]
  return next ? Math.min(next.tick, tick) : tick
}

export function tickToMusicalBar(tick: number, model: TempoMapModel): number {
  const safeTick = nonNegativeFinite(tick, 'Tick')
  const segment = findTickSegment(model, safeTick)
  return segment.startBar
    + (safeTick - segment.tick) / (ticksPerBeatValues(segment.bpm, segment.meter) * segment.meter.numerator)
}

export function musicalBarToTick(bar: number, model: TempoMapModel): number {
  const safeBar = nonNegativeFinite(bar, 'Bar')
  const segment = findAxisSegment(model, safeBar, 'startBar')
  const tick = segment.tick
    + (safeBar - segment.startBar) * ticksPerBeatValues(segment.bpm, segment.meter) * segment.meter.numerator
  const index = model.segments.indexOf(segment)
  const next = model.segments[index + 1]
  return next ? Math.min(next.tick, tick) : tick
}

export function tickToMusicalPosition(tick: number, model: TempoMapModel): MusicalPosition {
  const safeTick = nonNegativeFinite(tick, 'Tick')
  const tempo = tempoAtTick(safeTick, model)
  const barValue = tickToMusicalBar(safeTick, model)
  const zeroBasedBar = Math.max(0, Math.floor(barValue + EPSILON))
  const barStartTick = musicalBarToTick(zeroBasedBar, model)
  const beatValue = Math.max(0, tickToMusicalBeat(safeTick, model) - tickToMusicalBeat(barStartTick, model))
  const zeroBasedBeat = Math.max(0, Math.floor(beatValue + EPSILON))
  return {
    bar: zeroBasedBar + 1,
    beat: Math.min(tempo.meter.numerator, zeroBasedBeat + 1),
    beatFraction: Math.max(0, beatValue - zeroBasedBeat),
    bpm: tempo.bpm,
    meter: tempo.meter,
  }
}

/** Returns bounded beat/bar grid lines, even for multi-hour projects at high BPM. */
export function enumerateTempoGridLines(
  startTick: number,
  endTick: number,
  model: TempoMapModel,
  maxLines = 10_000,
): TempoGridLine[] {
  const start = nonNegativeFinite(Math.min(startTick, endTick), 'Start tick')
  const end = nonNegativeFinite(Math.max(startTick, endTick), 'End tick')
  const limit = Math.max(2, Math.trunc(maxLines))
  const firstBeat = Math.ceil(tickToMusicalBeat(start, model) - EPSILON)
  const finalBeat = Math.floor(tickToMusicalBeat(end, model) + EPSILON)
  const firstBar = Math.ceil(tickToMusicalBar(start, model) - EPSILON)
  const finalBar = Math.floor(tickToMusicalBar(end, model) + EPSILON)
  const beatCount = Math.max(0, finalBeat - firstBeat + 1)
  const barCount = Math.max(0, finalBar - firstBar + 1)
  const beatBudget = Math.max(1, Math.floor(limit * 0.75))
  const barBudget = Math.max(1, limit - beatBudget)
  const beatStride = Math.max(1, Math.ceil(beatCount / beatBudget))
  const barStride = Math.max(1, Math.ceil(barCount / barBudget))
  const lines = new Map<number, TempoGridLine>()
  const add = (tick: number, major: boolean) => {
    if (tick < start - EPSILON || tick > end + EPSILON) return
    const key = Math.round(tick * 1_000_000)
    const previous = lines.get(key)
    const position = tickToMusicalPosition(tick, model)
    lines.set(key, {
      tick,
      ...position,
      major: major || previous?.major === true,
    })
  }
  const beatStart = Math.ceil(firstBeat / beatStride) * beatStride
  for (let beat = beatStart; beat <= finalBeat; beat += beatStride) {
    add(musicalBeatToTick(beat, model), false)
  }
  const barStart = Math.ceil(firstBar / barStride) * barStride
  for (let bar = barStart; bar <= finalBar; bar += barStride) {
    add(musicalBarToTick(bar, model), true)
  }
  return [...lines.values()].sort((left, right) => left.tick - right.tick)
}

/** Beat-aware snapping whose physical clock remains the same 20 TPS clock. */
export function snapTickToTempoMap(
  tick: number,
  settings: TimelineSettings,
  model: TempoMapModel,
  bypass = false,
): number {
  const safeTick = nonNegativeFinite(tick, 'Tick')
  if (bypass || settings.snap.mode === 'off') return Math.round(safeTick)
  if (settings.snap.mode === 'tick') {
    return Math.max(0, Math.round(Math.round(safeTick / settings.snap.tickStep) * settings.snap.tickStep))
  }
  const beatStep = 4 / settings.snap.beatDivision
  const beat = tickToMusicalBeat(safeTick, model)
  return Math.max(0, Math.round(musicalBeatToTick(Math.round(beat / beatStep) * beatStep, model)))
}

export function formatMusicalPosition(tick: number, model: TempoMapModel): string {
  const position = tickToMusicalPosition(tick, model)
  return `${position.bar}.${position.beat}`
}
