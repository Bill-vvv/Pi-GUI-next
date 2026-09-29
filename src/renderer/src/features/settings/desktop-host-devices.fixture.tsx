import { act, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import type { DesktopHostAccessStatus, DesktopHostDeviceSummary } from '../../../../shared/remote-admin-contract'
import { DesktopHostAccessPanel } from './DesktopHostAccessPanel'
import '../../tokens.css'
import '../../styles.css'
import './settings.css'

const PAIRED_AT = Date.UTC(2026, 8, 20, 8, 0)
const EXPIRES_AT = Date.UTC(2026, 9, 20, 8, 0)

function device(letter: string, label: string | null, controlling = false): DesktopHostDeviceSummary {
  return { deviceId: letter.repeat(64), label, pairedAt: PAIRED_AT, expiresAt: EXPIRES_AT, controlling }
}

function status(devices: DesktopHostDeviceSummary[]): DesktopHostAccessStatus {
  return { enabled: true, endpoint: 'http://127.0.0.1:18788', devices }
}

type Deferred = { promise: Promise<DesktopHostAccessStatus>, resolve: (value: DesktopHostAccessStatus) => void, reject: (reason: unknown) => void }

function deferred(): Deferred {
  let resolve!: Deferred['resolve']
  let reject!: Deferred['reject']
  const promise = new Promise<DesktopHostAccessStatus>((settle, fail) => { resolve = settle; reject = fail })
  return { promise, resolve, reject }
}

export async function runDesktopHostDeviceChecks(): Promise<string[]> {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const checks: string[] = []
  const check = (condition: unknown, label: string): void => {
    if (!condition) throw new Error(label)
    checks.push(label)
  }
  const flush = (): Promise<void> => act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  })
  const dialogButton = (text: string): HTMLButtonElement | undefined =>
    [...document.querySelectorAll<HTMLButtonElement>('.settings-dialog button')].find((button) => button.textContent === text)
  const revokeButton = (name: string): HTMLButtonElement =>
    container.querySelector<HTMLButtonElement>(`button[aria-label="撤销 ${name}"]`)!
  const dialogText = (): string => document.querySelector('.settings-dialog')?.textContent ?? ''

  // The Host is the source of truth; the harness mirrors it like Main would.
  let hostDevices = [device('a', 'Desk PC', true), device('b', null)]
  const revokeCalls: string[] = []
  let pendingRevoke: Deferred | null = null

  try {
    await act(async () => root.render(
      <StrictMode>
        <DesktopHostAccessPanel
          busy={false}
          onGetStatus={async () => status(hostDevices)}
          onCreatePairingCode={async () => ({ code: '123456', expiresAt: Date.now() + 60_000 })}
          onRevokeDevice={(deviceId) => {
            revokeCalls.push(deviceId)
            pendingRevoke = deferred()
            return pendingRevoke.promise
          }}
        />
      </StrictMode>
    ))
    await flush()

    const rows = [...container.querySelectorAll('[aria-labelledby="settings-desktop-host-devices"] .settings-row')]
    check(rows.length === 2 &&
      rows[0]!.querySelector('h4')?.textContent === 'Desk PC' &&
      rows[1]!.querySelector('h4')?.textContent === '未命名设备',
      'Each paired device has its own row, with a fallback name')
    check(container.querySelector('#settings-desktop-host-devices')?.textContent?.includes('（2/8）') === true,
      'The heading shows the device count against the limit')
    check(rows[0]!.textContent?.includes('正在使用') === true && rows[1]!.textContent?.includes('正在使用') === false,
      'Only the controlling device is marked as in use')

    // Cancelling never revokes, and focus returns to the device's own action.
    const unnamed = revokeButton('未命名设备')
    unnamed.focus()
    await act(async () => { unnamed.click() })
    await flush()
    check(dialogText().includes('撤销“未命名设备”？') && dialogText().includes('其他设备不受影响') &&
      !dialogText().includes('当前连接会断开'),
      'The confirmation names the selected idle device')
    await act(async () => { dialogButton('取消')!.click() })
    await flush()
    check(document.querySelector('.settings-dialog') === null && revokeCalls.length === 0,
      'Cancel closes the dialog without revoking')
    check(document.activeElement === unnamed, 'Focus returns to the revoke action of that device')

    // Confirming revokes exactly the selected device once; the dialog blocks repeats while busy.
    await act(async () => { revokeButton('Desk PC').click() })
    await flush()
    check(dialogText().includes('当前连接会断开'), 'Revoking the controlling device warns that it disconnects')
    await act(async () => { dialogButton('确认撤销')!.click() })
    await flush()
    check(revokeCalls.length === 1 && revokeCalls[0] === 'a'.repeat(64), 'Revoke is bound to the selected device id')
    check(dialogButton('撤销中…')?.disabled === true && dialogButton('取消')?.disabled === true,
      'The pending revoke disables both dialog actions')
    check(revokeButton('未命名设备').disabled, 'Other device actions wait for the pending revoke')
    hostDevices = [device('b', null)]
    await act(async () => { pendingRevoke!.resolve(status(hostDevices)) })
    await flush()
    check(document.querySelector('.settings-dialog') === null &&
      container.querySelectorAll('[aria-labelledby="settings-desktop-host-devices"] .settings-row').length === 1,
      'After the Host confirms, the dialog closes and the list shows the Host result')

    // A device that is already gone: the error stays in place and the list is refreshed.
    await act(async () => { revokeButton('未命名设备').click() })
    await flush()
    await act(async () => { dialogButton('确认撤销')!.click() })
    hostDevices = []
    await act(async () => { pendingRevoke!.reject(new Error('设备不存在或已撤销。')) })
    await flush()
    check(container.querySelector('[role="alert"]')?.textContent?.includes('设备不存在或已撤销') === true,
      'A failed revoke reports the Host error')
    check(document.querySelector('.settings-dialog') === null &&
      container.textContent?.includes('当前没有已配对的 Windows 客户端。') === true,
      'The refreshed list replaces a device that no longer exists and closes its dialog')

    await act(async () => root.unmount())

    // At the device limit the pairing action is really disabled and explains why.
    const fullRoot = createRoot(container)
    hostDevices = 'abcdefgh'.split('').map((letter, index) => device(letter, `PC ${index + 1}`))
    await act(async () => fullRoot.render(
      <StrictMode>
        <DesktopHostAccessPanel
          busy={false}
          onGetStatus={async () => status(hostDevices)}
          onCreatePairingCode={async () => { throw new Error('must not be called') }}
          onRevokeDevice={async () => status(hostDevices)}
        />
      </StrictMode>
    ))
    await flush()
    const pairButton = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === '生成桌面配对码')!
    check(pairButton.disabled && container.textContent?.includes('已达上限') === true,
      'At 8 devices the pairing action is disabled with its reason in the row')
    check(document.documentElement.scrollWidth <= window.innerWidth,
      'The device list fits the viewport without horizontal overflow')
    await act(async () => fullRoot.unmount())
    return checks
  } finally {
    container.remove()
  }
}
