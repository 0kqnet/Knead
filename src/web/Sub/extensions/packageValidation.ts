import {
  EXTENSION_API_VERSION,
  EXTENSION_CAPABILITIES,
  EXTENSION_PERMISSIONS,
  type ExtensionCapability,
  type ExtensionManifest,
  type ExtensionPermission,
} from './types'
import {
  DECLARATIVE_EXTENSION_FORMAT,
  DECLARATIVE_EXTENSION_SCHEMA_VERSION,
  MAX_DSL_STEPS,
  MAX_EXTENSION_PACKAGE_BYTES,
  MAX_PACKAGE_CONTRIBUTIONS,
  type DeclarativeCommandAction,
  type DeclarativeCommandContribution,
  type DeclarativeContributionBase,
  type DeclarativeExtensionPackage,
  type DeclarativeMarkerOperation,
  type DeclarativeMarkerTransformContribution,
  type DeclarativePackageParseResult,
  type DeclarativePackageValidation,
  type DeclarativePackageValidationIssue,
  type DeclarativeTrackOperation,
  type DeclarativeTrackTransformContribution,
} from './packageTypes'

const EXTENSION_ID_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9][a-z0-9-]*)+$/
const CONTRIBUTION_ID_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
const SOUND_ID_PATTERN = /^(?:[a-z0-9_.-]+:[a-z0-9_./-]+|[a-z0-9_.-]+(?:\.[a-z0-9_.-]+)+)$/

type Issue = DeclarativePackageValidationIssue
type RecordValue = Record<string, unknown>

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(value: RecordValue, allowed: readonly string[], path: string, issues: Issue[]): void {
  const allowedSet = new Set(allowed)
  Object.keys(value).forEach((key) => {
    if (!allowedSet.has(key)) issues.push({ path: `${path}.${key}`, message: 'unknown field' })
  })
}

function text(
  value: unknown,
  path: string,
  issues: Issue[],
  maximumLength: number,
  required = true,
): value is string {
  if (value === undefined && !required) return false
  if (typeof value !== 'string' || (required && value.trim().length === 0)) {
    issues.push({ path, message: required ? 'must be a non-empty string' : 'must be a string' })
    return false
  }
  if (value.length > maximumLength) issues.push({ path, message: `must be at most ${maximumLength} characters` })
  return true
}

function finite(
  value: unknown,
  path: string,
  issues: Issue[],
  minimum: number,
  maximum: number,
  integer = false,
): value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || (integer && !Number.isInteger(value))) {
    issues.push({ path, message: `must be a ${integer ? 'finite integer' : 'finite number'}` })
    return false
  }
  if (value < minimum || value > maximum) {
    issues.push({ path, message: `must be between ${minimum} and ${maximum}` })
  }
  return true
}

function permissionList(value: unknown, path: string, issues: Issue[]): ExtensionPermission[] {
  if (!Array.isArray(value)) {
    issues.push({ path, message: 'must be an array' })
    return []
  }
  const permissions: ExtensionPermission[] = []
  const seen = new Set<string>()
  value.forEach((candidate, index) => {
    if (typeof candidate !== 'string' || !(EXTENSION_PERMISSIONS as readonly string[]).includes(candidate)) {
      issues.push({ path: `${path}[${index}]`, message: `unknown permission ${JSON.stringify(candidate)}` })
    }
    else if (seen.has(candidate)) {
      issues.push({ path: `${path}[${index}]`, message: `duplicate permission ${candidate}` })
    }
    else {
      seen.add(candidate)
      permissions.push(candidate as ExtensionPermission)
    }
  })
  return permissions
}

