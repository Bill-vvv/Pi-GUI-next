import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'

import type {
  KernelPromptImage,
  ThinkingLevel,
  ThinkingLevelMap
} from '../../shared/kernel-contract.ts'
import {
  OPENAI_FAST_MODE_ENTRY_TYPE,
  parseOpenAiFastModeEntryData
} from '../../../extensions/pi-gui-openai-fast-mode/src/protocol.mjs'
import { isRecord } from '../utils/guards.ts'
import { LfJsonlParser, type JsonlParseBatch } from './jsonl-framing.ts'

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000
const DEFAULT_ABORT_TIMEOUT_MS = 120_000
const DEFAULT_COMPACT_TIMEOUT_MS = 120_000
const MAX_ENTRY_ID_LENGTH = 512
const MAX_EXTENSION_EVENT_CHANNELS = 32
const MAX_EXTENSION_EVENT_CHANNEL_LENGTH = 256
export const PI_RPC_EXTENSION_EVENT_MAX_RECORD_BYTES = 256 * 1024
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u
/** Main-memory projection bounds for one get_tree response. */
export const PI_RPC_TREE_MAX_NODES = 10_000
export const PI_RPC_TREE_MAX_DEPTH = 2_048
export const PI_RPC_TREE_MAX_LABEL_CHARS = 4_096
export const PI_RPC_TREE_MAX_LABEL_TIMESTAMP_CHARS = 256
const ADVISOR_CAPABILITY_CUSTOM_TYPE = 'pi-gui.multi-advisor/capabilities'
const MAGIC_CONTEXT_CUSTOM_TYPE = 'ctx-status'
const MAX_MAGIC_CONTEXT_TITLE_CHARS = 256
const MAX_MAGIC_CONTEXT_TEXT_CHARS = 30_000
const GUI_THINKING_LEVELS: ThinkingLevel[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max'
]
const EXTENSION_CAPABILITIES = [
  'event',
  'tool',
  'command',
  'flag',
  'shortcut',
  'message_renderer',
  'entry_renderer'
] as const
const EXTENSION_CAPABILITY_SET = new Set<string>(EXTENSION_CAPABILITIES)
const EXTENSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/u
const MAX_EXTENSION_ID_CHARS = 128
const MAX_LOADED_EXTENSIONS = 256
const MAX_EXTENSION_LOAD_ERRORS = 256

export type PiRpcModel = {
  id: string
  name?: string
  provider: string
  reasoning?: boolean
  thinkingLevelMap?: ThinkingLevelMap
  contextWindow?: number
  [key: string]: unknown
}

export type PiRpcModelCostTier = {
  inputTokensAbove: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export type PiRpcModelCost = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  tiers?: PiRpcModelCostTier[]
}

export type PiRpcAvailableModel = {
  id: string
  provider: string
  name?: string
  reasoning?: boolean
  thinkingLevelMap?: ThinkingLevelMap
  contextWindow?: number
  cost?: PiRpcModelCost
}

export type PiRpcSessionStats = {
  sessionFile?: string
  sessionId: string
  userMessages: number
  assistantMessages: number
  toolCalls: number
  toolResults: number
  totalMessages: number
  tokens: {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
    total: number
  }
  cost: number
  contextUsage?: {
    tokens: number | null
    contextWindow: number
    percent: number | null
  }
}

export type PiRpcSessionState = {
  sessionId?: string
  sessionFile?: string
  sessionName?: string
  model?: PiRpcModel | null
  thinkingLevel?: string
  isStreaming?: boolean
  isCompacting?: boolean
  messageCount?: number
  pendingMessageCount?: number
  sessionStats?: PiRpcSessionStats
  [key: string]: unknown
}

export type PiRpcSessionEntry = {
  id: string
  parentId: string | null
  type: string
  timestamp: string
  customType?:
    | typeof ADVISOR_CAPABILITY_CUSTOM_TYPE
    | typeof MAGIC_CONTEXT_CUSTOM_TYPE
    | typeof OPENAI_FAST_MODE_ENTRY_TYPE
  data?: unknown
  message?: {
    role: string
    content?: {
      text: string
      hasImage: boolean
    }
  }
}

export type PiRpcEntriesResult = {
  entries: PiRpcSessionEntry[]
  leafId: string | null
}

export type PiRpcTreeNode = {
  entry: PiRpcSessionEntry
  children: PiRpcTreeNode[]
  label?: string
  labelTimestamp?: string
}

export type PiRpcTreeResult = {
  tree: PiRpcTreeNode[]
  leafId: string | null
}

export type PiRpcNavigateTreeResult = {
  targetEntryId: string
  cancelled: boolean
  leafId: string | null
  editorText?: string
}

export type PiRpcExtensionEvent =
  | { type: 'extension_event'; channel: string; data: unknown }
  | {
      type: 'extension_event_diagnostic'
      reason: 'invalid_payload' | 'record_too_large' | 'queue_overflow'
    }

export type PiRpcForkResult = {
  text: string
  cancelled: boolean
}

export type PiRpcSlashCommand = {
  name: string
  description?: string
  source: 'extension' | 'prompt' | 'skill'
  sourceInfo: {
    source: string
    scope: 'user' | 'project' | 'temporary'
    origin: 'package' | 'top-level'
  }
}

export type PiRpcExtensionCapability = typeof EXTENSION_CAPABILITIES[number]

export type PiRpcLoadedExtension = {
  id: string
  capabilities: PiRpcExtensionCapability[]
}

export type PiRpcExtensionInventory = {
  protocolVersion: 1
  complete: boolean
  loading: 'eager_complete' | 'lazy_partial'
  extensions: PiRpcLoadedExtension[]
  loadErrorCount: number
}

