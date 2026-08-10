import type { Marker, TimelineState, Track } from '../types/timeline'

export const EXTENSION_API_VERSION = '1' as const

export const EXTENSION_PERMISSIONS = [
  'timeline.read',
  'timeline.transform',
  'selection.read',
  'notifications',
] as const

export type ExtensionPermission = typeof EXTENSION_PERMISSIONS[number]

export const EXTENSION_CAPABILITIES = [
  'commands',
  'markerTransforms',
  'trackTransforms',
] as const

export type ExtensionCapability = typeof EXTENSION_CAPABILITIES[number]

export interface ExtensionManifest {
  readonly apiVersion: typeof EXTENSION_API_VERSION
  readonly id: string
  readonly name: string
  readonly version: string
  readonly description?: string
  readonly author?: string
  readonly homepage?: string
  readonly permissions: {
    readonly required: readonly ExtensionPermission[]
    readonly optional?: readonly ExtensionPermission[]
  }
  readonly capabilities: readonly ExtensionCapability[]
}

export type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends ReadonlyArray<infer U>
    ? ReadonlyArray<DeepReadonly<U>>
    : T extends object
      ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
      : T

export type ExtensionValidationResult<T> =
  | { readonly ok: true, readonly value: T }
  | { readonly ok: false, readonly error: string }

export type ExtensionValidator<T> = (value: unknown) => ExtensionValidationResult<T>

export interface ExtensionPermissionSet {
  has(permission: ExtensionPermission): boolean
  values(): readonly ExtensionPermission[]
}

export interface ExtensionSelection {
  readonly markerIds: readonly string[]
  readonly trackIds: readonly string[]
}

export interface ExtensionCommandContext {
  readonly extensionId: string
  readonly permissions: ExtensionPermissionSet
  readonly project?: DeepReadonly<TimelineState>
  readonly selection?: DeepReadonly<ExtensionSelection>
  notify?(level: 'info' | 'success' | 'warning' | 'error', message: string): void
}

export interface ExtensionTransformContext {
  readonly extensionId: string
  readonly permissions: ExtensionPermissionSet
  readonly project: DeepReadonly<TimelineState>
  readonly selection: DeepReadonly<ExtensionSelection>
}

export type ExtensionDisposable = (() => void | Promise<void>) | {
  dispose(): void | Promise<void>
}

export interface ExtensionActivationContext {
  readonly extensionId: string
  readonly permissions: ExtensionPermissionSet
  readonly subscriptions: {
    add(disposable: ExtensionDisposable): void
  }
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string, details?: unknown): void
  notify?(level: 'info' | 'success' | 'warning' | 'error', message: string): void
}

interface ContributionBase {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly requiredPermissions: readonly ExtensionPermission[]
}

export interface ExtensionCommandContribution extends ContributionBase {
  readonly kind: 'command'
  validateInput(value: unknown): ExtensionValidationResult<unknown>
  validateOutput?(value: unknown): ExtensionValidationResult<unknown>
  execute(context: ExtensionCommandContext, input: unknown): unknown | Promise<unknown>
}

declare const commandTypes: unique symbol

export interface ExtensionCommand<TInput, TOutput> extends ExtensionCommandContribution {
  readonly [commandTypes]?: {
    readonly input: TInput
    readonly output: TOutput
  }
}

export interface MarkerTransformContribution extends ContributionBase {
  readonly kind: 'markerTransform'
  validateOptions(value: unknown): ExtensionValidationResult<unknown>
  transform(
    markers: readonly DeepReadonly<Marker>[],
    context: ExtensionTransformContext,
    options: unknown,
  ): readonly Marker[] | Promise<readonly Marker[]>
}

declare const markerTransformOptions: unique symbol

export interface MarkerTransform<TOptions> extends MarkerTransformContribution {
  readonly [markerTransformOptions]?: TOptions
}

export interface TrackTransformContribution extends ContributionBase {
  readonly kind: 'trackTransform'
  validateOptions(value: unknown): ExtensionValidationResult<unknown>
  transform(
    tracks: readonly DeepReadonly<Track>[],
    context: ExtensionTransformContext,
    options: unknown,
  ): readonly Track[] | Promise<readonly Track[]>
}

declare const trackTransformOptions: unique symbol

export interface TrackTransform<TOptions> extends TrackTransformContribution {
  readonly [trackTransformOptions]?: TOptions
}

export interface ExtensionContributions {
  readonly commands?: readonly ExtensionCommandContribution[]
  readonly markerTransforms?: readonly MarkerTransformContribution[]
  readonly trackTransforms?: readonly TrackTransformContribution[]
}

export interface ExtensionDefinition {
  readonly manifest: ExtensionManifest
  readonly contributes?: ExtensionContributions
  activate?(context: ExtensionActivationContext): void | ExtensionDisposable | Promise<void | ExtensionDisposable>
  deactivate?(): void | Promise<void>
}

export type ExtensionStatus = 'inactive' | 'activating' | 'active' | 'deactivating'

export type ExtensionFailurePhase =
  | 'registration'
  | 'activation'
  | 'deactivation'
  | 'permission'
  | 'validation'
  | 'command'
  | 'transform'
  | 'timeout'

export interface ExtensionFailure {
  readonly extensionId: string
  readonly contributionId?: string
  readonly phase: ExtensionFailurePhase
  readonly message: string
  readonly cause?: unknown
}

