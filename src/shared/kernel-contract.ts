export const KERNEL_COMMAND_CHANNEL = 'pi-gui:kernel-command'
export const KERNEL_EVENT_CHANNEL = 'pi-gui:kernel-event'
export const OPEN_EXTERNAL_CHANNEL = 'pi-gui:open-external'

export type RuntimeStatus =
  | 'stopped'
  | 'starting'
  | 'ready'
  | 'running'
  | 'stopping'
  | 'crashed'

export type ThinkingLevel =
  | 'off'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max'

export type KernelRuntimeState = {
  status: RuntimeStatus
  executable: string | null
  version: string | null
  stderrChars: number
  stderrSummary: string | null
  lastError: string | null
  exitCode: number | null
  exitSignal: string | null
}

export type KernelProjectState = {
  path: string
}

export type KernelSessionSummary = {
  key: string
  id: string
  name: string | null
}

export type KernelModelState = {
  provider: string
  id: string
  name: string
  reasoning: boolean
  contextWindow: number | null
}

export type KernelSessionState = {
  id: string | null
  name: string | null
  resumeAvailable: boolean
  model: KernelModelState | null
  thinkingLevel: ThinkingLevel | null
  messageCount: number
  pendingMessageCount: number
  settled: boolean
}

export type KernelMessageEntry = {
  id: string
  kind: 'message'
  role: 'user' | 'assistant'
  text: string
  timestamp: number
  streaming: boolean
  stopReason: string | null
  error: string | null
}

export type KernelThinkingEntry = {
  id: string
  kind: 'thinking'
  text: string
  timestamp: number
  streaming: boolean
}

export type KernelToolEntry = {
  id: string
  kind: 'tool'
  toolCallId: string
  name: string
  status: 'pending' | 'running' | 'success' | 'error'
  args: string
  output: string
  details: string
  truncated: boolean
  timestamp: number
  durationMs: number | null
}

export type KernelErrorEntry = {
  id: string
  kind: 'error'
  title: string
  message: string
  source: 'agent' | 'extension'
  timestamp: number
}

export type KernelConversationEntry =
  | KernelMessageEntry
  | KernelThinkingEntry
  | KernelToolEntry
  | KernelErrorEntry

export type KernelConversationState = {
  entries: KernelConversationEntry[]
  activeRunStartIndex: number | null
}

export type KernelState = {
  projects: KernelProjectState[]
  activeProjectKey: string | null
  sessions: KernelSessionSummary[]
  activeSessionKey: string | null
  runtime: KernelRuntimeState
  session: KernelSessionState
  conversation: KernelConversationState
}

export type KernelConversationEntryPatch =
  | { type: 'insert'; index: number; entry: KernelConversationEntry }
  | {
      type: 'append-message-text'
      index: number
      from: number
      text: string
      streaming: boolean
      stopReason: string | null
      error: string | null
    }
  | {
      type: 'append-thinking-text'
      index: number
      from: number
      text: string
      streaming: boolean
    }
  | {
      type: 'append-tool-output'
      index: number
      from: number
      output: string
      status: KernelToolEntry['status']
      details: string
      truncated: boolean
      durationMs: number | null
    }

export type KernelConversationPatch = {
  entries?: KernelConversationEntryPatch[]
  activeRunStartIndex?: number | null
}

export type KernelStatePatch = {
  runtime?: KernelRuntimeState
  session?: KernelSessionState
  conversation?: KernelConversationPatch
}

export type KernelCommand =
  | { type: 'kernel.get-state' }
  | { type: 'kernel.add-project' }
  | { type: 'kernel.activate-project'; projectKey: string }
  | { type: 'kernel.start-session' }
  | { type: 'kernel.activate-session'; sessionKey: string }
  | { type: 'kernel.prompt'; message: string }
  | { type: 'kernel.abort' }
  | { type: 'kernel.set-model'; provider: string; modelId: string }
  | { type: 'kernel.set-thinking-level'; level: ThinkingLevel }

export type KernelEvent =
  | {
      type: 'kernel.state-changed'
      state: KernelState
    }
  | {
      type: 'kernel.state-patched'
      patch: KernelStatePatch
    }

export type KernelApi = {
  getState: () => Promise<KernelState>
  addProject: () => Promise<KernelState>
  activateProject: (projectKey: string) => Promise<KernelState>
  startSession: () => Promise<KernelState>
  activateSession: (sessionKey: string) => Promise<KernelState>
  prompt: (message: string) => Promise<KernelState>
  abort: () => Promise<KernelState>
  setModel: (provider: string, modelId: string) => Promise<KernelState>
  setThinkingLevel: (level: ThinkingLevel) => Promise<KernelState>
  openExternal: (url: string) => Promise<void>
  subscribe: (listener: (event: KernelEvent) => void) => () => void
}