function manifest(value: unknown, issues: Issue[]): ExtensionManifest | null {
  if (!isRecord(value)) {
    issues.push({ path: '$.manifest', message: 'must be an object' })
    return null
  }
  hasOnlyKeys(value, [
    'apiVersion', 'id', 'name', 'version', 'description', 'author', 'homepage',
    'permissions', 'capabilities',
  ], '$.manifest', issues)
  if (value.apiVersion !== EXTENSION_API_VERSION) {
    issues.push({ path: '$.manifest.apiVersion', message: `must be ${EXTENSION_API_VERSION}` })
  }
  if (typeof value.id !== 'string' || value.id.length > 120 || !EXTENSION_ID_PATTERN.test(value.id)) {
    issues.push({ path: '$.manifest.id', message: 'must be a namespaced lowercase id such as vendor.extension' })
  }
  text(value.name, '$.manifest.name', issues, 120)
  if (value.description !== undefined) text(value.description, '$.manifest.description', issues, 2000, false)
  if (value.author !== undefined) text(value.author, '$.manifest.author', issues, 200, false)
  if (typeof value.version !== 'string' || !SEMVER_PATTERN.test(value.version)) {
    issues.push({ path: '$.manifest.version', message: 'must be a semantic version' })
  }
  if (value.homepage !== undefined) {
    if (text(value.homepage, '$.manifest.homepage', issues, 2048, false)) {
      try {
        const url = new URL(value.homepage)
        if (!['https:', 'http:'].includes(url.protocol)) {
          issues.push({ path: '$.manifest.homepage', message: 'must use http or https' })
        }
      }
      catch {
        issues.push({ path: '$.manifest.homepage', message: 'must be a valid URL' })
      }
    }
  }

  let required: ExtensionPermission[] = []
  let optional: ExtensionPermission[] = []
  if (!isRecord(value.permissions)) issues.push({ path: '$.manifest.permissions', message: 'must be an object' })
  else {
    hasOnlyKeys(value.permissions, ['required', 'optional'], '$.manifest.permissions', issues)
    required = permissionList(value.permissions.required, '$.manifest.permissions.required', issues)
    optional = permissionList(value.permissions.optional ?? [], '$.manifest.permissions.optional', issues)
    const requiredSet = new Set(required)
    optional.forEach((permission) => {
      if (requiredSet.has(permission)) {
        issues.push({ path: '$.manifest.permissions.optional', message: `${permission} is already required` })
      }
    })
  }

  const capabilities: ExtensionCapability[] = []
  if (!Array.isArray(value.capabilities)) issues.push({ path: '$.manifest.capabilities', message: 'must be an array' })
  else {
    const seen = new Set<string>()
    value.capabilities.forEach((candidate, index) => {
      if (typeof candidate !== 'string' || !(EXTENSION_CAPABILITIES as readonly string[]).includes(candidate)) {
        issues.push({ path: `$.manifest.capabilities[${index}]`, message: `unknown capability ${JSON.stringify(candidate)}` })
      }
      else if (seen.has(candidate)) {
        issues.push({ path: `$.manifest.capabilities[${index}]`, message: `duplicate capability ${candidate}` })
      }
      else {
        seen.add(candidate)
        capabilities.push(candidate as ExtensionCapability)
      }
    })
  }

  if (issues.length > 0) return null
  return {
    apiVersion: EXTENSION_API_VERSION,
    id: value.id as string,
    name: value.name as string,
    version: value.version as string,
    description: value.description as string | undefined,
    author: value.author as string | undefined,
    homepage: value.homepage as string | undefined,
    permissions: { required, optional },
    capabilities,
  }
}

function contributionBase(
  value: RecordValue,
  path: string,
  requested: ReadonlySet<ExtensionPermission>,
  issues: Issue[],
): DeclarativeContributionBase {
  if (typeof value.id !== 'string' || value.id.length > 80 || !CONTRIBUTION_ID_PATTERN.test(value.id)) {
    issues.push({ path: `${path}.id`, message: 'must be a lowercase contribution id (maximum 80 characters)' })
  }
  text(value.name, `${path}.name`, issues, 120)
  if (value.description !== undefined) text(value.description, `${path}.description`, issues, 1000, false)
  const requiredPermissions = permissionList(value.requiredPermissions, `${path}.requiredPermissions`, issues)
  requiredPermissions.forEach((permission) => {
    if (!requested.has(permission)) {
      issues.push({ path: `${path}.requiredPermissions`, message: `${permission} is not requested by the manifest` })
    }
  })
  return {
    id: typeof value.id === 'string' ? value.id : '',
    name: typeof value.name === 'string' ? value.name : '',
    description: typeof value.description === 'string' ? value.description : undefined,
    requiredPermissions,
  }
}

function commandAction(value: unknown, path: string, permissions: ReadonlySet<ExtensionPermission>, issues: Issue[]): DeclarativeCommandAction | null {
  if (!isRecord(value)) {
    issues.push({ path, message: 'must be an object' })
    return null
  }
  if (value.op === 'notify') {
    hasOnlyKeys(value, ['op', 'level', 'message'], path, issues)
    if (!['info', 'success', 'warning', 'error'].includes(value.level as string)) {
      issues.push({ path: `${path}.level`, message: 'must be info, success, warning, or error' })
    }
    text(value.message, `${path}.message`, issues, 500)
    if (!permissions.has('notifications')) issues.push({ path, message: 'notify requires notifications' })
    return { op: 'notify', level: value.level as 'info', message: value.message as string }
  }
  if (value.op === 'projectSummary') {
    hasOnlyKeys(value, ['op'], path, issues)
    if (!permissions.has('timeline.read')) issues.push({ path, message: 'projectSummary requires timeline.read' })
    return { op: 'projectSummary' }
  }
  if (value.op === 'selectionSummary') {
    hasOnlyKeys(value, ['op'], path, issues)
    if (!permissions.has('selection.read')) issues.push({ path, message: 'selectionSummary requires selection.read' })
    return { op: 'selectionSummary' }
  }
  issues.push({ path: `${path}.op`, message: `unknown command operation ${JSON.stringify(value.op)}` })
  return null
}

