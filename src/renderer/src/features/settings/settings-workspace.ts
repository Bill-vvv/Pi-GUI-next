import { useCallback, useRef, useState } from 'react'

import type { SettingsSection } from './SettingsNavigation'

export type SettingsPageLifecycle = {
  dirty: boolean
  activeOperation: boolean
}

type ConfirmSettingsLeave = (message: string) => boolean

const EMPTY_PAGE_LIFECYCLE: SettingsPageLifecycle = {
  dirty: false,
  activeOperation: false
}

function confirmSettingsLeave(message: string): boolean {
  return window.confirm(message)
}

export function hasUnsavedSettingsDraft<T>(draft: T | null, baseline: T | null): boolean {
  return draft !== null &&
    baseline !== null &&
    JSON.stringify(draft) !== JSON.stringify(baseline)
}

export function settingsLeaveConfirmation(
  lifecycle: SettingsPageLifecycle
): string | null {
  if (lifecycle.dirty && lifecycle.activeOperation) {
    return '当前设置有尚未保存的修改，且登录仍在进行。离开将放弃修改并取消登录，是否继续？'
  }
  if (lifecycle.dirty) return '放弃尚未保存的设置修改？'
  if (lifecycle.activeOperation) return '登录仍在进行。离开设置会取消登录，是否继续？'
  return null
}

export function canLeaveSettingsPage(
  lifecycle: SettingsPageLifecycle,
  confirmLeave: ConfirmSettingsLeave
): boolean {
  const message = settingsLeaveConfirmation(lifecycle)
  return message === null || confirmLeave(message)
}

export function useSettingsWorkspace(): {
  settingsOpen: boolean
  settingsSection: SettingsSection
  openSettings: () => void
  requestSectionChange: (nextSection: SettingsSection) => boolean
  requestCloseSettings: () => boolean
  onDirtyChange: (dirty: boolean) => void
  onActiveOperationChange: (active: boolean) => void
} {
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('general')
  const pageLifecycleRef = useRef<SettingsPageLifecycle>(EMPTY_PAGE_LIFECYCLE)

  const resetPageLifecycle = useCallback(() => {
    pageLifecycleRef.current = EMPTY_PAGE_LIFECYCLE
  }, [])
  const onDirtyChange = useCallback((dirty: boolean) => {
    pageLifecycleRef.current = {
      ...pageLifecycleRef.current,
      dirty
    }
  }, [])
  const onActiveOperationChange = useCallback((activeOperation: boolean) => {
    pageLifecycleRef.current = {
      ...pageLifecycleRef.current,
      activeOperation
    }
  }, [])
  const openSettings = useCallback(() => {
    setSettingsOpen(true)
  }, [])
  const requestSectionChange = useCallback((nextSection: SettingsSection): boolean => {
    if (nextSection === settingsSection) return true
    if (!canLeaveSettingsPage(pageLifecycleRef.current, confirmSettingsLeave)) return false
    resetPageLifecycle()
    setSettingsSection(nextSection)
    return true
  }, [resetPageLifecycle, settingsSection])
  const requestCloseSettings = useCallback((): boolean => {
    if (!canLeaveSettingsPage(pageLifecycleRef.current, confirmSettingsLeave)) return false
    resetPageLifecycle()
    setSettingsOpen(false)
    return true
  }, [resetPageLifecycle])

  return {
    settingsOpen,
    settingsSection,
    openSettings,
    requestSectionChange,
    requestCloseSettings,
    onDirtyChange,
    onActiveOperationChange
  }
}