export type PiRpcEvent = Record<string, unknown> & { type: string }

export type PiRpcExtensionUiResponse =
  | { id: string; value: string }
  | { id: string; cancelled: true }

export type PiRpcDiagnostic =
  | { type: 'stdout-parse-error'; error: Error }
  | {
      type: 'extension-event-protocol-error'
      recordType: 'extension_event' | 'extension_event_diagnostic'
    }
  | { type: 'stderr'; chunk: string }
  | { type: 'process-error'; error: Error }
  | { type: 'process-exit'; code: number | null; signal: NodeJS.Signals | null }

export type PiRpcClientOptions = {
  requestTimeoutMs?: number
  onDiagnostic?: (diagnostic: PiRpcDiagnostic) => void
  onEvent?: (event: PiRpcEvent) => void
  onExtensionEvent?: (event: PiRpcExtensionEvent) => void
  createRequestId?: () => string
}

type PiRpcCommandName =
  | 'get_state'
  | 'get_session_stats'
  | 'get_messages'
  | 'get_entries'
  | 'get_tree'
  | 'navigate_tree'
  | 'fork'
  | 'prompt'
  | 'steer'
  | 'follow_up'
  | 'abort'
  | 'set_model'
  | 'set_thinking_level'
  | 'get_commands'
  | 'get_available_models'
  | 'compact'
  | 'set_session_name'
  | 'subscribe_extension_events'
  | 'get_extensions'