function markerOperation(value: unknown, path: string, issues: Issue[]): DeclarativeMarkerOperation | null {
  if (!isRecord(value)) {
    issues.push({ path, message: 'must be an object' })
    return null
  }
  switch (value.op) {
    case 'shiftTicks':
      hasOnlyKeys(value, ['op', 'ticks'], path, issues)
      finite(value.ticks, `${path}.ticks`, issues, -1_000_000, 1_000_000, true)
      return { op: value.op, ticks: value.ticks as number }
    case 'quantizeTicks':
      hasOnlyKeys(value, ['op', 'step', 'strength'], path, issues)
      finite(value.step, `${path}.step`, issues, 1, 100_000, true)
      finite(value.strength, `${path}.strength`, issues, 0, 1)
      return { op: value.op, step: value.step as number, strength: value.strength as number }
    case 'transpose':
      hasOnlyKeys(value, ['op', 'semitones'], path, issues)
      finite(value.semitones, `${path}.semitones`, issues, -48, 48)
      return { op: value.op, semitones: value.semitones as number }
    case 'scaleVolume':
      hasOnlyKeys(value, ['op', 'factor'], path, issues)
      finite(value.factor, `${path}.factor`, issues, 0, 4)
      return { op: value.op, factor: value.factor as number }
    case 'setPan':
      hasOnlyKeys(value, ['op', 'pan'], path, issues)
      finite(value.pan, `${path}.pan`, issues, -1, 1)
      return { op: value.op, pan: value.pan as number }
    case 'setLane':
      hasOnlyKeys(value, ['op', 'lane'], path, issues)
      finite(value.lane, `${path}.lane`, issues, 0, 1)
      return { op: value.op, lane: value.lane as number }
    case 'setSound':
      hasOnlyKeys(value, ['op', 'soundId', 'variantIndex'], path, issues)
      if (!text(value.soundId, `${path}.soundId`, issues, 200) || !SOUND_ID_PATTERN.test(value.soundId)) {
        issues.push({ path: `${path}.soundId`, message: 'must be a valid namespaced or dotted sound id' })
      }
      if (value.variantIndex !== undefined) finite(value.variantIndex, `${path}.variantIndex`, issues, -1, 10_000, true)
      return { op: value.op, soundId: value.soundId as string, variantIndex: value.variantIndex as number | undefined }
    case 'duplicate':
      hasOnlyKeys(value, ['op', 'copies', 'intervalTicks', 'semitoneStep', 'volumeDecay'], path, issues)
      finite(value.copies, `${path}.copies`, issues, 1, 16, true)
      finite(value.intervalTicks, `${path}.intervalTicks`, issues, 0, 1_000_000, true)
      finite(value.semitoneStep, `${path}.semitoneStep`, issues, -48, 48)
      finite(value.volumeDecay, `${path}.volumeDecay`, issues, 0, 1)
      return {
        op: value.op,
        copies: value.copies as number,
        intervalTicks: value.intervalTicks as number,
        semitoneStep: value.semitoneStep as number,
        volumeDecay: value.volumeDecay as number,
      }
    default:
      issues.push({ path: `${path}.op`, message: `unknown marker operation ${JSON.stringify(value.op)}` })
      return null
  }
}

function trackOperation(value: unknown, path: string, issues: Issue[]): DeclarativeTrackOperation | null {
  if (!isRecord(value)) {
    issues.push({ path, message: 'must be an object' })
    return null
  }
  switch (value.op) {
    case 'adjustGainDb':
      hasOnlyKeys(value, ['op', 'decibels'], path, issues)
      finite(value.decibels, `${path}.decibels`, issues, -72, 72)
      return { op: value.op, decibels: value.decibels as number }
    case 'setPan':
      hasOnlyKeys(value, ['op', 'pan'], path, issues)
      finite(value.pan, `${path}.pan`, issues, -1, 1)
      return { op: value.op, pan: value.pan as number }
    case 'prefixName':
      hasOnlyKeys(value, ['op', 'prefix'], path, issues)
      text(value.prefix, `${path}.prefix`, issues, 80)
      return { op: value.op, prefix: value.prefix as string }
    case 'setMuted':
    case 'setSolo':
    case 'setLocked':
      hasOnlyKeys(value, ['op', 'value'], path, issues)
      if (typeof value.value !== 'boolean') issues.push({ path: `${path}.value`, message: 'must be boolean' })
      return { op: value.op, value: value.value as boolean }
    default:
      issues.push({ path: `${path}.op`, message: `unknown track operation ${JSON.stringify(value.op)}` })
      return null
  }
}

