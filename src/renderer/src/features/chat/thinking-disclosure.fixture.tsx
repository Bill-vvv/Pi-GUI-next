import { createElement, type ComponentProps } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import type { KernelConversationEntry, KernelSubagentStatus, KernelSubagentTranscript, KernelThinkingEntry } from '../../../../shared/kernel-contract'
import { Timeline } from './Timeline'
import { NativeSubagentTranscript } from './NativeSubagentTranscript'

const thinking = (id: string, streaming: boolean): KernelThinkingEntry => ({
  id, kind: 'thinking', text: 'First reasoning paragraph.\n\nSecond reasoning paragraph.',
  summary: false, streaming, timestamp: 2
})
const entries = (streaming: boolean, grouped = false): KernelConversationEntry[] => [
  { id: 'user', kind: 'message', role: 'user', phase: null, text: 'Investigate.', timestamp: 0, streaming: false, stopReason: null, error: null },
  // A mixed compact process mounts ProcessSequence rather than the summary-only detail shortcut.
  { id: 'commentary', kind: 'message', role: 'assistant', phase: 'commentary', text: 'Inspecting.', timestamp: 1, streaming: false, stopReason: null, error: null },
  thinking('stage', streaming && !grouped),
  ...(grouped ? [thinking('stage-continuation', streaming)] : [])
]
const noop = (): void => undefined
const done = async (): Promise<void> => undefined
const baseProps: ComponentProps<typeof Timeline> = {
  entries: [], activeRunStartIndex: 0, runtimeStatus: 'running', loading: false,
  compactionActive: false, navigateToLatestPromptOnMount: false, showPromptNavigation: false,
  toolDisplayDensity: 'compact', sessionKey: 'session', askSessionKey: null,
  canCopyAnswers: false, canExportSession: false, canForkSession: false,
  canEditHistoryPrompt: false, hasEarlierConversation: false, conversationActionBusy: false,
  conversationActionStatus: null, conversationActionError: null,
  onCopyAnswer: done, onExportSession: done, onLoadEarlierConversation: done,
  onForkTurn: done, onNavigateHistoryPrompt: done, onSendHistoryPrompt: done,
  onHistoryPromptEditingChange: noop, subagentTaskSelection: null, onOpenSubagentTask: noop,
  onSubmitAsk: done, onCancelAsk: done, onLayoutStabilizeReady: noop, warning: null
}

