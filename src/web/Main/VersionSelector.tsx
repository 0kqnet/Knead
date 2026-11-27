import React from 'react'
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import {
  Box, Button, ChevronDownIcon, CircleCheckIcon, DownloadIcon, HStack, Text,
} from '@yamada-ui/react'
import { useAddDispatch, useAppSelector } from '../../store/_store'
import { updateSoundList, updateTargetVersion } from '../../store/fetchSlice'
import { VersionInfoType, compareReleaseVersionInfo, compareSnapshotVersionInfo, comparePreReleaseVersionInfo, compareReleaseCandidateVersionInfo, parseVersion } from '../../types/VersionInfo'
import { useTranslation } from 'react-i18next'
import { List, type ListImperativeAPI, type RowComponentProps } from 'react-window'
import type { AssetDownloadProgress } from '../../../@types/global'

type AvailableVersion = VersionInfoType & {
  downloaded: boolean
}

type VersionRow =
  | { type: 'heading', label: string }
  | { type: 'version', version: AvailableVersion }

type VersionRowData = {
  activeIndex: number
  listId: string
  rows: VersionRow[]
  selectedVersion: string
  onActivate: (index: number) => void
  onSelect: (version: string) => void
}

type VirtualVersionSelectProps = {
  disabled: boolean
  placeholder: string
  rows: VersionRow[]
  value: string
  onChange: (version: string) => void
}

const VERSION_ROW_HEIGHT = 32
const VERSION_LIST_HEIGHT = VERSION_ROW_HEIGHT * 8

const VersionStatusIcon = ({ downloaded }: { downloaded: boolean }) => downloaded
  ? <CircleCheckIcon aria-hidden color="var(--studio-success)" boxSize="14px" />
  : <DownloadIcon aria-hidden color="var(--studio-muted)" boxSize="14px" />

function VirtualVersionRow({ index, style, data }: RowComponentProps<{ data: VersionRowData }>) {
  const row = data.rows[index]
  if (row.type === 'heading') {
    return (
      <Box
        style={style}
        color="var(--studio-muted)"
        fontSize="xs"
        fontWeight="semibold"
        paddingX={3}
        paddingY={2}
        role="presentation"
      >
        {row.label}
      </Box>
    )
  }

  const selected = row.version.raw === data.selectedVersion
  const active = index === data.activeIndex
  return (
    <HStack
      aria-selected={selected}
      id={`${data.listId}-${index}`}
      className="knead-option"
      data-active={active}
      onClick={() => data.onSelect(row.version.raw)}
      onMouseEnter={() => data.onActivate(index)}
      role="option"
      style={style}
      title={row.version.raw}
      userSelect="none"
    >
      <VersionStatusIcon downloaded={row.version.downloaded} />
      <Text overflow="hidden" textOverflow="ellipsis" whiteSpace="nowrap">
        {row.version.raw}
      </Text>
    </HStack>
  )
}

const VirtualVersionSelect = ({ disabled, placeholder, rows, value, onChange }: VirtualVersionSelectProps) => {
  const listId = useId()
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<ListImperativeAPI>(null)
  const selectedVersion = useMemo(() => {
    const row = rows.find((row): row is Extract<VersionRow, { type: 'version' }> => {
      return row.type === 'version' && row.version.raw === value
    })
    return row?.version
  }, [rows, value])

  const firstVersionIndex = useMemo(() => rows.findIndex(row => row.type === 'version'), [rows])
  const selectedIndex = useMemo(() => rows.findIndex((row) => {
    return row.type === 'version' && row.version.raw === value
  }), [rows, value])

  const activate = useCallback((index: number) => {
    setActiveIndex(index)
    listRef.current?.scrollToRow({ index, align: 'smart' })
  }, [])

  const openList = useCallback(() => {
    const nextIndex = selectedIndex >= 0 ? selectedIndex : Math.max(0, firstVersionIndex)
    setActiveIndex(nextIndex)
    setOpen(true)
    requestAnimationFrame(() => listRef.current?.scrollToRow({ index: nextIndex, align: 'smart' }))
  }, [firstVersionIndex, selectedIndex])

  const selectVersion = useCallback((version: string) => {
    onChange(version)
    setOpen(false)
  }, [onChange])

  const moveActive = useCallback((direction: 1 | -1) => {
    let nextIndex = activeIndex
    do {
      nextIndex += direction
    } while (nextIndex >= 0 && nextIndex < rows.length && rows[nextIndex].type !== 'version')
    if (nextIndex < 0 || nextIndex >= rows.length) return
    activate(nextIndex)
  }, [activate, activeIndex, rows])

  useEffect(() => {
    if (!open) return
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    window.addEventListener('mousedown', closeOnOutsideClick)
    return () => window.removeEventListener('mousedown', closeOnOutsideClick)
  }, [open])

  useEffect(() => {
    if (disabled) setOpen(false)
  }, [disabled])

  const rowData = useMemo<VersionRowData>(() => ({
    activeIndex,
    listId,
    rows,
    selectedVersion: value,
    onActivate: activate,
    onSelect: selectVersion,
  }), [activeIndex, activate, listId, rows, selectVersion, value])

  return (
    <Box ref={containerRef} position="relative" width="14rem" zIndex={open ? 100 : undefined}>
      <Button
        className="knead-select-trigger"
        role="combobox"
        aria-label={placeholder}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open ? `${listId}-${activeIndex}` : undefined}
        aria-expanded={open}
        aria-haspopup="listbox"
        disabled={disabled || firstVersionIndex < 0}
        endIcon={<ChevronDownIcon aria-hidden className="knead-select-chevron" transform={open ? 'rotate(180deg)' : undefined} />}
        justifyContent="space-between"
        onClick={() => open ? setOpen(false) : openList()}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            if (!open) {
              openList()
            }
            else {
              moveActive(event.key === 'ArrowDown' ? 1 : -1)
            }
          }
          else if (event.key === 'Enter' && open) {
            event.preventDefault()
            const row = rows[activeIndex]
            if (row?.type === 'version') selectVersion(row.version.raw)
          }
          else if (event.key === 'Escape' && open) {
            event.preventDefault()
            setOpen(false)
          }
          else if (event.key === 'Tab' && open) {
            setOpen(false)
          }
        }}
        variant="subtle"
        width="full"
      >
        <HStack gap={2} minW={0}>
          {selectedVersion && <VersionStatusIcon downloaded={selectedVersion.downloaded} />}
          <Text color={selectedVersion ? undefined : 'var(--studio-muted)'} overflow="hidden" textOverflow="ellipsis" whiteSpace="nowrap">
            {selectedVersion?.raw ?? placeholder}
          </Text>
        </HStack>
      </Button>
      {open && rows.length > 0 && (
        <Box
          className="knead-popup"
          id={listId}
          aria-label={placeholder}
          left={0}
          overflow="hidden"
          position="absolute"
          role="listbox"
          top="calc(100% + 4px)"
          width="full"
          zIndex={50}
        >
          <List
            listRef={listRef}
            style={{ height: Math.min(rows.length * VERSION_ROW_HEIGHT, VERSION_LIST_HEIGHT), width: '100%' }}
            rowCount={rows.length}
            rowHeight={VERSION_ROW_HEIGHT}
            rowComponent={VirtualVersionRow}
            rowProps={{ data: rowData }}
            rowKey={(index) => {
              const row = rows[index]
              return row.type === 'heading' ? `heading-${row.label}` : row.version.raw
            }}
            overscanCount={3}
          />
        </Box>
      )}
    </Box>
  )
}

