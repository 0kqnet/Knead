export interface OverviewRange {
  startTick: number
  endTick: number
}

export function clampOverviewTick(tick: number, lengthTicks: number): number {
  if (!Number.isFinite(tick)) return 0
  return Math.max(0, Math.min(Math.max(1, lengthTicks), tick))
}

export function overviewXToTick(x: number, width: number, lengthTicks: number): number {
  if (!Number.isFinite(width) || width <= 0) return 0
  return clampOverviewTick((Math.max(0, Math.min(width, x)) / width) * lengthTicks, lengthTicks)
}

export function timelineViewportRange(
  scrollLeft: number,
  clientWidth: number,
  pxPerTick: number,
  headerWidth: number,
  leadingPadding: number,
  lengthTicks: number,
): OverviewRange {
  const usableWidth = Math.max(0, clientWidth - headerWidth)
  const timelineScroll = scrollLeft - leadingPadding
  const scale = Math.max(0.001, pxPerTick)
  const startTick = clampOverviewTick(timelineScroll / scale, lengthTicks)
  const endTick = clampOverviewTick((timelineScroll + usableWidth) / scale, lengthTicks)
  return { startTick, endTick: Math.max(startTick, endTick) }
}