function steps<T>(
  value: unknown,
  path: string,
  issues: Issue[],
  validate: (candidate: unknown, candidatePath: string, issues: Issue[]) => T | null,
): readonly T[] {
  if (!Array.isArray(value) || value.length === 0) {
    issues.push({ path, message: 'must be a non-empty array' })
    return []
  }
  if (value.length > MAX_DSL_STEPS) issues.push({ path, message: `cannot contain more than ${MAX_DSL_STEPS} steps` })
  return value.flatMap((candidate, index) => {
    const parsed = validate(candidate, `${path}[${index}]`, issues)
    return parsed === null ? [] : [parsed]
  })
}

function contributionArrays(
  value: unknown,
  requested: ReadonlySet<ExtensionPermission>,
  issues: Issue[],
): DeclarativeExtensionPackage['contributes'] {
  if (!isRecord(value)) {
    issues.push({ path: '$.contributes', message: 'must be an object' })
    return {}
  }
  hasOnlyKeys(value, ['commands', 'markerTransforms', 'trackTransforms'], '$.contributes', issues)
  const ids = new Set<string>()
  let total = 0
  const parseArray = <T>(
    source: unknown,
    kind: 'commands' | 'markerTransforms' | 'trackTransforms',
    parseContribution: (entry: RecordValue, path: string, base: DeclarativeContributionBase) => T,
  ): readonly T[] | undefined => {
    if (source === undefined) return undefined
    if (!Array.isArray(source)) {
      issues.push({ path: `$.contributes.${kind}`, message: 'must be an array' })
      return []
    }
    total += source.length
    return source.flatMap((candidate, index) => {
      const path = `$.contributes.${kind}[${index}]`
      if (!isRecord(candidate)) {
        issues.push({ path, message: 'must be an object' })
        return []
      }
      const base = contributionBase(candidate, path, requested, issues)
      if (ids.has(base.id)) issues.push({ path: `${path}.id`, message: `duplicate contribution id ${base.id}` })
      else if (base.id) ids.add(base.id)
      return [parseContribution(candidate, path, base)]
    })
  }

  const commands = parseArray<DeclarativeCommandContribution>(value.commands, 'commands', (entry, path, base) => {
    hasOnlyKeys(entry, ['kind', 'id', 'name', 'description', 'requiredPermissions', 'actions'], path, issues)
    if (entry.kind !== 'command') issues.push({ path: `${path}.kind`, message: 'must be command' })
    const required = new Set(base.requiredPermissions)
    return {
      ...base,
      kind: 'command',
      actions: steps(entry.actions, `${path}.actions`, issues, (candidate, candidatePath, targetIssues) => (
        commandAction(candidate, candidatePath, required, targetIssues)
      )),
    }
  })
  const markerTransforms = parseArray<DeclarativeMarkerTransformContribution>(
    value.markerTransforms,
    'markerTransforms',
    (entry, path, base) => {
      hasOnlyKeys(entry, ['kind', 'id', 'name', 'description', 'requiredPermissions', 'steps'], path, issues)
      if (entry.kind !== 'markerTransform') issues.push({ path: `${path}.kind`, message: 'must be markerTransform' })
      for (const required of ['timeline.read', 'timeline.transform', 'selection.read'] as const) {
        if (!base.requiredPermissions.includes(required)) {
          issues.push({ path: `${path}.requiredPermissions`, message: `${required} is required for transforms` })
        }
      }
      return { ...base, kind: 'markerTransform', steps: steps(entry.steps, `${path}.steps`, issues, markerOperation) }
    },
  )
  const trackTransforms = parseArray<DeclarativeTrackTransformContribution>(
    value.trackTransforms,
    'trackTransforms',
    (entry, path, base) => {
      hasOnlyKeys(entry, ['kind', 'id', 'name', 'description', 'requiredPermissions', 'steps'], path, issues)
      if (entry.kind !== 'trackTransform') issues.push({ path: `${path}.kind`, message: 'must be trackTransform' })
      for (const required of ['timeline.read', 'timeline.transform', 'selection.read'] as const) {
        if (!base.requiredPermissions.includes(required)) {
          issues.push({ path: `${path}.requiredPermissions`, message: `${required} is required for transforms` })
        }
      }
      return { ...base, kind: 'trackTransform', steps: steps(entry.steps, `${path}.steps`, issues, trackOperation) }
    },
  )
  if (total === 0) issues.push({ path: '$.contributes', message: 'must declare at least one contribution' })
  if (total > MAX_PACKAGE_CONTRIBUTIONS) {
    issues.push({ path: '$.contributes', message: `cannot contain more than ${MAX_PACKAGE_CONTRIBUTIONS} contributions` })
  }
  return { commands, markerTransforms, trackTransforms }
}

