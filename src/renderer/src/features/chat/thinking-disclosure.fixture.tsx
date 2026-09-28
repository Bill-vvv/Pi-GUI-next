import { createElement, type ComponentProps } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import type { KernelConversationEntry, KernelThinkingEntry } from '../../../../shared/kernel-contract'
import { Timeline } from './Timeline'

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
