import './Studio.css'
import React, { useCallback, useEffect, useState } from 'react'
import { useAddDispatch, useAppSelector } from '../../store/_store'
import { updateSoundList, updateTargetVersion } from '../../store/fetchSlice'
import { StudioWorkspace } from './components/StudioWorkspace'
import { VersionInfoType } from '../../types/VersionInfo'

export const SubApp = () => {
  const dispatch = useAddDispatch()
  const targetVersion = useAppSelector(s => s.fetch.targetVersion)

  useEffect(() => {
    ;(async () => {
      const version = await window.myAPI.getSetting('selectedVersion')
      if (version) dispatch(updateTargetVersion({ targetVersion: version as VersionInfoType }))
      else {
        const list = await window.myAPI.getCurrentSounds()
        if (Array.isArray(list)) dispatch(updateSoundList({ sounds: list }))
      }
    })()
  }, [dispatch])

  const activateTargetVersion = useCallback(async (version: string) => {
    const list = await window.myAPI.get_mcSounds(version)
    dispatch(updateSoundList({ sounds: list }))
  }, [dispatch])

  const [mainSelectedId, setMainSelectedId] = useState<string>('')
  useEffect(() => {
    const fetchMainSelectedId = async () => {
      const id = await window.myAPI.getMainSelectedSound()
      setMainSelectedId(id)
    }
    fetchMainSelectedId()
    const interval = setInterval(fetchMainSelectedId, 1000)
    return () => clearInterval(interval)
  }, [])

  return (
    <StudioWorkspace
      defaultSoundId={mainSelectedId}
      defaultTargetVersion={targetVersion?.raw}
      activateTargetVersion={activateTargetVersion}
    />
  )
}
