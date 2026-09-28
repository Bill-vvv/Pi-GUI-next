import { act, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from '../../App'
import { createPreviewKernelApi, createPreviewRemoteAdminApi } from '../../preview/create-preview-kernel-api'
import { DESKTOP_HOST_GIT_COMMAND_TYPES, DESKTOP_HOST_KERNEL_COMMAND_TYPES } from '../../../../shared/desktop-host-contract'
import type { DesktopClientStatus } from '../../../../shared/desktop-client-contract'
import type { GitCommitExecutionRequest, GitRepositoryState } from '../../../../shared/git-contract'
import '../../tokens.css'
import '../../styles.css'

export async function runRemoteGitWriteChecks(): Promise<string[]> {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const original = { gui: window.piGui, git: window.piGit, remote: window.piRemote, desktop: window.piDesktopClient }
  const preview = createPreviewKernelApi()
  window.piGui = preview
  window.piRemote = createPreviewRemoteAdminApi()
  const project = (await preview.getState()).state.activeProjectKey!
  let state: GitRepositoryState = {
    kind: 'repository', projectRoot: project, repositoryRoot: project, headOid: 'a'.repeat(40), indexTreeOid: 'b'.repeat(40),
    indexFingerprint: 'index', worktreeFingerprint: 'worktree', statusRevision: 'status', branch: 'main', upstream: null,
    detached: false, ahead: 0, behind: 0, refreshedAt: 1, truncated: false, lastError: null,
    files: [{ id: 'file', path: '中文 file.txt', originalPath: null, state: 'mixed', indexChange: 'modified', worktreeChange: 'modified', conflicted: false, fingerprint: 'file' }]
  }
  const pending: Array<{ method: string; projectKey: string; request: unknown; resolve: (value: unknown) => void; reject: (error: Error) => void }> = []
  const calls: string[] = []
  window.piGit = Object.fromEntries(['refresh', 'stageFile', 'unstageFile', 'prepareCommit', 'executeCommit', 'getDiff', 'listHistory', 'prepareBranchSync', 'executeBranchSync'].map((method) => [method,
    (projectKey: string, request: unknown) => {
      calls.push(method)
      if (method === 'refresh') return Promise.resolve({ projectKey, result: { ok: true, state: structuredClone(state) } })
      return new Promise((resolve, reject) => pending.push({ method, projectKey, request, resolve, reject }))
    }
  ])) as unknown as Window['piGit']
  let status: Extract<DesktopClientStatus, { mode: 'windows-remote' }> = {
    mode: 'windows-remote', phase: 'connected', hasStoredCredential: true, lastHost: null,
    capabilities: { kernelCommandTypes: DESKTOP_HOST_KERNEL_COMMAND_TYPES, gitCommandTypes: DESKTOP_HOST_GIT_COMMAND_TYPES },
    error: null, failureKind: null, recovery: null
  }
  const listeners = new Set<(status: DesktopClientStatus) => void>()
  window.piDesktopClient = { getStatus: async () => status, setControlIdentity: () => {},
    subscribeStatus: (listener: (value: DesktopClientStatus) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
  } as unknown as Window['piDesktopClient']
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const checks: string[] = []
  const check = (condition: unknown, message: string) => { if (!condition) throw new Error(message) }
  const run = async (fn: () => void) => { await act(async () => { fn() }) }
  const frame = async () => { await act(async () => { await new Promise<void>((resolve) => requestAnimationFrame(() => resolve())) }) }
  const take = (method: string) => {
    const index = pending.findIndex((call) => call.method === method)
    check(index >= 0, `Missing ${method}`)
    return pending.splice(index, 1)[0]!
  }
  const settle = (call: ReturnType<typeof take>, result: unknown) => run(() => call.resolve({ projectKey: call.projectKey, result }))
  const prepareButton = () => container.querySelector<HTMLButtonElement>('.git-repository-commit button')!
  const dialog = () => document.querySelector<HTMLElement>('.git-commit-dialog')!
  const commitButton = () => [...dialog().querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Commit')!
  const prepared = () => ({ ok: true, preview: { snapshot: { repositoryRoot: project, headOid: state.headOid, branch: 'main',
    indexTreeOid: state.indexTreeOid, indexFingerprint: state.indexFingerprint }, stagedFileCount: 1,
    pushTarget: { remote: 'origin', branch: 'main' }, amendAvailable: true, suggestedMessage: 'Review remote changes' } })
  const openCommit = async () => { await run(() => prepareButton().click()); await settle(take('prepareCommit'), prepared()); await frame() }
  try {
    await run(() => root.render(<StrictMode><App /></StrictMode>))
    await frame()
    await run(() => container.querySelector<HTMLButtonElement>('.workbench-header-right-sidebar-toggle')!.click())
    await frame()
    check(container.querySelectorAll('[aria-label="Git 子视图"] [role="tab"]').length === 2, 'Remote exposed Branches')
    check(prepareButton()?.textContent === '提交', 'Remote commit entry missing or advertises push')
    const actions = () => [...container.querySelectorAll<HTMLButtonElement>('.git-change-action')]
    check(actions().length === 2, 'Mixed file must offer stage and unstage')
    checks.push('The complete remote App exposes staging and ordinary commit while keeping Branches unavailable')

    const stage = actions().find((button) => button.getAttribute('aria-label')?.startsWith('暂存'))!
    await run(() => { stage.click(); stage.click() })
    const staged = take('stageFile')
    check(pending.length === 0 && (staged.request as { expectedStatusRevision: string }).expectedStatusRevision === state.statusRevision, 'Stage duplicated or lost snapshot')
    await settle(staged, { ok: true, action: 'stage', path: '中文 file.txt', state })
    await frame()
    const unstage = actions().find((button) => button.getAttribute('aria-label')?.startsWith('取消'))!
    check(unstage && !unstage.disabled, 'Unstage action is unavailable')
    await run(() => unstage.click())
    await settle(take('unstageFile'), { ok: false, action: 'unstage', path: '中文 file.txt', state,
      error: { code: 'stale', message: 'changed', stderrBytes: 0 } })
    await frame()
    check(container.textContent?.includes('Git 状态已经变化'), 'Stale mutation did not refresh and explain')
    checks.push('Stage and unstage use snapshot-bound APIs, block duplicate clicks and refresh stale results')

    await openCommit()
    check(!dialog().textContent?.includes('Push') && !dialog().textContent?.includes('Amend'), 'Remote dialog exposes unsupported modes')
    const bounds = dialog().getBoundingClientRect()
    check(bounds.left >= 0 && bounds.right <= innerWidth && dialog().contains(document.activeElement), 'Commit modal overflow or missing focus')
    await run(() => { commitButton().click(); commitButton().click() })
    const submitted = take('executeCommit')
    const request = submitted.request as GitCommitExecutionRequest
    check(request.mode === 'commit' && request.message === 'Review remote changes' && request.snapshot.indexFingerprint === state.indexFingerprint && pending.length === 0, 'Commit request changed mode, message, snapshot or duplicated')
    await settle(submitted, { mode: 'commit', commit: { status: 'succeeded', oid: 'c'.repeat(40), warnings: [] }, push: null, postState: { ok: true, state } })
    check(dialog().textContent?.includes('提交成功'), 'Commit result is not visible')
    await run(() => [...dialog().querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === '关闭')!.click())
    checks.push('Commit confirmation preserves the exact preview, supports keyboard focus and sends one ordinary commit')

    await openCommit()
    await run(() => commitButton().click())
    const uncertain = take('executeCommit')
    const count = calls.filter((method) => method === 'executeCommit').length
    await run(() => uncertain.reject(new Error('connection lost after commit start')))
    check(dialog().textContent?.includes('提交结果未确认') && commitButton().disabled && calls.filter((method) => method === 'executeCommit').length === count, 'Unknown result was hidden or retried')
    await run(() => commitButton().click())
    check(calls.filter((method) => method === 'executeCommit').length === count, 'Uncertain commit can be replayed from the old dialog')
    await run(() => [...dialog().querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === '关闭')!.click())
    checks.push('A lost commit response stays explicitly uncertain and is not replayed')

    await run(() => prepareButton().click())
    const old = take('prepareCommit')
    const current = (await preview.getState()).state
    const next = current.sessions.find((session) => session.key !== current.activeSessionKey)!
    await act(async () => { await preview.activateSession(next.key) })
    await frame()
    await settle(old, prepared())
    check(!dialog(), 'Session navigation accepted a previous commit preview')
    checks.push('Same-project Session navigation invalidates a late commit confirmation')

    await openCommit()
    await run(() => commitButton().click())
    const late = take('executeCommit')
    const connected = status
    await run(() => { status = { ...status, phase: 'reconnecting', capabilities: null }; for (const listener of listeners) listener(status) })
    check(!dialog(), 'Disconnect retained a commit dialog')
    await run(() => late.reject(new Error('disconnected')))
    await run(() => { status = connected; for (const listener of listeners) listener(status) })
    await frame()
    check(!dialog(), 'Reconnect restored an old mutation dialog')
    checks.push('Disconnect discards a late commit result and reconnect does not reopen or replay it')

    check(!calls.some((method) => method === 'prepareBranchSync' || method === 'executeBranchSync'), 'Remote invoked branch or network actions')
    checks.push('All remote Git write scenarios keep network and branch commands unused')
    return checks
  } finally {
    await run(() => root.unmount())
    container.remove()
    window.piGui = original.gui; window.piGit = original.git; window.piRemote = original.remote
    if (original.desktop === undefined) delete window.piDesktopClient
    else window.piDesktopClient = original.desktop
  }
}