type PendingRequest = {
  command: PiRpcCommandName
  requireData: boolean
  requireCommand: boolean
  expectedSubscriptionChannels?: string[]
  resolve: (data: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class PiRpcClient {
  private readonly process: ChildProcessWithoutNullStreams
  private readonly requestTimeoutMs: number
  private readonly onDiagnostic: (diagnostic: PiRpcDiagnostic) => void
  private readonly onEvent: (event: PiRpcEvent) => void
  private readonly onExtensionEvent: (event: PiRpcExtensionEvent) => void
  private readonly createRequestId: () => string
  private readonly stdoutParser = new LfJsonlParser()
  private readonly stderrDecoder = new StringDecoder('utf8')
  private readonly pending = new Map<string, PendingRequest>()
  private stdoutEnded = false
  private processFinished = false
  private activeExtensionEventChannels = new Set<string>()
  private subscriptionReplacementPending = false
  private extensionEventProtocolDiagnosticProduced = false

  constructor(process: ChildProcessWithoutNullStreams, options: PiRpcClientOptions = {}) {
    this.process = process
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    this.onDiagnostic = options.onDiagnostic ?? (() => undefined)
    this.onEvent = options.onEvent ?? (() => undefined)
    this.onExtensionEvent = options.onExtensionEvent ?? (() => undefined)
    this.createRequestId = options.createRequestId ?? randomUUID

    process.stdout.on('data', (chunk: Buffer | string) => {
      this.handleStdout(chunk)
    })
    process.stdout.on('end', () => {
      this.endStdout()
    })
    process.stderr.on('data', (chunk: Buffer) => {
      const text = this.stderrDecoder.write(chunk)
      if (text.length > 0) {
        this.onDiagnostic({ type: 'stderr', chunk: text })
      }
    })
    process.stderr.on('end', () => {
      const tail = this.stderrDecoder.end()
      if (tail.length > 0) {
        this.onDiagnostic({ type: 'stderr', chunk: tail })
      }
    })
    process.on('error', (error) => {
      this.onDiagnostic({ type: 'process-error', error })
      this.finishProcess(new Error(`Pi RPC process error: ${error.message}`))
    })
    process.on('exit', (code, signal) => {
      this.reportExitAndFinish(code, signal)
    })
    process.on('close', (code, signal) => {
      this.endStdout()
      this.reportExitAndFinish(code, signal)
    })
  }

  async getState(timeoutMs = this.requestTimeoutMs): Promise<PiRpcSessionState> {
    const data = await this.request({ type: 'get_state' }, true, timeoutMs)
    if (!isRecord(data)) {
      throw new Error('Invalid Pi RPC get_state response')
    }
    if (data.model !== undefined && data.model !== null) {
      if (!isPiRpcModel(data.model)) {
        throw new Error('Invalid Pi RPC get_state response')
      }
      return { ...data, model: normalizePiRpcModel(data.model) }
    }
    return data
  }

  async getSessionStats(timeoutMs = this.requestTimeoutMs): Promise<PiRpcSessionStats> {
    const data = await this.request({ type: 'get_session_stats' }, true, timeoutMs)
    if (!isPiRpcSessionStats(data)) {
      throw new Error('Invalid Pi RPC get_session_stats response')
    }
    return data
  }

  async getMessages(timeoutMs = this.requestTimeoutMs): Promise<unknown[]> {
    const data = await this.request({ type: 'get_messages' }, true, timeoutMs)
    if (!isRecord(data) || !Array.isArray(data.messages)) {
      throw new Error('Invalid Pi RPC get_messages response')
    }
    return data.messages
  }

  async getEntries(timeoutMs = this.requestTimeoutMs): Promise<PiRpcEntriesResult> {
    const data = await this.request({ type: 'get_entries' }, true, timeoutMs)
    if (
      !isRecord(data) ||
      !Array.isArray(data.entries) ||
      !(data.leafId === null || isNonEmptyString(data.leafId))
    ) {
      throw new Error('Invalid Pi RPC get_entries response')
    }

    return {
      entries: data.entries.map(normalizePiRpcSessionEntry),
      leafId: data.leafId
    }
  }

  async getTree(timeoutMs = this.requestTimeoutMs): Promise<PiRpcTreeResult> {
    const data = await this.request({ type: 'get_tree' }, true, timeoutMs, true)
    return normalizePiRpcTreeResult(data)
  }

  async navigateTree(
    targetEntryId: string,
    timeoutMs = this.requestTimeoutMs
  ): Promise<PiRpcNavigateTreeResult> {
    const validatedTargetEntryId = validateIdentifier(
      targetEntryId,
      'Pi RPC tree target entry ID',
      MAX_ENTRY_ID_LENGTH
    )
    const data = await this.request(
      { type: 'navigate_tree', targetEntryId: validatedTargetEntryId },
      true,
      timeoutMs,
      true
    )
    return normalizePiRpcNavigateTreeResult(data, validatedTargetEntryId)
  }

  async fork(entryId: string, timeoutMs = this.requestTimeoutMs): Promise<PiRpcForkResult> {
    if (entryId.trim().length === 0) {
      throw new Error('Pi RPC fork entry ID must not be empty')
    }
    const data = await this.request({ type: 'fork', entryId }, true, timeoutMs)
    if (!isRecord(data) || typeof data.text !== 'string' || typeof data.cancelled !== 'boolean') {
      throw new Error('Invalid Pi RPC fork response')
    }
    return { text: data.text, cancelled: data.cancelled }
  }

  async prompt(
    message: string,
    images?: readonly KernelPromptImage[],
    timeoutMs = this.requestTimeoutMs
  ): Promise<void> {
    await this.request({
      type: 'prompt',
      message,
      ...(images !== undefined && images.length > 0 ? { images: images.map(copyPromptImage) } : {})
    }, false, timeoutMs)
  }

  async steer(
    message: string,
    images?: readonly KernelPromptImage[],
    timeoutMs = this.requestTimeoutMs
  ): Promise<void> {
    await this.request({
      type: 'steer',
      message,
      ...(images !== undefined && images.length > 0 ? { images: images.map(copyPromptImage) } : {})
    }, false, timeoutMs)
  }

  async followUp(
    message: string,
    images?: readonly KernelPromptImage[],
    timeoutMs = this.requestTimeoutMs
  ): Promise<void> {
    await this.request({
      type: 'follow_up',
      message,
      ...(images !== undefined && images.length > 0 ? { images: images.map(copyPromptImage) } : {})
    }, false, timeoutMs)
  }

  async abort(timeoutMs = Math.max(this.requestTimeoutMs, DEFAULT_ABORT_TIMEOUT_MS)): Promise<void> {
    // Pi abort waits for agent_settled after tools stop; long bash kills can exceed the default RPC timeout.
    await this.request({ type: 'abort' }, false, timeoutMs)
  }

  async setModel(
    provider: string,
    modelId: string,
    timeoutMs = this.requestTimeoutMs
  ): Promise<PiRpcModel> {
    const data = await this.request({ type: 'set_model', provider, modelId }, true, timeoutMs)
    if (!isPiRpcModel(data)) {
      throw new Error('Invalid Pi RPC set_model response')
    }
    return normalizePiRpcModel(data)
  }

  async setThinkingLevel(level: string, timeoutMs = this.requestTimeoutMs): Promise<void> {
    await this.request({ type: 'set_thinking_level', level }, false, timeoutMs)
  }

  async getCommands(timeoutMs = this.requestTimeoutMs): Promise<PiRpcSlashCommand[]> {
    const data = await this.request({ type: 'get_commands' }, true, timeoutMs)
    if (!isRecord(data) || !Array.isArray(data.commands)) {
      throw new Error('Invalid Pi RPC get_commands response')
    }

    return data.commands.map((command) => {
      if (!isPiRpcSlashCommand(command)) {
        throw new Error('Invalid Pi RPC get_commands response')
      }
      const sourceInfo = {
        source: command.sourceInfo.source,
        scope: command.sourceInfo.scope,
        origin: command.sourceInfo.origin
      }
      return command.description === undefined
        ? { name: command.name, source: command.source, sourceInfo }
        : { name: command.name, description: command.description, source: command.source, sourceInfo }
    })
  }

  async getExtensions(timeoutMs = this.requestTimeoutMs): Promise<PiRpcExtensionInventory> {
    const data = await this.request({ type: 'get_extensions' }, true, timeoutMs)
    return normalizePiRpcExtensionInventory(data)
  }

  async getAvailableModels(timeoutMs = this.requestTimeoutMs): Promise<PiRpcAvailableModel[]> {
    const data = await this.request({ type: 'get_available_models' }, true, timeoutMs)
    if (!isRecord(data) || !Array.isArray(data.models)) {
      throw new Error('Invalid Pi RPC get_available_models response')
    }

    return data.models.map((model) => {
      if (!isPiRpcAvailableModel(model)) {
        throw new Error('Invalid Pi RPC get_available_models response')
      }
      return {
        id: model.id,
        provider: model.provider,
        ...(typeof model.name === 'string' ? { name: model.name } : {}),
        ...(typeof model.reasoning === 'boolean' ? { reasoning: model.reasoning } : {}),
        ...(model.thinkingLevelMap === undefined
          ? {}
          : { thinkingLevelMap: projectThinkingLevelMap(model.thinkingLevelMap) }),
        ...(typeof model.contextWindow === 'number' ? { contextWindow: model.contextWindow } : {}),
        ...(model.cost === undefined ? {} : { cost: projectPiRpcModelCost(model.cost) })
      }
    })
  }

  async compact(
    customInstructions?: string,
    timeoutMs = Math.max(this.requestTimeoutMs, DEFAULT_COMPACT_TIMEOUT_MS)
  ): Promise<void> {
    await this.request(
      customInstructions === undefined
        ? { type: 'compact' }
        : { type: 'compact', customInstructions },
      false,
      timeoutMs
    )
  }

  async setSessionName(name: string, timeoutMs = this.requestTimeoutMs): Promise<void> {
    await this.request({ type: 'set_session_name', name }, false, timeoutMs)
  }

  async subscribeExtensionEvents(
    channels: readonly string[],
    timeoutMs = this.requestTimeoutMs
  ): Promise<string[]> {
    const validatedChannels = validateExtensionEventChannels(channels)
    if (this.subscriptionReplacementPending) {
      throw new Error('Pi RPC extension-event subscription replacement is already in progress')
    }

    // Complete-set replacement can detach the old server binding before its response.
    // Fail closed for the entire attempt and install only an exactly correlated success.
    this.subscriptionReplacementPending = true
    this.activeExtensionEventChannels.clear()
    this.extensionEventProtocolDiagnosticProduced = false
    try {
      return await this.request(
        { type: 'subscribe_extension_events', channels: validatedChannels },
        true,
        timeoutMs,
        true,
        validatedChannels
      ) as string[]
    } finally {
      this.subscriptionReplacementPending = false
    }
  }

  async respondExtensionUi(response: PiRpcExtensionUiResponse): Promise<void> {
    if (
      response.id.length === 0 ||
      response.id.length > 256 ||
      response.id.includes('\0')
    ) {
      throw new Error('Invalid Pi RPC extension UI request ID')
    }
    if ('value' in response && (response.value.length > 4_000 || response.value.includes('\0'))) {
      throw new Error('Invalid Pi RPC extension UI response value')
    }
    await this.writeRecord({ type: 'extension_ui_response', ...response })
  }

  private writeRecord(record: Record<string, unknown>): Promise<void> {
    if (this.processFinished || !this.process.stdin.writable) {
      return Promise.reject(new Error('Pi RPC process is not writable'))
    }
    return new Promise((resolve, reject) => {
      try {
        this.process.stdin.write(`${JSON.stringify(record)}\n`, (error) => {
          if (error) reject(error)
          else resolve()
        })
      } catch (error) {
        reject(toError(error))
      }
    })
  }

  private request(
    command: { type: PiRpcCommandName; [key: string]: unknown },
    requireData: boolean,
    timeoutMs: number,
    requireCommand = false,
    expectedSubscriptionChannels?: string[]
  ): Promise<unknown> {
    if (this.processFinished || !this.process.stdin.writable) {
      return Promise.reject(new Error('Pi RPC process is not writable'))
    }

    const id = this.nextRequestId()
    const request = { id, ...command }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(id)
        if (pending === undefined || !this.pending.delete(id)) {
          return
        }
        if (pending.expectedSubscriptionChannels !== undefined) {
          this.subscriptionReplacementPending = false
        }
        reject(new Error(`Timed out waiting for Pi RPC response: ${command.type}`))
      }, timeoutMs)
      timer.unref?.()

      this.pending.set(id, {
        command: command.type,
        requireData,
        requireCommand,
        ...(expectedSubscriptionChannels === undefined
          ? {}
          : { expectedSubscriptionChannels: [...expectedSubscriptionChannels] }),
        resolve,
        reject,
        timer
      })
      try {
        this.process.stdin.write(`${JSON.stringify(request)}\n`, (error) => {
          if (error) this.rejectOne(id, error)
        })
      } catch (error) {
        this.rejectOne(id, toError(error))
      }
    })
  }

  private nextRequestId(): string {
    let id = this.createRequestId()
    while (this.pending.has(id)) {
      id = this.createRequestId()
    }
    if (id.length === 0) {
      throw new Error('Pi RPC request ID must not be empty')
    }
    return id
  }

  private handleStdout(chunk: Buffer | string): void {
    this.handleBatch(this.stdoutParser.push(chunk))
  }

  private endStdout(): void {
    if (this.stdoutEnded) {
      return
    }
    this.stdoutEnded = true
    this.handleBatch(this.stdoutParser.end())
  }

  private handleBatch(batch: JsonlParseBatch): void {
    for (let index = 0; index < batch.records.length; index++) {
      this.handleRecord(batch.records[index], batch.recordByteLengths[index]!)
    }
    for (const error of batch.errors) {
      this.onDiagnostic({ type: 'stdout-parse-error', error })
    }
  }

  private handleRecord(value: unknown, recordByteLength: number): void {
    if (!isRecord(value) || typeof value.type !== 'string') {
      return
    }
    if (value.type === 'extension_event' || value.type === 'extension_event_diagnostic') {
      if (this.processFinished) return
      if (recordByteLength > PI_RPC_EXTENSION_EVENT_MAX_RECORD_BYTES) {
        this.reportMalformedExtensionEvent(value.type)
        return
      }
      const event = normalizePiRpcExtensionEvent(value)
      if (event === null) {
        this.reportMalformedExtensionEvent(value.type)
      } else if (
        event.type === 'extension_event'
          ? this.activeExtensionEventChannels.has(event.channel)
          : this.activeExtensionEventChannels.size > 0
      ) {
        this.onExtensionEvent(event)
      } else {
        this.reportMalformedExtensionEvent(value.type)
      }
      return
    }
    if (value.type !== 'response') {
      this.onEvent(value as PiRpcEvent)
      return
    }
    if (typeof value.id !== 'string') {
      return
    }

    const pending = this.pending.get(value.id)
    if (!pending) {
      return
    }
    this.pending.delete(value.id)
    clearTimeout(pending.timer)
    if (pending.expectedSubscriptionChannels !== undefined) {
      this.subscriptionReplacementPending = false
    }

    if (pending.requireCommand && value.command !== pending.command) {
      pending.reject(new Error(`Invalid Pi RPC ${pending.command} response`))
      return
    }
    if (value.success === false) {
      const detail = typeof value.error === 'string' ? `: ${value.error}` : ''
      pending.reject(new Error(`Pi RPC ${pending.command} failed${detail}`))
      return
    }
    if (value.success !== true || (pending.requireData && !('data' in value))) {
      pending.reject(new Error(`Invalid Pi RPC ${pending.command} response`))
      return
    }

    if (pending.expectedSubscriptionChannels !== undefined) {
      let responseChannels: string[]
      try {
        responseChannels = normalizeExtensionEventSubscriptionResponse(value.data)
      } catch {
        pending.reject(new Error('Invalid Pi RPC subscribe_extension_events response'))
        return
      }
      if (!arraysEqual(responseChannels, pending.expectedSubscriptionChannels)) {
        pending.reject(new Error('Invalid Pi RPC subscribe_extension_events response'))
        return
      }
      // Install before resolving: a following record in this same parser batch must
      // observe the new complete binding without waiting for a Promise continuation.
      this.activeExtensionEventChannels = new Set(responseChannels)
      this.extensionEventProtocolDiagnosticProduced = false
      pending.resolve(responseChannels)
      return
    }

    pending.resolve(value.data)
  }

  private reportMalformedExtensionEvent(
    recordType: 'extension_event' | 'extension_event_diagnostic'
  ): void {
    if (this.extensionEventProtocolDiagnosticProduced) return
    this.extensionEventProtocolDiagnosticProduced = true
    this.onDiagnostic({ type: 'extension-event-protocol-error', recordType })
  }

  private rejectOne(id: string, error: Error): void {
    const pending = this.pending.get(id)
    if (!pending) {
      return
    }
    this.pending.delete(id)
    clearTimeout(pending.timer)
    if (pending.expectedSubscriptionChannels !== undefined) {
      this.subscriptionReplacementPending = false
    }
    pending.reject(error)
  }

  private reportExitAndFinish(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.processFinished) {
      return
    }
    this.onDiagnostic({ type: 'process-exit', code, signal })
    const detail = code !== null ? ` with code ${code}` : signal !== null ? ` from signal ${signal}` : ''
    this.finishProcess(new Error(`Pi RPC process exited before responding${detail}`))
  }

  private finishProcess(error: Error): void {
    if (this.processFinished) {
      return
    }
    this.processFinished = true
    this.activeExtensionEventChannels.clear()
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
    this.subscriptionReplacementPending = false
  }
}

