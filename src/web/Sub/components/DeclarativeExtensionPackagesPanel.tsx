import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Box, Button, Flex, Text } from '@yamada-ui/react'
import type { TimelineState } from '../types/timeline'
import {
  EXTENSION_PERMISSIONS,
  INSTALLED_EXTENSIONS_SETTING,
  MAX_EXTENSION_PACKAGE_BYTES,
  MAX_INSTALLED_EXTENSION_PACKAGES,
  compileDeclarativeExtensionPackage,
  createInstalledExtension,
  extensionPackageFileName,
  packageValidationMessage,
  parseDeclarativeExtensionPackage,
  parseInstalledExtensionStore,
  serializeDeclarativeExtensionPackage,
  serializeInstalledExtensionStore,
  type DeclarativeExtensionPackage,
  type ExtensionPermission,
  type ExtensionRegistry,
  type InstalledDeclarativeExtension,
} from '../extensions'

const DECLARATIVE_IDS_BY_REGISTRY = new WeakMap<ExtensionRegistry, Set<string>>()

function declarativeIds(registry: ExtensionRegistry): Set<string> {
  const existing = DECLARATIVE_IDS_BY_REGISTRY.get(registry)
  if (existing) return existing
  const created = new Set<string>()
  DECLARATIVE_IDS_BY_REGISTRY.set(registry, created)
  return created
}

interface Feedback {
  readonly tone: 'error' | 'success' | 'info'
  readonly text: string
}

interface Props {
  registry: ExtensionRegistry
  project: TimelineState
  selectedMarkerIds: readonly string[]
  onApply: (nextState: TimelineState, nextSelectedIds?: readonly string[]) => void | Promise<void>
  onRegistryChanged: () => void
  onFeedback: (feedback: Feedback) => void
  onBusyChange: (busy: boolean) => void
}

