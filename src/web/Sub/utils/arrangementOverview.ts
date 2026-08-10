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
  const timelineScroll = Math.max(0, scrollLeft - headerWidth - leadingPadding)
  const startTick = clampOverviewTick(timelineScroll / Math.max(0.001, pxPerTick), lengthTicks)
  const endTick = clampOverviewTick(startTick + usableWidth / Math.max(0.001, pxPerTick), lengthTicks)
  return { startTick, endTick: Math.max(startTick, endTick) }
}
