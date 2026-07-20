export const KERNEL_COMMAND_CHANNEL = 'pi-gui:kernel-command'
export const KERNEL_EVENT_CHANNEL = 'pi-gui:kernel-event'

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
  lastError: string | null
  exitCode: number | null
  exitSignal: string | null
}

export type ProjectTrust = 'trusted' | 'untrusted'

export type KernelProjectState = {
  path: string | null
  trust: ProjectTrust | null
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
  thinking: string
  timestamp: number
  streaming: boolean
  stopReason: string | null
  error: string | null
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

export type KernelConversationEntry = KernelMessageEntry | KernelToolEntry | KernelErrorEntry

export type KernelConversationState = {
  entries: KernelConversationEntry[]
}

export type KernelState = {
  project: KernelProjectState
  runtime: KernelRuntimeState
  session: KernelSessionState
  conversation: KernelConversationState
}

export type KernelCommand =
  | { type: 'kernel.get-state' }
  | { type: 'kernel.select-project' }
  | { type: 'kernel.set-project-trust'; trust: ProjectTrust }
  | { type: 'kernel.start-project' }
  | { type: 'kernel.prompt'; message: string }
  | { type: 'kernel.abort' }
  | { type: 'kernel.set-model'; provider: string; modelId: string }
  | { type: 'kernel.set-thinking-level'; level: ThinkingLevel }

export type KernelEvent = {
  type: 'kernel.state-changed'
  state: KernelState
}

export type KernelApi = {
  getState: () => Promise<KernelState>
  selectProject: () => Promise<KernelState>
  setProjectTrust: (trust: ProjectTrust) => Promise<KernelState>
  startProject: () => Promise<KernelState>
  prompt: (message: string) => Promise<KernelState>
  abort: () => Promise<KernelState>
  setModel: (provider: string, modelId: string) => Promise<KernelState>
  setThinkingLevel: (level: ThinkingLevel) => Promise<KernelState>
  subscribe: (listener: (event: KernelEvent) => void) => () => void
}