export function normalizePiRpcTreeResult(value: unknown): PiRpcTreeResult {
  try {
    if (
      !hasExactKeys(value, ['tree', 'leafId']) ||
      !Array.isArray(value.tree) ||
      !(value.leafId === null || typeof value.leafId === 'string')
    ) {
      throw new Error('invalid tree envelope')
    }

    const leafId = value.leafId === null
      ? null
      : validateIdentifier(value.leafId, 'Pi RPC tree leaf ID', MAX_ENTRY_ID_LENGTH)
    const tree: PiRpcTreeNode[] = []
    const ids = new Set<string>()
    const roots: PiRpcSessionEntry[] = []
    const stack: Array<{
      value: unknown
      parent: PiRpcTreeNode | null
      depth: number
    }> = []
    for (let index = value.tree.length - 1; index >= 0; index--) {
      stack.push({ value: value.tree[index], parent: null, depth: 1 })
    }

    let nodeCount = 0
    while (stack.length > 0) {
      const frame = stack.pop()!
      nodeCount += 1
      if (nodeCount > PI_RPC_TREE_MAX_NODES || frame.depth > PI_RPC_TREE_MAX_DEPTH) {
        throw new Error('tree bounds exceeded')
      }
      if (
        !isRecord(frame.value) ||
        !hasRequiredAndAllowedKeys(frame.value, ['entry', 'children'], [
          'entry',
          'children',
          'label',
          'labelTimestamp'
        ]) ||
        !Array.isArray(frame.value.children)
      ) {
        throw new Error('invalid tree node')
      }

      const normalizedEntry = projectPiRpcTreeEntry(frame.value.entry)
      validateIdentifier(normalizedEntry.id, 'Pi RPC tree entry ID', MAX_ENTRY_ID_LENGTH)
      if (normalizedEntry.parentId !== null) {
        validateIdentifier(normalizedEntry.parentId, 'Pi RPC tree parent ID', MAX_ENTRY_ID_LENGTH)
      }
      if (ids.has(normalizedEntry.id)) {
        throw new Error('duplicate tree entry ID')
      }
      ids.add(normalizedEntry.id)

      if (frame.parent === null) {
        roots.push(normalizedEntry)
      } else if (normalizedEntry.parentId !== frame.parent.entry.id) {
        throw new Error('inconsistent tree parent')
      }

      const label = normalizeOptionalBoundedString(
        frame.value.label,
        PI_RPC_TREE_MAX_LABEL_CHARS
      )
      const labelTimestamp = normalizeOptionalBoundedString(
        frame.value.labelTimestamp,
        PI_RPC_TREE_MAX_LABEL_TIMESTAMP_CHARS
      )
      const projected: PiRpcTreeNode = {
        entry: normalizedEntry,
        children: [],
        ...(label === undefined ? {} : { label }),
        ...(labelTimestamp === undefined ? {} : { labelTimestamp })
      }
      if (frame.parent === null) tree.push(projected)
      else frame.parent.children.push(projected)

      for (let index = frame.value.children.length - 1; index >= 0; index--) {
        stack.push({
          value: frame.value.children[index],
          parent: projected,
          depth: frame.depth + 1
        })
      }
    }

    for (const root of roots) {
      if (root.parentId === root.id || (root.parentId !== null && ids.has(root.parentId))) {
        throw new Error('cyclic or inconsistent root parent')
      }
    }
    if (leafId !== null && !ids.has(leafId)) {
      throw new Error('tree leaf is missing')
    }
    if (tree.length === 0 && leafId !== null) {
      throw new Error('empty tree has a leaf')
    }

    return { tree, leafId }
  } catch {
    throw new Error('Invalid Pi RPC get_tree response')
  }
}

