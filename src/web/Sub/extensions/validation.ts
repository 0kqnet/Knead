import {
  EXTENSION_API_VERSION,
  EXTENSION_CAPABILITIES,
  EXTENSION_PERMISSIONS,
  type ExtensionCapability,
  type ExtensionCommandContribution,
  type ExtensionDefinition,
  type ExtensionPermission,
  type MarkerTransformContribution,
  type TrackTransformContribution,
} from './types'

const EXTENSION_ID_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9][a-z0-9-]*)+$/
const CONTRIBUTION_ID_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
const MAX_CONTRIBUTIONS_PER_KIND = 256

export interface ExtensionValidationIssue {
  readonly path: string
  readonly message: string
}

export type ExtensionDefinitionValidation =
  | { readonly ok: true, readonly definition: ExtensionDefinition }
  | { readonly ok: false, readonly issues: readonly ExtensionValidationIssue[] }

export class ExtensionDefinitionError extends Error {
  readonly issues: readonly ExtensionValidationIssue[]

  constructor(issues: readonly ExtensionValidationIssue[]) {
    super(issues.map(issue => `${issue.path}: ${issue.message}`).join('; '))
    this.name = 'ExtensionDefinitionError'
    this.issues = issues
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isKnownPermission(value: unknown): value is ExtensionPermission {
  return typeof value === 'string' && (EXTENSION_PERMISSIONS as readonly string[]).includes(value)
}

function isKnownCapability(value: unknown): value is ExtensionCapability {
  return typeof value === 'string' && (EXTENSION_CAPABILITIES as readonly string[]).includes(value)
}

function validateShortText(
  value: unknown,
  path: string,
  issues: ExtensionValidationIssue[],
  maximumLength: number,
  required: boolean,
): void {
  if (value === undefined && !required) return
  if (typeof value !== 'string' || (required && value.trim().length === 0)) {
    issues.push({ path, message: required ? 'must be a non-empty string' : 'must be a string' })
    return
  }
  if (value.length > maximumLength) issues.push({ path, message: `must be at most ${maximumLength} characters` })
}

function validatePermissionList(
  value: unknown,
  path: string,
  issues: ExtensionValidationIssue[],
): ExtensionPermission[] {
  if (!Array.isArray(value)) {
    issues.push({ path, message: 'must be an array' })
    return []
  }
  const result: ExtensionPermission[] = []
  const seen = new Set<string>()
  value.forEach((permission, index) => {
    if (!isKnownPermission(permission)) {
      issues.push({ path: `${path}[${index}]`, message: `unknown permission ${JSON.stringify(permission)}` })
      return
    }
    if (seen.has(permission)) {
      issues.push({ path: `${path}[${index}]`, message: `duplicate permission ${permission}` })
      return
    }
    seen.add(permission)
    result.push(permission)
  })
  return result
}

function validateContributionBase(
  value: unknown,
  path: string,
  requestedPermissions: ReadonlySet<ExtensionPermission>,
  issues: ExtensionValidationIssue[],
): value is Record<string, unknown> {
  if (!isRecord(value)) {
    issues.push({ path, message: 'must be an object' })
    return false
  }
  if (typeof value.id !== 'string' || !CONTRIBUTION_ID_PATTERN.test(value.id) || value.id.length > 80) {
    issues.push({ path: `${path}.id`, message: 'must be a lowercase contribution id (maximum 80 characters)' })
  }
  validateShortText(value.name, `${path}.name`, issues, 120, true)
  validateShortText(value.description, `${path}.description`, issues, 1000, false)
  const permissions = validatePermissionList(value.requiredPermissions, `${path}.requiredPermissions`, issues)
  permissions.forEach((permission) => {
    if (!requestedPermissions.has(permission)) {
      issues.push({
        path: `${path}.requiredPermissions`,
        message: `${permission} is not requested by the manifest`,
      })
    }
  })
  return true
}

function validateContributionArray(
  value: unknown,
  kind: 'commands' | 'markerTransforms' | 'trackTransforms',
  requestedPermissions: ReadonlySet<ExtensionPermission>,
  ids: Set<string>,
  issues: ExtensionValidationIssue[],
): number {
  if (value === undefined) return 0
  if (!Array.isArray(value)) {
    issues.push({ path: `contributes.${kind}`, message: 'must be an array' })
    return 0
  }
  if (value.length > MAX_CONTRIBUTIONS_PER_KIND) {
    issues.push({ path: `contributes.${kind}`, message: `cannot contain more than ${MAX_CONTRIBUTIONS_PER_KIND} entries` })
  }

  value.forEach((contribution, index) => {
    const path = `contributes.${kind}[${index}]`
    if (!validateContributionBase(contribution, path, requestedPermissions, issues)) return
    const id = typeof contribution.id === 'string' ? contribution.id : ''
    if (ids.has(id)) issues.push({ path: `${path}.id`, message: `duplicate contribution id ${JSON.stringify(id)}` })
    else if (id) ids.add(id)

    if (kind === 'commands') {
      if (contribution.kind !== 'command') issues.push({ path: `${path}.kind`, message: 'must be command' })
      if (typeof contribution.validateInput !== 'function') issues.push({ path: `${path}.validateInput`, message: 'must be a function' })
      if (contribution.validateOutput !== undefined && typeof contribution.validateOutput !== 'function') {
        issues.push({ path: `${path}.validateOutput`, message: 'must be a function when provided' })
      }
      if (typeof contribution.execute !== 'function') issues.push({ path: `${path}.execute`, message: 'must be a function' })
      return
    }

    const expectedKind = kind === 'markerTransforms' ? 'markerTransform' : 'trackTransform'
    if (contribution.kind !== expectedKind) issues.push({ path: `${path}.kind`, message: `must be ${expectedKind}` })
    if (typeof contribution.validateOptions !== 'function') issues.push({ path: `${path}.validateOptions`, message: 'must be a function' })
    if (typeof contribution.transform !== 'function') issues.push({ path: `${path}.transform`, message: 'must be a function' })

    const permissions = Array.isArray(contribution.requiredPermissions)
      ? new Set(contribution.requiredPermissions)
      : new Set()
    for (const permission of ['timeline.read', 'timeline.transform', 'selection.read'] as const) {
      if (!permissions.has(permission)) {
        issues.push({ path: `${path}.requiredPermissions`, message: `${permission} is required for transforms` })
      }
    }
  })
  return value.length
}

export function validateExtensionDefinition(value: unknown): ExtensionDefinitionValidation {
  const issues: ExtensionValidationIssue[] = []
  if (!isRecord(value)) return { ok: false, issues: [{ path: '$', message: 'must be an object' }] }
  if (!isRecord(value.manifest)) return { ok: false, issues: [{ path: 'manifest', message: 'must be an object' }] }

  const manifest = value.manifest
  if (manifest.apiVersion !== EXTENSION_API_VERSION) {
    issues.push({
      path: 'manifest.apiVersion',
      message: `unsupported API version ${JSON.stringify(manifest.apiVersion)}; expected ${EXTENSION_API_VERSION}`,
    })
  }
  if (typeof manifest.id !== 'string' || !EXTENSION_ID_PATTERN.test(manifest.id) || manifest.id.length > 120) {
    issues.push({ path: 'manifest.id', message: 'must be a namespaced lowercase id such as vendor.extension' })
  }
  validateShortText(manifest.name, 'manifest.name', issues, 120, true)
  validateShortText(manifest.description, 'manifest.description', issues, 2000, false)
  validateShortText(manifest.author, 'manifest.author', issues, 200, false)
  if (typeof manifest.version !== 'string' || !SEMVER_PATTERN.test(manifest.version)) {
    issues.push({ path: 'manifest.version', message: 'must be a valid semantic version' })
  }
  if (manifest.homepage !== undefined) {
    if (typeof manifest.homepage !== 'string' || manifest.homepage.length > 2048) {
      issues.push({ path: 'manifest.homepage', message: 'must be a URL string no longer than 2048 characters' })
    }
    else {
      try {
        const url = new URL(manifest.homepage)
        if (url.protocol !== 'https:' && url.protocol !== 'http:') {
          issues.push({ path: 'manifest.homepage', message: 'must use http or https' })
        }
      }
      catch {
        issues.push({ path: 'manifest.homepage', message: 'must be a valid URL' })
      }
    }
  }

  let requiredPermissions: ExtensionPermission[] = []
  let optionalPermissions: ExtensionPermission[] = []
  if (!isRecord(manifest.permissions)) {
    issues.push({ path: 'manifest.permissions', message: 'must be an object' })
  }
  else {
    requiredPermissions = validatePermissionList(manifest.permissions.required, 'manifest.permissions.required', issues)
    optionalPermissions = validatePermissionList(manifest.permissions.optional ?? [], 'manifest.permissions.optional', issues)
    const requiredSet = new Set(requiredPermissions)
    optionalPermissions.forEach((permission) => {
      if (requiredSet.has(permission)) {
        issues.push({ path: 'manifest.permissions.optional', message: `${permission} is already required` })
      }
    })
  }
  const requestedPermissions = new Set([...requiredPermissions, ...optionalPermissions])

  const declaredCapabilities = new Set<ExtensionCapability>()
  if (!Array.isArray(manifest.capabilities)) {
    issues.push({ path: 'manifest.capabilities', message: 'must be an array' })
  }
  else {
    manifest.capabilities.forEach((capability, index) => {
      if (!isKnownCapability(capability)) {
        issues.push({ path: `manifest.capabilities[${index}]`, message: `unknown capability ${JSON.stringify(capability)}` })
      }
      else if (declaredCapabilities.has(capability)) {
        issues.push({ path: `manifest.capabilities[${index}]`, message: `duplicate capability ${capability}` })
      }
      else declaredCapabilities.add(capability)
    })
  }

  if (value.activate !== undefined && typeof value.activate !== 'function') {
    issues.push({ path: 'activate', message: 'must be a function when provided' })
  }
  if (value.deactivate !== undefined && typeof value.deactivate !== 'function') {
    issues.push({ path: 'deactivate', message: 'must be a function when provided' })
  }

  const counts: Record<ExtensionCapability, number> = {
    commands: 0,
    markerTransforms: 0,
    trackTransforms: 0,
  }
  const ids = new Set<string>()
  if (value.contributes !== undefined && !isRecord(value.contributes)) {
    issues.push({ path: 'contributes', message: 'must be an object when provided' })
  }
  else if (isRecord(value.contributes)) {
    counts.commands = validateContributionArray(value.contributes.commands, 'commands', requestedPermissions, ids, issues)
    counts.markerTransforms = validateContributionArray(value.contributes.markerTransforms, 'markerTransforms', requestedPermissions, ids, issues)
    counts.trackTransforms = validateContributionArray(value.contributes.trackTransforms, 'trackTransforms', requestedPermissions, ids, issues)
  }

  for (const capability of EXTENSION_CAPABILITIES) {
    const declared = declaredCapabilities.has(capability)
    const provided = counts[capability] > 0
    if (provided && !declared) {
      issues.push({ path: 'manifest.capabilities', message: `${capability} must be declared for its contributions` })
    }
    if (declared && !provided) {
      issues.push({ path: 'manifest.capabilities', message: `${capability} is declared but has no contributions` })
    }
  }

  return issues.length > 0
    ? { ok: false, issues }
    : { ok: true, definition: value as unknown as ExtensionDefinition }
}

export function getCommands(definition: ExtensionDefinition): readonly ExtensionCommandContribution[] {
  return definition.contributes?.commands ?? []
}

export function getMarkerTransforms(definition: ExtensionDefinition): readonly MarkerTransformContribution[] {
  return definition.contributes?.markerTransforms ?? []
}

export function getTrackTransforms(definition: ExtensionDefinition): readonly TrackTransformContribution[] {
  return definition.contributes?.trackTransforms ?? []
}
