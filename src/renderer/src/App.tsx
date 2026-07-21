import { useEffect, useRef, useState } from 'react'

import type {
  KernelStatePatch,
  KernelState,
  ThinkingLevel
} from '../../shared/kernel-contract'
import { ChatWorkbench } from './features/chat/ChatWorkbench'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function App(): React.JSX.Element {
  const [kernelState, setKernelState] = useState<KernelState | null>(null)
  const [ipcError, setIpcError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [pendingAction, setPendingAction] = useState<string | null>(null)
  const kernelStateRef = useRef<KernelState | null>(null)
  const eventRevision = useRef(0)

  useEffect(() => {
    let active = true
    let pendingPatches: KernelStatePatch[] = []
    let framePatches: KernelStatePatch[] = []
    let renderFrame: number | null = null
    let unsubscribe = (): void => undefined

    const commitImmediately = (state: KernelState): void => {
      if (renderFrame !== null) {
        cancelAnimationFrame(renderFrame)
        renderFrame = null
      }
      framePatches = []
      kernelStateRef.current = state
      setKernelState(state)
    }

    const schedulePatch = (patch: KernelStatePatch): void => {
      framePatches.push(patch)
      if (renderFrame !== null) return
      renderFrame = requestAnimationFrame(() => {
        renderFrame = null
        const state = kernelStateRef.current
        const patches = framePatches
        framePatches = []
        if (!active || state === null) return
        const nextState = applyStatePatches(state, patches)
        kernelStateRef.current = nextState
        setKernelState(nextState)
      })
    }

    try {
      unsubscribe = window.piGui.subscribe((event) => {
        if (!active) return
        eventRevision.current += 1
        if (event.type === 'kernel.state-changed') {
          pendingPatches = []
          commitImmediately(event.state)
        } else {
          const state = kernelStateRef.current
          if (state === null) pendingPatches.push(event.patch)
          else schedulePatch(event.patch)
        }
        setIpcError(null)
      })

      void window.piGui.getState().then(
        (state) => {
          if (!active) return
          if (kernelStateRef.current !== null) return
          const initialized = applyStatePatches(state, pendingPatches)
          pendingPatches = []
          commitImmediately(initialized)
          setIpcError(null)
        },
        (error: unknown) => {
          if (!active) return
          setIpcError(errorMessage(error))
        }
      )
    } catch (error: unknown) {
      setIpcError(errorMessage(error))
    }

    return () => {
      active = false
      if (renderFrame !== null) cancelAnimationFrame(renderFrame)
      unsubscribe()
    }
  }, [])

  async function runAction(
    action: string,
    operation: () => Promise<KernelState>
  ): Promise<void> {
    if (pendingAction !== null) throw new Error('Another action is already running.')
    setPendingAction(action)
    setActionError(null)
    const revisionBeforeAction = eventRevision.current
    try {
      const state = await operation()
      if (eventRevision.current === revisionBeforeAction) {
        kernelStateRef.current = state
        setKernelState(state)
      }
    } catch (error) {
      setActionError(errorMessage(error))
      throw error
    } finally {
      setPendingAction(null)
    }
  }

  if (kernelState === null) {
    return (
      <main className="screen-loading">
        {ipcError ? `无法连接 Workbench Kernel：${ipcError}` : '正在连接 Pi Workbench…'}
      </main>
    )
  }

  return (
    <ChatWorkbench
      state={kernelState}
      pendingAction={pendingAction}
      actionError={actionError ?? ipcError}
      onSelectProject={() => runAction('select-project', () => window.piGui.selectProject())}
      onStart={() => runAction('start-project', () => window.piGui.startProject())}
      onResume={() => runAction('resume-session', () => window.piGui.resumeSession())}
      onPrompt={(message) => runAction('prompt', () => window.piGui.prompt(message))}
      onAbort={() => runAction('abort', () => window.piGui.abort())}
      onSetThinkingLevel={(level: ThinkingLevel) =>
        runAction('set-thinking-level', () => window.piGui.setThinkingLevel(level))
      }
    />
  )
}

function applyStatePatches(state: KernelState, patches: KernelStatePatch[]): KernelState {
  let runtime = state.runtime
  let session = state.session
  let entries = state.conversation.entries
  let activeRunStartIndex = state.conversation.activeRunStartIndex
  let conversationChanged = false
  let entriesCopied = false

  for (const patch of patches) {
    if (patch.runtime !== undefined) runtime = patch.runtime
    if (patch.session !== undefined) session = patch.session
    if (patch.conversation === undefined) continue
    if (patch.conversation.entries !== undefined) {
      if (!entriesCopied) {
        entries = entries.slice()
        entriesCopied = true
      }
      conversationChanged = true
      for (const change of patch.conversation.entries) {
        if (change.type === 'insert') {
          if (change.index === entries.length) entries.push(change.entry)
          else if (entries[change.index]?.id !== change.entry.id) {
            throw new Error(`Conversation insert index ${change.index} is out of sequence.`)
          }
          continue
        }

        const current = entries[change.index]
        if (current === undefined) {
          throw new Error(`Conversation patch index ${change.index} does not exist.`)
        }
        if (change.type === 'append-message-text') {
          if (current.kind !== 'message') throw new Error('Conversation message patch kind mismatch.')
          const text = appendProjectedText(current.text, change.from, change.text)
          if (text === null) continue
          entries[change.index] = {
            ...current,
            text,
            streaming: change.streaming,
            stopReason: change.stopReason,
            error: change.error
          }
          continue
        }
        if (change.type === 'append-thinking-text') {
          if (current.kind !== 'thinking') throw new Error('Conversation thinking patch kind mismatch.')
          const text = appendProjectedText(current.text, change.from, change.text)
          if (text === null) continue
          entries[change.index] = { ...current, text, streaming: change.streaming }
          continue
        }
        if (current.kind !== 'tool') throw new Error('Conversation tool patch kind mismatch.')
        const output = appendProjectedText(current.output, change.from, change.output)
        if (output === null) continue
        entries[change.index] = {
          ...current,
          output,
          status: change.status,
          details: change.details,
          truncated: change.truncated,
          durationMs: change.durationMs
        }
      }
    }
    if ('activeRunStartIndex' in patch.conversation) {
      activeRunStartIndex = patch.conversation.activeRunStartIndex ?? null
      conversationChanged = true
    }
  }

  return {
    ...state,
    runtime,
    session,
    conversation: conversationChanged
      ? { entries, activeRunStartIndex }
      : state.conversation
  }
}

function appendProjectedText(current: string, from: number, addition: string): string | null {
  if (current.length === from) return `${current}${addition}`
  const targetLength = from + addition.length
  if (current.length >= targetLength && current.slice(from, targetLength) === addition) return null
  throw new Error(`Conversation text patch expected ${from} characters; received ${current.length}.`)
}
