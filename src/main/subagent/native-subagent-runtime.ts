import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { SessionManager, type AgentSession, type ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'

import type { KernelSubagentDefinition, KernelSubagentStatus } from '../../shared/kernel-contract.ts'
import { isRecord } from '../utils/guards.ts'
import { errorMessage } from '../utils/errors.ts'
import type { NativeAgentLease } from '../runtime/native-agent-lease.ts'
import { SubagentDefinitionStore } from './subagent-definition-store.ts'

const TASK_ENTRY_TYPE = 'pi-gui-native-task'
const MAX_REPORT_CHARS = 12_000

export interface NativeSubagentSession {
  readonly nativeSession: AgentSession
  runTask(message: string): Promise<void>
  dispose(): Promise<void>
  switchTaskModel(model: string): Promise<void>
  abortTask(): Promise<void>
}

export type NativeChildOptions = {
  sessionManager: SessionManager
  definition: KernelSubagentDefinition
  model: string
  depth: number
  maxDepth: number
  thinking: AgentSession['thinkingLevel']
}

type TaskRecord = {
  id: string
  ownerSessionFile: string
  toolCallId: string
  sessionFile: string | null
  agent: string
  task: string
  model: string | null
  status: KernelSubagentStatus
  createdAt: number
  durationMs: number
  error: string | null
  finalOutput: string | null
  toolCount: number
  turnCount: number
  currentTool: string | null
  currentPath: string | null
  inheritedStats?: { toolCalls: number; assistantMessages: number; tokens: { input: number; output: number; cacheRead: number; cacheWrite: number }; cost: number }
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; turns: number } | null
}

type LiveTask = {
  record: TaskRecord
  driver: NativeSubagentSession | null
  completion: Promise<void> | null
  abortRequested: boolean
}

export type NativeSubagentRuntimeOptions = {
  cwd: string
  depth: number
  maxDepth: number
  lease: NativeAgentLease
  parent: () => AgentSession
  createChild: (options: NativeChildOptions) => Promise<NativeSubagentSession>
  onError: (error: unknown) => void
}

/** Execution owner. Every child has its own SDK Session and native JSONL history. */
export class NativeSubagentRuntime {
  private readonly tasks = new Map<string, LiveTask>()
  private readonly notificationRuns = new Set<Promise<void>>()
  private readonly definitions = new SubagentDefinitionStore()
  private disposed = false
  private suppressNotifications = 0

  private readonly options: NativeSubagentRuntimeOptions

  constructor(options: NativeSubagentRuntimeOptions) { this.options = options }

  get hasActivity(): boolean { return this.notificationRuns.size > 0 || [...this.tasks.values()].some(({ completion }) => completion !== null) }

  async resetForSession(): Promise<void> {
    if (this.hasActivity) throw new Error('Cannot replace a Session with running child tasks.')
    await Promise.all([...this.tasks.values()].map(async ({ driver }) => { await driver?.dispose() }))
    this.tasks.clear()
  }

  restore(): void {
    const parent = this.options.parent()
    for (const entry of parent.sessionManager.getEntries()) {
      if (entry.type !== 'custom' || entry.customType !== TASK_ENTRY_TYPE || !isRecord(entry.data)) continue
      const data = entry.data
      if (data.ownerSessionFile !== parent.sessionFile || typeof data.id !== 'string' ||
        typeof data.agent !== 'string' || typeof data.task !== 'string' ||
        typeof data.toolCallId !== 'string' || typeof data.createdAt !== 'number') continue
      const record = data as unknown as TaskRecord
      const existing = this.tasks.get(record.id)
      if (existing?.completion !== null && existing !== undefined) continue
      this.tasks.set(record.id, { record: { ...record }, driver: existing?.driver ?? null, completion: null, abortRequested: false })
    }
    for (const task of this.tasks.values()) {
      if (task.completion !== null || (task.record.status !== 'running' && task.record.status !== 'pending')) continue
      task.record.status = 'paused'
      task.record.error = 'Runtime stopped while this task was in progress. Continue explicitly to resume.'
      this.persist(task)
    }
  }

