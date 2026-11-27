import React from 'react'
import { ButtonPropsContext, extendConfig, extendTheme, SelectPropsContext, SliderPropsContext, UIProvider } from '@yamada-ui/react'

const config = extendConfig({ defaultColorMode: 'system' })

const theme = extendTheme({
  styles: {
    globalStyle: { ':host, body': { colorScheme: 'gray' } },
    layerStyles: { solid: { border: '1px solid {colorScheme.muted}' } },
  },
  semanticTokens: {
    colorSchemes: { primary: 'purple' },
    colors: {
      bg: {
        base: 'var(--studio-canvas)', panel: 'var(--studio-panel)', float: 'var(--studio-panel)',
        subtle: 'var(--knead-control-hover)', muted: 'var(--studio-raised)',
      },
      fg: { base: 'var(--studio-text)', muted: 'var(--studio-muted)' },
      border: {
        base: 'var(--knead-control-line)', muted: 'var(--studio-line)',
        emphasized: 'var(--knead-control-line-hover)', error: 'var(--studio-error)',
      },
      gray: {
        solid: 'var(--studio-raised)', contrast: 'var(--studio-text)', outline: 'var(--studio-text)',
        ghost: 'var(--knead-control-hover)', subtle: 'var(--knead-control-bg)',
        muted: 'var(--knead-control-line)', fg: 'var(--studio-text)',
      },
      purple: {
        solid: 'var(--studio-accent)', contrast: '#fff', outline: 'var(--studio-accent-text)',
        ghost: 'var(--studio-accent-soft)', subtle: 'var(--studio-accent-soft)',
        muted: 'var(--knead-accent-line)', fg: 'var(--studio-accent-text)',
      },
    },
  },
})

const buttonDefaults = {
  h: 'min(var(--height), var(--knead-control-height))', lineHeight: 1.3,
  fontSize: 'var(--knead-control-font)', borderRadius: 'var(--knead-control-radius)',
} as const

// Yamada sets the positioner's minimum width to the trigger width. Let that
// determine its actual width, including when a long option needs to wrap.
const selectDefaults = {
  placement: 'end-start', gutter: 4, matchWidth: true,
  contentProps: { minW: 0, positionerProps: { w: 0 } },
} as const

const sliderDefaults = {
  size: 'sm', colorScheme: 'purple', trackFill: 'var(--knead-track)',
  rangeFill: 'var(--knead-slider-accent)', thumbStroke: 'var(--knead-slider-accent)',
  thumbFill: 'var(--studio-panel)', thumbSize: '14px',
} as const

export function KneadUIProvider({ children }: React.PropsWithChildren) {
  return (
    <UIProvider config={config} theme={theme}>
      <ButtonPropsContext value={buttonDefaults}>
        <SelectPropsContext value={selectDefaults}>
          <SliderPropsContext value={sliderDefaults}>{children}</SliderPropsContext>
        </SelectPropsContext>
      </ButtonPropsContext>
    </UIProvider>
  )
}
