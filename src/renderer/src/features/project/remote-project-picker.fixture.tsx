import { act, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RemoteProjectPicker } from './RemoteProjectPicker'
import { App } from '../../App'
import { createPreviewKernelApi, createPreviewRemoteAdminApi } from '../../preview/create-preview-kernel-api'
import type { ProjectDirectoryListing } from '../../../../shared/project-directory-contract'
import type { DesktopClientStatus } from '../../../../shared/desktop-client-contract'
import { DESKTOP_HOST_KERNEL_COMMAND_TYPES } from '../../../../shared/desktop-host-contract'
import '../../tokens.css'
import '../../styles.css'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

export async function runRemoteProjectPickerChecks(): Promise<string[]> {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const original = { gui: window.piGui, remote: window.piRemote, desktop: window.piDesktopClient }
  const container = document.createElement('div')
  const opener = document.createElement('button')
  opener.textContent = 'Open picker'
  document.body.append(opener, container)
  const root = createRoot(container)
  const checks: string[] = []
  const requests: Array<ReturnType<typeof deferred<ProjectDirectoryListing>> & { path?: string }> = []
  const selected: string[] = []
  let submission = deferred<void>()
  let closed = 0
  let key = 0
  const check = (condition: unknown, message: string): void => { if (!condition) throw new Error(message) }
  const run = async (operation: () => void) => { await act(async () => { operation() }) }
  const frame = async () => { await act(async () => { await new Promise<void>((resolve) => requestAnimationFrame(() => resolve())) }) }
  const listing = (path: string, extra: Partial<Extract<ProjectDirectoryListing, { ok: true }>> = {}): ProjectDirectoryListing => ({
    ok: true, path, parentPath: path === '/' ? null : '/', entries: [], truncated: false, inaccessibleLinks: 0, ...extra
  })
  const browse = (path?: string) => {
    const request = { ...deferred<ProjectDirectoryListing>(), path }
    requests.push(request)
    return request.promise
  }
  window.piGui = { ...createPreviewKernelApi(), listProjectDirectories: browse }
  const mount = async () => {
    opener.focus()
    await run(() => root.render(<StrictMode><RemoteProjectPicker key={++key}
      onClose={() => { closed += 1; root.render(null) }}
      onSelect={(path) => { selected.push(path); return submission.promise }} /></StrictMode>))
    await frame()
  }
  const take = () => {
    check(requests.length > 0, 'Missing directory request')
    return requests.pop()!
  }
  const button = (label: string): HTMLButtonElement => {
    const found = [...document.querySelectorAll<HTMLButtonElement>('.remote-project-picker button')]
      .find((element) => element.textContent === label)
    check(found, `Missing button: ${label}`)
    return found!
  }
  const input = () => document.querySelector<HTMLInputElement>('.remote-project-picker input')!
  const click = async (label: string) => run(() => button(label).click())
  const type = async (value: string) => run(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input(), value)
    input().dispatchEvent(new Event('input', { bubbles: true }))
  })
  const escape = async () => run(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))

  try {
    await mount()
    const initial = take()
    check(initial.path === undefined && button('选择当前目录').disabled && document.activeElement === input(), 'Initial home browse or focus is incorrect')
    await run(() => initial.resolve(listing('/home/user', {
      entries: [{ name: '中文 项目', path: '/home/user/link', symbolicLink: true }],
      truncated: true, inaccessibleLinks: 2
    })))
    check(document.body.textContent!.includes('只显示部分结果') && document.body.textContent!.includes('有 2 个链接无法访问'), 'Incomplete listings were presented as complete')
    checks.push('Home loading, focus, bounded-list and inaccessible-link feedback are visible')

    await click('中文 项目目录链接')
    const linked = take()
    check(linked.path === '/home/user/link', 'Child link path was not sent')
    await run(() => linked.resolve(listing('/srv/中文 项目')))
    check(input().value === '/srv/中文 项目', 'Host canonical path was not displayed')
    await click('上一级')
    check(requests.at(-1)?.path === '/', 'Parent navigation was not sent')
    await run(() => take().resolve(listing('/')))
    check(button('上一级').disabled, 'Root parent must be disabled')
    checks.push('Child navigation uses Host paths and canonical results; root has no parent')

    await type('/slow')
    check(button('选择当前目录').disabled, 'Editing retained a selectable old directory')
    await click('打开')
    const slow = take()
    await type('/new')
    await click('打开')
    await run(() => take().resolve(listing('/new')))
    await run(() => slow.resolve(listing('/slow')))
    check(input().value === '/new' && !button('选择当前目录').disabled, 'Late response replaced the latest directory')
    checks.push('Typing invalidates selection and older navigation responses cannot overwrite newer results')

    await type('/denied')
    await click('打开')
    await run(() => take().resolve({ ok: false, code: 'access-denied', message: '没有读取权限' }))
    check(document.querySelector('[role="alert"]')?.textContent === '没有读取权限' && button('选择当前目录').disabled, 'Access error did not block selection')
    await click('打开')
    await run(() => take().reject(new Error('Host disconnected')))
    check(document.querySelector('[role="alert"]')?.textContent === 'Host disconnected', 'Transport failure was hidden')
    checks.push('Directory and transport errors remain explicit and cannot submit stale listings')

    await click('主目录')
    await run(() => take().resolve(listing('/srv/中文 项目')))
    await run(() => { button('选择当前目录').click(); button('选择当前目录').click() })
    await escape()
    check(selected.length === 1 && selected[0] === '/srv/中文 项目' && closed === 0 && button('取消').disabled, 'Submission was duplicated or dismissed while pending')
    await run(() => submission.reject(new Error('Project changed; browse again')))
    check(!button('选择当前目录').disabled && document.querySelector('[role="alert"]')?.textContent === 'Project changed; browse again', 'Registration error closed the picker or blocked retry')
    checks.push('Registration is single-flight, blocks dismissal while pending and exposes failure for retry')

    submission = deferred<void>()
    await click('选择当前目录')
    await run(() => submission.resolve())
    check(closed === 1 && document.querySelector('[role="dialog"]') === null && document.activeElement === opener, 'Success did not close and restore focus')
    checks.push('Successful registration closes the modal and restores its trigger focus')

    await mount()
    const cancelled = take()
    await escape()
    await mount()
    await run(() => take().resolve(listing('/fresh')))
    await run(() => cancelled.resolve(listing('/cancelled')))
    check(input().value === '/fresh', 'Cancelled request leaked into a reopened picker')
    input().focus()
    await run(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true })))
    check(document.activeElement === button('选择当前目录'), 'Shift-Tab escaped the modal')
    await run(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })))
    check(document.activeElement === input(), 'Tab escaped the modal')
    checks.push('Cancel/reopen rejects late responses and keyboard focus stays in the active modal')

    await click('主目录')
    const disconnected = take()
    await run(() => root.render(null))
    await run(() => disconnected.resolve(listing('/late-disconnect')))
    check(document.querySelector('[role="dialog"]') === null, 'Unmounted picker reopened from a late response')
    checks.push('Disconnect/unmount cannot publish a late directory response')

    // Mount the real App and Workbench to verify the remote capability and callback wiring.
    const preview = createPreviewKernelApi()
    const appPaths: Array<string | undefined> = []
    window.piGui = { ...preview, listProjectDirectories: browse, addProject: async (path) => {
      appPaths.push(path)
      return { revision: (await preview.getState()).revision }
    } }
    window.piRemote = createPreviewRemoteAdminApi()
    let status: Extract<DesktopClientStatus, { mode: 'windows-remote' }> = {
      mode: 'windows-remote', phase: 'connected', hasStoredCredential: true,
      lastHost: { sshHostAlias: 'fixture', localPort: 18788, desktopHostPort: 18788 },
      capabilities: { kernelCommandTypes: DESKTOP_HOST_KERNEL_COMMAND_TYPES },
      error: null, failureKind: null, recovery: null
    }
    const listeners = new Set<(value: DesktopClientStatus) => void>()
    window.piDesktopClient = {
      getStatus: async () => status, setControlIdentity: () => {},
      subscribeStatus: (listener: (value: DesktopClientStatus) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
    } as unknown as Window['piDesktopClient']
    await run(() => root.render(<StrictMode><App /></StrictMode>))
    await frame()
    const add = () => container.querySelector<HTMLButtonElement>('button[aria-label="添加项目"]')!
    check(add() && !add().disabled, 'Remote App has no enabled Add Project action')
    await run(() => add().click())
    await run(() => take().resolve(listing('/srv/中文 项目')))
    await click('选择当前目录')
    check(appPaths.length === 1 && appPaths[0] === '/srv/中文 项目' && !document.querySelector('.remote-project-picker'), 'App did not pass the explicit Linux path through its mutation acknowledgement')
    checks.push('Real App and Workbench route remote Add Project through the picker and revision acknowledgement')

    await run(() => add().click())
    const appLate = take()
    await run(() => {
      status = { ...status, phase: 'reconnecting', capabilities: null }
      for (const listener of listeners) listener(status)
    })
    await run(() => appLate.resolve(listing('/old-host')))
    check(!document.querySelector('.remote-project-picker') && !add(), 'Disconnected App retained a project picker or Add action')
    checks.push('Real App disconnect removes the picker and disables project actions before late reads finish')

    await run(() => root.render(null))
    delete window.piDesktopClient
    await run(() => root.render(<StrictMode><App /></StrictMode>))
    await frame()
    await run(() => add().click())
    check(appPaths.length === 2 && appPaths[1] === undefined && !document.querySelector('.remote-project-picker'), 'Local Add Project no longer delegates to the native directory picker')
    checks.push('Local App keeps its native directory-picker command without a remote modal')

    await run(() => root.render(null))
    await mount()
    await run(() => take().resolve(listing('/long/' + '路径'.repeat(100), {
      entries: [{ name: '目录'.repeat(100), path: '/long/child', symbolicLink: true }]
    })))
    const dialog = document.querySelector<HTMLElement>('.remote-project-picker')!
    dialog.style.width = '288px'
    await frame()
    check(dialog.scrollWidth <= dialog.clientWidth + 1, 'Long paths cause horizontal overflow in a narrow modal')
    checks.push('Long Unicode paths and directory links fit a narrow modal without horizontal overflow')
    await escape()
    check(document.querySelector('.remote-project-picker') === null, 'Escape failed after App lifecycle changes')
    checks.push('Modal cleanup remains correct across standalone and complete App lifecycles')
    return checks
  } finally {
    await run(() => root.unmount())
    container.remove()
    opener.remove()
    window.piGui = original.gui
    window.piRemote = original.remote
    if (original.desktop === undefined) delete window.piDesktopClient
    else window.piDesktopClient = original.desktop
  }
}
