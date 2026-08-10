import {
  EXTENSION_PERMISSIONS,
  type ExtensionPermission,
} from './types'
import {
  MAX_EXTENSION_PACKAGE_BYTES,
  MAX_INSTALLED_EXTENSION_PACKAGES,
  type InstalledDeclarativeExtension,
  type InstalledExtensionStore,
  type InstalledExtensionStoreLoadResult,
  type DeclarativeExtensionPackage,
} from './packageTypes'
import {
  serializeDeclarativeExtensionPackage,
  validateDeclarativeExtensionPackage,
} from './packageValidation'

export const INSTALLED_EXTENSIONS_SETTING = 'studioDeclarativeExtensionPackages'
export const MAX_EXTENSION_STORE_BYTES = MAX_EXTENSION_PACKAGE_BYTES * MAX_INSTALLED_EXTENSION_PACKAGES

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeGrants(
  extensionPackage: DeclarativeExtensionPackage,
  value: unknown,
): { grants: readonly ExtensionPermission[], warning?: string } {
  if (!Array.isArray(value)) return { grants: [], warning: 'grantedPermissions is not an array' }
  const requested = new Set<ExtensionPermission>([
    ...extensionPackage.manifest.permissions.required,
    ...(extensionPackage.manifest.permissions.optional ?? []),
  ])
  const grants: ExtensionPermission[] = []
  const seen = new Set<string>()
  for (const candidate of value) {
    if (
      typeof candidate !== 'string'
      || !(EXTENSION_PERMISSIONS as readonly string[]).includes(candidate)
      || !requested.has(candidate as ExtensionPermission)
      || seen.has(candidate)
    ) {
      return { grants: [], warning: `invalid permission grant ${JSON.stringify(candidate)}` }
    }
    seen.add(candidate)
    grants.push(candidate as ExtensionPermission)
  }
  return { grants }
}

export function createInstalledExtension(
  extensionPackage: DeclarativeExtensionPackage,
  grantedPermissions: readonly ExtensionPermission[],
  enabled = false,
): InstalledDeclarativeExtension {
  const validated = validateDeclarativeExtensionPackage(extensionPackage)
  if (!validated.ok) throw new Error(validated.issues.map(issue => `${issue.path}: ${issue.message}`).join('; '))
  const normalized = normalizeGrants(validated.package, grantedPermissions)
  if (normalized.warning) throw new Error(normalized.warning)
  const requiredGranted = validated.package.manifest.permissions.required.every(permission => (
    normalized.grants.includes(permission)
  ))
  if (enabled && !requiredGranted) throw new Error('Enabled extension is missing a required permission grant')
  return {
    package: validated.package,
    grantedPermissions: normalized.grants,
    enabled,
  }
}

export function parseInstalledExtensionStore(text: string | null | undefined): InstalledExtensionStoreLoadResult {
  if (!text) return { records: [], warnings: [] }
  const byteLength = new TextEncoder().encode(text).byteLength
  if (byteLength > MAX_EXTENSION_STORE_BYTES) {
    return { records: [], warnings: [`Extension store exceeds ${MAX_EXTENSION_STORE_BYTES} bytes`] }
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  }
  catch (error) {
    return { records: [], warnings: [`Extension store JSON is invalid: ${error instanceof Error ? error.message : String(error)}`] }
  }
  if (
    !isRecord(value)
    || value.format !== 'knead-installed-extensions'
    || value.version !== 1
    || !Array.isArray(value.packages)
  ) {
    return { records: [], warnings: ['Extension store envelope is invalid'] }
  }
  const warnings: string[] = []
  const records: InstalledDeclarativeExtension[] = []
  const ids = new Set<string>()
  value.packages.slice(0, MAX_INSTALLED_EXTENSION_PACKAGES).forEach((candidate, index) => {
    if (!isRecord(candidate)) {
      warnings.push(`packages[${index}] is not an object`)
      return
    }
    const validated = validateDeclarativeExtensionPackage(candidate.package)
    if (!validated.ok) {
      warnings.push(`packages[${index}] was ignored: ${validated.issues[0]?.path} ${validated.issues[0]?.message}`)
      return
    }
    const id = validated.package.manifest.id
    if (ids.has(id)) {
      warnings.push(`Duplicate extension ${id} was ignored`)
      return
    }
    const grants = normalizeGrants(validated.package, candidate.grantedPermissions)
    if (grants.warning) {
      warnings.push(`${id} was ignored: ${grants.warning}`)
      return
    }
    let enabled = candidate.enabled === true
    if (candidate.enabled !== true && candidate.enabled !== false) {
      warnings.push(`${id} had an invalid enabled flag and was loaded disabled`)
      enabled = false
    }
    if (enabled && !validated.package.manifest.permissions.required.every(permission => grants.grants.includes(permission))) {
      warnings.push(`${id} was missing required grants and was loaded disabled`)
      enabled = false
    }
    try {
      const packageBytes = new TextEncoder().encode(serializeDeclarativeExtensionPackage(validated.package)).byteLength
      if (packageBytes > MAX_EXTENSION_PACKAGE_BYTES) {
        warnings.push(`${id} exceeds the per-package size budget and was ignored`)
        return
      }
    }
    catch (error) {
      warnings.push(`${id} could not be normalized: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    ids.add(id)
    records.push({ package: validated.package, grantedPermissions: grants.grants, enabled })
  })
  if (value.packages.length > MAX_INSTALLED_EXTENSION_PACKAGES) {
    warnings.push(`Only the first ${MAX_INSTALLED_EXTENSION_PACKAGES} extension packages were considered`)
  }
  return { records, warnings }
}

export function serializeInstalledExtensionStore(
  records: readonly InstalledDeclarativeExtension[],
): string {
  if (records.length > MAX_INSTALLED_EXTENSION_PACKAGES) {
    throw new Error(`Cannot install more than ${MAX_INSTALLED_EXTENSION_PACKAGES} extension packages`)
  }
  const ids = new Set<string>()
  const packages = records.map((record) => {
    const normalized = createInstalledExtension(record.package, record.grantedPermissions, record.enabled)
    const id = normalized.package.manifest.id
    if (ids.has(id)) throw new Error(`Duplicate installed extension ${id}`)
    ids.add(id)
    return normalized
  })
  const store: InstalledExtensionStore = {
    format: 'knead-installed-extensions',
    version: 1,
    packages,
  }
  const text = JSON.stringify(store)
  if (new TextEncoder().encode(text).byteLength > MAX_EXTENSION_STORE_BYTES) {
    throw new Error(`Extension store exceeds ${MAX_EXTENSION_STORE_BYTES} bytes`)
  }
  return text
}

export function extensionPackageFileName(extensionPackage: DeclarativeExtensionPackage): string {
  return `${extensionPackage.manifest.id}-${extensionPackage.manifest.version}.knead-extension.json`
}