const PERMISSION_LABELS: Record<ExtensionPermission, string> = {
  'timeline.read': 'Read project timeline',
  'timeline.transform': 'Replace explicitly selected items',
  'selection.read': 'Read the current selection',
  'notifications': 'Show local notifications',
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function resultMessage(result: Awaited<ReturnType<ExtensionRegistry['activate']>>): string {
  return result.ok ? '' : `${result.error.phase}: ${result.error.message}`
}

function transformedSelection(
  previous: TimelineState,
  next: TimelineState,
  selectedIds: readonly string[],
): readonly string[] {
  const selected = new Set(selectedIds)
  const untouchedIds = new Set(previous.markers.filter(marker => !selected.has(marker.id)).map(marker => marker.id))
  return next.markers.filter(marker => !untouchedIds.has(marker.id)).map(marker => marker.id)
}

function downloadPackage(extensionPackage: DeclarativeExtensionPackage): void {
  const blob = new Blob([serializeDeclarativeExtensionPackage(extensionPackage)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = extensionPackageFileName(extensionPackage)
  link.click()
  URL.revokeObjectURL(url)
}

function requestedPermissions(extensionPackage: DeclarativeExtensionPackage): readonly ExtensionPermission[] {
  return [
    ...extensionPackage.manifest.permissions.required,
    ...(extensionPackage.manifest.permissions.optional ?? []),
  ]
}

export const DeclarativeExtensionPackagesPanel: React.FC<Props> = ({
  registry,
  project,
  selectedMarkerIds,
  onApply,
  onRegistryChanged,
  onFeedback,
  onBusyChange,
}) => {
  const [records, setRecords] = useState<readonly InstalledDeclarativeExtension[]>([])
  const [packageJson, setPackageJson] = useState('')
  const [pendingPackage, setPendingPackage] = useState<DeclarativeExtensionPackage | null>(null)
  const [pendingGrants, setPendingGrants] = useState<ReadonlySet<ExtensionPermission>>(new Set())
  const [busy, setBusy] = useState<string | null>('loading')
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const packageIds = declarativeIds(registry)

  const selectedTrackIds = useMemo(() => {
    const selected = new Set(selectedMarkerIds)
    return [...new Set(project.markers.filter(marker => selected.has(marker.id)).map(marker => marker.trackId))]
  }, [project.markers, selectedMarkerIds])

  useEffect(() => {
    onBusyChange(busy !== null)
    return () => onBusyChange(false)
  }, [busy, onBusyChange])

  const persist = (next: readonly InstalledDeclarativeExtension[]) => {
    setRecords(next)
    if ('myAPI' in window) {
      window.myAPI.setSetting(INSTALLED_EXTENSIONS_SETTING, serializeInstalledExtensionStore(next))
    }
  }

  useEffect(() => {
    let alive = true
    const load = async () => {
      let saved: unknown
      try {
        saved = 'myAPI' in window
          ? await window.myAPI.getSetting(INSTALLED_EXTENSIONS_SETTING)
          : undefined
      }
      catch (error) {
        if (alive) onFeedback({ tone: 'error', text: `Extension storage: ${errorMessage(error)}` })
      }
      if (!alive) return
      const loaded = parseInstalledExtensionStore(typeof saved === 'string' ? saved : undefined)
      const warnings = [...loaded.warnings]
      const accepted: InstalledDeclarativeExtension[] = []
      for (const record of loaded.records) {
        if (!alive) return
        try {
          const id = record.package.manifest.id
          const existing = registry.get(id)
          if (existing && !packageIds.has(id)) throw new Error(`Extension id ${id} collides with a trusted extension`)
          if (!existing) {
            const definition = compileDeclarativeExtensionPackage(record.package)
            registry.register(definition, record.grantedPermissions)
            packageIds.add(id)
          }
          const lifecycle = record.enabled
            ? await registry.activate(id)
            : await registry.deactivate(id)
          const enabled = registry.get(id)?.status === 'active'
          accepted.push(lifecycle.ok ? record : { ...record, enabled })
          if (!lifecycle.ok) warnings.push(resultMessage(lifecycle))
        }
        catch (error) {
          warnings.push(`${record.package.manifest.id} was isolated: ${errorMessage(error)}`)
        }
      }
      if (!alive) return
      setRecords(accepted)
      setBusy(null)
      onRegistryChanged()
      if (warnings.length > 0) {
        onFeedback({ tone: 'info', text: `Extension recovery: ${warnings.join('; ')}` })
      }
    }
    void load()
    return () => {
      alive = false
    }
  }, [onFeedback, onRegistryChanged, packageIds, registry])

  const validateImport = (text: string) => {
    const parsed = parseDeclarativeExtensionPackage(text)
    if (!parsed.ok) {
      setPendingPackage(null)
      onFeedback({ tone: 'error', text: `Package rejected: ${packageValidationMessage(parsed.issues)}` })
      return
    }
    const id = parsed.package.manifest.id
    if (registry.get(id)) {
      setPendingPackage(null)
      onFeedback({ tone: 'error', text: `Package id ${id} collides with an installed or built-in extension.` })
      return
    }
    setPendingPackage(parsed.package)
    setPendingGrants(new Set(parsed.package.manifest.permissions.required))
    onFeedback({
      tone: 'info',
      text: `${parsed.package.manifest.name} validated (${parsed.byteLength} bytes). Review permissions before installation.`,
    })
  }

  const installPending = () => {
    if (!pendingPackage || busy) return
    if (records.length >= MAX_INSTALLED_EXTENSION_PACKAGES) {
      onFeedback({ tone: 'error', text: `At most ${MAX_INSTALLED_EXTENSION_PACKAGES} third-party packages can be installed.` })
      return
    }
    setBusy('install')
    try {
      const grants = [...pendingGrants]
      const record = createInstalledExtension(pendingPackage, grants)
      registry.register(compileDeclarativeExtensionPackage(pendingPackage), grants)
      packageIds.add(pendingPackage.manifest.id)
      persist([...records, record])
      onRegistryChanged()
      onFeedback({ tone: 'success', text: `${pendingPackage.manifest.name} installed disabled. Enable it when ready.` })
      setPendingPackage(null)
      setPackageJson('')
    }
    catch (error) {
      onFeedback({ tone: 'error', text: `Install failed: ${errorMessage(error)}` })
    }
    finally {
      setBusy(null)
    }
  }

  const togglePackage = async (record: InstalledDeclarativeExtension) => {
    const id = record.package.manifest.id
    if (busy) return
    setBusy(`toggle:${id}`)
    try {
      const result = record.enabled ? await registry.deactivate(id) : await registry.activate(id)
      if (!result.ok) onFeedback({ tone: 'error', text: resultMessage(result) })
      else {
        persist(records.map(candidate => candidate === record ? { ...candidate, enabled: !record.enabled } : candidate))
        onFeedback({ tone: 'info', text: `${record.package.manifest.name} ${record.enabled ? 'disabled' : 'enabled'}.` })
      }
      onRegistryChanged()
    }
    catch (error) {
      onFeedback({ tone: 'error', text: `Lifecycle failed: ${errorMessage(error)}` })
    }
    finally {
      setBusy(null)
    }
  }

  const changeGrant = async (
    record: InstalledDeclarativeExtension,
    permission: ExtensionPermission,
    granted: boolean,
  ) => {
    const id = record.package.manifest.id
    if (busy) return
    setBusy(`permission:${id}`)
    try {
      if (record.enabled) {
        const deactivated = await registry.deactivate(id)
        if (!deactivated.ok) throw new Error(resultMessage(deactivated))
      }
      const grants = granted
        ? [...record.grantedPermissions, permission]
        : record.grantedPermissions.filter(candidate => candidate !== permission)
      const result = registry.setGrantedPermissions(id, grants)
      if (!result.ok) throw new Error(`${result.error.phase}: ${result.error.message}`)
      persist(records.map(candidate => candidate === record
        ? createInstalledExtension(candidate.package, grants, false)
        : candidate))
      onRegistryChanged()
      onFeedback({
        tone: 'info',
        text: `${PERMISSION_LABELS[permission]} ${granted ? 'granted' : 'revoked'}; extension is disabled.`,
      })
    }
    catch (error) {
      onFeedback({ tone: 'error', text: `Permission change failed: ${errorMessage(error)}` })
    }
    finally {
      setBusy(null)
    }
  }

  const removePackage = async (record: InstalledDeclarativeExtension) => {
    const id = record.package.manifest.id
    if (confirmRemoveId !== id) {
      setConfirmRemoveId(id)
      return
    }
    if (busy) return
    setBusy(`remove:${id}`)
    try {
      const result = await registry.unregister(id)
      if (!result.ok && registry.get(id)) throw new Error(resultMessage(result))
      packageIds.delete(id)
      persist(records.filter(candidate => candidate !== record))
      onRegistryChanged()
      setConfirmRemoveId(null)
      onFeedback({
        tone: result.ok ? 'success' : 'info',
        text: result.ok
          ? `${record.package.manifest.name} removed from this device.`
          : `${record.package.manifest.name} removed; cleanup reported ${resultMessage(result)}.`,
      })
    }
    catch (error) {
      onFeedback({ tone: 'error', text: `Remove failed: ${errorMessage(error)}` })
    }
    finally {
      setBusy(null)
    }
  }

  const runCommand = async (record: InstalledDeclarativeExtension, contributionId: string) => {
    const id = record.package.manifest.id
    if (busy) return
    setBusy(`run:${id}:${contributionId}`)
    try {
      const result = await registry.executeCommandById(id, contributionId, {}, {
        project,
        selection: { markerIds: selectedMarkerIds, trackIds: selectedTrackIds },
      })
      if (!result.ok) throw new Error(`${result.error.phase}: ${result.error.message}`)
      const messages = (result.value as { messages?: unknown }).messages
      onFeedback({ tone: 'success', text: Array.isArray(messages) ? messages.join(' · ') : 'Command completed.' })
    }
    catch (error) {
      onFeedback({ tone: 'error', text: `Command failed: ${errorMessage(error)}` })
    }
    finally {
      setBusy(null)
      onRegistryChanged()
    }
  }

  const runMarkerTransform = async (record: InstalledDeclarativeExtension, contributionId: string) => {
    const id = record.package.manifest.id
    if (busy || selectedMarkerIds.length === 0) return
    setBusy(`run:${id}:${contributionId}`)
    try {
      const result = await registry.executeMarkerTransformById(
        id,
        contributionId,
        {},
        { project, markerIds: selectedMarkerIds },
      )
      if (!result.ok) throw new Error(`${result.error.phase}: ${result.error.message}`)
      const nextSelection = transformedSelection(project, result.value, selectedMarkerIds)
      await onApply(result.value, nextSelection)
      onFeedback({ tone: 'success', text: `${contributionId} transformed ${nextSelection.length} marker(s).` })
    }
    catch (error) {
      onFeedback({ tone: 'error', text: `Transform failed: ${errorMessage(error)}` })
    }
    finally {
      setBusy(null)
      onRegistryChanged()
    }
  }

  const runTrackTransform = async (record: InstalledDeclarativeExtension, contributionId: string) => {
    const id = record.package.manifest.id
    if (busy || selectedTrackIds.length === 0) return
    setBusy(`run:${id}:${contributionId}`)
    try {
      const result = await registry.executeTrackTransformById(
        id,
        contributionId,
        {},
        { project, trackIds: selectedTrackIds },
      )
      if (!result.ok) throw new Error(`${result.error.phase}: ${result.error.message}`)
      await onApply(result.value, selectedMarkerIds)
      onFeedback({ tone: 'success', text: `${contributionId} transformed ${selectedTrackIds.length} track(s).` })
    }
    catch (error) {
      onFeedback({ tone: 'error', text: `Transform failed: ${errorMessage(error)}` })
    }
    finally {
      setBusy(null)
      onRegistryChanged()
    }
  }

  const importFile = async (file: File | undefined) => {
    if (!file) return
    if (file.size > MAX_EXTENSION_PACKAGE_BYTES) {
      onFeedback({ tone: 'error', text: `Package file exceeds ${MAX_EXTENSION_PACKAGE_BYTES} bytes.` })
      return
    }
    try {
      const text = await file.text()
      setPackageJson(text)
      validateImport(text)
    }
    catch (error) {
      onFeedback({ tone: 'error', text: `Package file could not be read: ${errorMessage(error)}` })
    }
  }

  return (
    <Box mt="4" p="4" bg="gray.900" borderRadius="lg" border="1px solid" borderColor="purple.700">
      <Text fontWeight="bold">Declarative Extension Packages</Text>
      <Text fontSize="xs" color="gray.400">
        Install local JSON packages built from a fixed transform/command DSL. Packages cannot contain or execute JavaScript.
      </Text>

      <Flex mt="3" gap="2" align="start" wrap="wrap">
        <textarea
          aria-label="Extension package JSON"
          value={packageJson}
          onChange={event => setPackageJson(event.target.value)}
          placeholder="Paste a .knead-extension.json package here"
          style={{
            minWidth: '280px', minHeight: '82px', flex: 1, padding: '8px', borderRadius: '6px',
            color: 'white', background: '#171923', border: '1px solid #4a5568', fontFamily: 'monospace',
          }}
        />
        <Flex direction="column" gap="2">
          <Button size="sm" onClick={() => validateImport(packageJson)} isDisabled={!packageJson.trim() || busy !== null}>
            Validate JSON
          </Button>
          <Button size="sm" variant="outline" onClick={() => fileInput.current?.click()} isDisabled={busy !== null}>
            Import File
          </Button>
          <input
            ref={fileInput}
            type="file"
            accept=".json,.knead-extension.json,application/json"
            aria-label="Import extension package file"
            style={{ display: 'none' }}
            onChange={event => void importFile(event.target.files?.[0])}
          />
        </Flex>
      </Flex>

      {pendingPackage && (
        <Box mt="3" p="3" bg="gray.800" borderRadius="md" data-testid="package-install-preview">
          <Text fontWeight="bold">
            {pendingPackage.manifest.name}
            {' v'}
            {pendingPackage.manifest.version}
          </Text>
          <Text fontSize="xs" color="gray.400">{pendingPackage.manifest.id}</Text>
          <Text mt="2" fontSize="xs">Approve requested permissions:</Text>
          {requestedPermissions(pendingPackage).map(permission => (
            <label key={permission} style={{ display: 'block', fontSize: '12px', marginTop: '4px' }}>
              <input
                type="checkbox"
                checked={pendingGrants.has(permission)}
                onChange={(event) => {
                  const next = new Set(pendingGrants)
                  if (event.target.checked) next.add(permission)
                  else next.delete(permission)
                  setPendingGrants(next)
                }}
              />
              {' '}
              {PERMISSION_LABELS[permission]}
              {pendingPackage.manifest.permissions.required.includes(permission) ? ' (required)' : ' (optional)'}
            </label>
          ))}
          <Button mt="3" size="sm" colorScheme="purple" onClick={installPending} isLoading={busy === 'install'}>
            Install Package
          </Button>
        </Box>
      )}

      {busy === 'loading' && <Text mt="3" fontSize="xs">Loading installed packages…</Text>}
      {busy !== 'loading' && records.length === 0 && (
        <Text mt="3" fontSize="xs" color="gray.500">No third-party packages installed.</Text>
      )}

      {records.map((record) => {
        const extensionPackage = record.package
        const id = extensionPackage.manifest.id
        const info = registry.get(id)
        const isActive = info?.status === 'active'
        return (
          <Box
            key={id} mt="3" p="3" bg="gray.800" borderRadius="md"
            data-extension-package={id} data-testid={`extension-package-${id}`}
          >
            <Flex align="center" gap="2" wrap="wrap">
              <Box flex="1" minW="220px">
                <Text fontWeight="bold">{extensionPackage.manifest.name}</Text>
                <Text fontSize="xs" color="gray.400">
                  {id}
                  {' · v'}
                  {extensionPackage.manifest.version}
                  {' · schema 1'}
                </Text>
              </Box>
              <Text fontSize="xs" color={isActive ? 'green.300' : 'gray.400'}>{info?.status ?? 'inactive'}</Text>
              <Button size="xs" onClick={() => void togglePackage(record)} isDisabled={busy !== null}>
                {isActive ? 'Disable' : 'Enable'}
              </Button>
              <Button
                size="xs" variant="outline" isDisabled={busy !== null}
                onClick={() => {
                  try {
                    downloadPackage(extensionPackage)
                    onFeedback({ tone: 'success', text: `${extensionPackage.manifest.name} exported.` })
                  }
                  catch (error) {
                    onFeedback({ tone: 'error', text: `Export failed: ${errorMessage(error)}` })
                  }
                }}
              >
                Export
              </Button>
              <Button size="xs" colorScheme="red" onClick={() => void removePackage(record)} isDisabled={busy !== null}>
                {confirmRemoveId === id ? 'Confirm Remove' : 'Remove'}
              </Button>
            </Flex>

            <Box mt="2">
              {requestedPermissions(extensionPackage).map(permission => (
                <label key={permission} style={{ display: 'inline-block', fontSize: '11px', marginRight: '12px' }}>
                  <input
                    type="checkbox"
                    checked={record.grantedPermissions.includes(permission)}
                    disabled={busy !== null}
                    onChange={event => void changeGrant(record, permission, event.target.checked)}
                  />
                  {' '}
                  {permission}
                </label>
              ))}
            </Box>

            {info?.lastFailure && (
              <Text mt="2" fontSize="xs" color="red.300">
                Last failure:
                {' '}
                {info.lastFailure.phase}
                :
                {' '}
                {info.lastFailure.message}
              </Text>
            )}

            <Flex mt="2" gap="2" wrap="wrap">
              {extensionPackage.contributes.commands?.map(contribution => (
                <Button
                  key={contribution.id} size="xs" colorScheme="blue"
                  isDisabled={!isActive || busy !== null}
                  onClick={() => void runCommand(record, contribution.id)}
                >
                  Run
                  {' '}
                  {contribution.name}
                </Button>
              ))}
              {extensionPackage.contributes.markerTransforms?.map(contribution => (
                <Button
                  key={contribution.id} size="xs" colorScheme="cyan"
                  isDisabled={!isActive || busy !== null || selectedMarkerIds.length === 0}
                  onClick={() => void runMarkerTransform(record, contribution.id)}
                >
                  Apply
                  {' '}
                  {contribution.name}
                </Button>
              ))}
              {extensionPackage.contributes.trackTransforms?.map(contribution => (
                <Button
                  key={contribution.id} size="xs" colorScheme="green"
                  isDisabled={!isActive || busy !== null || selectedTrackIds.length === 0}
                  onClick={() => void runTrackTransform(record, contribution.id)}
                >
                  Apply
                  {' '}
                  {contribution.name}
                </Button>
              ))}
            </Flex>
          </Box>
        )
      })}

      <Text mt="3" fontSize="xs" color="orange.300">
        Security boundary: JSON packages are interpreted by host-owned operations only. They are not process, filesystem,
        network, Web Worker, or arbitrary-code sandboxes because no package code is loaded at all.
      </Text>
      <Text fontSize="xs" color="gray.500">
        Supported permissions:
        {' '}
        {(EXTENSION_PERMISSIONS as readonly string[]).join(', ')}
      </Text>
    </Box>
  )
}