function projectPiRpcTreeEntry(value: unknown): PiRpcSessionEntry {
  const entry = normalizePiRpcSessionEntry(value)
  if (
    (entry.customType === ADVISOR_CAPABILITY_CUSTOM_TYPE ||
      entry.customType === OPENAI_FAST_MODE_ENTRY_TYPE) &&
    'data' in entry
  ) {
    const { data: _privateInternalData, ...projected } = entry
    return projected
  }
  return entry
}

function normalizePiRpcNavigateTreeResult(
  value: unknown,
  expectedTargetEntryId: string
): PiRpcNavigateTreeResult {
  const allowedKeys = ['targetEntryId', 'cancelled', 'leafId', 'editorText'] as const
  if (
    !isRecord(value) ||
    !hasRequiredAndAllowedKeys(value, ['targetEntryId', 'cancelled', 'leafId'], allowedKeys) ||
    value.targetEntryId !== expectedTargetEntryId ||
    typeof value.cancelled !== 'boolean' ||
    !(value.leafId === null || typeof value.leafId === 'string') ||
    !(value.editorText === undefined || typeof value.editorText === 'string')
  ) {
    throw new Error('Invalid Pi RPC navigate_tree response')
  }
  try {
    const leafId = value.leafId === null
      ? null
      : validateIdentifier(value.leafId, 'Pi RPC tree leaf ID', MAX_ENTRY_ID_LENGTH)
    return {
      targetEntryId: expectedTargetEntryId,
      cancelled: value.cancelled,
      leafId,
      ...(value.editorText === undefined ? {} : { editorText: value.editorText })
    }
  } catch {
    throw new Error('Invalid Pi RPC navigate_tree response')
  }
}

