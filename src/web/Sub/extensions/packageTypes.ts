import type { ExtensionManifest, ExtensionPermission } from './types'

export const DECLARATIVE_EXTENSION_FORMAT = 'knead-extension-package' as const
export const DECLARATIVE_EXTENSION_SCHEMA_VERSION = 1 as const

export const MAX_EXTENSION_PACKAGE_BYTES = 256 * 1024
export const MAX_INSTALLED_EXTENSION_PACKAGES = 32
export const MAX_PACKAGE_CONTRIBUTIONS = 64
export const MAX_DSL_STEPS = 64
export const MAX_DSL_OUTPUT_MARKERS = 25_000

export interface DeclarativeContributionBase {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly requiredPermissions: readonly ExtensionPermission[]
}

export type DeclarativeCommandAction =
  | {
    readonly op: 'notify'
    readonly level: 'info' | 'success' | 'warning' | 'error'
    readonly message: string
  }
  | { readonly op: 'projectSummary' }
  | { readonly op: 'selectionSummary' }

export interface DeclarativeCommandContribution extends DeclarativeContributionBase {
  readonly kind: 'command'
  readonly actions: readonly DeclarativeCommandAction[]
}

export type DeclarativeMarkerOperation =
  | { readonly op: 'shiftTicks', readonly ticks: number }
  | { readonly op: 'quantizeTicks', readonly step: number, readonly strength: number }
  | { readonly op: 'transpose', readonly semitones: number }
  | { readonly op: 'scaleVolume', readonly factor: number }
  | { readonly op: 'setPan', readonly pan: number }
  | { readonly op: 'setLane', readonly lane: number }
  | { readonly op: 'setSound', readonly soundId: string, readonly variantIndex?: number }
  | {
    readonly op: 'duplicate'
    readonly copies: number
    readonly intervalTicks: number
    readonly semitoneStep: number
    readonly volumeDecay: number
  }

export interface DeclarativeMarkerTransformContribution extends DeclarativeContributionBase {
  readonly kind: 'markerTransform'
  readonly steps: readonly DeclarativeMarkerOperation[]
}

export type DeclarativeTrackOperation =
  | { readonly op: 'adjustGainDb', readonly decibels: number }
  | { readonly op: 'setPan', readonly pan: number }
  | { readonly op: 'prefixName', readonly prefix: string }
  | { readonly op: 'setMuted', readonly value: boolean }
  | { readonly op: 'setSolo', readonly value: boolean }
  | { readonly op: 'setLocked', readonly value: boolean }

export interface DeclarativeTrackTransformContribution extends DeclarativeContributionBase {
  readonly kind: 'trackTransform'
  readonly steps: readonly DeclarativeTrackOperation[]
}

export interface DeclarativeExtensionPackage {
  readonly format: typeof DECLARATIVE_EXTENSION_FORMAT
  readonly schemaVersion: typeof DECLARATIVE_EXTENSION_SCHEMA_VERSION
  readonly manifest: ExtensionManifest
  readonly contributes: {
    readonly commands?: readonly DeclarativeCommandContribution[]
    readonly markerTransforms?: readonly DeclarativeMarkerTransformContribution[]
    readonly trackTransforms?: readonly DeclarativeTrackTransformContribution[]
  }
}

export interface DeclarativePackageValidationIssue {
  readonly path: string
  readonly message: string
}

export type DeclarativePackageValidation =
  | { readonly ok: true, readonly package: DeclarativeExtensionPackage }
  | { readonly ok: false, readonly issues: readonly DeclarativePackageValidationIssue[] }

export type DeclarativePackageParseResult =
  | {
    readonly ok: true
    readonly package: DeclarativeExtensionPackage
    readonly byteLength: number
  }
  | {
    readonly ok: false
    readonly issues: readonly DeclarativePackageValidationIssue[]
  }

export interface InstalledDeclarativeExtension {
  readonly package: DeclarativeExtensionPackage
  readonly grantedPermissions: readonly ExtensionPermission[]
  readonly enabled: boolean
}

export interface InstalledExtensionStore {
  readonly format: 'knead-installed-extensions'
  readonly version: 1
  readonly packages: readonly InstalledDeclarativeExtension[]
}

export interface InstalledExtensionStoreLoadResult {
  readonly records: readonly InstalledDeclarativeExtension[]
  readonly warnings: readonly string[]
}

export interface DeclarativeCommandOutput {
  readonly messages: readonly string[]
}
