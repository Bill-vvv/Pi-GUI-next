import { randomUUID } from 'node:crypto'
import type {
  AgentCollaborationOperation, AgentCollaborationResult, AgentDelivery, AgentSessionReference
} from '../../shared/agent-collaboration-contract.ts'

export type SessionCollaborationHost = {
  list: () => AgentSessionReference[]
  spawn: (sourceSessionId: string, title?: string, model?: string) => Promise<AgentSessionReference>
  ready: (sessionId: string) => boolean
  deliver: (delivery: AgentDelivery) => Promise<void>
  abort: (sessionId: string) => Promise<void>
  reportError: (sessionId: string, error: string) => void
  now: () => number
}

/** In-memory deliveries belong to exact persisted Pi Sessions, never foreground selection. */
export class SessionCollaboration {
  private readonly records = new Map<string, AgentDelivery>()
  private readonly queues = new Map<string, string[]>()
  private readonly running = new Map<string, string>()
  private readonly notify = new Set<string>()
  private readonly draining = new Set<string>()

  private readonly host: SessionCollaborationHost

  constructor(host: SessionCollaborationHost) {
    this.host = host
  }

  ready(sessionId: string): void {
    this.scheduleDrain(sessionId)
  }

  hasPending(sessionId: string): boolean {
    return this.running.has(sessionId) || (this.queues.get(sessionId)?.length ?? 0) > 0
  }

  async execute(sourceSessionId: string, operation: AgentCollaborationOperation): Promise<AgentCollaborationResult> {
    this.session(sourceSessionId)
    if (operation.action === 'list') return { kind: 'sessions', sessions: this.host.list() }
    if (operation.action === 'spawn') {
      const target = await this.host.spawn(sourceSessionId, operation.title, operation.model)
      const delivery = this.enqueue(sourceSessionId, target.sessionId, 'task', operation.task, operation.notifyOnCompletion !== false)
      await this.drain(target.sessionId)
      return { kind: 'delivery', delivery: { ...delivery } }
    }
    const target = this.session(operation.sessionId)
    if (operation.action === 'send') {
      if (target.status === 'crashed' || target.status === 'stopped') throw new Error('Target Session must be resumed before receiving agent messages.')
      if (sourceSessionId === target.sessionId) throw new Error('SessionTask cannot send a message to its own Session.')
      const delivery = this.enqueue(sourceSessionId, target.sessionId, 'message', operation.content, operation.notifyOnCompletion !== false)
      await this.drain(target.sessionId)
      return { kind: 'delivery', delivery: { ...delivery } }
    }
    const deliveries = [...this.records.values()].filter((delivery) =>
      delivery.targetSessionId === target.sessionId && delivery.sourceSessionId === sourceSessionId &&
      (operation.messageId === undefined || delivery.messageId === operation.messageId)
    )
    if (operation.messageId !== undefined && deliveries.length === 0) {
      throw new Error('Delivery does not belong to the requesting Session and target.')
    }
    if (operation.action === 'status') return { kind: 'status', session: target, deliveries: deliveries.map((delivery) => ({ ...delivery })) }
    if (operation.action === 'result') return { kind: 'result', delivery: deliveries.length === 0 ? null : { ...deliveries.at(-1)! } }
    const pending = deliveries.filter((delivery) => delivery.status === 'queued' || delivery.status === 'running')
    const abortRunning = pending.some((delivery) => this.running.get(target.sessionId) === delivery.messageId)
    const runningId = this.running.get(target.sessionId)
    const runningWasNotified = runningId !== undefined && this.notify.has(runningId)
    for (const delivery of pending) {
      delivery.status = 'cancelled'
      delivery.updatedAt = this.host.now()
      this.notify.delete(delivery.messageId)
    }
    this.queues.set(target.sessionId, (this.queues.get(target.sessionId) ?? []).filter((id) => !pending.some((delivery) => delivery.messageId === id)))
    if (abortRunning) {
      try {
        await this.host.abort(target.sessionId)
      } catch (error) {
        const runningDelivery = runningId === undefined ? undefined : this.records.get(runningId)
        if (runningDelivery !== undefined && this.running.get(target.sessionId) === runningId) {
          runningDelivery.status = 'running'
          runningDelivery.updatedAt = this.host.now()
          if (runningWasNotified) this.notify.add(runningDelivery.messageId)
        }
        throw error
      }
    }
    return { kind: 'cancelled', sessionId: target.sessionId, messageIds: pending.map((delivery) => delivery.messageId) }
  }