export type ExtensionResult<T> =
  | { readonly ok: true, readonly value: T }
  | { readonly ok: false, readonly error: ExtensionFailure }

export interface ExtensionInfo {
  readonly manifest: ExtensionManifest
  readonly status: ExtensionStatus
  readonly grantedPermissions: readonly ExtensionPermission[]
  readonly lastFailure?: ExtensionFailure
}

export interface ExtensionInvocation {
  readonly project?: TimelineState
  readonly selection?: Partial<ExtensionSelection>
}

export interface MarkerTransformInvocation {
  readonly project: TimelineState
  readonly markerIds: readonly string[]
}

export interface TrackTransformInvocation {
  readonly project: TimelineState
  readonly trackIds: readonly string[]
}

export interface ExtensionRegistryOptions {
  readonly executionTimeoutMs?: number
  readonly maxMarkers?: number
  readonly maxTracks?: number
  readonly onFailure?: (failure: ExtensionFailure) => void
  readonly onLog?: (entry: {
    readonly extensionId: string
    readonly level: 'debug' | 'info' | 'warn' | 'error'
    readonly message: string
    readonly details?: unknown
  }) => void
  readonly onNotification?: (entry: {
    readonly extensionId: string
    readonly level: 'info' | 'success' | 'warning' | 'error'
    readonly message: string
  }) => void
}

export interface CommandSpec<TInput, TOutput> extends ContributionBase {
  readonly validateInput: ExtensionValidator<TInput>
  readonly validateOutput?: ExtensionValidator<TOutput>
  execute(context: ExtensionCommandContext, input: DeepReadonly<TInput>): TOutput | Promise<TOutput>
}

export interface MarkerTransformSpec<TOptions> extends ContributionBase {
  readonly validateOptions: ExtensionValidator<TOptions>
  transform(
    markers: readonly DeepReadonly<Marker>[],
    context: ExtensionTransformContext,
    options: DeepReadonly<TOptions>,
  ): readonly Marker[] | Promise<readonly Marker[]>
}

export interface TrackTransformSpec<TOptions> extends ContributionBase {
  readonly validateOptions: ExtensionValidator<TOptions>
  transform(
    tracks: readonly DeepReadonly<Track>[],
    context: ExtensionTransformContext,
    options: DeepReadonly<TOptions>,
  ): readonly Track[] | Promise<readonly Track[]>
}

export function defineCommand<TInput, TOutput>(spec: CommandSpec<TInput, TOutput>): ExtensionCommand<TInput, TOutput> {
  return Object.freeze({
    kind: 'command' as const,
    id: spec.id,
    name: spec.name,
    description: spec.description,
    requiredPermissions: Object.freeze([...spec.requiredPermissions]),
    validateInput: (value: unknown): ExtensionValidationResult<unknown> => spec.validateInput(value),
    validateOutput: spec.validateOutput
      ? (value: unknown): ExtensionValidationResult<unknown> => spec.validateOutput?.(value) ?? { ok: false, error: 'Output validator is unavailable' }
      : undefined,
    execute: (context: ExtensionCommandContext, input: unknown) => (
      spec.execute(context, input as DeepReadonly<TInput>)
    ),
  })
}

export function defineMarkerTransform<TOptions>(spec: MarkerTransformSpec<TOptions>): MarkerTransform<TOptions> {
  return Object.freeze({
    kind: 'markerTransform' as const,
    id: spec.id,
    name: spec.name,
    description: spec.description,
    requiredPermissions: Object.freeze([...spec.requiredPermissions]),
    validateOptions: (value: unknown): ExtensionValidationResult<unknown> => spec.validateOptions(value),
    transform: (
      markers: readonly DeepReadonly<Marker>[],
      context: ExtensionTransformContext,
      options: unknown,
    ) => spec.transform(markers, context, options as DeepReadonly<TOptions>),
  })
}

export function defineTrackTransform<TOptions>(spec: TrackTransformSpec<TOptions>): TrackTransform<TOptions> {
  return Object.freeze({
    kind: 'trackTransform' as const,
    id: spec.id,
    name: spec.name,
    description: spec.description,
    requiredPermissions: Object.freeze([...spec.requiredPermissions]),
    validateOptions: (value: unknown): ExtensionValidationResult<unknown> => spec.validateOptions(value),
    transform: (
      tracks: readonly DeepReadonly<Track>[],
      context: ExtensionTransformContext,
      options: unknown,
    ) => spec.transform(tracks, context, options as DeepReadonly<TOptions>),
  })
}

export function defineExtension(definition: ExtensionDefinition): ExtensionDefinition {
  return Object.freeze({
    ...definition,
    manifest: Object.freeze({
      ...definition.manifest,
      permissions: Object.freeze({
        required: Object.freeze([...definition.manifest.permissions.required]),
        optional: Object.freeze([...(definition.manifest.permissions.optional ?? [])]),
      }),
      capabilities: Object.freeze([...definition.manifest.capabilities]),
    }),
    contributes: definition.contributes
      ? Object.freeze({
          commands: Object.freeze([...(definition.contributes.commands ?? [])]),
          markerTransforms: Object.freeze([...(definition.contributes.markerTransforms ?? [])]),
          trackTransforms: Object.freeze([...(definition.contributes.trackTransforms ?? [])]),
        })
      : undefined,
  })
}
