import { useEffect, useState } from 'react'

import {
  DEFAULT_SHORTCUT_SETTINGS,
  SHORTCUT_ACTION_IDS,
  copyShortcutSettings,
  findShortcutSettingsIssue,
  shortcutBindingFromKeyboardInput,
  type ShortcutActionId,
  type ShortcutSettings
} from '../../../../shared/shortcut-settings'
import './shortcut-settings-panel.css'

const SHORTCUT_ACTION_LABELS: Record<ShortcutActionId, string> = {
  'new-session': '新建对话',
  'focus-composer': '聚焦 Composer',
  'open-settings': '打开设置',
  'open-model-selector': '打开模型选择器',
  'reload-session': '重载当前对话',
  'previous-project': '上一个项目',
  'next-project': '下一个项目',
  'previous-session': '上一个对话',
  'next-session': '下一个对话',
  'archive-session': '归档当前对话',
  'copy-last-answer': '复制最后一条 Assistant 最终回答'
}

type ShortcutSettingsPanelProps = {
  settings: ShortcutSettings
  onSave: (settings: ShortcutSettings) => Promise<void>
  onRecordingChange: (recording: boolean) => void
}

export function ShortcutSettingsPanel({
  settings,
  onSave,
  onRecordingChange
}: ShortcutSettingsPanelProps): React.JSX.Element {
  const [recordingActionId, setRecordingActionId] = useState<ShortcutActionId | null>(null)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{
    kind: 'error' | 'status'
    text: string
  } | null>(null)

  useEffect(() => {
    onRecordingChange(recordingActionId !== null)
    return () => onRecordingChange(false)
  }, [onRecordingChange, recordingActionId])

  useEffect(() => {
    if (recordingActionId === null) return
    const handleKeyDown = (event: KeyboardEvent): void => {
      event.preventDefault()
      event.stopPropagation()
      if (event.key === 'Escape') {
        setRecordingActionId(null)
        setMessage({ kind: 'status', text: '已取消快捷键录入。' })
        return
      }
      if (event.isComposing || event.keyCode === 229) return

      const binding = shortcutBindingFromKeyboardInput(event)
      if (binding === null) {
        if (event.key === 'Control' || event.key === 'Alt' || event.key === 'Shift') return
        setMessage({
          kind: 'error',
          text: '该按键组合无效。请使用 Ctrl 或 Alt 配合非编辑按键。'
        })
        return
      }

      const nextSettings = copyShortcutSettings(settings)
      nextSettings[recordingActionId] = binding
      const issue = findShortcutSettingsIssue(nextSettings)
      if (issue !== null) {
        setMessage({ kind: 'error', text: shortcutIssueMessage(issue) })
        return
      }
      setRecordingActionId(null)
      void saveSettings(nextSettings)
    }
    document.addEventListener('keydown', handleKeyDown, true)
    return () => document.removeEventListener('keydown', handleKeyDown, true)
  }, [recordingActionId, settings])

  async function saveSettings(nextSettings: ShortcutSettings): Promise<void> {
    const issue = findShortcutSettingsIssue(nextSettings)
    if (issue !== null) {
      setMessage({ kind: 'error', text: shortcutIssueMessage(issue) })
      return
    }
    setSaving(true)
    setMessage(null)
    try {
      await onSave(nextSettings)
      setMessage({ kind: 'status', text: '快捷键已保存。' })
    } catch {
      setMessage({ kind: 'error', text: '快捷键保存失败，请重试。' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <div className="settings-section-heading settings-section-heading-with-action">
        <h2>快捷键</h2>
        <button
          className="shortcut-restore-defaults"
          type="button"
          disabled={saving}
          onClick={() => {
            setRecordingActionId(null)
            void saveSettings(copyShortcutSettings(DEFAULT_SHORTCUT_SETTINGS))
          }}
        >
          恢复默认
        </button>
      </div>

      <section
        className="settings-group settings-group-inline settings-prefs"
        aria-labelledby="shortcut-settings-heading"
      >
        <h3 id="shortcut-settings-heading" className="settings-group-heading">应用快捷键</h3>
        <div className="settings-group-card">
          {SHORTCUT_ACTION_IDS.map((actionId) => {
            const recording = recordingActionId === actionId
            const binding = settings[actionId]
            return (
              <div className="settings-row" key={actionId}>
                <div className="settings-row-copy">
                  <h4>{SHORTCUT_ACTION_LABELS[actionId]}</h4>
                  {binding === null ? <p>未绑定</p> : <p className="shortcut-binding">{binding}</p>}
                </div>
                <div className="settings-row-control shortcut-settings-actions">
                  <button
                    className={recording ? 'recording' : ''}
                    type="button"
                    aria-pressed={recording}
                    disabled={saving}
                    onClick={() => {
                      setMessage(null)
                      setRecordingActionId(recording ? null : actionId)
                    }}
                  >
                    {recording ? '请按下一组快捷键…' : binding === null ? '录入' : '更改'}
                  </button>
                  <button
                    className="shortcut-clear"
                    type="button"
                    disabled={saving || binding === null}
                    onClick={() => {
                      setRecordingActionId(null)
                      const nextSettings = copyShortcutSettings(settings)
                      nextSettings[actionId] = null
                      void saveSettings(nextSettings)
                    }}
                  >
                    清除
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      </section>

      {recordingActionId === null ? null : (
        <p className="shortcut-recording-help" role="status">
          正在录入“{SHORTCUT_ACTION_LABELS[recordingActionId]}”。按 Escape 取消。
        </p>
      )}
      {message === null ? null : (
        <p
          className={`shortcut-settings-message ${message.kind}`}
          role={message.kind === 'error' ? 'alert' : 'status'}
        >
          {message.text}
        </p>
      )}
    </>
  )
}

function shortcutIssueMessage(
  issue: NonNullable<ReturnType<typeof findShortcutSettingsIssue>>
): string {
  if (issue.type === 'duplicate-binding') {
    return `${issue.binding} 已用于“${SHORTCUT_ACTION_LABELS[issue.conflictingActionId]}”，请选择其他组合。`
  }
  if (issue.type === 'reserved-binding') {
    return `${issue.binding} 是系统或文本编辑保留组合，不能使用。`
  }
  return '该按键组合无效。请使用 Ctrl 或 Alt 配合非编辑按键。'
}
