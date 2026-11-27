import { isSoundStopMarker, type Marker } from '../types/timeline'

interface MarkerTickIndex {
  entries: { marker: Marker, index: number }[]
  leafCount: number
  maxEndTicks: Float64Array
}

/** Index marker spans so finding visible or playable notes does not scan the song. */
export function createMarkerTickIndex(markers: readonly Marker[]): MarkerTickIndex {
  const entries = markers.map((marker, index) => ({ marker, index }))
    .sort((left, right) => left.marker.tick - right.marker.tick)
  const leafCount = 2 ** Math.ceil(Math.log2(Math.max(1, entries.length)))
  const maxEndTicks = new Float64Array(leafCount * 2)
  for (const [index, { marker }] of entries.entries()) {
    const duration = isSoundStopMarker(marker) ? 0 : Math.max(0, marker.duration ?? 0)
    maxEndTicks[leafCount + index] = marker.tick + duration
  }
  // Each parent stores the furthest end of its descendants, including notes
  // whose heads are before the window but whose tails still cross it.
  for (let node = leafCount - 1; node > 0; node--) {
    maxEndTicks[node] = Math.max(maxEndTicks[node * 2], maxEndTicks[node * 2 + 1])
  }
  return { entries, leafCount, maxEndTicks }
}

export function forEachMarkerInTickRange(
  { entries, leafCount, maxEndTicks }: MarkerTickIndex,
  startTick: number,
  endTick: number,
  visit: (marker: Marker, originalIndex: number) => void,
): void {
  if (endTick < startTick) return
  const walk = (node: number, start: number, size: number): void => {
    const entry = entries[start]
    if (!entry || entry.marker.tick > endTick || maxEndTicks[node] < startTick) return
    if (size === 1) {
      visit(entry.marker, entry.index)
      return
    }
    const half = size / 2
    walk(node * 2, start, half)
    walk(node * 2 + 1, start + half, half)
  }
  walk(1, 0, leafCount)
}
