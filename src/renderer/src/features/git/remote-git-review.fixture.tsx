import { act, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from '../../App'
import { GitChangesPanel } from './GitChangesPanel'
import { createPreviewKernelApi, createPreviewRemoteAdminApi } from '../../preview/create-preview-kernel-api'
import { DESKTOP_HOST_GIT_READ_COMMAND_TYPES as DESKTOP_HOST_GIT_COMMAND_TYPES, DESKTOP_HOST_KERNEL_COMMAND_TYPES } from '../../../../shared/desktop-host-contract'
import type { DesktopClientStatus } from '../../../../shared/desktop-client-contract'
import { GIT_HISTORY_PAGE_SIZE, type GitRepositoryState, type GitDiffRequest } from '../../../../shared/git-contract'
import '../../tokens.css'
import '../../styles.css'

export async function runRemoteGitReviewChecks(): Promise<string[]> {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const original = { gui: window.piGui, git: window.piGit, remote: window.piRemote, desktop: window.piDesktopClient }
  const calls: string[] = []
  const pending: Array<{ method: string; projectKey: string; payload: unknown; resolve: (value: unknown) => void }> = []
  const methods = ['refresh', 'readFile', 'getDiff', 'listHistory', 'getHistoryDetail', 'getHistoryFileDiff',
    'authorizeAncestorRepository', 'stageFile', 'unstageFile', 'prepareCommit', 'executeCommit', 'prepareBranchSync', 'executeBranchSync']
  window.piGit = Object.fromEntries(methods.map((method) => [method, (projectKey: string, payload: unknown) => {
    calls.push(method)
    return new Promise((resolve) => pending.push({ method, projectKey, payload, resolve }))
  }])) as unknown as Window['piGit']
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const results: string[] = []
  const check = (condition: unknown, message: string) => { if (!condition) throw new Error(message) }
  const run = async (fn: () => void) => { await act(async () => { fn() }) }
  const frame = async () => { await act(async () => { await new Promise<void>((resolve) => requestAnimationFrame(() => resolve())) }) }
  const take = (method: string) => {
    const index = pending.findIndex((call) => call.method === method)
    check(index >= 0, `Missing ${method}`)
    return pending.splice(index, 1)[0]!
  }
  const settle = async (call: ReturnType<typeof take>, result: unknown) => run(() => call.resolve({ projectKey: call.projectKey, result }))
  const state = (project: string): GitRepositoryState => ({
    kind: 'repository', projectRoot: project, repositoryRoot: project, headOid: 'a'.repeat(40),
    indexTreeOid: 'b'.repeat(40), indexFingerprint: 'index', worktreeFingerprint: 'worktree', statusRevision: 'status',
    branch: 'main', upstream: null, detached: false, ahead: 0, behind: 0, refreshedAt: 1, truncated: false, lastError: null,
    files: [{ id: 'file', path: '中文 file.txt', originalPath: null, state: 'mixed', indexChange: 'modified',
      worktreeChange: 'modified', conflicted: false, fingerprint: 'file' }]
  })
  const diff = (call: ReturnType<typeof take>) => ({
    kind: (call.payload as GitDiffRequest).kind, path: '中文 file.txt', state: 'ready', revision: 'diff',
    headOid: 'a'.repeat(40), indexTreeOid: 'b'.repeat(40), worktreeFingerprint: 'worktree',
    files: [{ id: 'file', path: '中文 file.txt', originalPath: null, change: 'modified', hunks: [{
      id: 'hunk', header: '@@ -1 +1 @@', oldStart: 1, oldLines: 1, newStart: 1, newLines: 1,
      lines: [{ kind: 'remove', oldLine: 1, newLine: null, content: 'old content' },
        { kind: 'add', oldLine: null, newLine: 1, content: 'remote review content' }]
    }] }], byteCount: 60, fileCount: 1, hunkCount: 1, lineCount: 2, error: null
  })
  const allTabs = () => [...container.querySelectorAll<HTMLButtonElement>('[aria-label="Git 子视图"] [role="tab"]')]
  const reader = () => document.querySelector<HTMLElement>('.git-file-reader')
  const readButton = () => container.querySelector<HTMLButtonElement>('.git-file-read-button')!
  const fullFile = { path: '中文 file.txt', state: 'ready', text: 'context\n<script>plain file marker</script>\ntail',
    byteCount: 47, statusRevision: 'status', error: null }
  const hasWrites = () => container.querySelector('.git-change-action, .git-repository-commit, .git-branches-panel, .git-commit-dialog') !== null
  try {
    await run(() => root.render(<GitChangesPanel projectKey="/A" readOnly />))
    await settle(take('refresh'), { ok: true, state: state('/A') })
    check(allTabs().map((tab) => tab.textContent).join(',') === 'Changes,History' && !hasWrites(), 'Read-only panel exposes unavailable write actions')
    await run(() => allTabs()[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true })))
    check(allTabs()[1]?.getAttribute('aria-selected') === 'true', 'Keyboard did not select the last available read tab')
    const list = take('listHistory')
    await settle(list, { ok: true, snapshot: (list.payload as { snapshot: unknown }).snapshot, commits: [], offset: 0, pageSize: GIT_HISTORY_PAGE_SIZE, hasMore: false })
    results.push('Read-only review exposes Changes/History only and keyboard navigation follows those tabs')

    await run(() => allTabs()[0]!.click())
    const file = container.querySelector<HTMLButtonElement>('.git-change-disclosure')!
    check(file, 'Read-only file disclosure is missing')
    await run(() => file.click())
    const request = take('getDiff')
    check((request.payload as GitDiffRequest).path === '中文 file.txt', 'Diff lost its exact file path')
    await settle(request, diff(request))
    check(container.textContent?.includes('remote review content'), 'Read-only panel did not render the returned diff text')
    check(!hasWrites() && !calls.some((name) => /stage|Commit|Branch/.test(name)), 'Read-only review issued a write command')
    results.push('Read-only review opens the existing diff viewer without exposing or invoking mutations')

    await run(() => { readButton().focus(); readButton().click() })
    await frame()
    check(reader()?.contains(document.activeElement), 'Reader did not receive keyboard focus')
    const fullRead = take('readFile')
    check(!Object.hasOwn(fullRead.payload as object, 'kind'), 'File reader confused working content with a staged diff')
    await settle(fullRead, fullFile)
    check(reader()?.querySelector('pre')?.textContent === fullFile.text && !reader()?.querySelector('script'), 'File text was truncated or interpreted as HTML')
    const bounds = reader()!.getBoundingClientRect()
    check(bounds.left >= 0 && bounds.right <= window.innerWidth && bounds.bottom <= window.innerHeight, 'File reader overflows the viewport')
    await run(() => {
      reader()!.querySelector('pre')!.focus()
      document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }))
    })
    check(document.activeElement === reader()!.querySelector('button'), 'Tab did not stay inside the file modal')
    await run(() => document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
    check(!reader() && document.activeElement === readButton(), 'Escape did not close the reader and restore its trigger')
    results.push('Full file text stays plain and the modal owns keyboard focus and restores its trigger')

    await run(() => readButton().click())
    const dismissed = take('readFile')
    await run(() => reader()!.querySelector<HTMLButtonElement>('[aria-label="关闭文件阅读"]')!.click())
    await settle(dismissed, fullFile)
    check(!reader() && !document.body.textContent?.includes('plain file marker'), 'Dismissed read restored stale content')
    results.push('Pending file reads remain cancellable and their late responses cannot reopen the reader')

    await run(() => readButton().click())
    await settle(take('readFile'), { ...fullFile, state: 'oversized', text: null, byteCount: 0, statusRevision: null })
    check(reader()?.querySelector('[role="alert"]')?.textContent?.includes('256 KiB'), 'File size error is not visible')
    await run(() => [...reader()!.querySelectorAll('button')].find((button) => button.textContent === '重试读取')!.click())
    await settle(take('readFile'), { ...fullFile, text: '', byteCount: 0 })
    check(reader()?.textContent?.includes('空文件') && reader()?.querySelector('pre')?.textContent === '', 'Retry did not display a valid empty file')
    await run(() => document.querySelector<HTMLDivElement>('.git-file-reader-backdrop')!.click())
    check(!reader(), 'Reader backdrop did not dismiss')
    results.push('Reading limits are explicit and retry supports an empty file without stale error text')

    await run(() => readButton().click())
    await settle(take('readFile'), { ...fullFile, statusRevision: 'old-status' })
    check(reader()?.querySelector('[role="alert"]') && !reader()?.querySelector('pre'), 'Reader accepted another repository snapshot')
    await run(() => reader()!.querySelector('button')!.click())
    results.push('The file viewer refuses a successful response for another repository snapshot')

    await run(() => root.render(<GitChangesPanel projectKey="/A" />))
    await settle(take('refresh'), { ok: true, state: state('/A') })
    check(allTabs().length === 3 && hasWrites(), 'Local Git lost its full workflow')
    await run(() => readButton().click())
    const previousModeRead = take('readFile')
    await run(() => root.render(<GitChangesPanel projectKey="/A" readOnly />))
    await settle(take('refresh'), { ok: true, state: state('/A') })
    check(allTabs().length === 2 && !hasWrites(), 'Changing capability retained local write controls')
    await settle(previousModeRead, fullFile)
    check(!reader(), 'Changing capability retained the previous file reader')
    results.push('Capability changes rebuild the panel and local Git keeps its existing write workflow')

    await run(() => root.render(null))
    const preview = createPreviewKernelApi()
    window.piGui = preview
    window.piRemote = createPreviewRemoteAdminApi()
    const initial = (await preview.getState()).state
    const project = initial.activeProjectKey!
    let status: Extract<DesktopClientStatus, { mode: 'windows-remote' }> = {
      mode: 'windows-remote', phase: 'connected', hasStoredCredential: true, lastHost: null,
      capabilities: { kernelCommandTypes: DESKTOP_HOST_KERNEL_COMMAND_TYPES, gitCommandTypes: DESKTOP_HOST_GIT_COMMAND_TYPES },
      error: null, failureKind: null, recovery: null
    }
    const listeners = new Set<(status: DesktopClientStatus) => void>()
    window.piDesktopClient = {
      getStatus: async () => status, setControlIdentity: () => {},
      subscribeStatus: (listener: (status: DesktopClientStatus) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
    } as unknown as Window['piDesktopClient']
    await run(() => root.render(<StrictMode><App /></StrictMode>))
    await frame()
    const open = container.querySelector<HTMLButtonElement>('.workbench-header-right-sidebar-toggle')!
    check(open, 'Remote App did not expose the sidebar')
    await run(() => open.click())
    // StrictMode issues two reads; settle both, leaving the current lifecycle authoritative.
    while (pending.some((call) => call.method === 'refresh')) await settle(take('refresh'), { ok: true, state: state(project) })
    check(allTabs().length === 2 && !hasWrites(), 'App did not apply remote read-only capability to Git')
    results.push('Complete remote App opens the existing Git panel with read-only capability')

    await run(() => container.querySelector<HTMLButtonElement>('.git-change-disclosure')!.click())
    const oldDiff = take('getDiff')
    await run(() => readButton().click())
    const oldFiles = pending.filter((call) => call.method === 'readFile')
    for (const call of oldFiles) pending.splice(pending.indexOf(call), 1)
    const nextSession = initial.sessions.find((session) => session.key !== initial.activeSessionKey)
    check(nextSession, 'Preview needs a second Session for the navigation test')
    await act(async () => { await preview.activateSession(nextSession!.key) })
    await frame()
    while (pending.some((call) => call.method === 'refresh')) await settle(take('refresh'), { ok: true, state: state(project) })
    await settle(oldDiff, diff(oldDiff))
    for (const call of oldFiles) await settle(call, fullFile)
    check(!reader(), 'Previous Session file text appeared after navigation')
    check(container.querySelector('.git-change-disclosure')?.getAttribute('aria-expanded') === 'false', 'Old Session retained its open diff after navigation')
    check(!container.textContent?.includes('remote review content'), 'Previous Session diff text appeared after navigation')
    results.push('Same-Project Session navigation resets remote review and ignores the previous diff response')

    await run(() => readButton().click())
    const disconnectedFiles = pending.filter((call) => call.method === 'readFile')
    for (const call of disconnectedFiles) pending.splice(pending.indexOf(call), 1)
    const connected = status
    await run(() => {
      status = { ...status, phase: 'reconnecting', capabilities: null }
      for (const listener of listeners) listener(status)
    })
    for (const call of disconnectedFiles) await settle(call, fullFile)
    check(!reader() && !document.body.textContent?.includes('plain file marker'), 'Disconnect retained file text')
    await run(() => { status = connected; for (const listener of listeners) listener(status) })
    await frame()
    check(!reader(), 'Reconnect restored the old reader')
    const reopenedSidebar = container.querySelector<HTMLButtonElement>('.workbench-header-right-sidebar-toggle')!
    check(reopenedSidebar, 'Reconnect did not restore the Workbench')
    if (reopenedSidebar.getAttribute('aria-expanded') !== 'true') await run(() => reopenedSidebar.click())
    while (pending.some((call) => call.method === 'refresh')) await settle(take('refresh'), { ok: true, state: state(project) })
    check(allTabs().length === 2 && !reader(), 'Reconnect reused an old file reader')
    results.push('App disconnect discards pending file reads and reconnect starts without cached file content')

    await run(() => allTabs()[1]!.click())
    const lateHistory = take('listHistory')
    await run(() => {
      status = { ...status, phase: 'reconnecting', capabilities: null }
      for (const listener of listeners) listener(status)
    })
    await settle(lateHistory, { ok: true, snapshot: (lateHistory.payload as { snapshot: unknown }).snapshot,
      commits: [], offset: 0, pageSize: GIT_HISTORY_PAGE_SIZE, hasMore: false })
    check(allTabs().length === 0 && !container.querySelector('.git-change-disclosure'), 'Disconnected App retained remote repository content')
    results.push('App disconnect removes repository content and a late history response cannot restore it')
    check(!calls.some((name) => ['stageFile', 'unstageFile', 'prepareCommit', 'executeCommit', 'prepareBranchSync', 'executeBranchSync'].includes(name)), 'Review lifecycle invoked a write or network Git command')
    results.push('All remote review lifecycles complete without Git writes or network operations')
    return results
  } finally {
    await run(() => root.unmount())
    container.remove()
    window.piGui = original.gui
    window.piGit = original.git
    window.piRemote = original.remote
    if (original.desktop === undefined) delete window.piDesktopClient
    else window.piDesktopClient = original.desktop
  }
}