function normalizeExtensionEventSubscriptionResponse(value: unknown): string[] {
  if (!hasExactKeys(value, ['channels']) || !Array.isArray(value.channels)) {
    throw new Error('Invalid Pi RPC subscribe_extension_events response')
  }
  try {
    if (value.channels.length > MAX_EXTENSION_EVENT_CHANNELS) {
      throw new Error('too many channels')
    }
    const seen = new Set<string>()
    return value.channels.map((channel) => {
      const normalized = validateIdentifier(
        channel,
        'Pi RPC extension event channel',
        MAX_EXTENSION_EVENT_CHANNEL_LENGTH
      )
      if (seen.has(normalized)) throw new Error('duplicate channel')
      seen.add(normalized)
      return normalized
    })
  } catch {
    throw new Error('Invalid Pi RPC subscribe_extension_events response')
  }
}

function normalizePiRpcExtensionEvent(value: Record<string, unknown>): PiRpcExtensionEvent | null {
  try {
    if (value.type === 'extension_event') {
      if (!hasExactKeys(value, ['type', 'channel', 'data'])) return null
      return {
        type: 'extension_event',
        channel: validateIdentifier(
          value.channel,
          'Pi RPC extension event channel',
          MAX_EXTENSION_EVENT_CHANNEL_LENGTH
        ),
        data: value.data
      }
    }
    if (
      !hasExactKeys(value, ['type', 'reason']) ||
      (
        value.reason !== 'invalid_payload' &&
        value.reason !== 'record_too_large' &&
        value.reason !== 'queue_overflow'
      )
    ) {
      return null
    }
    return { type: 'extension_event_diagnostic', reason: value.reason }
  } catch {
    return null
  }
}

