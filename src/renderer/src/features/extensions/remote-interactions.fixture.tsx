import { act, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from '../../App'
import { createPreviewKernelApi, createPreviewRemoteAdminApi } from '../../preview/create-preview-kernel-api'
import { DESKTOP_HOST_KERNEL_COMMAND_TYPES } from '../../../../shared/desktop-host-contract'
import type { DesktopClientStatus } from '../../../../shared/desktop-client-contract'
import type { KernelEvent, KernelExtensionDialogRequest, KernelMutationAck, KernelToolEntry } from '../../../../shared/kernel-contract'
import '../../tokens.css'
import '../../styles.css'

export async function runRemoteInteractionChecks(): Promise<string[]> {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const original = { gui: window.piGui, remote: window.piRemote, desktop: window.piDesktopClient }
  const preview = createPreviewKernelApi()
  const snapshot = await preview.getState()
  let state = snapshot.state
  let revision = snapshot.revision
  const listeners = new Set<(event: KernelEvent) => void>()
  const publish = () => {
    revision += 1
    for (const listener of listeners) listener({ type: 'kernel.state-changed', revision, state: structuredClone(state) })
  }
  let status: Extract<DesktopClientStatus, { mode: 'windows-remote' }> = {
    mode: 'windows-remote', phase: 'connected', hasStoredCredential: true, lastHost: null,
    capabilities: { kernelCommandTypes: DESKTOP_HOST_KERNEL_COMMAND_TYPES }, error: null, failureKind: null, recovery: null
  }
  const statusListeners = new Set<(status: DesktopClientStatus) => void>()
  const pending: Array<{ args: unknown[]; cancel: boolean; resolve: (value: KernelMutationAck) => void; reject: (error: Error) => void }> = []
  const calls: unknown[][] = []
  let holdInvocation = false
  let finishInvocation: ((ack: KernelMutationAck) => void) | undefined
  const respond = (cancel: boolean, args: unknown[]) => new Promise<KernelMutationAck>((resolve, reject) => pending.push({ cancel, args, resolve, reject }))
  state = { ...state, commands: [...state.commands, { id: 'pi-command:extension:run', name: 'run', source: 'extension',
    description: 'Run adapted command', argumentHint: '<task>', sourceInfo: { source: 'npm:pi-subagents@0.37.2', scope: 'user', origin: 'package' } }] }
  window.piGui = { ...preview,
    getState: async () => ({ revision, state: structuredClone(state) }),
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    invokeCommand: async (...args) => {
      calls.push(args)
      if (holdInvocation) return new Promise<KernelMutationAck>((resolve) => { finishInvocation = resolve })
      return { revision }
    },
    respondExtensionDialog: (...args) => respond(false, args),
    cancelExtensionDialog: (...args) => respond(true, args),
    submitAsk: (...args) => respond(false, args),
    cancelAsk: (...args) => respond(true, args)
  }
  window.piRemote = createPreviewRemoteAdminApi()
  window.piDesktopClient = { getStatus: async () => status, setControlIdentity: () => {},
    subscribeStatus: (listener: (status: DesktopClientStatus) => void) => { statusListeners.add(listener); return () => { statusListeners.delete(listener) } }
  } as unknown as Window['piDesktopClient']
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const checks: string[] = []
  const check = (condition: unknown, message: string) => { if (!condition) throw new Error(message) }
  const run = async (fn: () => void) => { await act(async () => { fn() }) }
  const frame = async () => { await act(async () => { await new Promise<void>((resolve) => requestAnimationFrame(() => resolve())) }) }
  const take = () => { const call = pending.shift(); check(call, 'Dialog response did not reach preload'); return call! }
  const dialog = () => document.querySelector<HTMLElement>('.extension-dialog')!
  const submit = () => dialog().querySelector<HTMLButtonElement>('[type="submit"]')!
  const field = () => dialog().querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('input, textarea, select')!
  const setValue = (element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')!.set!.call(element, value)
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
  }
  const request = (method: KernelExtensionDialogRequest['method'], invocation = 'invocation-1'): KernelExtensionDialogRequest => ({
    projectKey: state.activeProjectKey!, sessionKey: state.activeSessionKey!, sessionId: state.session.id!,
    requestId: 'same-request-id', commandInvocationId: invocation, commandName: 'run', method,
    title: '远程扩展输入', message: '是否继续？', options: ['explorer', 'reviewer'], placeholder: '输入', prefill: '初始内容', status: 'waiting', error: null
  })
  const show = async (value: KernelExtensionDialogRequest) => run(() => { state = { ...state, extensionDialog: value }; publish() })
  const settle = async (call: ReturnType<typeof take>) => run(() => {
    state = { ...state, extensionDialog: null }; publish(); call.resolve({ revision })
  })
  try {
    await run(() => root.render(<StrictMode><App /></StrictMode>))
    await frame()
    const composer = container.querySelector<HTMLTextAreaElement>('.composer textarea')!
    check(composer, 'Composer unavailable')
    await run(() => setValue(composer, '/run explorer inspect'))
    await run(() => container.querySelector<HTMLFormElement>('form')!.requestSubmit())
    await frame()
    check(calls.length === 1 && calls[0]?.[0] === 'pi-command:extension:run', 'Adapted command did not use the existing invocation API')
    await run(() => setValue(composer, '/new'))
    await run(() => container.querySelector<HTMLFormElement>('form')!.requestSubmit())
    check(calls.length === 1 && container.textContent?.includes('未知命令'), 'Remote composer exposed a local GUI command')
    checks.push('Remote Composer invokes an adapted Extension and rejects unavailable GUI slash commands')

    const originalSession = { key: state.activeSessionKey!, id: state.session.id! }
    const otherSession = state.sessions.find((session) => session.key !== state.activeSessionKey)!
    check(otherSession, 'Fixture needs a second Session')
    await run(() => setValue(composer, '保留这份草稿'))
    await run(() => { state = { ...state, activeSessionKey: otherSession.key, session: { ...state.session, id: otherSession.id } }; publish() })
    await run(() => setValue(composer, '/run explorer later'))
    holdInvocation = true
    await run(() => container.querySelector<HTMLFormElement>('form')!.requestSubmit())
    check(finishInvocation, 'Deferred command did not start')
    await run(() => { state = { ...state, activeSessionKey: originalSession.key, session: { ...state.session, id: originalSession.id } }; publish() })
    check(composer.value === '保留这份草稿', 'Navigation did not restore the saved draft')
    await run(() => finishInvocation!({ revision }))
    check(composer.value === '保留这份草稿', 'Late command completion cleared another Session draft')
    holdInvocation = false
    checks.push('An Extension command finishing after navigation cannot clear another Session draft')

    const askEntry: KernelToolEntry = {
      id: 'remote-ask', kind: 'tool', toolCallId: 'remote-ask', name: 'ask', status: 'running', args: '{}', output: '',
      details: '', truncated: false, timestamp: Date.now(), durationMs: null, subagent: null,
      ask: { status: 'waiting', error: null, questions: [{ id: 'scope', prompt: '选择范围', type: 'single', placeholder: null,
        options: [{ value: 'small', label: '小范围', description: null }, { value: 'large', label: '大范围', description: null }] }] }
    }
    const priorConversation = state.conversation
    await run(() => {
      state = { ...state, conversation: { startIndex: 0, activeRunStartIndex: 0, entries: [
        { id: 'ask-prompt', kind: 'message', role: 'user', text: '请确认范围', timestamp: Date.now(), streaming: false, stopReason: null, error: null }, askEntry
      ] } }
      publish()
    })
    await frame()
    const askCard = () => container.querySelector<HTMLElement>('.ask-tool-card')!
    check(askCard(), 'Remote Ask form is unavailable')
    await run(() => askCard().querySelector<HTMLInputElement>('input[type="radio"]')!.click())
    await run(() => { askCard().querySelector<HTMLButtonElement>('.ask-tool-submit')!.click(); askCard().querySelector<HTMLButtonElement>('.ask-tool-submit')!.click() })
    const answered = take()
    check(!answered.cancel && pending.length === 0 && JSON.stringify(answered.args) === JSON.stringify([state.activeSessionKey, 'remote-ask', [{ questionId: 'scope', value: 'small' }]]), 'Ask lost ownership or sent duplicate answers')
    await run(() => answered.reject(new Error('Ask 回复失败')))
    check(askCard().textContent?.includes('Ask 回复失败'), 'Ask failure was hidden')
    await run(() => { askCard().querySelector<HTMLButtonElement>('.ask-tool-cancel')!.click(); askCard().querySelector<HTMLButtonElement>('.ask-tool-cancel')!.click() })
    const askCancelled = take()
    check(askCancelled.cancel && pending.length === 0 && askCancelled.args[1] === 'remote-ask', 'Ask sent duplicate cancellation or wrong tool identity')
    await run(() => { state = { ...state, conversation: priorConversation }; publish(); askCancelled.resolve({ revision }) })
    checks.push('Remote Ask submits structured answers, blocks duplicate clicks, reports failure and cancels the original request')

    for (const [method, value] of [['select', 'reviewer'], ['input', '中文回答'], ['editor', '第一行\n第二行'], ['confirm', 'true']] as const) {
      const target = request(method, `invocation-${method}`)
      await show(target)
      await frame()
      const bounds = dialog().getBoundingClientRect()
      check(bounds.left >= 0 && bounds.right <= innerWidth, 'Dialog overflows viewport')
      check(dialog().contains(document.activeElement), 'Modal did not receive focus')
      if (method !== 'confirm') await run(() => setValue(field(), value))
      await run(() => { submit().click(); submit().click() })
      const call = take()
      check(!call.cancel && pending.length === 0 && submit().disabled, 'Double response was not blocked')
      check(JSON.stringify(call.args) === JSON.stringify([target.projectKey, target.sessionKey, target.sessionId, target.requestId, target.commandInvocationId, value]), 'Dialog response lost its exact owner or value')
      await settle(call)
      check(!dialog(), 'Acknowledged dialog stayed open')
    }
    checks.push('Select, input, editor and confirm dialogs preserve exact ownership, focus, bounds and single submission')

    await show(request('input'))
    await run(() => submit().click())
    await run(() => take().reject(new Error('连接结果未确认，请检查当前任务。')))
    check(dialog().textContent?.includes('连接结果未确认') && !submit().disabled, 'Failure was hidden or retry stayed disabled')
    await run(() => dialog().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
    const cancel = take()
    check(cancel.cancel, 'Escape did not use cancel API')
    await settle(cancel)
    checks.push('A failed response stays visible and Escape uses the exact cancellation API')

    await show(request('input', 'old-invocation'))
    await run(() => setValue(field(), 'old draft'))
    await run(() => submit().click())
    const old = take()
    await show(request('editor', 'new-invocation'))
    check(field().value === '初始内容' && !submit().disabled, 'Reused request ID inherited a previous invocation draft')
    await run(() => old.reject(new Error('old response error')))
    check(!dialog().textContent?.includes('old response error') && field().value === '初始内容', 'Old response changed the new dialog')
    checks.push('A new invocation with a reused request ID resets its draft and ignores late errors')

    await run(() => {
      const next = state.sessions.find((session) => session.key !== state.activeSessionKey)!
      check(next, 'Fixture needs another Session')
      state = { ...state, activeSessionKey: next.key, session: { ...state.session, id: next.id }, extensionDialog: null }
      publish()
    })
    check(!dialog(), 'Session navigation retained old modal')
    checks.push('Session navigation removes the old Extension dialog')

    await show(request('confirm'))
    await run(() => submit().click())
    const disconnected = take()
    await run(() => { status = { ...status, phase: 'reconnecting', capabilities: null }; for (const listener of statusListeners) listener(status) })
    check(!dialog(), 'Disconnect retained an actionable modal')
    await run(() => disconnected.reject(new Error('lost connection')))
    check(!dialog(), 'Late disconnected response restored a dialog')
    checks.push('Disconnect unmounts modal controls and ignores late responses')

    await run(() => { status = { ...status, phase: 'connected', capabilities: { kernelCommandTypes: DESKTOP_HOST_KERNEL_COMMAND_TYPES.filter((type) => type !== 'kernel.respond-extension-dialog') } }; for (const listener of statusListeners) listener(status) })
    await frame()
    check(dialog() && submit().disabled && dialog().textContent?.includes('当前 Host 不支持'), 'Missing capability did not disable responses explicitly')
    await run(() => submit().click())
    check(pending.length === 0, 'Unsupported response reached preload')
    checks.push('An incomplete Host capability disables the dialog with a visible explanation')

    await run(() => { status = { ...status, capabilities: { kernelCommandTypes: DESKTOP_HOST_KERNEL_COMMAND_TYPES } }; for (const listener of statusListeners) listener(status) })
    await frame()
    check(!submit().disabled && pending.length === 0, 'Reconnect replayed the old response or retained a pending flag')
    checks.push('A fresh connected view restores the Host request without replaying a response')
    return checks
  } finally {
    await run(() => root.unmount())
    container.remove()
    window.piGui = original.gui
    window.piRemote = original.remote
    if (original.desktop === undefined) delete window.piDesktopClient
    else window.piDesktopClient = original.desktop
  }
}
