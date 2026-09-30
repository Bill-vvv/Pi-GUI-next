import type { KernelConversationEntry, ThinkingLevel } from './kernel-contract.ts'

export type KernelSubagentDefinitionScope = 'builtin' | 'user' | 'project'
export type KernelSubagentEditableScope = Exclude<KernelSubagentDefinitionScope, 'builtin'>

export type KernelSubagentDefinition = {
  id: string
  scope: KernelSubagentDefinitionScope
  editable: boolean
  enabled: boolean
  name: string
  description: string
  systemPrompt: string
  model: string | null
  fallbackModels: string[] | null
  thinking: ThinkingLevel | null
  systemPromptMode: 'replace' | 'append'
  inheritProjectContext: boolean
  inheritSkills: boolean
  defaultContext: 'fresh' | 'fork' | null
  tools: string[] | null
  skills: string[] | null
  defaultAsync: boolean | null
  timeoutMs: number | null
  maxTurns: number | null
  maxSubagentDepth: number | null
}

export type KernelSubagentDefinitionInput = Omit<
  KernelSubagentDefinition,
  'id' | 'editable' | 'enabled' | 'scope'
> & {
  originalId: string | null
  scope: KernelSubagentEditableScope
}

export type KernelSubagentStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'paused'
  | 'detached'

export type KernelSubagentUsage = {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  costUsd: number
}

export type KernelSubagentOutputReference = {
  agent: string | null
  path: string
  sizeLabel: string | null
  lines: number | null
}

export type KernelSubagentParticipant = {
  nativeTaskId?: string
  index: number
  agent: string
  status: KernelSubagentStatus
  task: string
  model: string | null
  usage: KernelSubagentUsage | null
  currentTool: string | null
  currentPath: string | null
  toolCount: number
  turnCount: number
  tokens: number
  durationMs: number
  error: string | null
  finalOutput: string | null
  outputReferences: KernelSubagentOutputReference[]
}

export type KernelSubagentTranscript = {
  taskId: string
  status: KernelSubagentStatus
  entries: KernelConversationEntry[]
}

export type KernelSubagentRun = {
  mode: 'single' | 'parallel' | 'chain'
  runId: string | null
  asyncId: string | null
  participants: KernelSubagentParticipant[]
}
