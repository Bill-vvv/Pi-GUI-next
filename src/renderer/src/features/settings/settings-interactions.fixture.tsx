import { act, StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'

import type { GeneralSettings as GeneralSettingsValue } from '../../../../shared/kernel-contract'
import { GeneralSettings } from './GeneralSettings'
import { useSettingsConfirm } from './SettingsConfirmDialog'
import '../../tokens.css'
import '../../styles.css'
import './settings.css'

const GENERAL: GeneralSettingsValue = {
  startupWorkspaceRestore: 'restore',
  autoContinueInterruptedTasks: false,
  fastExtensionLoading: false,
  doubleClickBorderMaximize: true
}

function ConfirmHarness({ onResult }: { onResult: (confirmed: boolean) => void }): React.JSX.Element {
  const { confirm, confirmDialog } = useSettingsConfirm()
  return (
    <>
      <button
        type="button"
        id="confirm-trigger"
        onClick={() => {
          void confirm({
            title: '删除「reviewer」？',
            description: '此操作会删除对应的定义文件。',
            confirmLabel: '删除',
            danger: true
          }).then(onResult)
        }}
      >
        删除
      </button>
      {confirmDialog}
    </>
  )
}

function GeneralHarness({
  onSave
}: {
  onSave: (settings: GeneralSettingsValue) => Promise<void>
}): React.JSX.Element {
  const [general, setGeneral] = useState(GENERAL)
  return (
    <GeneralSettings
      general={general}
      sessionNaming={{ mode: 'auto' }}
      availableModels={[]}
      clientOnly={false}
      busy={false}
      onSetGeneral={async (next) => {
        await onSave(next)
        setGeneral(next)
      }}
      onSetSessionNaming={async () => undefined}
    />
  )
}

export async function runSettingsInteractionChecks(): Promise<string[]> {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const checks: string[] = []
  const check = (condition: unknown, label: string): void => {
    if (!condition) throw new Error(label)
    checks.push(label)
  }
  const key = async (value: string, shiftKey = false): Promise<void> => {
    await act(async () => {
      document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', {
        key: value, shiftKey, bubbles: true, cancelable: true
      }))
    })
  }
  const nextFrame = (): Promise<void> => act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  })

  try {
    // Immediate-apply rows report failures on the row that started the save.
    let saves = 0
    let lastSaved: GeneralSettingsValue | null = null
    let failNext = true
    await act(async () => root.render(
      <StrictMode>
        <GeneralHarness
          onSave={async (next) => {
            saves += 1
            lastSaved = next
            if (failNext) throw new Error('磁盘不可写')
          }}
        />
      </StrictMode>
    ))
    const autoContinue = container.querySelector<HTMLInputElement>('#general-auto-continue-interrupted-tasks')!
    check(autoContinue.getAttribute('role') === 'switch' && autoContinue.type === 'checkbox',
      'Immediate on/off setting renders as a native checkbox with the switch role')
    const doubleClick = container.querySelector<HTMLInputElement>('#general-double-click-border-maximize')!
    check(doubleClick.getAttribute('role') === 'switch' && doubleClick.checked &&
      container.querySelector('label[for="general-double-click-border-maximize"]') !== null,
      'Double-click maximize is a labelled switch reflecting the saved value')
    await act(async () => { autoContinue.click() })
    await act(async () => { await Promise.resolve() })
    const row = autoContinue.closest('.settings-row')!
    const alert = row.querySelector('[role="alert"]')
    check(saves === 1 && alert?.textContent?.includes('磁盘不可写') === true,
      'Save failure is shown inside the row that started the save')
    check(container.querySelectorAll('[role="alert"]').length === 1,
      'Other rows stay free of the failure')
    failNext = false
    await act(async () => { doubleClick.click() })
    await act(async () => { await Promise.resolve() })
    check(container.querySelector('[role="alert"]') === null && !doubleClick.checked,
      'A later successful save clears the earlier row failure')
    doubleClick.focus()
    await act(async () => { doubleClick.click() })
    await act(async () => { await Promise.resolve() })
    check(doubleClick.checked && saves === 3, 'Switch toggles again through its native activation')
    const startup = container.querySelector<HTMLElement>('[aria-labelledby="general-startup-workspace-restore-label"]')!
    const segments = [...startup.querySelectorAll<HTMLButtonElement>('button')]
    check(startup.getAttribute('role') === 'group' &&
      document.getElementById('general-startup-workspace-restore-label')?.textContent === '启动后显示' &&
      segments.map((button) => button.getAttribute('aria-pressed')).join() === 'true,false',
      'Short choices render as a labelled pressed-button group')
    check(startup.getBoundingClientRect().right <= window.innerWidth && startup.scrollWidth <= startup.clientWidth + 1,
      'Segmented choice fits the row without horizontal overflow')
    await act(async () => { segments[1]!.click() })
    await act(async () => { await Promise.resolve() })
    check(saves === 4 && (lastSaved as GeneralSettingsValue | null)?.startupWorkspaceRestore === 'none' &&
      segments[1]!.getAttribute('aria-pressed') === 'true',
      'Choosing a segment saves once and moves the pressed state')
    await act(async () => { segments[1]!.click() })
    check(saves === 4, 'Choosing the current segment does not save again')
    await act(async () => root.unmount())

    // In-app confirmation replaces window.confirm.
    const results: boolean[] = []
    const confirmRoot = createRoot(container)
    await act(async () => confirmRoot.render(
      <StrictMode><ConfirmHarness onResult={(confirmed) => results.push(confirmed)} /></StrictMode>
    ))
    const trigger = container.querySelector<HTMLButtonElement>('#confirm-trigger')!
    const dialogButton = (text: string): HTMLButtonElement =>
      [...document.querySelectorAll<HTMLButtonElement>('.settings-dialog button')]
        .find((button) => button.textContent === text)!
    const openDialog = async (): Promise<void> => {
      trigger.focus()
      await act(async () => { trigger.click() })
      await nextFrame()
    }

    await openDialog()
    const dialog = document.querySelector<HTMLElement>('.settings-dialog')!
    check(dialog.getAttribute('aria-modal') === 'true' &&
      document.getElementById(dialog.getAttribute('aria-labelledby')!)?.textContent === '删除「reviewer」？' &&
      document.getElementById(dialog.getAttribute('aria-describedby')!)?.textContent?.includes('定义文件') === true,
      'Dialog is a labelled, described modal')
    check(document.activeElement === dialogButton('取消'), 'Focus starts on the safe cancel action')
    check(dialogButton('删除').classList.contains('settings-dialog-danger'), 'Destructive confirm uses the danger tone')
    const bounds = dialog.getBoundingClientRect()
    check(bounds.left >= 0 && bounds.right <= window.innerWidth && dialog.scrollWidth <= dialog.clientWidth,
      'Dialog fits the viewport without horizontal overflow')
    await key('Tab', true)
    check(document.activeElement === dialogButton('删除'), 'Shift Tab wraps focus inside the dialog')
    await key('Escape')
    check(document.querySelector('.settings-dialog') === null && results.at(-1) === false,
      'Escape cancels and resolves false')
    check(document.activeElement === trigger, 'Focus returns to the trigger after closing')

    await openDialog()
    await act(async () => { dialogButton('删除').click() })
    check(document.querySelector('.settings-dialog') === null && results.at(-1) === true,
      'Confirm resolves true and closes')

    await openDialog()
    await act(async () => confirmRoot.unmount())
    await act(async () => { await Promise.resolve() })
    check(document.querySelector('.settings-dialog') === null && results.at(-1) === false,
      'Unmounting the page cancels a pending confirmation')
    return checks
  } finally {
    container.remove()
  }
}