export function validateDeclarativeExtensionPackage(value: unknown): DeclarativePackageValidation {
  const issues: Issue[] = []
  if (!isRecord(value)) return { ok: false, issues: [{ path: '$', message: 'must be an object' }] }
  hasOnlyKeys(value, ['format', 'schemaVersion', 'manifest', 'contributes'], '$', issues)
  if (value.format !== DECLARATIVE_EXTENSION_FORMAT) {
    issues.push({ path: '$.format', message: `must be ${DECLARATIVE_EXTENSION_FORMAT}` })
  }
  if (value.schemaVersion !== DECLARATIVE_EXTENSION_SCHEMA_VERSION) {
    issues.push({ path: '$.schemaVersion', message: `unsupported schema version ${JSON.stringify(value.schemaVersion)}` })
  }
  const parsedManifest = manifest(value.manifest, issues)
  const requested = new Set<ExtensionPermission>([
    ...(parsedManifest?.permissions.required ?? []),
    ...(parsedManifest?.permissions.optional ?? []),
  ])
  const contributes = contributionArrays(value.contributes, requested, issues)
  if (parsedManifest) {
    const actual = new Set<ExtensionCapability>()
    if ((contributes.commands?.length ?? 0) > 0) actual.add('commands')
    if ((contributes.markerTransforms?.length ?? 0) > 0) actual.add('markerTransforms')
    if ((contributes.trackTransforms?.length ?? 0) > 0) actual.add('trackTransforms')
    for (const capability of EXTENSION_CAPABILITIES) {
      if (parsedManifest.capabilities.includes(capability) !== actual.has(capability)) {
        issues.push({ path: '$.manifest.capabilities', message: `${capability} must exactly match its contributions` })
      }
    }
  }
  if (issues.length > 0 || !parsedManifest) return { ok: false, issues }
  return {
    ok: true,
    package: {
      format: DECLARATIVE_EXTENSION_FORMAT,
      schemaVersion: DECLARATIVE_EXTENSION_SCHEMA_VERSION,
      manifest: parsedManifest,
      contributes,
    },
  }
}

export function parseDeclarativeExtensionPackage(textValue: string): DeclarativePackageParseResult {
  const byteLength = new TextEncoder().encode(textValue).byteLength
  if (byteLength > MAX_EXTENSION_PACKAGE_BYTES) {
    return {
      ok: false,
      issues: [{ path: '$', message: `package is ${byteLength} bytes; maximum is ${MAX_EXTENSION_PACKAGE_BYTES}` }],
    }
  }
  let value: unknown
  try {
    value = JSON.parse(textValue)
  }
  catch (error) {
    return {
      ok: false,
      issues: [{ path: '$', message: `invalid JSON: ${error instanceof Error ? error.message : String(error)}` }],
    }
  }
  const validated = validateDeclarativeExtensionPackage(value)
  return validated.ok
    ? { ok: true, package: validated.package, byteLength }
    : validated
}

export function serializeDeclarativeExtensionPackage(extensionPackage: DeclarativeExtensionPackage): string {
  const validated = validateDeclarativeExtensionPackage(extensionPackage)
  if (!validated.ok) throw new Error(validated.issues.map(issue => `${issue.path}: ${issue.message}`).join('; '))
  const serialized = JSON.stringify(validated.package, null, 2)
  const byteLength = new TextEncoder().encode(serialized).byteLength
  if (byteLength > MAX_EXTENSION_PACKAGE_BYTES) throw new Error(`Package exceeds ${MAX_EXTENSION_PACKAGE_BYTES} bytes`)
  return serialized
}

export function packageValidationMessage(issues: readonly Issue[], maximum = 4): string {
  const displayed = issues.slice(0, maximum).map(issue => `${issue.path}: ${issue.message}`)
  if (issues.length > maximum) displayed.push(`…and ${issues.length - maximum} more`)
  return displayed.join('; ')
}