  async register(pi: ExtensionAPI): Promise<void> {
    const names = (await this.definitions.list(this.options.cwd)).filter(({ enabled }) => enabled)
      .map(({ name, description }) => `${name}: ${description}`).join('\n')
    pi.registerTool({
      name: 'Task', label: '子任务',
      description: `Start an independent background child agent, or continue an existing taskId with a new task. A continued task keeps its agent; an explicit model changes the model for that task. Returns immediately; the report is delivered automatically. Children never grant new user authorization. Available agents:\n${names}`,
      promptSnippet: 'Delegate a focused task to an independent background agent.',
      parameters: Type.Object({
        task: Type.String({ minLength: 1 }),
        agent: Type.Optional(Type.String()),
        taskId: Type.Optional(Type.String()),
        model: Type.Optional(Type.String())
      }),
      execute: async (toolCallId, args) => {
        if (args.taskId !== undefined && args.agent !== undefined && args.agent !== this.requireTask(args.taskId).record.agent) {
          throw new Error('Continuing a child task retains its agent definition.')
        }
        const task = args.taskId === undefined
          ? await this.start(toolCallId, args.agent ?? 'worker', args.task, args.model)
          : await this.continueTask(args.taskId, args.task, args.model)
        return toolResult(`Task ${task.record.id} started in the background (${task.record.agent}).`, this.details(task))
      }
    })
    pi.registerTool({
      name: 'TaskWait', label: '等待子任务',
      description: 'Wait up to timeoutMs for selected background task reports. Omit taskIds to wait for all current children. A timeout leaves tasks running.',
      parameters: Type.Object({
        taskIds: Type.Optional(Type.Array(Type.String())),
        timeoutMs: Type.Optional(Type.Number({ minimum: 0, maximum: 60_000 }))
      }),
      execute: async (_id, args, signal) => {
        const selected = args.taskIds === undefined ? [...this.tasks.values()] : args.taskIds.map((id) => this.requireTask(id))
        const pending = Promise.all(selected.map(({ completion }) => completion))
        const timeoutMs = args.timeoutMs ?? 30_000
        await new Promise<void>((resolve) => {
          const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve() }
          const timer = setTimeout(done, timeoutMs)
          signal?.addEventListener('abort', done, { once: true })
          void pending.then(done)
          if (signal?.aborted) done()
        })
        return toolResult(JSON.stringify(selected.map(({ record }) => record)), this.groupDetails(selected))
      }
    })
    pi.registerTool({
      name: 'TaskList', label: '子任务列表',
      description: 'Read status, model, usage and reports of this session’s child tasks without waiting.',
      parameters: Type.Object({}),
      execute: async () => {
        const tasks = [...this.tasks.values()]
        return toolResult(JSON.stringify(tasks.map(({ record }) => record)), this.groupDetails(tasks))
      }
    })
    pi.registerTool({
      name: 'TaskStop', label: '停止子任务',
      description: 'Stop selected background child tasks. Omit taskIds to stop all children. Stopped tasks can be continued with Task(taskId, task).',
      parameters: Type.Object({ taskIds: Type.Optional(Type.Array(Type.String())) }),
      execute: async (_id, args) => {
        const selected = args.taskIds === undefined ? [...this.tasks.values()] : args.taskIds.map((id) => this.requireTask(id))
        await Promise.all(selected.map((task) => this.stopTask(task)))
        return toolResult(JSON.stringify(selected.map(({ record }) => record)), this.groupDetails(selected))
      }
    })
  }

  private requireTask(id: string): LiveTask {
    const task = this.tasks.get(id)
    if (task === undefined) throw new Error(`Native child task not found: ${id}`)
    return task
  }

  private async definition(agent: string): Promise<KernelSubagentDefinition> {
    const candidates = await this.definitions.list(this.options.cwd)
    const definition = [...candidates].reverse().find(({ name, id }) => name === agent || id === agent)
    if (definition === undefined || !definition.enabled) throw new Error(`Child agent is unavailable or disabled: ${agent}`)
    if (definition.defaultAsync === false) throw new Error(`Native Task runs in the background. Remove async: false from agent ${definition.name}.`)
    return definition
  }

  private async start(toolCallId: string, agent: string, instruction: string, model?: string): Promise<LiveTask> {
    if (this.disposed) throw new Error('Native task owner is disposed.')
    if (this.options.depth >= this.options.maxDepth) throw new Error(`Child agent nesting exceeds maxDepth=${this.options.maxDepth}.`)
    const definition = await this.definition(agent)
    const parent = this.options.parent()
    const task: LiveTask = {
      record: {
        id: randomUUID(), ownerSessionFile: parent.sessionFile!, toolCallId, sessionFile: null,
        agent: definition.name, task: instruction, model: null, status: 'pending', createdAt: Date.now(),
        durationMs: 0, error: null, finalOutput: null, toolCount: 0, turnCount: 0,
        currentTool: null, currentPath: null, usage: null
      },
      driver: null, completion: null, abortRequested: false
    }
    this.tasks.set(task.record.id, task)
    this.launch(task, definition, instruction, model)
    return task
  }

  private async continueTask(id: string, instruction: string, requestedModel?: string): Promise<LiveTask> {
    const task = this.requireTask(id)
    if (task.completion !== null) throw new Error(`Child task is already running: ${id}`)
    if (this.disposed) throw new Error('Native task owner is disposed.')
    const definition = await this.definition(task.record.agent)
    if (task.completion !== null) throw new Error(`Child task is already running: ${id}`)
    this.launch(task, definition, instruction, requestedModel)
    return task
  }

  private launch(task: LiveTask, definition: KernelSubagentDefinition, instruction: string, requestedModel?: string): void {
    const release = this.options.lease.begin()
    task.abortRequested = false
    task.record.status = 'running'
    task.record.error = null
    task.record.finalOutput = null
    try { this.persist(task) } catch (error) { release(); throw error }
    const run = this.run(task, definition, instruction, requestedModel).finally(async () => {
      const driver = task.driver
      if (driver === null) return
      await driver.dispose()
      if (task.driver === driver) task.driver = null
    })
    const completion = run.catch((error: unknown) => {
      task.record.status = task.abortRequested ? 'paused' : 'failed'
      task.record.error = errorMessage(error)
    }).then(async () => {
      task.record.currentTool = null
      task.record.currentPath = null
      this.persist(task)
      task.completion = null
      if (!this.disposed && this.suppressNotifications === 0) {
        const state = task.record.status === 'completed' ? 'completed' : task.record.status === 'paused' ? 'paused' : 'failed'
        const notification = this.options.parent().sendCustomMessage({
          customType: 'subagent-notify', display: true,
          content: `Background task ${state}: **${task.record.agent}**\n\nTask ${task.record.id}\n${task.record.error ?? task.record.finalOutput ?? '(no output)'}`,
          details: this.details(task)
        }, { triggerTurn: true, deliverAs: 'followUp' }).catch(this.options.onError)
        this.notificationRuns.add(notification)
        void notification.finally(() => this.notificationRuns.delete(notification))
      }
    }).catch(this.options.onError).finally(() => { if (task.completion === completion) task.completion = null; release() })
    task.completion = completion
  }

  private async run(task: LiveTask, definition: KernelSubagentDefinition, instruction: string, requestedModel?: string): Promise<void> {
    const startedAt = Date.now()
    let timeout: ReturnType<typeof setTimeout> | undefined
    let unsubscribe: (() => void) | undefined
    try {
      if (task.driver !== null && requestedModel !== undefined) await task.driver.switchTaskModel(requestedModel)
      if (task.driver === null) {
        const parent = this.options.parent()
        const sessionDir = join(dirname(parent.sessionFile!), 'subagents', parent.sessionId)
        const manager = task.record.sessionFile !== null ? SessionManager.open(task.record.sessionFile)
          : definition.defaultContext === 'fork' ? SessionManager.forkFrom(parent.sessionFile!, this.options.cwd, sessionDir)
            : SessionManager.create(this.options.cwd, sessionDir, { parentSession: parent.sessionFile })
        const parentModel = parent.model
        const inheritedModel = parentModel === undefined ? undefined : `${parentModel.provider}/${parentModel.id}`
        const model = requestedModel ?? task.record.model ?? definition.model ?? inheritedModel
        if (model === undefined) throw new Error('No model is configured for this child agent.')
        task.driver = await this.options.createChild({
          sessionManager: manager, definition, model, depth: this.options.depth + 1,
          maxDepth: Math.min(this.options.maxDepth, definition.maxSubagentDepth ?? this.options.maxDepth),
          thinking: definition.thinking ?? parent.thinkingLevel
        })
        if (task.record.inheritedStats === undefined && definition.defaultContext === 'fork') task.record.inheritedStats = task.driver.nativeSession.getSessionStats()
        task.record.sessionFile = task.driver.nativeSession.sessionFile!
        this.persist(task)
      }
      const session = task.driver.nativeSession
      if (task.abortRequested) { task.record.status = 'paused'; return }
      this.refresh(task)
      const beforeTurns = task.record.turnCount
      unsubscribe = session.subscribe((event) => {
        if (event.type === 'tool_execution_start') {
          task.record.currentTool = event.toolName
          task.record.currentPath = isRecord(event.args) && typeof event.args.path === 'string' ? event.args.path : null
        } else if (event.type === 'tool_execution_end') {
          task.record.currentTool = null
          task.record.currentPath = null
        }
        this.refresh(task)
        if (definition.maxTurns !== null && task.record.turnCount - beforeTurns >= definition.maxTurns && event.type === 'message_end' && event.message.role === 'assistant' && event.message.stopReason === 'toolUse') {
          task.record.error = `Configured turn budget reached (${definition.maxTurns}).`
          task.abortRequested = true
          void task.driver!.abortTask().catch(this.options.onError)
        }
        if (event.type === 'tool_execution_start' || event.type === 'tool_execution_end' || event.type === 'message_end') this.publish(task)
      })
      if (definition.timeoutMs !== null) {
        timeout = setTimeout(() => {
          task.record.error = `Configured task timeout reached (${definition.timeoutMs}ms).`
          task.abortRequested = true
          void task.driver!.abortTask().catch(this.options.onError)
        }, definition.timeoutMs)
      }
      const fallbacks = requestedModel === undefined ? definition.fallbackModels ?? [] : []
      const attempts = [task.record.model ?? this.options.parent().model?.id ?? '', ...fallbacks]
      for (let attempt = 0; attempt < attempts.length; attempt += 1) {
        if (attempt > 0) {
          const fallback = attempts[attempt]!
          await task.driver.switchTaskModel(fallback)
          this.options.onError(new Error(`Child ${task.record.id} switches to explicitly configured fallback ${fallback}: ${task.record.error}`))
        }
        try {
          await task.driver.runTask(instruction)
          const latest = [...session.messages].reverse().find((message) => message.role === 'assistant')
          if (latest?.role === 'assistant' && latest.stopReason === 'error') throw new Error(latest.errorMessage ?? 'Child model request failed.')
          if (!task.abortRequested) task.record.error = null
          break
        } catch (error) {
          if (task.abortRequested || attempt === attempts.length - 1) throw error
          task.record.error = errorMessage(error)
        }
      }
      this.refresh(task)
      const lastAssistant = [...session.messages].reverse().find((message) => message.role === 'assistant')
      if (lastAssistant?.role === 'assistant') {
        if (lastAssistant.stopReason === 'error') throw new Error(lastAssistant.errorMessage ?? 'Child model request failed.')
        if (lastAssistant.stopReason === 'aborted') task.abortRequested = true
        task.record.finalOutput = lastAssistant.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n').slice(0, MAX_REPORT_CHARS)
      }
      task.record.status = task.abortRequested ? 'paused' : 'completed'
    } finally {
      if (timeout !== undefined) clearTimeout(timeout)
      unsubscribe?.()
      task.record.durationMs += Date.now() - startedAt
      if (task.driver !== null) this.refresh(task)
    }
  }

  private refresh(task: LiveTask): void {
    if (task.driver === null) return
    const session = task.driver.nativeSession
    const stats = session.getSessionStats()
    const inherited = task.record.inheritedStats
    task.record.toolCount = stats.toolCalls - (inherited?.toolCalls ?? 0)
    task.record.turnCount = stats.assistantMessages - (inherited?.assistantMessages ?? 0)
    task.record.model = session.model === undefined ? null : `${session.model.provider}/${session.model.id}`
    task.record.usage = {
      input: stats.tokens.input - (inherited?.tokens.input ?? 0), output: stats.tokens.output - (inherited?.tokens.output ?? 0),
      cacheRead: stats.tokens.cacheRead - (inherited?.tokens.cacheRead ?? 0), cacheWrite: stats.tokens.cacheWrite - (inherited?.tokens.cacheWrite ?? 0),
      cost: stats.cost - (inherited?.cost ?? 0), turns: task.record.turnCount
    }
  }

  private persist(task: LiveTask): void {
    this.options.parent().sessionManager.appendCustomEntry(TASK_ENTRY_TYPE, { ...task.record })
    this.publish(task)
  }

  private publish(task: LiveTask): void {
    if (this.disposed) return
    // Observability only: no child transcript or progress enters the parent model context.
    const message = { role: 'custom' as const, customType: 'pi-gui-native-subagent-progress', display: false,
      content: '', details: this.details(task), timestamp: Date.now() }
    // SDK events are exposed through the driver's callback, without persisting duplicate progress rows.
    this.onProgress?.(message)
  }

  onProgress?: (message: { role: 'custom'; customType: string; display: boolean; content: string; details: unknown; timestamp: number }) => void

  private details(task: LiveTask) {
    const record = task.record
    return {
      mode: 'single' as const, toolCallId: record.toolCallId, runId: record.id, asyncId: record.id,
      progress: [{ ...record, index: 0, nativeTaskId: record.id, tokens: (record.usage?.input ?? 0) + (record.usage?.output ?? 0) }],
      results: [{ ...record, index: 0, nativeTaskId: record.id, exitCode: record.status === 'completed' ? 0 : record.status === 'failed' ? 1 : undefined }]
    }
  }

  private groupDetails(tasks: LiveTask[]) {
    return { mode: 'parallel', progress: tasks.map((task, index) => ({ ...this.details(task).progress[0], index })),
      results: tasks.map((task, index) => ({ ...this.details(task).results[0], index })) }
  }

  async transcript(id: string): Promise<{ taskId: string; messages: unknown[]; status: KernelSubagentStatus }> {
    const task = this.requireTask(id)
    const manager = task.driver?.nativeSession.sessionManager ?? (task.record.sessionFile === null ? null : SessionManager.open(task.record.sessionFile))
    const messages = manager === null ? [] : manager.getBranch().flatMap<unknown>((entry) => {
      if (entry.type === 'message') return [{ ...entry.message }]
      if (entry.type === 'custom_message') return [{ role: 'custom', ...entry, timestamp: Date.parse(entry.timestamp) }]
      return []
    })
    return { taskId: id, messages, status: task.record.status }
  }

  async control(id: string, action: 'stop' | 'continue', message?: string): Promise<void> {
    const task = this.requireTask(id)
    if (action === 'stop') await this.stopTask(task)
    else {
      if (message === undefined || message.trim().length === 0) throw new Error('Continuing a child task requires a message.')
      await this.continueTask(id, message)
    }
  }

  private async stopTask(task: LiveTask): Promise<void> {
    const completion = task.completion
    if (completion === null) return
    task.abortRequested = true
    await task.driver?.abortTask()
    await completion
  }

  /** Wait only for this owner's descendants and reports, never the shared root lease. */
  async waitForSettled(): Promise<void> {
    while (this.hasActivity) {
      await Promise.all([
        ...[...this.tasks.values()].map(({ completion }) => completion),
        ...this.notificationRuns
      ])
    }
  }

  async abortAll(): Promise<void> {
    this.suppressNotifications += 1
    try { await Promise.all([...this.tasks.values()].map((task) => this.stopTask(task))) }
    finally { this.suppressNotifications -= 1 }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    await this.abortAll()
    await this.waitForSettled()
    await Promise.all([...this.tasks.values()].map(async ({ driver }) => { await driver?.dispose() }))
  }
}

function toolResult(text: string, details: unknown) {
  return { content: [{ type: 'text' as const, text }], details }
}
