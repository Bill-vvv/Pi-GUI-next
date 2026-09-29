import { act, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'

import type { GeneralSettings as GeneralSettingsValue } from '../../../../shared/kernel-contract'
import { GeneralSettings } from './GeneralSettings'
import { SettingsNavigation } from './SettingsNavigation'
import { SETTINGS_SEARCH_HIT_ATTRIBUTE, useSettingsJump } from './settings-jump'
import type { SettingsSearchEntry } from './settings-search'
import type { SettingsJumpTarget } from './settings-workspace'
import '../../tokens.css'
import '../../styles.css'
import './settings.css'

const GENERAL: GeneralSettingsValue = {
  startupWorkspaceRestore: 'restore',
  autoContinueInterruptedTasks: false,
  fastExtensionLoading: false,
  doubleClickBorderMaximize: true
}

type HarnessProps = {
  clientOnly?: boolean
  searchAvailable?: boolean
  showPage?: boolean
  acceptSelection?: boolean
  busy?: boolean
  onSelect: (entry: SettingsSearchEntry) => void
}

let jumpRevision = 0

function SearchHarness({
  clientOnly = false,
  searchAvailable = true,
  showPage = true,
  acceptSelection = true,
  busy = false,
  onSelect
}: HarnessProps): React.JSX.Element {
  const [target, setTarget] = useState<SettingsJumpTarget | null>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  useSettingsJump(contentRef, target)
  return (
    <div style={{ display: 'flex', height: '600px' }}>
      <aside style={{ width: '260px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
        <SettingsNavigation
          section="general"
          clientOnly={clientOnly}
          searchAvailable={searchAvailable}
          onSectionChange={() => undefined}
          onSearchSelect={(entry) => {
            onSelect(entry)
            if (!acceptSelection) return false
            jumpRevision += 1
            setTarget({ id: entry.target, revision: jumpRevision })
            return true
          }}
          onBack={() => undefined}
        />
      </aside>
      <div className="settings-content" ref={contentRef} style={{ overflow: 'auto' }}>
        {showPage ? (
          <GeneralSettings
            general={GENERAL}
            sessionNaming={{ mode: 'auto' }}
            availableModels={[]}
            clientOnly={false}
            busy={busy}
            onSetGeneral={async () => undefined}
            onSetSessionNaming={async () => undefined}
          />
        ) : null}
      </div>
    </div>
  )
}

export async function runSettingsSearchChecks(): Promise<string[]> {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const checks: string[] = []
  const check = (condition: unknown, label: string): void => {
    if (!condition) throw new Error(label)
    checks.push(label)
  }
  const selected: SettingsSearchEntry[] = []
  const render = async (props: Omit<HarnessProps, 'onSelect'> = {}): Promise<void> => {
    await act(async () => {
      root.render(<SearchHarness {...props} onSelect={(entry) => selected.push(entry)} />)
    })
  }
  const input = (): HTMLInputElement => container.querySelector<HTMLInputElement>('input[role="combobox"]')!
  const type = async (value: string): Promise<void> => {
    await act(async () => {
      const field = input()
      field.focus()
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value)
      field.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }
  const key = async (value: string): Promise<KeyboardEvent> => {
    const event = new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true })
    await act(async () => { document.activeElement!.dispatchEvent(event) })
    return event
  }
  const options = (): HTMLElement[] => [...container.querySelectorAll<HTMLElement>('[role="option"]')]
  const nav = (): HTMLElement => container.querySelector<HTMLElement>('nav.settings-nav')!
  const hit = (): Element | null => container.querySelector(`[${SETTINGS_SEARCH_HIT_ATTRIBUTE}]`)

  try {
    await render()
    check(input().getAttribute('aria-expanded') === 'false' && input().getAttribute('aria-label') === '搜索设置',
      'The search field is a collapsed, labelled combobox')

    await type('深色')
    check(input().getAttribute('aria-expanded') === 'true' && options()[0]?.textContent?.startsWith('主题'),
      'A synonym finds the theme setting')
    check(nav().hidden && getComputedStyle(nav()).display === 'none', 'Results replace the navigation while searching')
    check(options()[0].querySelector('small')?.textContent === '外观', 'A result names its page')

    await type('命名')
    check(options().length === 1 && options()[0].getAttribute('aria-selected') === 'true' &&
      input().getAttribute('aria-activedescendant') === options()[0].id,
    'The first result is active and referenced by the combobox')

    await type('实验')
    check(options().length === 2, 'A group name matches every setting in that group')
    await key('ArrowDown')
    check(options()[1].getAttribute('aria-selected') === 'true', 'ArrowDown moves the active result')
    await key('ArrowDown')
    check(options()[0].getAttribute('aria-selected') === 'true', 'ArrowDown wraps to the first result')
    await key('ArrowUp')
    check(input().getAttribute('aria-activedescendant') === options()[1].id, 'ArrowUp wraps to the last result')

    await type('zzzz')
    check(options().length === 0 && container.querySelector('[role="status"]')?.textContent === '没有匹配的设置' &&
      input().getAttribute('aria-expanded') === 'true',
    'A query without matches keeps the search open with a no-results status')

    const escape = await key('Escape')
    check(escape.defaultPrevented && input().value === '' && !nav().hidden && document.activeElement === input(),
      'Escape clears a query, keeps focus in the field and restores the navigation')
    const idleEscape = await key('Escape')
    check(!idleEscape.defaultPrevented, 'Escape on an empty field is left to the settings workspace')

    await type('双击')
    await key('Enter')
    const doubleClick = document.getElementById('general-double-click-border-maximize')
    check(selected.at(-1)?.target === 'general-double-click-border-maximize' && input().value === '',
      'Enter selects the active result and clears the query')
    check(document.activeElement === doubleClick && hit() === doubleClick?.closest('.settings-row'),
      'The jump focuses the setting control and marks its row')
    await act(async () => { document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })) })
    check(hit() === null, 'The next pointer press clears the mark')

    await type('启动')
    await act(async () => {
      options()[0].dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
      options()[0].click()
    })
    check(document.activeElement?.closest('.settings-row')?.contains(document.getElementById('general-startup-workspace-restore-label')),
      'Clicking a result jumps to a row whose label is not a control')

    await render({ busy: true })
    await type('启动后')
    await key('Enter')
    check(document.activeElement === document.getElementById('general-startup-workspace-restore-label'),
      'Without a usable control the jump focuses the target itself')

    await render({ acceptSelection: false })
    await type('窗口')
    await key('Enter')
    check(input().value === '窗口' && document.activeElement === input(), 'A refused jump keeps the query and focus')

    await render({ showPage: false })
    await type('自动对话')
    await key('Enter')
    await render({ showPage: true })
    await act(async () => { await new Promise((resolve) => requestAnimationFrame(resolve)) })
    check(document.activeElement === document.getElementById('session-naming-mode'),
      'A target that renders later is revealed when it appears')

    await act(async () => { root.render(<></>) })
    await render({ showPage: false })
    await type('扩展启动')
    await key('Enter')
    await act(async () => { document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })) })
    await render({ showPage: true })
    await act(async () => { await new Promise((resolve) => requestAnimationFrame(resolve)) })
    check(document.activeElement !== document.getElementById('general-fast-extension-loading') && hit() === null,
      'A pending jump stops once the user takes over')

    await act(async () => { root.render(<></>) })
    await render({ clientOnly: true })
    await type('模型')
    check(options().every((option) => option.querySelector('small')?.textContent?.startsWith('键盘快捷键')),
      'The SSH client only finds settings it renders')

    await render({ searchAvailable: false })
    check(container.querySelector('input[role="combobox"]') === null && !nav().hidden,
      'The icon rail has no search field and always shows the navigation')
  } finally {
    await act(async () => { root.unmount() })
    container.remove()
  }
  return checks
}