export async function runThinkingDisclosureChecks(): Promise<string[]> {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const checks: string[] = []
  let identity = 0
  let density: 'compact' | 'standard' | 'detailed' = 'compact'
  const render = async (
    streaming: boolean, settled = false, grouped = false,
    displayedEntries = entries(streaming, grouped)
  ): Promise<void> => {
    flushSync(() => root.render(createElement(Timeline, {
      ...baseProps, key: identity, toolDisplayDensity: density, entries: displayedEntries,
      activeRunStartIndex: settled ? null : 0, runtimeStatus: settled ? 'ready' : 'running'
    })))
    // Native details toggle events are queued, including programmatic open changes.
    await new Promise((resolve) => setTimeout(resolve, 30))
  }
  const details = (selector = '.process-thinking'): HTMLDetailsElement => {
    const element = container.querySelector<HTMLDetailsElement>(`details${selector}`)
    if (!element) throw new Error(`Missing ${selector}`)
    return element
  }
  const toggle = async (element: HTMLDetailsElement): Promise<void> => {
    flushSync(() => element.querySelector('summary')!.click())
    await new Promise((resolve) => setTimeout(resolve, 30))
  }
  const expect = (condition: boolean, message: string): void => {
    if (!condition) throw new Error(message)
  }
  const start = async (): Promise<void> => {
    identity += 1
    await render(true)
    if (density === 'compact') await toggle(details('.live-process-status'))
    expect(details().open, 'active thinking starts expanded')
  }

  try {
    await start()
    await render(false)
    expect(!details().open, 'untouched unpinned thinking collapses on completion')
    await render(false, true)
    expect(!details('.completed-process').open, 'untouched run retains historical default collapse')
    checks.push('Untouched active/inactive and settled defaults remain unchanged')

    await start()
    await toggle(details())
    await toggle(details())
    const stage = details()
    await render(true, false, true)
    expect(details() === stage && stage.open, 'adjacent thinking updates preserve stage identity and choice')
    await render(false, false, true)
    expect(details() === stage && stage.open, 'explicit expansion survives stage completion')
    await render(false, true, true)
    expect(details('.completed-process').open && details().open,
      'explicit stage expansion survives actual LiveTurn to CompletedTurn remount')
    expect(details().textContent!.includes('Second reasoning paragraph.'), 'expanded body remains mounted')
    checks.push('Explicit expansion survives grouped updates, stage completion and parent remount')

    await toggle(details('.completed-process'))
    await render(false, true, true)
    expect(!details('.completed-process').open, 'user can still close the completed parent')
    checks.push('Completed process can be manually collapsed despite a remembered stage choice')

    await start()
    await toggle(details())
    await render(false)
    expect(!details().open, 'explicit collapse survives stage completion')
    await render(true)
    expect(!details().open, 'same-stage reactivation does not override explicit collapse')
    await render(false, true)
    expect(!details('.completed-process').open, 'explicit collapse does not force completed parent open')
    await toggle(details('.completed-process'))
    expect(!details().open, 'explicit collapse survives completed child remount')
    checks.push('Explicit collapse wins over subsequent automatic transitions and remounts')

    density = 'detailed'
    await start()
    await render(false)
    expect(details().open, 'pinned stage retains its default expansion')
    await toggle(details())
    await render(true)
    expect(!details().open, 'pinned is not forced open after a user collapse')
    await render(false, true)
    expect(!details('.completed-process').open, 'pinning alone never opts a run into retained expansion')
    checks.push('Pinned default and user-collapse contract remain unchanged')

    await start()
    await toggle(details())
    await toggle(details())
    await render(false, true)
    expect(details('.completed-process').open, 'explicit pinned expansion is remembered')
    identity += 1
    await render(false, true)
    expect(!details('.completed-process').open, 'new Conversation identity discards disclosure choices')
    expect(container.querySelector('.process-thinking') === null, 'history body stays lazily unmounted')
    checks.push('Conversation identity reset restores default historical collapse')

    for (const mode of ['detailed', 'standard'] as const) {
      density = mode
      for (const expectedOpen of [true, false]) {
        identity += 1
        const user = entries(false)[0]!
        const first = thinking('first', false)
        await render(false, false, false, [user, first])
        // Give the earlier member the opposite explicit choice to exercise conflict resolution.
        await toggle(details())
        if (!expectedOpen) await toggle(details())
        expect(details().open === !expectedOpen, 'earlier member has conflicting explicit intent')
        const displayed = (streaming: boolean): KernelConversationEntry[] => mode === 'detailed'
          ? [user, first, {
              id: 'error', kind: 'error', title: 'Retry', message: 'Retrying transport',
              source: 'agent', timestamp: 3
            }, thinking('second', streaming)]
          : [user, { ...first, summary: true, text: '**Earlier summary**' }, thinking('second', streaming)]
        await render(true, false, false, displayed(true))
        expect(container.querySelectorAll('details.process-thinking').length === 1,
          'live path hides the earlier chunk or summary without changing its existing rules')
        await toggle(details())
        if (expectedOpen) await toggle(details())
        expect(details().open === expectedOpen, 'later visible member has explicit choice')
        await render(false, true, false, displayed(false))
        expect(details('.completed-process').open === expectedOpen,
          'completed parent uses the same merged-group choice, not any stale open member')
        if (!expectedOpen) await toggle(details('.completed-process'))
        expect(container.querySelectorAll('details.process-thinking').length === 1,
          'settled projection still merges both thinking entries')
        expect(details().open === expectedOpen,
          'later explicit member wins when settled group starts with a different entry')
        await toggle(details())
        await render(true, false, false, displayed(true))
        expect(details().open === !expectedOpen,
          'toggling merged group records every displayed member before the first member is hidden')
        checks.push(`${mode}: merged and filtered groups preserve explicit ${expectedOpen ? 'open' : 'closed'} choice`)
      }
    }
  } finally {
    flushSync(() => root.unmount())
    container.remove()
  }
  return checks
}

