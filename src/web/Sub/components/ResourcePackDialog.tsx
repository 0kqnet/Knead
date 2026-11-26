import React, { useEffect, useState } from 'react'
import { Box, Button, Flex, Text } from '@yamada-ui/react'
import { useTranslation } from 'react-i18next'
import {
  MAX_EMBEDDED_CUSTOM_AUDIO_PROJECT_BYTES,
  type EmbeddedCustomAudioAsset,
} from '../types/timeline'
import type { ResourcePackSound } from '../utils/resourcePack'
import {
  mergeResourcePackCustomAudio,
  parseResourcePackArchive,
  prepareResourcePackInstall,
  type ParsedResourcePack,
} from '../utils/resourcePackImport'
import { restoreProjectCustomAudio } from '../utils/projectCustomAudio'
import { useModalDialog } from '../hooks/useModalDialog'

export interface ResourcePackInstallSummary {
  packs: { label: string, packFormat?: number }[]
  soundCount: number
  variantCount: number
  assetCount: number
  warnings: string[]
  /** Resolved Minecraft variant metadata, without the archive bytes. */
  sounds: ResourcePackSound[]
}

export interface ResourcePackDialogProps {
  open: boolean
  existingCustomAudio: readonly EmbeddedCustomAudioAsset[]
  /** Decoded reference-track bytes already consuming the shared 96 MiB budget. */
  referenceAudioBytes?: number
  onInstall: (
    assets: readonly EmbeddedCustomAudioAsset[],
    summary: Readonly<ResourcePackInstallSummary>,
  ) => void | Promise<void>
  onClose: () => void
}

const MAX_RESOURCE_PACK_BASE64_CHARS = Math.ceil(64 * 1024 * 1024 / 3) * 4

function decodeBase64(value: string): Uint8Array {
  if (!value || value.length > MAX_RESOURCE_PACK_BASE64_CHARS) {
    throw new Error('Resource-pack ZIP exceeds the 64 MiB archive limit')
  }
  let binary: string
  try {
    binary = atob(value)
  }
  catch {
    throw new Error('Desktop host returned invalid resource-pack data')
  }
  const data = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) data[index] = binary.charCodeAt(index)
  return data
}

function move<T>(values: readonly T[], from: number, to: number): T[] {
  if (to < 0 || to >= values.length || from === to) return [...values]
  const next = [...values]
  const [value] = next.splice(from, 1)
  next.splice(to, 0, value)
  return next
}

