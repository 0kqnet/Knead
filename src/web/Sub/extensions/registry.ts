import type { Marker, TimelineState, Track } from '../types/timeline'
import { getTimelineLengthTicks } from '../utils/tempoMap'
import { parse, serialize } from '../utils/timelineIO'
import {
  EXTENSION_PERMISSIONS,
  type DeepReadonly,
  type ExtensionActivationContext,
  type ExtensionCommand,
  type ExtensionCommandContext,
  type ExtensionCommandContribution,
  type ExtensionDefinition,
  type ExtensionDisposable,
  type ExtensionFailure,
  type ExtensionFailurePhase,
  type ExtensionInfo,
  type ExtensionInvocation,
  type ExtensionPermission,
  type ExtensionPermissionSet,
  type ExtensionRegistryOptions,
  type ExtensionResult,
  type ExtensionSelection,
  type ExtensionStatus,
  type MarkerTransform,
  type MarkerTransformContribution,
  type MarkerTransformInvocation,
  type TrackTransform,
  type TrackTransformContribution,
  type TrackTransformInvocation,
} from './types'
import {
  ExtensionDefinitionError,
  getCommands,
  getMarkerTransforms,
  getTrackTransforms,
  validateExtensionDefinition,
} from './validation'

const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_MAX_MARKERS = 100_000
const DEFAULT_MAX_TRACKS = 1_024
const MAX_NOTIFICATION_LENGTH = 500

class ExtensionTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Extension operation exceeded ${timeoutMs} ms`)
    this.name = 'ExtensionTimeoutError'
  }
}

interface RegisteredExtension {
  readonly definition: ExtensionDefinition
  status: ExtensionStatus
  grantedPermissions: Set<ExtensionPermission>
  disposables: ExtensionDisposable[]
  lastFailure?: ExtensionFailure
}

interface PermissionCheck {
  readonly ok: boolean
  readonly missing: readonly ExtensionPermission[]
}

function isKnownPermission(value: unknown): value is ExtensionPermission {
  return typeof value === 'string' && (EXTENSION_PERMISSIONS as readonly string[]).includes(value)
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  }
  catch {
    return String(error)
  }
}

function cloneValue<T>(value: T): T {
  return structuredClone(value)
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): DeepReadonly<T> {
  if (typeof value !== 'object' || value === null) return value as DeepReadonly<T>
  if (seen.has(value)) return value as DeepReadonly<T>
  seen.add(value)
  for (const key of Reflect.ownKeys(value)) {
    deepFreeze((value as Record<PropertyKey, unknown>)[key], seen)
  }
  return Object.freeze(value) as DeepReadonly<T>
}

function permissionSetView(permissions: ReadonlySet<ExtensionPermission>): ExtensionPermissionSet {
  const values = Object.freeze([...permissions])
  return Object.freeze({
    has: (permission: ExtensionPermission) => permissions.has(permission),
    values: () => values,
  })
}

function isDisposable(value: unknown): value is ExtensionDisposable {
  return typeof value === 'function'
    || (typeof value === 'object' && value !== null && typeof (value as { dispose?: unknown }).dispose === 'function')
}

async function dispose(disposable: ExtensionDisposable): Promise<void> {
  if (typeof disposable === 'function') await disposable()
  else await disposable.dispose()
}

function replaceSelected<T extends { readonly id: string }>(
  existing: readonly T[],
  selectedIds: ReadonlySet<string>,
  replacements: readonly T[],
): T[] {
  const replacementIds = new Set(replacements.map(item => item.id))
  const isOneToOne = replacements.length === selectedIds.size
    && replacementIds.size === replacements.length
    && replacements.every(item => selectedIds.has(item.id))
  if (isOneToOne) {
    const byId = new Map(replacements.map(item => [item.id, item]))
    return existing.map(item => byId.get(item.id) ?? item)
  }

  const result: T[] = []
  let inserted = false
  for (const item of existing) {
    if (!selectedIds.has(item.id)) {
      result.push(item)
      continue
    }
    if (!inserted) {
      result.push(...replacements)
      inserted = true
    }
  }
  return result
}

function normalizeSelection(selection: unknown): { ok: true, value: ExtensionSelection } | { ok: false, error: string } {
  if (selection === undefined) return { ok: true, value: { markerIds: [], trackIds: [] } }
  if (typeof selection !== 'object' || selection === null || Array.isArray(selection)) {
    return { ok: false, error: 'selection must be an object' }
  }
  const source = selection as { markerIds?: unknown, trackIds?: unknown }
  const markerIds = source.markerIds ?? []
  const trackIds = source.trackIds ?? []
  if (!Array.isArray(markerIds)) return { ok: false, error: 'selection.markerIds must be an array' }
  if (!Array.isArray(trackIds)) return { ok: false, error: 'selection.trackIds must be an array' }
  const markerError = validateIdList(markerIds, 'selection.markerIds', true)
  if (markerError) return { ok: false, error: markerError }
  const trackError = validateIdList(trackIds, 'selection.trackIds', true)
  if (trackError) return { ok: false, error: trackError }
  return { ok: true, value: { markerIds: [...markerIds], trackIds: [...trackIds] } }
}

function validateIdList(ids: unknown, label: string, allowEmpty: boolean): string | null {
  if (!Array.isArray(ids)) return `${label} must be an array`
  if (!allowEmpty && ids.length === 0) return `${label} must contain at least one id`
  const seen = new Set<string>()
  for (let index = 0; index < ids.length; index++) {
    const id = ids[index]
    if (typeof id !== 'string' || id.length === 0) return `${label}[${index}] must be a non-empty string`
    if (seen.has(id)) return `${label}[${index}] duplicates ${JSON.stringify(id)}`
    seen.add(id)
  }
  return null
}

function positiveInteger(value: unknown, fallback: number, maximum: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(1, Math.min(maximum, Math.floor(value)))
    : fallback
}

function timeout<T>(work: () => T | Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new ExtensionTimeoutError(timeoutMs))
    }, timeoutMs)
    Promise.resolve()
      .then(work)
      .then((value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      }, (error: unknown) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(error)
      })
  })
}

export class ExtensionRegistry {
  private readonly entries = new Map<string, RegisteredExtension>()
  private readonly timeoutMs: number
  private readonly maxMarkers: number
  private readonly maxTracks: number
  private readonly options: ExtensionRegistryOptions

  constructor(options: ExtensionRegistryOptions = {}) {
    this.timeoutMs = positiveInteger(options.executionTimeoutMs, DEFAULT_TIMEOUT_MS, 300_000)
    this.maxMarkers = positiveInteger(options.maxMarkers, DEFAULT_MAX_MARKERS, 1_000_000)
    this.maxTracks = positiveInteger(options.maxTracks, DEFAULT_MAX_TRACKS, 10_000)
    this.options = options
  }

  register(
    definitionValue: ExtensionDefinition,
    grantedPermissions: readonly ExtensionPermission[] = [],
  ): ExtensionInfo {
    const validated = validateExtensionDefinition(definitionValue)
    if (!validated.ok) throw new ExtensionDefinitionError(validated.issues)
    const definition = validated.definition
    if (this.entries.has(definition.manifest.id)) {
      throw new ExtensionDefinitionError([{
        path: 'manifest.id',
        message: `${definition.manifest.id} is already registered`,
      }])
    }
    const grants = this.validateGrants(definition, grantedPermissions)
    const entry: RegisteredExtension = {
      definition,
      status: 'inactive',
      grantedPermissions: grants,
      disposables: [],
    }
    this.entries.set(definition.manifest.id, entry)
    return this.info(entry)
  }

  async unregister(extensionId: string): Promise<ExtensionResult<void>> {
    const entry = this.entries.get(extensionId)
    if (!entry) return this.failureResult(extensionId, 'registration', `Extension ${extensionId} is not registered`)
    const deactivated = await this.deactivate(extensionId)
    this.entries.delete(extensionId)
    return deactivated
  }

  list(): readonly ExtensionInfo[] {
    return [...this.entries.values()].map(entry => this.info(entry))
  }

  get(extensionId: string): ExtensionInfo | undefined {
    const entry = this.entries.get(extensionId)
    return entry ? this.info(entry) : undefined
  }

  getCommand(extensionId: string, commandId: string): ExtensionCommandContribution | undefined {
    const entry = this.entries.get(extensionId)
    return entry && getCommands(entry.definition).find(command => command.id === commandId)
  }

  listCommands(extensionId: string): readonly ExtensionCommandContribution[] {
    const entry = this.entries.get(extensionId)
    return entry ? [...getCommands(entry.definition)] : []
  }

  getMarkerTransform(extensionId: string, transformId: string): MarkerTransformContribution | undefined {
    const entry = this.entries.get(extensionId)
    return entry && getMarkerTransforms(entry.definition).find(transform => transform.id === transformId)
  }

  listMarkerTransforms(extensionId: string): readonly MarkerTransformContribution[] {
    const entry = this.entries.get(extensionId)
    return entry ? [...getMarkerTransforms(entry.definition)] : []
  }

  getTrackTransform(extensionId: string, transformId: string): TrackTransformContribution | undefined {
    const entry = this.entries.get(extensionId)
    return entry && getTrackTransforms(entry.definition).find(transform => transform.id === transformId)
  }

  listTrackTransforms(extensionId: string): readonly TrackTransformContribution[] {
    const entry = this.entries.get(extensionId)
    return entry ? [...getTrackTransforms(entry.definition)] : []
  }

  setGrantedPermissions(extensionId: string, permissions: readonly ExtensionPermission[]): ExtensionResult<void> {
    const entry = this.entries.get(extensionId)
    if (!entry) return this.failureResult(extensionId, 'permission', `Extension ${extensionId} is not registered`)
    if (entry.status !== 'inactive') {
      return this.report(entry, 'permission', 'Permissions can only be changed while an extension is inactive')
    }
    try {
      entry.grantedPermissions = this.validateGrants(entry.definition, permissions)
      return { ok: true, value: undefined }
    }
    catch (error) {
      return this.report(entry, 'permission', errorMessage(error), undefined, error)
    }
  }

  async activate(extensionId: string): Promise<ExtensionResult<void>> {
    const entry = this.entries.get(extensionId)
    if (!entry) return this.failureResult(extensionId, 'activation', `Extension ${extensionId} is not registered`)
    if (entry.status === 'active') return { ok: true, value: undefined }
    if (entry.status !== 'inactive') {
      return this.report(entry, 'activation', `Cannot activate while extension is ${entry.status}`)
    }
    const required = this.checkPermissions(entry, entry.definition.manifest.permissions.required)
    if (!required.ok) {
      return this.report(entry, 'permission', `Required permissions were not granted: ${required.missing.join(', ')}`)
    }

    entry.status = 'activating'
    entry.disposables = []
    let acceptingSubscriptions = true
    const context = this.activationContext(entry, (disposable) => {
      if (!isDisposable(disposable)) throw new TypeError('subscriptions.add expects a disposable')
      if (!acceptingSubscriptions) {
        void dispose(disposable).catch(() => undefined)
        return
      }
      entry.disposables.push(disposable)
    })

    const result = await this.isolate(entry, 'activation', undefined, () => entry.definition.activate?.(context))
    acceptingSubscriptions = false
    if (!result.ok) {
      await this.disposeAll(entry)
      entry.status = 'inactive'
      return result
    }
    if (result.value !== undefined) {
      if (!isDisposable(result.value)) {
        const invalid = this.report(entry, 'activation', 'activate() must return a disposable or undefined')
        await this.disposeAll(entry)
        entry.status = 'inactive'
        return invalid
      }
      entry.disposables.push(result.value)
    }
    entry.status = 'active'
    return { ok: true, value: undefined }
  }

  async deactivate(extensionId: string): Promise<ExtensionResult<void>> {
    const entry = this.entries.get(extensionId)
    if (!entry) return this.failureResult(extensionId, 'deactivation', `Extension ${extensionId} is not registered`)
    if (entry.status === 'inactive') return { ok: true, value: undefined }
    if (entry.status !== 'active') {
      return this.report(entry, 'deactivation', `Cannot deactivate while extension is ${entry.status}`)
    }
    entry.status = 'deactivating'
    const errors = await this.disposeAll(entry)
    const deactivation = await this.isolate(entry, 'deactivation', undefined, () => entry.definition.deactivate?.())
    if (!deactivation.ok) errors.push(deactivation.error.cause ?? deactivation.error.message)
    entry.status = 'inactive'
    if (errors.length > 0) {
      return this.report(
        entry,
        'deactivation',
        `${errors.length} deactivation cleanup operation${errors.length === 1 ? '' : 's'} failed`,
        undefined,
        errors,
      )
    }
    return { ok: true, value: undefined }
  }

  async executeCommand<TInput, TOutput>(
    extensionId: string,
    command: ExtensionCommand<TInput, TOutput>,
    input: TInput,
    invocation: ExtensionInvocation = {},
  ): Promise<ExtensionResult<TOutput>> {
    const result = await this.executeCommandContribution(extensionId, command, input, invocation)
    return result as ExtensionResult<TOutput>
  }

  async executeCommandById(
    extensionId: string,
    commandId: string,
    input: unknown,
    invocation: ExtensionInvocation = {},
  ): Promise<ExtensionResult<unknown>> {
    const command = this.getCommand(extensionId, commandId)
    if (!command) return this.failureResult(extensionId, 'command', `Command ${commandId} is not registered`, commandId)
    return this.executeCommandContribution(extensionId, command, input, invocation)
  }

  async executeMarkerTransform<TOptions>(
    extensionId: string,
    transform: MarkerTransform<TOptions>,
    options: TOptions,
    invocation: MarkerTransformInvocation,
  ): Promise<ExtensionResult<TimelineState>> {
    return this.executeMarkerTransformContribution(extensionId, transform, options, invocation)
  }

  async executeMarkerTransformById(
    extensionId: string,
    transformId: string,
    options: unknown,
    invocation: MarkerTransformInvocation,
  ): Promise<ExtensionResult<TimelineState>> {
    const transform = this.getMarkerTransform(extensionId, transformId)
    if (!transform) return this.failureResult(extensionId, 'transform', `Marker transform ${transformId} is not registered`, transformId)
    return this.executeMarkerTransformContribution(extensionId, transform, options, invocation)
  }

  async executeTrackTransform<TOptions>(
    extensionId: string,
    transform: TrackTransform<TOptions>,
    options: TOptions,
    invocation: TrackTransformInvocation,
  ): Promise<ExtensionResult<TimelineState>> {
    return this.executeTrackTransformContribution(extensionId, transform, options, invocation)
  }

  async executeTrackTransformById(
    extensionId: string,
    transformId: string,
    options: unknown,
    invocation: TrackTransformInvocation,
  ): Promise<ExtensionResult<TimelineState>> {
    const transform = this.getTrackTransform(extensionId, transformId)
    if (!transform) return this.failureResult(extensionId, 'transform', `Track transform ${transformId} is not registered`, transformId)
    return this.executeTrackTransformContribution(extensionId, transform, options, invocation)
  }

  private async executeCommandContribution(
    extensionId: string,
    command: ExtensionCommandContribution,
    input: unknown,
    invocation: ExtensionInvocation,
  ): Promise<ExtensionResult<unknown>> {
    const entry = this.entries.get(extensionId)
    if (!entry) return this.failureResult(extensionId, 'command', `Extension ${extensionId} is not registered`, command.id)
    if (!getCommands(entry.definition).includes(command)) {
      return this.report(entry, 'command', `Command ${command.id} does not belong to ${extensionId}`, command.id)
    }
    const ready = this.checkContribution(entry, command.requiredPermissions, 'command', command.id)
    if (!ready.ok) return ready

    const preparedInput = this.validateValue(entry, command.id, input, command.validateInput)
    if (!preparedInput.ok) return preparedInput
    const context = this.commandContext(entry, command, invocation)
    if (!context.ok) return context

    const executed = await this.isolate(entry, 'command', command.id, () => command.execute(context.value, preparedInput.value))
    if (!executed.ok) return executed
    const output = this.cloneForHost(entry, command.id, executed.value, 'Command output is not structured-cloneable')
    if (!output.ok) return output
    if (!command.validateOutput) return output
    return this.validateValue(entry, command.id, output.value, command.validateOutput, 'Command output')
  }

  private async executeMarkerTransformContribution(
    extensionId: string,
    transform: MarkerTransformContribution,
    options: unknown,
    invocation: MarkerTransformInvocation,
  ): Promise<ExtensionResult<TimelineState>> {
    const entry = this.entries.get(extensionId)
    if (!entry) return this.failureResult(extensionId, 'transform', `Extension ${extensionId} is not registered`, transform.id)
    if (!getMarkerTransforms(entry.definition).includes(transform)) {
      return this.report(entry, 'transform', `Marker transform ${transform.id} does not belong to ${extensionId}`, transform.id)
    }
    const ready = this.checkContribution(entry, transform.requiredPermissions, 'transform', transform.id)
    if (!ready.ok) return ready
    const project = this.normalizeProject(entry, transform.id, invocation.project)
    if (!project.ok) return project
    const idError = validateIdList(invocation.markerIds, 'markerIds', false)
    if (idError) return this.report(entry, 'validation', idError, transform.id)
    const selectedIds = new Set(invocation.markerIds)
    const selected = project.value.markers.filter(marker => selectedIds.has(marker.id))
    if (selected.length !== selectedIds.size) {
      return this.report(entry, 'validation', 'markerIds contains an id that is not in the project', transform.id)
    }
    const preparedOptions = this.validateValue(entry, transform.id, options, transform.validateOptions, 'Transform options')
    if (!preparedOptions.ok) return preparedOptions
    const context = this.transformContext(entry, project.value, {
      markerIds: invocation.markerIds,
      trackIds: [...new Set(selected.map(marker => marker.trackId))],
    })
    const selectedSnapshot = deepFreeze(cloneValue(selected))
    const transformed = await this.isolate(entry, 'transform', transform.id, () => (
      transform.transform(selectedSnapshot, context, preparedOptions.value)
    ))
    if (!transformed.ok) return transformed
    if (!Array.isArray(transformed.value)) {
      return this.report(entry, 'validation', 'Marker transform must return an array', transform.id)
    }
    const replacements = this.cloneForHost(entry, transform.id, transformed.value, 'Marker transform output is not structured-cloneable')
    if (!replacements.ok) return replacements
    const markers = replaceSelected(project.value.markers, selectedIds, replacements.value as readonly Marker[])
    if (markers.length > this.maxMarkers) {
      return this.report(entry, 'validation', `Marker transform exceeds the ${this.maxMarkers} marker limit`, transform.id)
    }
    return this.normalizeProject(entry, transform.id, {
      ...project.value,
      markers,
      lengthTicks: getTimelineLengthTicks(markers, project.value.lengthTicks, project.value.settings),
    })
  }

  private async executeTrackTransformContribution(
    extensionId: string,
    transform: TrackTransformContribution,
    options: unknown,
    invocation: TrackTransformInvocation,
  ): Promise<ExtensionResult<TimelineState>> {
    const entry = this.entries.get(extensionId)
    if (!entry) return this.failureResult(extensionId, 'transform', `Extension ${extensionId} is not registered`, transform.id)
    if (!getTrackTransforms(entry.definition).includes(transform)) {
      return this.report(entry, 'transform', `Track transform ${transform.id} does not belong to ${extensionId}`, transform.id)
    }
    const ready = this.checkContribution(entry, transform.requiredPermissions, 'transform', transform.id)
    if (!ready.ok) return ready
    const project = this.normalizeProject(entry, transform.id, invocation.project)
    if (!project.ok) return project
    const idError = validateIdList(invocation.trackIds, 'trackIds', false)
    if (idError) return this.report(entry, 'validation', idError, transform.id)
    const selectedIds = new Set(invocation.trackIds)
    const selected = project.value.tracks.filter(track => selectedIds.has(track.id))
    if (selected.length !== selectedIds.size) {
      return this.report(entry, 'validation', 'trackIds contains an id that is not in the project', transform.id)
    }
    const preparedOptions = this.validateValue(entry, transform.id, options, transform.validateOptions, 'Transform options')
    if (!preparedOptions.ok) return preparedOptions
    const context = this.transformContext(entry, project.value, {
      markerIds: project.value.markers.filter(marker => selectedIds.has(marker.trackId)).map(marker => marker.id),
      trackIds: invocation.trackIds,
    })
    const selectedSnapshot = deepFreeze(cloneValue(selected))
    const transformed = await this.isolate(entry, 'transform', transform.id, () => (
      transform.transform(selectedSnapshot, context, preparedOptions.value)
    ))
    if (!transformed.ok) return transformed
    if (!Array.isArray(transformed.value)) {
      return this.report(entry, 'validation', 'Track transform must return an array', transform.id)
    }
    const replacements = this.cloneForHost(entry, transform.id, transformed.value, 'Track transform output is not structured-cloneable')
    if (!replacements.ok) return replacements
    const tracks = replaceSelected(project.value.tracks, selectedIds, replacements.value as readonly Track[])
    if (tracks.length > this.maxTracks) {
      return this.report(entry, 'validation', `Track transform exceeds the ${this.maxTracks} track limit`, transform.id)
    }
    return this.normalizeProject(entry, transform.id, { ...project.value, tracks })
  }

  private normalizeProject(
    entry: RegisteredExtension,
    contributionId: string,
    project: TimelineState,
  ): ExtensionResult<TimelineState> {
    try {
      const json = serialize(project)
      const parsed = parse(json)
      if (!parsed.ok) return this.report(entry, 'validation', `Invalid project: ${parsed.error}`, contributionId)
      if (parsed.state.markers.length > this.maxMarkers) {
        return this.report(entry, 'validation', `Project exceeds the ${this.maxMarkers} marker limit`, contributionId)
      }
      if (parsed.state.tracks.length > this.maxTracks) {
        return this.report(entry, 'validation', `Project exceeds the ${this.maxTracks} track limit`, contributionId)
      }
      return { ok: true, value: parsed.state }
    }
    catch (error) {
      return this.report(entry, 'validation', `Project could not be validated: ${errorMessage(error)}`, contributionId, error)
    }
  }

  private commandContext(
    entry: RegisteredExtension,
    command: ExtensionCommandContribution,
    invocation: ExtensionInvocation,
  ): ExtensionResult<ExtensionCommandContext> {
    const required = new Set(command.requiredPermissions)
    let project: DeepReadonly<TimelineState> | undefined
    if (required.has('timeline.read')) {
      if (!invocation.project) return this.report(entry, 'validation', 'This command requires a project', command.id)
      const normalized = this.normalizeProject(entry, command.id, invocation.project)
      if (!normalized.ok) return normalized
      project = deepFreeze(cloneValue(normalized.value))
    }
    let selection: DeepReadonly<ExtensionSelection> | undefined
    if (required.has('selection.read')) {
      const normalizedSelection = normalizeSelection(invocation.selection)
      if (!normalizedSelection.ok) {
        return this.report(entry, 'validation', normalizedSelection.error, command.id)
      }
      if (project) {
        const markerIds = new Set(project.markers.map(marker => marker.id))
        const trackIds = new Set(project.tracks.map(track => track.id))
        if (normalizedSelection.value.markerIds.some(id => !markerIds.has(id))) {
          return this.report(entry, 'validation', 'selection.markerIds contains an id that is not in the project', command.id)
        }
        if (normalizedSelection.value.trackIds.some(id => !trackIds.has(id))) {
          return this.report(entry, 'validation', 'selection.trackIds contains an id that is not in the project', command.id)
        }
      }
      selection = deepFreeze(cloneValue(normalizedSelection.value))
    }
    const notify = required.has('notifications') ? this.notifier(entry) : undefined
    return {
      ok: true,
      value: Object.freeze({
        extensionId: entry.definition.manifest.id,
        permissions: permissionSetView(entry.grantedPermissions),
        project,
        selection,
        notify,
      }),
    }
  }

  private transformContext(
    entry: RegisteredExtension,
    project: TimelineState,
    selection: ExtensionSelection,
  ) {
    return Object.freeze({
      extensionId: entry.definition.manifest.id,
      permissions: permissionSetView(entry.grantedPermissions),
      project: deepFreeze(cloneValue(project)),
      selection: deepFreeze(cloneValue(selection)),
    })
  }

  private activationContext(
    entry: RegisteredExtension,
    addSubscription: (disposable: ExtensionDisposable) => void,
  ): ExtensionActivationContext {
    const notify = entry.grantedPermissions.has('notifications') ? this.notifier(entry) : undefined
    return Object.freeze({
      extensionId: entry.definition.manifest.id,
      permissions: permissionSetView(entry.grantedPermissions),
      subscriptions: Object.freeze({ add: addSubscription }),
      log: (level: 'debug' | 'info' | 'warn' | 'error', message: string, details?: unknown) => {
        if (!this.options.onLog) return
        const safeMessage = String(message).slice(0, 2_000)
        let safeDetails: unknown
        try {
          safeDetails = cloneValue(details)
        }
        catch {
          safeDetails = errorMessage(details)
        }
        try {
          this.options.onLog({ extensionId: entry.definition.manifest.id, level, message: safeMessage, details: safeDetails })
        }
        catch {
          // Host observers cannot break extension isolation.
        }
      },
      notify,
    })
  }

  private notifier(entry: RegisteredExtension) {
    return (level: 'info' | 'success' | 'warning' | 'error', message: string): void => {
      if (!this.options.onNotification) return
      const safeMessage = String(message).slice(0, MAX_NOTIFICATION_LENGTH)
      try {
        this.options.onNotification({ extensionId: entry.definition.manifest.id, level, message: safeMessage })
      }
      catch {
        // Host observers cannot break extension isolation.
      }
    }
  }

  private validateValue(
    entry: RegisteredExtension,
    contributionId: string,
    value: unknown,
    validator: (value: unknown) => { readonly ok: true, readonly value: unknown } | { readonly ok: false, readonly error: string },
    label = 'Command input',
  ): ExtensionResult<unknown> {
    try {
      const snapshot = deepFreeze(cloneValue(value))
      const validated = validator(snapshot)
      if (!validated || typeof validated !== 'object' || typeof validated.ok !== 'boolean') {
        return this.report(entry, 'validation', `${label} validator returned an invalid result`, contributionId)
      }
      if (!validated.ok) return this.report(entry, 'validation', `${label}: ${validated.error}`, contributionId)
      return { ok: true, value: deepFreeze(cloneValue(validated.value)) }
    }
    catch (error) {
      return this.report(entry, 'validation', `${label} validation failed: ${errorMessage(error)}`, contributionId, error)
    }
  }

  private cloneForHost(
    entry: RegisteredExtension,
    contributionId: string,
    value: unknown,
    message: string,
  ): ExtensionResult<unknown> {
    try {
      return { ok: true, value: cloneValue(value) }
    }
    catch (error) {
      return this.report(entry, 'validation', `${message}: ${errorMessage(error)}`, contributionId, error)
    }
  }

  private checkContribution(
    entry: RegisteredExtension,
    permissions: readonly ExtensionPermission[],
    phase: 'command' | 'transform',
    contributionId: string,
  ): ExtensionResult<void> {
    if (entry.status !== 'active') {
      return this.report(entry, phase, `Extension is ${entry.status}; activate it before execution`, contributionId)
    }
    const check = this.checkPermissions(entry, permissions)
    if (!check.ok) {
      return this.report(entry, 'permission', `Contribution permissions were not granted: ${check.missing.join(', ')}`, contributionId)
    }
    return { ok: true, value: undefined }
  }

  private checkPermissions(entry: RegisteredExtension, permissions: readonly ExtensionPermission[]): PermissionCheck {
    const missing = permissions.filter(permission => !entry.grantedPermissions.has(permission))
    return { ok: missing.length === 0, missing }
  }

  private validateGrants(
    definition: ExtensionDefinition,
    permissions: readonly ExtensionPermission[],
  ): Set<ExtensionPermission> {
    const requested = new Set([
      ...definition.manifest.permissions.required,
      ...(definition.manifest.permissions.optional ?? []),
    ])
    const result = new Set<ExtensionPermission>()
    permissions.forEach((permission) => {
      if (!isKnownPermission(permission)) throw new Error(`Unknown permission ${JSON.stringify(permission)}`)
      if (!requested.has(permission)) throw new Error(`${permission} was not requested by ${definition.manifest.id}`)
      result.add(permission)
    })
    return result
  }

  private async isolate<T>(
    entry: RegisteredExtension,
    phase: 'activation' | 'deactivation' | 'command' | 'transform',
    contributionId: string | undefined,
    work: () => T | Promise<T>,
  ): Promise<ExtensionResult<T>> {
    try {
      return { ok: true, value: await timeout(work, this.timeoutMs) }
    }
    catch (error) {
      const failurePhase: ExtensionFailurePhase = error instanceof ExtensionTimeoutError ? 'timeout' : phase
      return this.report(entry, failurePhase, errorMessage(error), contributionId, error)
    }
  }

  private async disposeAll(entry: RegisteredExtension): Promise<unknown[]> {
    const errors: unknown[] = []
    const disposables = entry.disposables.splice(0).reverse()
    for (const disposable of disposables) {
      try {
        await timeout(() => dispose(disposable), this.timeoutMs)
      }
      catch (error) {
        errors.push(error)
      }
    }
    return errors
  }

  private report<T = never>(
    entry: RegisteredExtension,
    phase: ExtensionFailurePhase,
    message: string,
    contributionId?: string,
    cause?: unknown,
  ): ExtensionResult<T> {
    const failure: ExtensionFailure = {
      extensionId: entry.definition.manifest.id,
      contributionId,
      phase,
      message,
      cause,
    }
    entry.lastFailure = failure
    try {
      this.options.onFailure?.(failure)
    }
    catch {
      // Host observers cannot break extension isolation.
    }
    return { ok: false, error: failure }
  }

  private failureResult<T = never>(
    extensionId: string,
    phase: ExtensionFailurePhase,
    message: string,
    contributionId?: string,
  ): ExtensionResult<T> {
    return {
      ok: false,
      error: { extensionId, contributionId, phase, message },
    }
  }

  private info(entry: RegisteredExtension): ExtensionInfo {
    return {
      manifest: entry.definition.manifest,
      status: entry.status,
      grantedPermissions: Object.freeze([...entry.grantedPermissions]),
      lastFailure: entry.lastFailure,
    }
  }
}