/** Exercise the actual transcript reader and typed controls in the existing Timeline fixture. */
export async function runNativeSubagentChecks(): Promise<string[]> {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const checks: string[] = []
  const calls: Array<{ taskId: string; sessionKey: string; action: string; message?: string }> = []
  let status: KernelSubagentStatus = 'completed'
  let continued = false
  let resolveLate: ((value: KernelSubagentTranscript) => void) | undefined
  const transcript = (taskId: string): KernelSubagentTranscript => ({
    taskId, status,
    entries: [
      { id: 'user', kind: 'message', role: 'user', phase: null, text: `Prompt for ${taskId}`, timestamp: 1, streaming: false, stopReason: null, error: null },
      { id: 'answer', kind: 'message', role: 'assistant', phase: null, text: `Answer for ${taskId}`, timestamp: 2, streaming: false, stopReason: null, error: null },
      ...(continued ? [{ id: 'followup', kind: 'message' as const, role: 'user' as const, phase: null, text: 'Continue precisely', timestamp: 3, streaming: false, stopReason: null, error: null }] : [])
    ]
  })
  const reader = async (taskId: string, sessionKey: string): Promise<KernelSubagentTranscript> => {
    if (sessionKey !== `session:${taskId}`) throw new Error('Wrong parent session')
    if (taskId === 'late') return new Promise((resolve) => { resolveLate = resolve })
    if (taskId === 'missing') throw new Error('Native task execution instance no longer exists')
    return transcript(taskId)
  }
  const control = async (taskId: string, sessionKey: string, action: 'stop' | 'continue', message?: string): Promise<void> => {
    calls.push({ taskId, sessionKey, action, message })
    status = action === 'stop' ? 'paused' : 'running'
    if (action === 'continue') continued = true
  }
  const render = (taskId: string, initialStatus: KernelSubagentStatus): void => {
    flushSync(() => root.render(createElement(NativeSubagentTranscript, {
      key: taskId, taskId, expectedSessionKey: `session:${taskId}`, initialStatus,
      onGetTranscript: reader, onControl: control
    })))
  }
  const until = async (condition: () => boolean, message: string): Promise<void> => {
    for (let frame = 0; frame < 120; frame += 1) {
      if (condition()) return
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    }
    throw new Error(message)
  }
  const button = (label: string): HTMLButtonElement => {
    const found = [...container.querySelectorAll('button')].find((element) => element.textContent === label)
    if (found === undefined) throw new Error(`Missing button ${label}`)
    return found
  }
  const typeMessage = (text: string): void => {
    const input = container.querySelector('textarea')!
    flushSync(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, text)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }
  try {
    render('task', 'completed')
    await until(() => container.textContent!.includes('Answer for task'), 'native transcript was not readable')
    checks.push('Native transcript renders prompt and answer with the existing Timeline')

    typeMessage('Keep this draft')
    status = 'running'
    render('task', 'running')
    await until(() => container.querySelector('textarea') === null && !button('停止').disabled, 'external Task continuation did not refresh the panel')
    flushSync(() => button('停止').click())
    await until(() => container.querySelector('textarea') !== null, 'stop did not refresh to paused')
    if (calls[0]?.action !== 'stop' || calls[0]?.sessionKey !== 'session:task') throw new Error('stop used the wrong task owner')
    if (container.querySelector('textarea')!.value !== 'Keep this draft') throw new Error('same-task status refresh discarded the continuation draft')
    checks.push('External continuation refreshes status; stopping uses the exact owner and preserves the draft')

    typeMessage('Continue precisely')
    flushSync(() => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    await until(() => container.textContent!.includes('Continue precisely') && container.querySelector('textarea') === null, 'continuation did not retain and extend task history')
    if (calls[1]?.action !== 'continue' || calls[1]?.message !== 'Continue precisely') throw new Error('continuation used the wrong command')
    checks.push('Continuing sends the typed command and retains earlier task history')

    render('late', 'completed')
    await until(() => resolveLate !== undefined, 'late read did not start')
    if (container.textContent!.includes('Answer for task')) throw new Error('task switch retained the old output')
    render('next', 'completed')
    await until(() => container.textContent!.includes('Answer for next'), 'new task did not load')
    resolveLate!(transcript('late'))
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    if (container.textContent!.includes('Answer for late')) throw new Error('late old-task response replaced the new task')
    checks.push('Identity switch clears old output and ignores a late transcript response')

    render('missing', 'failed')
    await until(() => container.textContent!.includes('当前无法读取或控制此子任务'), 'missing historical task did not show an unavailable state')
    if (container.querySelector('form') !== null) throw new Error('unavailable history exposed continuation')
    checks.push('Unavailable native task history exposes a concrete error and refresh without a fake control')
  } finally {
    flushSync(() => root.unmount())
    container.remove()
  }
  return checks
}
