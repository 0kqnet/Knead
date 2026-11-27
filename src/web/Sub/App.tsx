import './Studio.css'
import React, { useCallback, useEffect, useState } from 'react'
import { useAddDispatch, useAppSelector } from '../../store/_store'
import { updateSoundList } from '../../store/fetchSlice'
import { StudioWorkspace } from './components/StudioWorkspace'

export const SubApp = () => {
  const dispatch = useAddDispatch()
  const targetVersion = useAppSelector(s => s.fetch.targetVersion)

  const activateTargetVersion = useCallback(async (version: string, signal: AbortSignal) => {
    const sounds = version ? await window.myAPI.get_mcSounds(version) : await window.myAPI.getCurrentSounds()
    if (!signal.aborted) dispatch(updateSoundList({ sounds }))
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
