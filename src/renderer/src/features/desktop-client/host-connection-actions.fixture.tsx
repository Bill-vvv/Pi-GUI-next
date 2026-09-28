import { act, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { HostConnectionActions } from './HostConnectionActions'
import '../../tokens.css'
import '../../styles.css'

export async function runHostConnectionActionChecks(): Promise<string[]> {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const checks: string[] = []
  let disconnects = 0
  let revocations = 0
  let finish!: () => void
  let fail!: (error: Error) => void
  const pending = (): Promise<void> => new Promise((resolve, reject) => { finish = resolve; fail = reject })
  const render = async (): Promise<void> => { await act(async () => root.render(<StrictMode><HostConnectionActions
    hostAlias={'linux-host-'.repeat(12)} onDisconnect={async () => { disconnects++; await pending() }}
    onRevokePairing={async () => { revocations++; await pending() }} /></StrictMode>)) }
  const check = (condition: unknown, label: string): void => { if (!condition) throw new Error(label); checks.push(label) }
  const button = (text: string): HTMLButtonElement => [...document.querySelectorAll<HTMLButtonElement>('.host-connection-dialog button')].find((item) => item.textContent === text)!
  const open = async (): Promise<void> => {
    await act(async () => { const trigger = container.querySelector<HTMLButtonElement>('button')!; trigger.focus(); trigger.click() })
    await act(async () => new Promise<void>((resolve) => {
      if (document.activeElement === button('关闭')) resolve()
      else button('关闭').addEventListener('focus', () => resolve(), { once: true })
    }))
  }
  const key = async (value: string, shiftKey = false): Promise<void> => { await act(async () => {
    document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: value, shiftKey, bubbles: true, cancelable: true }))
  }) }
  try {
    await render()
    await open()
    const dialog = document.querySelector<HTMLElement>('.host-connection-dialog')!
    check(dialog.getAttribute('aria-modal') === 'true' && document.activeElement === button('关闭') &&
      dialog.textContent!.includes('保留配对') && dialog.textContent!.includes('删除本机凭证'), 'Dialog identifies its Host and distinguishes disconnect from revocation before either action')
    check(dialog.getBoundingClientRect().left >= 0 && dialog.getBoundingClientRect().right <= window.innerWidth &&
      dialog.scrollWidth <= dialog.clientWidth, 'Long Host names remain readable without horizontal overflow')
    await key('Tab', true)
    check(document.activeElement === button('取消配对'), 'Shift Tab wraps focus inside the modal')
    await key('Escape')
    check(document.querySelector('[role="dialog"]') === null && document.activeElement === container.querySelector('button'), 'Escape dismisses without mutation and restores the trigger')
    await open()
    await act(async () => { button('断开连接').click(); button('断开连接').click() })
    check(disconnects === 1 && revocations === 0 && [...dialogButtons()].every((element) => element.disabled), 'Disconnect is sent exactly once and never calls revocation')
    await key('Escape')
    await act(async () => document.querySelector<HTMLElement>('.host-connection-backdrop')!.click())
    check(document.querySelector('[role="dialog"]') !== null, 'Busy operation blocks Escape and backdrop dismissal')
    await act(async () => finish())
    check(document.querySelector('[role="dialog"]') === null, 'Acknowledged disconnect closes the operation surface')
    await open()
    await act(async () => { button('取消配对').click(); button('取消配对').click() })
    check(revocations === 1 && disconnects === 1, 'Explicit revoke invokes only its distinct API once')
    await act(async () => fail(new Error('取消配对的结果未确认，本地凭证已保留。')))
    check(document.querySelector('[role="alert"]')!.textContent!.includes('结果未确认') && !button('关闭').disabled, 'An unconfirmed revoke remains an error and restores available controls')
    await act(async () => button('取消配对').click())
    await act(async () => root.unmount())
    await act(async () => fail(new Error('late failure')))
    check(document.querySelector('[role="dialog"]') === null && document.querySelector('[role="alert"]') === null, 'Unmounted operation drops late responses without recreating a dialog')
    return checks
  } finally { await act(async () => root.unmount()); container.remove() }
}

function dialogButtons(): NodeListOf<HTMLButtonElement> { return document.querySelectorAll('.host-connection-dialog button') }
