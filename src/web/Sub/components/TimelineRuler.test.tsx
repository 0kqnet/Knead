// @vitest-environment jsdom

import React from 'react'
import { render, screen } from '@testing-library/react'
import { UIProvider } from '@yamada-ui/react'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '../types/timeline'
import { TimelineRuler } from './TimelineRuler'

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  })
})

describe('TimelineRuler tempo map', () => {
  it('labels a mid-measure meter event as the first beat of a new bar', () => {
    const settings = structuredClone(DEFAULT_SETTINGS)
    settings.timeDisplay = 'bars'
    render(
      <UIProvider>
        <TimelineRuler
          lengthTicks={80}
          pxPerTick={8}
          settings={settings}
          tempoMap={[
            { tick: 0, bpm: 120, meter: { numerator: 4, denominator: 4 } },
            { tick: 25, bpm: 120, meter: { numerator: 3, denominator: 4 } },
          ]}
          onSeek={vi.fn()}
          onLoopChange={vi.fn()}
        />
      </UIProvider>,
    )
    expect(screen.getByText('1.1')).toBeTruthy()
    expect(screen.getByText('2.1')).toBeTruthy()
    expect(screen.getByText('2.2')).toBeTruthy()
  })
})
