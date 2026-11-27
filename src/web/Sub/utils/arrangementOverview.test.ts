import { describe, expect, it } from 'vitest'
import { clampOverviewTick, overviewXToTick, timelineViewportRange } from './arrangementOverview'

describe('arrangement overview math', () => {
  it('maps overview coordinates to project ticks', () => {
    expect(overviewXToTick(250, 1000, 400)).toBe(100)
    expect(overviewXToTick(-20, 1000, 400)).toBe(0)
    expect(overviewXToTick(1200, 1000, 400)).toBe(400)
  })

  it('derives the visible timeline range after the sticky header', () => {
    expect(timelineViewportRange(368, 1248, 8, 248, 20, 400)).toEqual({
      startTick: 43.5,
      endTick: 168.5,
    })
    expect(timelineViewportRange(0, 1248, 8, 248, 20, 400)).toEqual({
      startTick: 0,
      endTick: 122.5,
    })
  })

  it('clamps invalid ticks safely', () => {
    expect(clampOverviewTick(Number.NaN, 200)).toBe(0)
    expect(clampOverviewTick(500, 200)).toBe(200)
  })
})
