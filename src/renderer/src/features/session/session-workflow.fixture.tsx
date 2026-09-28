import { act, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from '../../App'
import type {
  KernelArchiveReceipt, KernelConversationPage, KernelMutationAck, KernelSessionPreview,
  KernelSessionPreviewPageRequest
} from '../../../../shared/kernel-contract'
import { createPreviewKernelApi, createPreviewRemoteAdminApi } from '../../preview/create-preview-kernel-api'
import type { SessionViewTarget } from '../../session-view-target'
import { useSessionArchive, type SessionOperationRunner } from './use-session-archive'
import { useSessionFork } from './use-session-fork'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

export async function runSessionWorkflowChecks(): Promise<string[]> {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const originalApi = window.piGui
  const originalRemote = window.piRemote
  const originalNow = Date.now
  let now = originalNow()
  Date.now = () => now
  const base = (await createPreviewKernelApi().getState()).state
  let state = { ...base, activeProjectKey: 'project', activeSessionKey: 'A',
    runtime: { ...base.runtime, status: 'ready' as const }, session: { ...base.session, id: 'id-A', settled: true } }
  let target: SessionViewTarget | null = null
  let ack: ReturnType<typeof deferred<void>> | null = null
  let runtimeIdle: ReturnType<typeof deferred<void>> | null = null
  let activation: ReturnType<typeof deferred<void>> | null = null
  let locked = false
  const errors: string[] = []
  const drafts: string[] = []
  const completions: Array<boolean | null> = []
  const activations: string[] = []
  let previewOpened = 0
  type Request = ReturnType<typeof deferred<unknown>> & { method: string; args: unknown[] }
  const requests: Request[] = []
  const callCounts = new Map<string, number>()
  const methods = ['listForkCandidates', 'forkSession', 'archiveSession', 'undoArchiveSession',
    'previewArchivedSession', 'loadEarlierSessionPreview']
  window.piGui = Object.fromEntries(methods.map((method) => [method, (...args: unknown[]) => {
    const request = { ...deferred<unknown>(), method, args }
    requests.push(request)
    callCounts.set(method, (callCounts.get(method) ?? 0) + 1)
    return request.promise
  }])) as unknown as Window['piGui']

  const operations: SessionOperationRunner = {
    async mutation<T extends KernelMutationAck>(_action: unknown, operation: () => Promise<T>, exclusive = true): Promise<T> {
      if (exclusive && locked) throw new Error('Another action is already running.')
      if (exclusive) locked = true
      const acknowledgement = ack
      try {
        const value = await operation()
        if (acknowledgement !== null) await acknowledgement.promise
        return value
      } catch (error) {
        errors.push(String(error))
        throw error
      } finally {
        if (exclusive) locked = false
      }
    },
    async read(_action, operation) {
      try { await operation() } catch (error) { errors.push(String(error)); throw error }
    }
  }
  let archive!: ReturnType<typeof useSessionArchive>
  let fork!: ReturnType<typeof useSessionFork>
  function Probe() {
    archive = useSessionArchive({
      operations, waitForRuntimeEnsureIdle: () => runtimeIdle?.promise ?? Promise.resolve(),
      onArchived: (key) => { if (target?.kind === 'session' && target.sessionKey === key) target = null },
      onPreviewOpened: () => { previewOpened += 1; target = null; archive.clearArchivedSessionPreview() }
    })
    fork = useSessionFork({
      getKernelState: () => state, getSessionViewTarget: () => target,
      ensureSessionRuntime: async (key) => {
        activations.push(key)
        if (activation !== null) await activation.promise
        state = { ...state, activeSessionKey: key, session: { ...state.session, id: `id-${key}` } }
        target = null
      },
      runMutation: operations.mutation,
      onOpenError: (error) => { if (error !== null) errors.push(String(error)) },
      onCompletedAction: (result) => completions.push(result?.succeeded ?? null),
      onForked: (draft) => { drafts.push(draft); target = null }
    })
    return <output>{fork.forkDialogOpen ? 'fork-open' : 'fork-closed'}</output>
  }
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const checks: string[] = []
  let key = 0
  function check(value: unknown, message: string): void {
    if (!value) throw new Error(message)
  }
  const run = async (fn: () => void) => { await act(async () => { fn() }) }
  const mount = async () => { await run(() => root.render(<StrictMode><Probe key={++key} /></StrictMode>)) }
  const render = async () => { await run(() => root.render(<StrictMode><Probe key={key} /></StrictMode>)) }
  const take = (method: string) => {
    const index = requests.findIndex((entry) => entry.method === method)
    check(index >= 0, `Missing ${method}`)
    return requests.splice(index, 1)[0]!
  }
  const candidates = [{ entryId: 'entry', text: 'original prompt', timestamp: 1 }]
  const openFork = async () => {
    await run(() => { void fork.openForkDialog('original prompt') })
    await run(() => take('listForkCandidates').resolve(candidates))
  }
  const receipt = (token: string): KernelArchiveReceipt => ({
    token, projectKey: 'project', sessionKey: token, sessionName: token, durationMs: 5_000
  })
  const addReceipt = async (token: string) => {
    await run(() => { void archive.archiveSession(token) })
    await run(() => take('archiveSession').resolve({ revision: 1, receipt: receipt(token) }))
  }
  const preview = (token: string): KernelSessionPreview => ({
    previewId: `preview-${token}`, projectKey: 'project', sessionKey: token, sessionId: `id-${token}`,
    sessionName: token, conversation: { startIndex: 1, activeRunStartIndex: null,
      entries: [{ id: 'tail', kind: 'error', message: 'tail', title: 'Error', source: 'agent', timestamp: 1 }] }
  })

  try {
    await mount()
    await run(() => { void fork.openForkDialog() })
    const oldCandidates = take('listForkCandidates')
    await run(() => fork.closeForkDialog())
    await openFork()
    await run(() => oldCandidates.resolve([{ ...candidates[0], entryId: 'old' }]))
    check(fork.forkCandidates[0]?.entryId === 'entry', 'Closed dialog candidates leaked into a later opening')
    checks.push('Closed/reopened fork dialogs reject old candidate responses under StrictMode')

    await run(() => fork.closeForkDialog())
    target = { kind: 'session', projectKey: 'project', sessionKey: 'B' }
    activation = deferred<void>()
    await run(() => { void fork.openForkDialog() })
    check(!fork.forkDialogOpen && activations.at(-1) === 'B', 'Fork candidates loaded before historical activation')
    await run(() => activation!.resolve())
    activation = null
    await run(() => take('listForkCandidates').resolve(candidates))
    // Update authoritative identity without rendering: async submit must still fence the old owner.
    state = { ...state, activeSessionKey: 'C', session: { ...state.session, id: 'id-C' } }
    let staleError = ''
    await run(() => { void fork.forkSession('entry').catch((error) => { staleError = String(error) }) })
    check(staleError.includes('分叉目标') && !requests.some((r) => r.method === 'forkSession'), 'Fork used candidates from another Session')
    checks.push('Historical activation precedes candidates; synchronous identity fencing blocks stale submission')

    await openFork()
    ack = deferred<void>()
    await run(() => { void fork.forkSession('entry'); void fork.forkSession('entry') })
    check(callCounts.get('forkSession') === 1 && locked, 'Duplicate fork escaped the shared mutation gate')
    await run(() => take('forkSession').resolve({ revision: 7, draft: 'acknowledged draft', cancelled: false }))
    check(drafts.length === 0 && fork.forkSubmitting, 'Draft was applied before mutation acknowledgement')
    state = { ...state, activeSessionKey: 'fork-result', session: { ...state.session, id: 'fork-id' } }
    await render()
    await run(() => ack!.resolve())
    ack = null
    check(drafts.at(-1) === 'acknowledged draft' && !fork.forkDialogOpen && !locked, 'Acknowledged fork did not release dialog and gate')
    checks.push('One fork submission awaits the applied revision before filling the new Session draft')

    await openFork()
    await run(() => { void fork.forkSession('entry') })
    await run(() => take('forkSession').resolve({ revision: 8, draft: 'cancelled', cancelled: true }))
    check(drafts.length === 1 && !fork.forkDialogOpen, 'Cancelled fork wrote a draft')
    await openFork()
    await run(() => { void fork.forkSession('entry').catch(() => undefined) })
    await run(() => take('forkSession').reject(new Error('fork rejected')))
    check(fork.forkError === 'fork rejected' && !fork.forkSubmitting && !locked && completions.at(-1) === false,
      'Fork failure did not preserve local error and release the gate')
    checks.push('Cancelled forks preserve drafts; rejected forks keep a retryable local error')

    await mount()
    runtimeIdle = deferred<void>()
    ack = deferred<void>()
    await run(() => { void archive.archiveSession('receipt-A') })
    check(!requests.some((r) => r.method === 'archiveSession'), 'Archive raced an unfinished runtime ensure')
    await run(() => runtimeIdle!.resolve())
    runtimeIdle = null
    await run(() => take('archiveSession').resolve({ revision: 9, receipt: receipt('receipt-A') }))
    check(archive.archiveNotifications.length === 0, 'Receipt appeared before the archive revision was applied')
    await run(() => ack!.resolve())
    ack = null
    check(archive.archiveNotifications.length === 1 && !locked, 'Archive receipt missing after acknowledgement')
    checks.push('Archive waits for runtime ensure and acknowledged state before exposing its receipt')

    await addReceipt('receipt-B')
    await run(() => {
      void archive.previewArchivedSession('receipt-A')
      void archive.undoArchive('receipt-A')
      void archive.previewArchivedSession('receipt-A')
      void archive.undoArchive('receipt-B')
    })
    check(callCounts.get('previewArchivedSession') === 1 && callCounts.get('undoArchiveSession') === 1,
      'One-shot receipt could be claimed twice or independent receipt was blocked')
    await run(() => take('undoArchiveSession').resolve({ revision: 10 }))
    await run(() => take('previewArchivedSession').resolve(preview('receipt-A')))
    check(archive.archiveNotifications.length === 0 && archive.archivedSessionPreview?.preview.sessionKey === 'receipt-A',
      'Independent archive actions did not settle correctly')
    checks.push('Receipt claims are synchronous and independent undo/preview actions may settle concurrently')

    await addReceipt('late')
    const beforeOpened = previewOpened
    await run(() => { void archive.previewArchivedSession('late') })
    const late = take('previewArchivedSession')
    await run(() => archive.clearArchivedSessionPreview())
    target = { kind: 'session', projectKey: 'project', sessionKey: 'selected-after-request' }
    await run(() => late.resolve(preview('late')))
    check(archive.archivedSessionPreview === null && previewOpened === beforeOpened && target !== null,
      'A late archive preview replaced the newly selected Session')
    checks.push('Navigation invalidates pending archive previews before they can clear the selected Session')

    await addReceipt('first')
    await addReceipt('latest')
    await run(() => { void archive.previewArchivedSession('first') })
    const first = take('previewArchivedSession')
    await run(() => { void archive.previewArchivedSession('latest') })
    await run(() => take('previewArchivedSession').resolve(preview('latest')))
    await run(() => first.resolve(preview('first')))
    check(archive.archivedSessionPreview?.preview.sessionKey === 'latest', 'Older preview overwrote the latest request')
    await addReceipt('expired')
    await run(() => { void archive.previewArchivedSession('expired') })
    now += 5_001
    const openedBeforeExpiry = previewOpened
    await run(() => take('previewArchivedSession').resolve(preview('expired')))
    check(previewOpened === openedBeforeExpiry, 'Expired receipt changed navigation')
    checks.push('Latest archive preview wins; expired responses do not change navigation')

    await addReceipt('page')
    await run(() => { void archive.previewArchivedSession('page') })
    await run(() => take('previewArchivedSession').resolve(preview('page')))
    let pageError = ''
    await run(() => { void archive.loadEarlierArchivedPreview().catch((error) => { pageError = String(error) }) })
    const pageRequest = take('loadEarlierSessionPreview')
    const request = pageRequest.args[0] as KernelSessionPreviewPageRequest
    const page: KernelConversationPage = { ...request, startIndex: 0,
      entries: [{ id: 'earlier', kind: 'error', message: 'earlier', title: 'Error', source: 'agent', timestamp: 1 }] }
    await run(() => pageRequest.resolve(page))
    check(pageError === '' && archive.archivedSessionPreview?.preview.conversation.startIndex === 0,
      'Detached preview page failed to prepend with its exact identity')
    await addReceipt('stale-page')
    await run(() => { void archive.previewArchivedSession('stale-page') })
    await run(() => take('previewArchivedSession').resolve(preview('stale-page')))
    await run(() => { void archive.loadEarlierArchivedPreview().catch((error) => { pageError = String(error) }) })
    const stalePage = take('loadEarlierSessionPreview')
    await run(() => archive.clearArchivedSessionPreview())
    await run(() => stalePage.resolve(page))
    check(pageError.includes('stale') && archive.archivedSessionPreview === null, 'A stale detached page re-opened preview state')
    checks.push('Detached paging preserves its window identity and rejects pages after navigation')

    await addReceipt('unmounted')
    await run(() => { void archive.previewArchivedSession('unmounted') })
    const unmounted = take('previewArchivedSession')
    await run(() => { void fork.openForkDialog() })
    const unmountedCandidates = take('listForkCandidates')
    const beforeUnmount = previewOpened
    await mount()
    await run(() => { unmounted.resolve(preview('unmounted')); unmountedCandidates.resolve(candidates) })
    check(previewOpened === beforeUnmount && archive.archivedSessionPreview === null && !fork.forkDialogOpen,
      'Unmounted workflow completed into a new lifecycle')
    checks.push('Unmounted fork and archive requests cannot publish into a new React lifecycle')
    window.piGui = createPreviewKernelApi()
    window.piRemote = createPreviewRemoteAdminApi()
    const beforeFork = (await window.piGui.getState()).state.activeSessionKey
    await run(() => root.render(<StrictMode><App /></StrictMode>))
    await act(async () => { await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))) })
    const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="从此轮用户消息分叉对话"]:not(:disabled)')
    check(trigger !== null, 'Mounted App did not expose its available fork action')
    await run(() => trigger!.click())
    const submit = document.querySelector<HTMLButtonElement>('.session-fork-dialog-footer button:last-child')
    check(submit !== null && !submit.disabled, 'App did not wire fork candidates into the existing dialog')
    await run(() => submit!.click())
    await act(async () => { await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))) })
    check((await window.piGui.getState()).state.activeSessionKey !== beforeFork &&
      document.querySelector('.session-fork-dialog') === null &&
      [...container.querySelectorAll('textarea')].some((element) => element.value.length > 0),
      'App failed to apply the acknowledged fork and Composer draft through its real revision barrier')
    checks.push('Mounted App wires the existing fork dialog, real revision barrier and Composer draft together')

    const originalPreviewRead = window.piGui.previewArchivedSession
    const delayedPreview = deferred<KernelSessionPreview>()
    let requestedPreview: KernelSessionPreview | null = null
    window.piGui.previewArchivedSession = async (token) => {
      requestedPreview = await originalPreviewRead(token)
      return delayedPreview.promise
    }
    const archiveButton = container.querySelector<HTMLButtonElement>('button[aria-label="归档对话"]:not(:disabled)')
    check(archiveButton !== null, 'Mounted App did not expose archive on a registered Session')
    await run(() => archiveButton!.click())
    await act(async () => { await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))) })
    const previewButton = [...document.querySelectorAll<HTMLButtonElement>('.archive-notification-actions button')]
      .find((button) => button.textContent === '临时查看')
    check(previewButton !== undefined, 'Acknowledged archive did not expose its preview receipt')
    await run(() => previewButton!.click())
    check(requestedPreview !== null, 'Archive preview request was not issued')
    const startButton = container.querySelector<HTMLButtonElement>('button[aria-label="在此项目中启动对话"]:not(:disabled)')
    check(startButton !== null, 'A pending archive preview incorrectly locked Session navigation')
    await run(() => startButton!.click())
    await act(async () => { await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))) })
    await run(() => delayedPreview.resolve(requestedPreview!))
    check(container.querySelector('button[aria-label="退出归档预览"]') === null,
      'Late archive preview replaced a new Session selected through the real App')
    checks.push('Mounted App navigation rejects a late archive preview instead of replacing the new Session')
    return checks
  } finally {
    await act(async () => root.unmount())
    container.remove()
    Date.now = originalNow
    window.piGui = originalApi
    window.piRemote = originalRemote
  }
}