  /** Called only after the owning agent_settled; result is from this delivery's run. */
  settled(sessionId: string, result: string | null, error: string | null, aborted = false): void {
    const id = this.running.get(sessionId)
    this.running.delete(sessionId)
    const delivery = id === undefined ? undefined : this.records.get(id)
    if (delivery !== undefined && delivery.status === 'running') {
      delivery.status = aborted ? 'cancelled' : error === null ? 'completed' : 'failed'
      delivery.result = result
      delivery.error = error
      delivery.updatedAt = this.host.now()
      if (this.notify.delete(delivery.messageId) && delivery.kind !== 'completion') {
        const content = `对话 ${sessionId} 已${delivery.status === 'completed' ? '完成' : '结束'}投递 ${delivery.messageId}。\n\n${error ?? result ?? '（没有文本回答）'}`
        try {
          this.enqueue(sessionId, delivery.sourceSessionId, 'completion', content, false)
          this.scheduleDrain(delivery.sourceSessionId)
        } catch (cause) {
          this.host.reportError(delivery.sourceSessionId, cause instanceof Error ? cause.message : String(cause))
        }
      }
    }
    this.scheduleDrain(sessionId)
  }

  interrupted(sessionId: string, error: string): void {
    this.running.delete(sessionId)
    this.queues.delete(sessionId)
    for (const delivery of this.records.values()) {
      // A stopped sender must not be restarted later by a completion callback.
      if (delivery.sourceSessionId === sessionId) this.notify.delete(delivery.messageId)
      if (delivery.targetSessionId !== sessionId || !['queued', 'running'].includes(delivery.status)) continue
      delivery.status = 'interrupted'
      delivery.error = error
      delivery.updatedAt = this.host.now()
      this.notify.delete(delivery.messageId)
    }
  }

  private session(sessionId: string): AgentSessionReference {
    const matches = this.host.list().filter((session) => session.sessionId === sessionId)
    if (matches.length !== 1) throw new Error('Target Session identity is unavailable or ambiguous.')
    return matches[0]!
  }

  private enqueue(sourceSessionId: string, targetSessionId: string, kind: AgentDelivery['kind'], content: string, notify: boolean): AgentDelivery {
    if (content.trim().length === 0) throw new Error('Agent message must not be empty.')
    this.session(targetSessionId)
    while (this.records.size >= 256) {
      const expired = [...this.records.values()].find((record) => !['queued', 'running'].includes(record.status))
      if (expired === undefined) throw new Error('Agent message queue is full.')
      this.records.delete(expired.messageId)
    }
    const now = this.host.now()
    const delivery: AgentDelivery = {
      messageId: randomUUID(), sourceSessionId, targetSessionId, kind, content,
      status: 'queued', result: null, error: null, createdAt: now, updatedAt: now
    }
    this.records.set(delivery.messageId, delivery)
    this.queues.set(targetSessionId, [...(this.queues.get(targetSessionId) ?? []), delivery.messageId])
    if (notify) this.notify.add(delivery.messageId)
    return delivery
  }

  private scheduleDrain(sessionId: string): void {
    queueMicrotask(() => {
      void this.drain(sessionId).catch((cause: unknown) => {
        this.host.reportError(sessionId, cause instanceof Error ? cause.message : String(cause))
      })
    })
  }

  private async drain(sessionId: string): Promise<void> {
    if (this.draining.has(sessionId) || this.running.has(sessionId) || !this.host.ready(sessionId)) return
    const id = this.queues.get(sessionId)?.shift()
    if (id === undefined) return
    const delivery = this.records.get(id)!
    this.draining.add(sessionId)
    this.running.set(sessionId, id)
    delivery.status = 'running'
    delivery.updatedAt = this.host.now()
    try {
      await this.host.deliver(delivery)
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : String(cause)
      // An admission/start failure has no agent_settled event. Publish the explicit
      // failed attempt, including its one completion notification, without old output.
      if (this.running.get(sessionId) === id) this.settled(sessionId, null, error)
      throw cause
    } finally {
      this.draining.delete(sessionId)
      if (!this.running.has(sessionId)) this.scheduleDrain(sessionId)
    }
  }
}
