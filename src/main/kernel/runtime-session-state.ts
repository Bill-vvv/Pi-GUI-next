import type {
  KernelConversationState,
  KernelState,
  RuntimeStatus
} from '../../shared/kernel-contract.ts'
import type { PiRpcEvent } from '../pi-rpc/pi-rpc-client.ts'
import { stripPromptFileBlocks } from '../prompt/prompt-attachments.ts'
import type { RuntimeHostEvent, RuntimeHostState } from '../runtime/runtime-host.ts'
import { projectPiEvent } from './conversation-projection.ts'

/** Session-owned state excludes workspace selection, navigation and shared settings. */
export type RuntimeSessionState = Pick<KernelState,
  'activeSessionKey' | 'commands' | 'advisor' | 'availableModels' |
  'extensionDialog' | 'runtime' | 'session' | 'conversation'
>

/** Keep immutable field references; never retain the surrounding workspace object. */
export function runtimeSessionState(state: RuntimeSessionState): RuntimeSessionState {
  return {
    activeSessionKey: state.activeSessionKey,
    commands: state.commands,
    advisor: state.advisor,
    availableModels: state.availableModels,
    extensionDialog: state.extensionDialog,
    runtime: state.runtime,
    session: state.session,
    conversation: state.conversation
  }
}

export function projectRuntimeSessionState(
  workspace: KernelState,
  session: RuntimeSessionState
): KernelState {
  return { ...workspace, ...runtimeSessionState(session) }
}

/**
 * Foreground and background share these synchronous transitions. Persistence, UI
 * interaction responses, compaction and publication belong to the Kernel owner.
 * Unknown events retain reference identity unless the Conversation projector handles them.
 */
export function reduceRuntimeSessionEvent(
  state: RuntimeSessionState,
  event: RuntimeHostEvent,
  host: RuntimeHostState
): RuntimeSessionState {
  if (event.type === 'diagnostic') {
    return {
      ...state,
      runtime: toKernelRuntime(state.runtime.status, host,
        event.kind === 'stderr' ? undefined : event.message)
    }
  }
  if (event.type === 'process-exit') {
    return {
      ...state,
      runtime: toKernelRuntime(state.runtime.status, {
        ...host, exitCode: event.code, exitSignal: event.signal
      })
    }
  }
  if (event.type === 'activity-started') {
    if (state.runtime.status !== 'ready') return state
    return {
      ...state,
      runtime: toKernelRuntime('running', host),
      session: { ...state.session, settled: false },
      conversation: beginConversationRun(state.conversation)
    }
  }
  if (event.type === 'activity-settled') {
    if (state.runtime.status !== 'running') return state
    return {
      ...state,
      runtime: toKernelRuntime('ready', host),
      session: { ...state.session, settled: true },
      conversation: settleConversationRun(state.conversation)
    }
  }

  const pi = event.event
  let next = state
  if (pi.type === 'agent_start') {
    next = {
      ...next,
      runtime: toKernelRuntime('running', host),
      session: { ...next.session, settled: false },
      conversation: beginConversationRun(next.conversation)
    }
  } else if (pi.type === 'agent_settled') {
    next = {
      ...next,
      runtime: toKernelRuntime('ready', host),
      session: {
        ...next.session,
        settled: true,
        pendingMessageCount: 0,
        pendingSteeringMessages: [],
        pendingFollowUpMessages: []
      },
      conversation: settleConversationRun(next.conversation)
    }
  } else if (pi.type === 'message_end') {
    next = {
      ...next,
      session: { ...next.session, messageCount: next.session.messageCount + 1 }
    }
  } else if (pi.type === 'queue_update') {
    const { steering, followUp } = pi
    if (
      Array.isArray(steering) && steering.every((message): message is string => typeof message === 'string') &&
      Array.isArray(followUp) && followUp.every((message): message is string => typeof message === 'string')
    ) {
      const pendingSteeringMessages = steering.map(stripPromptFileBlocks)
      const pendingFollowUpMessages = followUp.map(stripPromptFileBlocks)
      next = {
        ...next,
        session: {
          ...next.session,
          pendingMessageCount: pendingSteeringMessages.length + pendingFollowUpMessages.length,
          pendingSteeringMessages,
          pendingFollowUpMessages
        }
      }
    }
  } else if (pi.type === 'session_info_changed' && typeof pi.name === 'string') {
    next = { ...next, session: { ...next.session, name: pi.name } }
  }

  const entries = projectPiEvent(next.conversation.entries, pi)
  return entries === next.conversation.entries
    ? next
    : { ...next, conversation: { ...next.conversation, entries } }
}

export function toKernelRuntime(
  status: RuntimeStatus,
  host: RuntimeHostState,
  lastError = host.lastError
): KernelState['runtime'] {
  return {
    status,
    executable: host.executable,
    version: host.version,
    stderrChars: host.stderrChars,
    stderrSummary: host.stderrSummary,
    lastError,
    exitCode: host.exitCode,
    exitSignal: host.exitSignal
  }
}

export function isAssistantMessageEnd(event: PiRpcEvent): boolean {
  return event.type === 'message_end' &&
    typeof event.message === 'object' && event.message !== null &&
    'role' in event.message && event.message.role === 'assistant'
}

export function hasAssistantUsage(event: PiRpcEvent): boolean {
  if (!isAssistantMessageEnd(event) || typeof event.message !== 'object' || event.message === null) return false
  return 'usage' in event.message && typeof event.message.usage === 'object' && event.message.usage !== null
}

export function beginConversationRun(conversation: KernelConversationState): KernelConversationState {
  if (conversation.activeRunStartIndex !== null) return conversation
  return { ...conversation, activeRunStartIndex: conversation.entries.length }
}

export function settleConversationRun(conversation: KernelConversationState): KernelConversationState {
  const activeRunStartIndex = conversation.activeRunStartIndex
  if (activeRunStartIndex === null) return conversation
  const entries = conversation.entries.map((entry, index) => {
    if (
      index < activeRunStartIndex || entry.kind !== 'tool' ||
      (entry.status !== 'pending' && entry.status !== 'running')
    ) return entry
    return { ...entry, status: 'error' as const }
  })
  return { entries, startIndex: 0, activeRunStartIndex: null }
}