function validateIdentifier(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`)
  if (value.length === 0) throw new Error(`${label} must not be empty`)
  if (value.length > maxLength) throw new Error(`${label} exceeds maximum length of ${maxLength}`)
  if (value.trim() !== value || CONTROL_CHARACTER_PATTERN.test(value)) {
    throw new Error(`${label} is malformed`)
  }
  return value
}

function validateExtensionEventChannels(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error('Pi RPC extension event channels must be an array')
  if (value.length > MAX_EXTENSION_EVENT_CHANNELS) {
    throw new Error(
      `Pi RPC extension event channel count exceeds maximum of ${MAX_EXTENSION_EVENT_CHANNELS}`
    )
  }
  const seen = new Set<string>()
  const channels: string[] = []
  for (const valueChannel of value) {
    const channel = validateIdentifier(
      valueChannel,
      'Pi RPC extension event channel',
      MAX_EXTENSION_EVENT_CHANNEL_LENGTH
    )
    if (seen.has(channel)) continue
    seen.add(channel)
    channels.push(channel)
  }
  return channels
}

function normalizeOptionalBoundedString(value: unknown, maxChars: number): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length > maxChars || value.includes('\0')) {
    throw new Error('invalid bounded string')
  }
  return value
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function hasRequiredAndAllowedKeys(
  value: Record<string, unknown>,
  requiredKeys: readonly string[],
  allowedKeys: readonly string[]
): boolean {
  const actualKeys = Object.keys(value)
  return requiredKeys.every((key) => Object.hasOwn(value, key)) &&
    actualKeys.every((key) => allowedKeys.includes(key))
}

function normalizePiRpcExtensionInventory(value: unknown): PiRpcExtensionInventory {
  if (
    !hasExactKeys(value, ['protocolVersion', 'complete', 'loading', 'extensions', 'loadErrorCount']) ||
    value.protocolVersion !== 1 ||
    typeof value.complete !== 'boolean' ||
    (value.loading !== 'eager_complete' && value.loading !== 'lazy_partial') ||
    !Array.isArray(value.extensions) ||
    value.extensions.length > MAX_LOADED_EXTENSIONS ||
    !isNonNegativeSafeInteger(value.loadErrorCount) ||
    value.loadErrorCount > MAX_EXTENSION_LOAD_ERRORS ||
    value.complete !== (value.loading === 'eager_complete' && value.loadErrorCount === 0)
  ) {
    throw new Error('Invalid Pi RPC get_extensions response')
  }

  const seenIds = new Set<string>()
  const extensions = value.extensions.map((extension): PiRpcLoadedExtension => {
    if (
      !hasExactKeys(extension, ['id', 'capabilities']) ||
      typeof extension.id !== 'string' ||
      extension.id.length > MAX_EXTENSION_ID_CHARS ||
      !EXTENSION_ID_PATTERN.test(extension.id) ||
      seenIds.has(extension.id) ||
      !Array.isArray(extension.capabilities)
    ) {
      throw new Error('Invalid Pi RPC get_extensions response')
    }
    seenIds.add(extension.id)

    const seenCapabilities = new Set<PiRpcExtensionCapability>()
    const capabilities = extension.capabilities.map((capability) => {
      if (
        typeof capability !== 'string' ||
        !EXTENSION_CAPABILITY_SET.has(capability) ||
        seenCapabilities.has(capability as PiRpcExtensionCapability)
      ) {
        throw new Error('Invalid Pi RPC get_extensions response')
      }
      const normalized = capability as PiRpcExtensionCapability
      seenCapabilities.add(normalized)
      return normalized
    })
    capabilities.sort(compareAscii)
    return { id: extension.id, capabilities }
  })
  extensions.sort((left, right) => compareAscii(left.id, right.id))

  return {
    protocolVersion: 1,
    complete: value.complete,
    loading: value.loading,
    extensions,
    loadErrorCount: value.loadErrorCount
  }
}

function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function hasExactKeys<T extends readonly string[]>(
  value: unknown,
  keys: T
): value is Record<T[number], unknown> {
  if (!isRecord(value)) return false
  const actualKeys = Object.keys(value)
  return actualKeys.length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}

function isPiRpcModel(value: unknown): value is PiRpcModel {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.provider === 'string' &&
    isOptionalThinkingLevelMap(value.thinkingLevelMap)
  )
}

export function normalizePiRpcSessionEntry(value: unknown): PiRpcSessionEntry {
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.id) ||
    !(value.parentId === null || typeof value.parentId === 'string') ||
    !isNonEmptyString(value.type) ||
    !isNonEmptyString(value.timestamp)
  ) {
    throw new Error('Invalid Pi RPC get_entries response')
  }

  const entry = {
    id: value.id,
    parentId: value.parentId,
    type: value.type,
    timestamp: value.timestamp
  }
  if (
    value.type === 'custom' &&
    (
      value.customType === ADVISOR_CAPABILITY_CUSTOM_TYPE ||
      value.customType === MAGIC_CONTEXT_CUSTOM_TYPE ||
      value.customType === OPENAI_FAST_MODE_ENTRY_TYPE
    )
  ) {
    return {
      ...entry,
      customType: value.customType,
      data: value.customType === MAGIC_CONTEXT_CUSTOM_TYPE
        ? normalizeMagicContextData(value.data)
        : value.customType === OPENAI_FAST_MODE_ENTRY_TYPE
          ? normalizeOpenAiFastModeEntryData(value.data)
          : value.data
    }
  }
  if (value.type !== 'message') {
    return entry
  }
  if (!isRecord(value.message) || !isNonEmptyString(value.message.role)) {
    throw new Error('Invalid Pi RPC get_entries response')
  }
  if (value.message.role !== 'user') {
    return { ...entry, message: { role: value.message.role } }
  }

  return {
    ...entry,
    message: {
      role: value.message.role,
      content: normalizeUserContent(value.message.content)
    }
  }
}

function normalizeOpenAiFastModeEntryData(value: unknown): { enabled: boolean } {
  const enabled = parseOpenAiFastModeEntryData(value)
  if (enabled === null) throw new Error('Invalid Pi RPC get_entries response')
  return { enabled }
}

function normalizeMagicContextData(value: unknown): unknown {
  if (!isRecord(value)) return undefined
  if (
    !isSafeMagicContextString(value.title, MAX_MAGIC_CONTEXT_TITLE_CHARS) ||
    !isSafeMagicContextString(value.text, MAX_MAGIC_CONTEXT_TEXT_CHARS)
  ) return undefined
  const level = value.level
  if (
    level !== undefined &&
    level !== 'info' &&
    level !== 'success' &&
    level !== 'warning' &&
    level !== 'error'
  ) return undefined
  return {
    title: value.title,
    text: value.text,
    ...(level === undefined ? {} : { level })
  }
}

function isSafeMagicContextString(value: unknown, maxChars: number): value is string {
  return typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= maxChars &&
    !value.includes('\0')
}

function normalizeUserContent(content: unknown): { text: string; hasImage: boolean } {
  if (typeof content === 'string') {
    return { text: content, hasImage: false }
  }
  if (!Array.isArray(content)) {
    throw new Error('Invalid Pi RPC get_entries response')
  }

  const text: string[] = []
  let hasImage = false
  for (const block of content) {
    if (!isRecord(block) || !isNonEmptyString(block.type)) {
      throw new Error('Invalid Pi RPC get_entries response')
    }
    if (block.type === 'text') {
      if (typeof block.text !== 'string') {
        throw new Error('Invalid Pi RPC get_entries response')
      }
      text.push(block.text)
    } else if (block.type === 'image') {
      if (!isNonEmptyString(block.mimeType) || !isNonEmptyString(block.data)) {
        throw new Error('Invalid Pi RPC get_entries response')
      }
      hasImage = true
    } else {
      throw new Error('Invalid Pi RPC get_entries response')
    }
  }
  return { text: text.join(''), hasImage }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isPiRpcAvailableModel(value: unknown): value is PiRpcAvailableModel {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    value.id.trim().length > 0 &&
    typeof value.provider === 'string' &&
    value.provider.trim().length > 0 &&
    (!('name' in value) || typeof value.name === 'string') &&
    (!('reasoning' in value) || typeof value.reasoning === 'boolean') &&
    isOptionalThinkingLevelMap(value.thinkingLevelMap) &&
    (!('contextWindow' in value) || isPositiveSafeInteger(value.contextWindow)) &&
    (!('cost' in value) || isPiRpcModelCost(value.cost))
  )
}

function isPiRpcModelCost(value: unknown): value is PiRpcModelCost {
  return (
    isRecord(value) &&
    isNonNegativeNumber(value.input) &&
    isNonNegativeNumber(value.output) &&
    isNonNegativeNumber(value.cacheRead) &&
    isNonNegativeNumber(value.cacheWrite) &&
    (
      value.tiers === undefined ||
      (
        Array.isArray(value.tiers) &&
        value.tiers.every((tier) =>
          isRecord(tier) &&
          Number.isSafeInteger(tier.inputTokensAbove) &&
          isNonNegativeNumber(tier.inputTokensAbove) &&
          isNonNegativeNumber(tier.input) &&
          isNonNegativeNumber(tier.output) &&
          isNonNegativeNumber(tier.cacheRead) &&
          isNonNegativeNumber(tier.cacheWrite)
        )
      )
    )
  )
}

function projectPiRpcModelCost(cost: PiRpcModelCost): PiRpcModelCost {
  return {
    input: cost.input,
    output: cost.output,
    cacheRead: cost.cacheRead,
    cacheWrite: cost.cacheWrite,
    ...(cost.tiers === undefined
      ? {}
      : {
          tiers: cost.tiers.map((tier) => ({
            inputTokensAbove: tier.inputTokensAbove,
            input: tier.input,
            output: tier.output,
            cacheRead: tier.cacheRead,
            cacheWrite: tier.cacheWrite
          }))
        })
  }
}

function isPiRpcSessionStats(value: unknown): value is PiRpcSessionStats {
  if (
    !isRecord(value) ||
    typeof value.sessionId !== 'string' ||
    !isNonNegativeNumber(value.cost)
  ) {
    return false
  }
  const tokens = value.tokens
  if (
    !isRecord(tokens) ||
    !isNonNegativeSafeInteger(tokens.input) ||
    !isNonNegativeSafeInteger(tokens.output) ||
    !isNonNegativeSafeInteger(tokens.cacheRead) ||
    !isNonNegativeSafeInteger(tokens.cacheWrite) ||
    !isNonNegativeSafeInteger(tokens.total)
  ) {
    return false
  }
  const contextUsage = value.contextUsage
  return (
    (!('sessionFile' in value) || typeof value.sessionFile === 'string') &&
    isNonNegativeSafeInteger(value.userMessages) &&
    isNonNegativeSafeInteger(value.assistantMessages) &&
    isNonNegativeSafeInteger(value.toolCalls) &&
    isNonNegativeSafeInteger(value.toolResults) &&
    isNonNegativeSafeInteger(value.totalMessages) &&
    (
      contextUsage === undefined ||
      (
        isRecord(contextUsage) &&
        (contextUsage.tokens === null || isNonNegativeSafeInteger(contextUsage.tokens)) &&
        isPositiveSafeInteger(contextUsage.contextWindow) &&
        (contextUsage.percent === null || isContextPercent(contextUsage.percent))
      )
    )
  )
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && isNonNegativeNumber(value)
}

function isPositiveSafeInteger(value: unknown): value is number {
  return isNonNegativeSafeInteger(value) && value > 0
}

function isContextPercent(value: unknown): value is number {
  return isNonNegativeNumber(value)
}

function normalizePiRpcModel(model: PiRpcModel): PiRpcModel {
  return {
    ...model,
    ...(model.thinkingLevelMap === undefined
      ? {}
      : { thinkingLevelMap: projectThinkingLevelMap(model.thinkingLevelMap) })
  }
}

function isOptionalThinkingLevelMap(value: unknown): boolean {
  return value === undefined || (
    isRecord(value) &&
    Object.values(value).every((entry) => typeof entry === 'string' || entry === null)
  )
}

function projectThinkingLevelMap(value: Record<string, string | null>): ThinkingLevelMap {
  const result: ThinkingLevelMap = {}
  for (const level of GUI_THINKING_LEVELS) {
    if (Object.prototype.hasOwnProperty.call(value, level)) result[level] = value[level] ?? null
  }
  return result
}

function isPiRpcSlashCommand(value: unknown): value is PiRpcSlashCommand {
  return (
    isRecord(value) &&
    typeof value.name === 'string' &&
    value.name.length > 0 &&
    !value.name.startsWith('/') &&
    (!('description' in value) || typeof value.description === 'string') &&
    (value.source === 'extension' || value.source === 'prompt' || value.source === 'skill') &&
    isRecord(value.sourceInfo) &&
    isNonEmptyString(value.sourceInfo.source) &&
    (
      value.sourceInfo.scope === 'user' ||
      value.sourceInfo.scope === 'project' ||
      value.sourceInfo.scope === 'temporary'
    ) &&
    (value.sourceInfo.origin === 'package' || value.sourceInfo.origin === 'top-level')
  )
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

function copyPromptImage(image: KernelPromptImage): KernelPromptImage {
  return { type: 'image', mimeType: image.mimeType, data: image.data }
}
