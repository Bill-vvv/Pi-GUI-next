import { act, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { DESKTOP_HOST_CHECK_STAGES, type DesktopClientHostConfig, type DesktopHostCheckResult, type DesktopClientApi, type DesktopClientConnectRequest, type DesktopClientStatus, type DesktopSshHostListing } from '../../../../shared/desktop-client-contract'
import { ConnectHostPanel } from './ConnectHostPanel'
import '../../tokens.css'
import '../../styles.css'

export async function runHostPreflightChecks(): Promise<string[]> {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const original = window.piDesktopClient
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const checks: string[] = []
  const calls: { id: string; config: DesktopClientHostConfig }[] = []
  const cancellations: string[] = []
  const connects: DesktopClientConnectRequest[] = []
  let resolveCheck!: (result: DesktopHostCheckResult) => void
  window.piDesktopClient = {
    checkHost: async (id, config) => {
      calls.push({ id, config })
      return new Promise<DesktopHostCheckResult>((resolve) => { resolveCheck = resolve })
    },
    cancelHostCheck: async (id) => { cancellations.push(id) }
  } as DesktopClientApi
  const status: Extract<DesktopClientStatus, { mode: 'windows-remote' }> = {
    mode: 'windows-remote', phase: 'disconnected', hasStoredCredential: false,
    lastHost: { sshHostAlias: 'preflight', localPort: 18788, desktopHostPort: 18789 },
    capabilities: null, error: null, failureKind: null, recovery: null
  }
  const render = async (): Promise<void> => { await act(async () => root.render(<StrictMode>
    <ConnectHostPanel status={{ ...status }} busy={false} error={null} onConnect={async (request) => { connects.push(request) }} />
  </StrictMode>)) }
  const check = (condition: unknown, label: string): void => { if (!condition) throw new Error(label); checks.push(label) }
  const button = (label: string): HTMLButtonElement => [...container.querySelectorAll<HTMLButtonElement>('button')].find((element) => element.textContent === label)!
  const click = async (element: HTMLElement): Promise<void> => { await act(async () => element.click()) }
  const input = async (name: string, value: string): Promise<void> => { await act(async () => {
    const element = container.querySelector<HTMLInputElement>(`[name="${name}"]`)!
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  }) }
  const result = (): DesktopHostCheckResult => ({
    config: calls.at(-1)!.config, checkedAt: new Date().toISOString(), outcome: 'passed', cleanupError: null,
    steps: DESKTOP_HOST_CHECK_STAGES.map((stage) => ({ stage, status: 'passed', detail: null }))
  })
  try {
    await render()
    await act(async () => { button('检查 Host').click(); button('检查 Host').click() })
    check(calls.length === 1 && Object.keys(calls[0]!.config).length === 3 && connects.length === 0,
      'Checking requires no pairing code, cannot duplicate, and never initiates the authenticated connection')
    check([...container.querySelectorAll<HTMLInputElement>('input')].every((element) => element.disabled) && !button('取消检查').disabled,
      'Host fields stay fixed while checking and cancellation remains available')
    await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    check(connects.length === 0, 'Programmatic connect cannot bypass a pending check')
    await act(async () => resolveCheck(result()))
    check(container.textContent!.includes('本次检查通过') && container.querySelectorAll('[data-check-status="passed"]').length === 5,
      'A finished check reports its five actual stages without claiming device authentication')
    await input('desktopHostPort', '18800')
    check(!container.textContent!.includes('本次检查通过'), 'Editing a target port invalidates the previous check result')
    await click(button('检查 Host'))
    const failed = result()
    failed.outcome = 'failed'
    failed.steps[2] = { stage: 'ssh-configuration', status: 'failed', detail: `Bad config: ${'long-config-path/'.repeat(30)}` }
    failed.steps[3]!.status = 'skipped'
    failed.steps[4]!.status = 'skipped'
    await act(async () => resolveCheck(failed))
    check(container.textContent!.includes('SSH 别名配置：失败') && container.textContent!.includes('Host 服务与版本：未完成') && container.scrollWidth <= window.innerWidth,
      'Failure shows the responsible stage, untested later stages and bounded long diagnostics')
    await click(button('检查 Host'))
    const cancel = button('取消检查')
    await act(async () => { cancel.click(); cancel.click() })
    check(cancellations.length === 1 && cancellations[0] === calls.at(-1)!.id && button('正在停止检查…').disabled,
      'Cancel is bound to the exact operation and waits for cleanup without duplicate requests')
    await act(async () => resolveCheck({ ...result(), outcome: 'cancelled' }))
    check(container.textContent!.includes('检查已取消') && !container.textContent!.includes('本次检查通过') && !button('检查 Host').disabled,
      'Cancelled checks restore controls and cannot appear successful')
    await click(button('检查 Host'))
    await act(async () => resolveCheck({ ...result(), outcome: 'failed', cleanupError: 'process still running' }))
    check(container.textContent!.includes('临时 SSH 进程释放失败') && !container.textContent!.includes('本次检查通过'),
      'Successful probes with failed process cleanup remain a failed check')
    await input('localPort', '0')
    const before = calls.length
    await click(button('检查 Host'))
    check(calls.length === before && container.textContent!.includes('localPort must be'), 'Invalid ports fail locally before issuing a check')
    await input('localPort', '18788')
    await click(button('检查 Host'))
    const pendingId = calls.at(-1)!.id
    await act(async () => root.render(null))
    await act(async () => resolveCheck(result()))
    await render()
    check(cancellations.at(-1) === pendingId && !container.textContent!.includes('本次检查通过'),
      'Unmount cancels its own operation and ignores a late successful response')
    status.phase = 'checking'
    await render()
    check(button('检查 Host').disabled && container.textContent!.includes('检查中…'), 'Authoritative checking status blocks a remounted page from starting another connection')
    return checks
  } finally {
    await act(async () => root.unmount())
    container.remove()
    if (original === undefined) delete window.piDesktopClient
    else window.piDesktopClient = original
  }
}

export async function runSshDiscoveryChecks(): Promise<string[]> {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const original = window.piDesktopClient
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const checks: string[] = []
  let calls = 0
  let resolveListing!: (value: DesktopSshHostListing) => void
  let rejectListing!: (error: Error) => void
  window.piDesktopClient = { listSshHosts: () => {
    calls++
    return new Promise<DesktopSshHostListing>((resolve, reject) => { resolveListing = resolve; rejectListing = reject })
  } } as DesktopClientApi
  const status: Extract<DesktopClientStatus, { mode: 'windows-remote' }> = {
    mode: 'windows-remote', phase: 'disconnected', hasStoredCredential: true,
    lastHost: { sshHostAlias: 'manual', localPort: 18788, desktopHostPort: 18789 },
    capabilities: null, error: null, failureKind: null, recovery: null
  }
  const requests: DesktopClientConnectRequest[] = []
  const render = async (): Promise<void> => { await act(async () => root.render(<StrictMode>
    <ConnectHostPanel status={{ ...status }} busy={false} error={null} onConnect={async (request) => { requests.push(request) }} />
  </StrictMode>)) }
  const check = (condition: unknown, name: string): void => { if (!condition) throw new Error(name); checks.push(name) }
  const discover = (): HTMLButtonElement => container.querySelector('.connect-host-discovery > button')!
  const alias = (): HTMLInputElement => container.querySelector('[name="sshHostAlias"]')!
  const click = async (element: HTMLElement): Promise<void> => { await act(async () => element.click()) }
  const listing: DesktopSshHostListing = {
    hosts: [{ alias: 'linux-build', filePath: `C:/Users/中文 with spaces/${'long-directory/'.repeat(8)}.ssh/config`, line: 4 }],
    searchedFiles: ['C:/Users/中文 with spaces/.ssh/config'], warnings: ['Match 条件未执行']
  }
  try {
    await render()
    check(calls === 0, 'Opening the connection page never scans or connects automatically')
    await act(async () => { discover().click(); discover().click() })
    check(calls === 1 && discover().disabled, 'Repeated discovery clicks share one pending request')
    await act(async () => resolveListing(listing))
    check(alias().value === 'manual' && requests.length === 0, 'Discovery does not overwrite the typed alias or initiate a connection')
    check(container.textContent!.includes('Match 条件未执行') && container.textContent!.includes('配置文件来源'), 'Sources and incomplete-discovery warnings remain visible')
    const trigger = container.querySelector<HTMLButtonElement>('[aria-haspopup="listbox"]')!
    await click(trigger)
    const listbox = document.querySelector('[role="listbox"]')!
    const box = listbox.getBoundingClientRect()
    check(box.left >= 0 && box.right <= window.innerWidth + 1 && container.scrollWidth <= window.innerWidth, 'Long source paths and picker stay inside the viewport')
    const focusRestored = new Promise<void>((resolve) => trigger.addEventListener('focus', () => resolve(), { once: true }))
    await act(async () => listbox.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    await focusRestored
    check(document.querySelector('[role="listbox"]') === null && document.activeElement === trigger, 'Escape closes discovery choices and restores keyboard focus')
    await click(trigger)
    const option = [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')].find((element) => element.textContent!.includes('linux-build'))!
    await click(option)
    await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    check(alias().value === 'linux-build' && requests[0]?.sshHostAlias === 'linux-build' && requests[0]?.desktopHostPort === 18789, 'Selecting an alias feeds the existing typed connection without changing ports')
    await click(discover())
    status.phase = 'connecting'
    await render()
    await act(async () => resolveListing({ ...listing, hosts: [{ alias: 'late', filePath: 'late', line: 1 }] }))
    check(!container.textContent!.includes('late') && discover().disabled, 'Starting a connection discards pending discovery results and disables scanning')
    status.phase = 'disconnected'
    await render()
    await click(discover())
    await act(async () => rejectListing(new Error('配置超过读取上限')))
    check(container.querySelector('[role="alert"]')!.textContent!.includes('超过读取上限') && !alias().disabled && !discover().disabled, 'Discovery errors are explicit and leave manual connection and retry usable')
    await click(discover())
    await act(async () => resolveListing({ hosts: [], searchedFiles: ['missing/config'], warnings: [] }))
    check(container.textContent!.includes('未发现可选的主机别名') && alias().value === 'linux-build', 'Empty discovery preserves the manual alias and shows an honest empty state')
    await click(discover())
    await act(async () => root.render(null))
    await act(async () => resolveListing(listing))
    await render()
    check(!container.textContent!.includes('候选主机') && !discover().disabled, 'Unmounted discovery cannot leak results into a new connection page')
    return checks
  } finally {
    await act(async () => root.unmount())
    container.remove()
    if (original === undefined) delete window.piDesktopClient
    else window.piDesktopClient = original
  }
}

export async function runConnectionChecks(): Promise<string[]> {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const checks: string[] = []
  const requests: DesktopClientConnectRequest[] = []
  const status: Extract<DesktopClientStatus, { mode: 'windows-remote' }> = {
    mode: 'windows-remote', phase: 'disconnected', hasStoredCredential: true,
    lastHost: { sshHostAlias: 'fixture', localPort: 18788, desktopHostPort: 18788 },
    capabilities: null, error: null, failureKind: null, recovery: null
  }
  const check = (condition: unknown, label: string): void => {
    if (!condition) throw new Error(label)
    checks.push(label)
  }
  const render = async (): Promise<void> => {
    await act(async () => root.render(<ConnectHostPanel status={{ ...status }} busy={false} error={null}
      onConnect={async (request) => { requests.push(request) }} />))
  }
  const submit = async (): Promise<void> => {
    await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  }
  try {
    status.phase = 'reconnecting'
    status.recovery = { attempt: 2, maxAttempts: 5, delayMs: 1_000 }
    status.failureKind = 'network'
    status.error = 'Connection refused'
    await render()
    check(container.textContent!.includes('第 2/5 次重连'), 'Shows the actual recovery attempt and backoff')
    check([...container.querySelectorAll('input, button')].every((element) => (element as HTMLInputElement).disabled), 'All connect controls are disabled during recovery')
    await submit()
    check(requests.length === 0, 'Programmatic submit cannot bypass recovery disabled state')

    status.phase = 'disconnected'
    status.recovery = { attempt: 5, maxAttempts: 5, delayMs: 0 }
    await render()
    check(container.textContent!.includes('已尝试 5/5') && container.querySelector('button[type="submit"]')!.textContent === '重试连接', 'Exhaustion reports its limit and exposes manual retry')
    await submit()
    check(requests.length === 1 && requests[0]!.sshHostAlias === 'fixture' && !('pairingCode' in requests[0]!), 'Manual retry uses the saved host without inventing a pairing code')

    status.hasStoredCredential = false
    status.failureKind = 'authentication'
    status.error = 'Device revoked'
    await render()
    check(container.querySelector<HTMLInputElement>('input[name="pairingCode"]')!.required && container.textContent!.includes('生成新的配对码'), 'Revocation requires a new code and gives a recovery instruction')

    status.failureKind = 'ssh-authentication'
    status.error = 'Permission denied'
    await render()
    check(container.querySelector('[role="alert"]')!.textContent!.includes('SSH 登录失败'), 'SSH login failure is distinguished from device revocation')

    status.failureKind = 'protocol'
    status.error = 'Build mismatch'
    await render()
    check(container.querySelector('[role="alert"]')!.textContent!.includes('同一源码构建'), 'Compatibility failure explains how to align both installations')
    for (const phase of ['disconnecting', 'revoking'] as const) {
      status.phase = phase
      await render()
      await submit()
      check(requests.length === 1 && [...container.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, button')].every((element) => element.disabled) &&
        container.textContent!.includes(phase === 'revoking' ? '正在取消配对' : '配对将保留'), `${phase} locks connection controls and explains credential handling`)
    }
    return checks
  } finally {
    await act(async () => root.unmount())
    container.remove()
  }
}
