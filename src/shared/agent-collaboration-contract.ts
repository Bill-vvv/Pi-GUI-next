/** App-owned session communication. The sender is bound by the owning RuntimeContext. */
export type AgentCollaborationOperation =
  | { action: 'list' }
  | { action: 'spawn'; task: string; title?: string; model?: string; notifyOnCompletion?: boolean }
  | { action: 'send'; sessionId: string; content: string; notifyOnCompletion?: boolean }
  | { action: 'status' | 'result' | 'cancel'; sessionId: string; messageId?: string }

export type AgentDeliveryStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'

export type AgentSessionReference = {
  sessionId: string
  title: string
  projectPath: string
  status: 'idle' | 'running' | 'waiting' | 'stopped' | 'crashed'
}

export type AgentDelivery = {
  messageId: string
  sourceSessionId: string
  targetSessionId: string
  kind: 'task' | 'message' | 'completion'
  content: string
  status: AgentDeliveryStatus
  result: string | null
  error: string | null
  createdAt: number
  updatedAt: number
}

export type AgentCollaborationResult =
  | { kind: 'sessions'; sessions: AgentSessionReference[] }
  | { kind: 'delivery'; delivery: AgentDelivery }
  | { kind: 'status'; session: AgentSessionReference; deliveries: AgentDelivery[] }
  | { kind: 'result'; delivery: AgentDelivery | null }
  | { kind: 'cancelled'; sessionId: string; messageIds: string[] }

export type AgentCollaborationRequest = {
  requestId: string
  operation: AgentCollaborationOperation
}

export type AgentCollaborationResponse =
  | { requestId: string; ok: true; result: AgentCollaborationResult }
  | { requestId: string; ok: false; error: string }

/** Strict host boundary validation; the sender identity is intentionally absent. */
export function isAgentCollaborationOperation(value: unknown): value is AgentCollaborationOperation {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const operation = value as Record<string, unknown>
  const keys = Object.keys(operation)
  const text = (key: string, max = 30_000): boolean => typeof operation[key] === 'string' &&
    (operation[key] as string).trim().length > 0 && (operation[key] as string).length <= max && !(operation[key] as string).includes('\0')
  const optional = (key: string, max = 256): boolean => operation[key] === undefined || text(key, max)
  const allowed = (names: string[]): boolean => keys.every((key) => names.includes(key))
  if (operation.action === 'list') return keys.length === 1
  if (operation.action === 'spawn') return text('task') && optional('title') && optional('model') &&
    (operation.notifyOnCompletion === undefined || typeof operation.notifyOnCompletion === 'boolean') &&
    allowed(['action', 'task', 'title', 'model', 'notifyOnCompletion'])
  if (operation.action === 'send') return text('sessionId', 256) && text('content') &&
    (operation.notifyOnCompletion === undefined || typeof operation.notifyOnCompletion === 'boolean') &&
    allowed(['action', 'sessionId', 'content', 'notifyOnCompletion'])
  return ['status', 'result', 'cancel'].includes(String(operation.action)) && text('sessionId', 256) &&
    optional('messageId') && allowed(['action', 'sessionId', 'messageId'])
}