export const ResourcePackDialog: React.FC<ResourcePackDialogProps> = ({
  open,
  existingCustomAudio,
  referenceAudioBytes = 0,
  onInstall,
  onClose,
}) => {
  const { t } = useTranslation()
  const [packs, setPacks] = useState<ParsedResourcePack[]>([])
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [warnings, setWarnings] = useState<string[]>([])
  const { dialogRef } = useModalDialog({ open, busy, onClose })

  useEffect(() => {
    if (!open) return
    setPacks([])
    setMessage('')
    setWarnings([])
  }, [open])

  if (!open) return null

  const addPack = async () => {
    setBusy(true)
    setMessage('')
    try {
      const opened = await window.myAPI.resourcePack.open()
      if (!opened.ok) {
        if (!('canceled' in opened)) setMessage(t('studio.resource_pack_error', { error: opened.error }))
        return
      }
      const parsed = await parseResourcePackArchive(decodeBase64(opened.dataBase64), opened.path)
      if (packs.some(pack => pack.fingerprint === parsed.fingerprint)) {
        setMessage(t('studio.resource_pack_duplicate', { name: parsed.label }))
        return
      }
      setPacks(previous => [...previous, parsed])
      setWarnings(parsed.warnings)
      setMessage(t('studio.resource_pack_added', {
        name: parsed.label,
        sounds: parsed.manifests.length,
        assets: parsed.audio.length,
      }))
    }
    catch (error) {
      setMessage(t('studio.resource_pack_error', {
        error: error instanceof Error ? error.message : String(error),
      }))
    }
    finally {
      setBusy(false)
    }
  }

  const install = async () => {
    setBusy(true)
    setMessage('')
    try {
      const plan = await prepareResourcePackInstall(packs)
      if (!plan.assets.length) throw new Error(t('studio.resource_pack_no_playable'))
      const merged = mergeResourcePackCustomAudio(existingCustomAudio, plan)
      const customBytes = merged.reduce((total, asset) => total + asset.byteLength, 0)
      if (!Number.isSafeInteger(referenceAudioBytes) || referenceAudioBytes < 0
        || customBytes + referenceAudioBytes > MAX_EMBEDDED_CUSTOM_AUDIO_PROJECT_BYTES) {
        throw new Error(t('studio.resource_pack_budget_error'))
      }

      // Keep runtime and timeline state in lockstep. If the host update fails,
      // restore the exact previous registry before surfacing the error.
      await restoreProjectCustomAudio(merged)
      const summary: ResourcePackInstallSummary = {
        packs: packs.map(pack => ({ label: pack.label, packFormat: pack.packFormat })),
        soundCount: plan.soundIds.length,
        variantCount: plan.variantCount,
        assetCount: plan.assets.length,
        warnings: plan.warnings,
        sounds: plan.sounds,
      }
      try {
        await onInstall(merged, summary)
      }
      catch (error) {
        await restoreProjectCustomAudio(existingCustomAudio)
        throw error
      }
      setWarnings(plan.warnings)
      setMessage(t('studio.resource_pack_installed', {
        packs: packs.length,
        sounds: plan.soundIds.length,
        variants: plan.variantCount,
      }))
    }
    catch (error) {
      setMessage(t('studio.resource_pack_error', {
        error: error instanceof Error ? error.message : String(error),
      }))
    }
    finally {
      setBusy(false)
    }
  }

  return (
    <Box
      position="fixed" inset="0" zIndex="2150" bg="rgba(0,0,0,.78)"
      display="flex" alignItems="center" justifyContent="center"
      onPointerDown={(event) => { if (event.target === event.currentTarget && !busy) onClose() }}
    >
      <Box
        ref={dialogRef} role="dialog" aria-modal="true" aria-label={t('studio.resource_pack_title')} tabIndex={-1}
        w="720px" maxW="calc(100vw - 32px)" maxH="calc(100vh - 32px)" overflowY="auto"
        bg="var(--studio-panel)" borderRadius="lg" boxShadow="xl" p="5"
      >
        <Flex align="start" gap="3">
          <Box>
            <Text fontSize="xl" fontWeight="bold">{t('studio.resource_pack_title')}</Text>
            <Text fontSize="sm" color="var(--studio-muted)">{t('studio.resource_pack_description')}</Text>
          </Box>
          <Box flex="1" />
          <Button size="sm" onClick={onClose} disabled={busy}>×</Button>
        </Flex>

        <Box mt="5" p="4" bg="var(--studio-frame)" borderRadius="md">
          <Flex align="center" gap="3">
            <Box flex="1">
              <Text fontWeight="bold">{t('studio.resource_pack_layers')}</Text>
              <Text fontSize="xs" color="var(--studio-muted)">{t('studio.resource_pack_priority_hint')}</Text>
            </Box>
            <Button data-dialog-initial-focus colorScheme="cyan" onClick={addPack} loading={busy}>
              {t('studio.resource_pack_add')}
            </Button>
          </Flex>

          {!packs.length && (
            <Text mt="4" p="4" textAlign="center" fontSize="sm" color="var(--studio-muted)">
              {t('studio.resource_pack_empty')}
            </Text>
          )}
          <Flex mt={packs.length ? '3' : '0'} direction="column" gap="2">
            {packs.map((pack, index) => (
              <Flex
                key={pack.fingerprint} align="center" gap="2" p="3"
                border="1px solid" borderColor="var(--studio-line)" borderRadius="md"
              >
                <Text minW="28px" fontSize="xs" color="var(--studio-muted)">{index + 1}</Text>
                <Box flex="1" minW="0">
                  <Text
                    fontSize="sm" fontWeight="bold" overflow="hidden"
                    textOverflow="ellipsis" whiteSpace="nowrap"
                  >
                    {pack.label}
                  </Text>
                  <Text fontSize="xs" color="var(--studio-muted)">
                    {t('studio.resource_pack_layer_summary', {
                      format: pack.packFormat ?? '?',
                      manifests: pack.manifests.length,
                      assets: pack.audio.length,
                    })}
                  </Text>
                </Box>
                <Button
                  size="xs" aria-label={t('studio.resource_pack_move_lower')}
                  onClick={() => setPacks(previous => move(previous, index, index - 1))}
                  disabled={busy || index === 0}
                >
                  ↑
                </Button>
                <Button
                  size="xs" aria-label={t('studio.resource_pack_move_higher')}
                  onClick={() => setPacks(previous => move(previous, index, index + 1))}
                  disabled={busy || index === packs.length - 1}
                >
                  ↓
                </Button>
                <Button
                  size="xs" colorScheme="red" variant="outline"
                  aria-label={t('studio.resource_pack_remove', { name: pack.label })}
                  onClick={() => setPacks(previous => previous.filter(item => item.fingerprint !== pack.fingerprint))}
                  disabled={busy}
                >
                  ×
                </Button>
              </Flex>
            ))}
          </Flex>
        </Box>

        {warnings.length > 0 && (
          <Box mt="4" p="3" bg="orange.900" borderRadius="md">
            <Text mb="1" fontSize="xs" fontWeight="bold">
              {t('studio.resource_pack_warnings', { count: warnings.length })}
            </Text>
            {warnings.slice(0, 20).map(warning => (
              <Text key={warning} fontSize="xs">
                •
                {' '}
                {warning}
              </Text>
            ))}
            {warnings.length > 20 && (
              <Text mt="1" fontSize="xs">{t('studio.resource_pack_more_warnings', { count: warnings.length - 20 })}</Text>
            )}
          </Box>
        )}
        {message && (
          <Text
            mt="4" fontSize="sm"
            color={message.includes('Error') || message.includes('エラー') || message.includes('失敗') ? 'red.300' : 'green.300'}
          >
            {message}
          </Text>
        )}
        <Flex mt="5" justify="flex-end" gap="3">
          <Button onClick={onClose} disabled={busy}>{t('studio.close')}</Button>
          <Button colorScheme="green" onClick={install} loading={busy} disabled={!packs.length}>
            {t('studio.resource_pack_install')}
          </Button>
        </Flex>
      </Box>
    </Box>
  )
}