export const VersionSelector = () => {
  const { t } = useTranslation()
  const dispatch = useAddDispatch()

  const [versions, setVersions] = useState<AvailableVersion[]>([])
  const savedVersion = useAppSelector(state => state.fetch.targetVersion?.raw ?? '')
  const [requestedVersion, setRequestedVersion] = useState('')
  const versionToLoad = requestedVersion || savedVersion
  const loadedVersion = useRef('')
  const [isDownloading, setIsDownloading] = useState(false)
  const [downloadProgress, setDownloadProgress] = useState<AssetDownloadProgress | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const availableVersions = await window.myAPI.get_versions()
        if (cancelled) return
        const parsedVersions = availableVersions.flatMap(({ id, downloaded }) => {
          const parsed = parseVersion(id)
          return parsed ? [{ ...parsed, downloaded } as AvailableVersion] : []
        })
        setVersions(parsedVersions)
      }
      catch (e: unknown) {
        alert(e)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!versionToLoad || versionToLoad === loadedVersion.current) return
    let cancelled = false
    void (async () => {
      setIsDownloading(true)
      setDownloadProgress(null)
      let stopListening: (() => void) | undefined
      try {
        stopListening = await window.myAPI.onAssetDownloadProgress((progress) => {
          if (!cancelled && progress.version === versionToLoad) {
            setDownloadProgress(progress)
          }
        })
        if (cancelled) return
        await window.myAPI.downloadVersionAssets(versionToLoad)
        if (cancelled) return
        const sounds = await window.myAPI.get_mcSounds(versionToLoad)
        if (cancelled) return
        const selectedVersion = parseVersion(versionToLoad)
        await window.myAPI.updateSettings({ selectedVersion })
        if (!cancelled) {
          loadedVersion.current = versionToLoad
          dispatch(updateTargetVersion({ targetVersion: selectedVersion }))
          setVersions(versions => versions.map((version) => {
            return version.raw === versionToLoad ? { ...version, downloaded: true } : version
          }))
          dispatch(updateSoundList({ sounds }))
        }
      }
      catch (e: unknown) {
        if (!cancelled) {
          alert(e)
        }
      }
      finally {
        stopListening?.()
        if (!cancelled) {
          setIsDownloading(false)
          setRequestedVersion('')
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [versionToLoad, requestedVersion, dispatch])

  const versionRows = useMemo<VersionRow[]>(() => {
    const major_versions = versions.filter(v => v.kind === 'release').sort(compareReleaseVersionInfo).reverse()
    const snapshot_versions = versions.filter(v => v.kind === 'snapshot').sort(compareSnapshotVersionInfo).reverse()
    const pre_versions = versions.filter(v => v.kind === 'pre-release').sort(comparePreReleaseVersionInfo).reverse()
    const rc_versions = versions.filter(v => v.kind === 'release-candidate').sort(compareReleaseCandidateVersionInfo).reverse()
    return [
      { type: 'heading', label: t('release_version') },
      ...major_versions.map(version => ({ type: 'version', version }) as const),
      { type: 'heading', label: t('snapshot_version') },
      ...[...rc_versions, ...pre_versions, ...snapshot_versions].map(version => ({ type: 'version', version }) as const),
    ]
  }, [t, versions])

  return (
    <HStack gap={2}>
      <VirtualVersionSelect
        disabled={isDownloading}
        onChange={(version) => { if (version !== loadedVersion.current) setRequestedVersion(version) }}
        placeholder={t('version_select')}
        rows={versionRows}
        value={versionToLoad}
      />
      {isDownloading && (
        <HStack gap={1} whiteSpace="nowrap">
          <Text fontSize="sm">
            {downloadProgress
              ? t('asset_downloading_progress', {
                  completed: downloadProgress.completedAssets,
                  total: downloadProgress.totalAssets,
                })
              : t('asset_downloading')}
          </Text>
        </HStack>
      )}
    </HStack>
  )
}
