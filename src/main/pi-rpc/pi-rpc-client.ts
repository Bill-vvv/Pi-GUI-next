import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'

import { LfJsonlParser, type JsonlParseBatch } from './jsonl-framing.ts'

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000

export type PiRpcModel = {
  id: string
  name?: string
  provider: string
  reasoning?: boolean
  contextWindow?: number
  [key: string]: unknown
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
  [key: string]: unknown
}

export type PiRpcEvent = Record<string, unknown> & { type: string }

export type PiRpcDiagnostic =
  | { type: 'stdout-parse-error'; error: Error }
  | { type: 'stderr'; chunk: string }
  | { type: 'process-error'; error: Error }
  | { type: 'process-exit'; code: number | null; signal: NodeJS.Signals | null }

export type PiRpcClientOptions = {
  requestTimeoutMs?: number
  onDiagnostic?: (diagnostic: PiRpcDiagnostic) => void
  onEvent?: (event: PiRpcEvent) => void
  createRequestId?: () => string
}

type PiRpcCommandName =
  | 'get_state'
  | 'get_messages'
  | 'prompt'
  | 'abort'
  | 'set_model'
  | 'set_thinking_level'

type PendingRequest = {
  command: PiRpcCommandName
  requireData: boolean
  resolve: (data: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class PiRpcClient {
  private readonly process: ChildProcessWithoutNullStreams
  private readonly requestTimeoutMs: number
  private readonly onDiagnostic: (diagnostic: PiRpcDiagnostic) => void
  private readonly onEvent: (event: PiRpcEvent) => void
  private readonly createRequestId: () => string
  private readonly stdoutParser = new LfJsonlParser()
  private readonly stderrDecoder = new StringDecoder('utf8')
  private readonly pending = new Map<string, PendingRequest>()
  private stdoutEnded = false
  private processFinished = false

  constructor(process: ChildProcessWithoutNullStreams, options: PiRpcClientOptions = {}) {
    this.process = process
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    this.onDiagnostic = options.onDiagnostic ?? (() => undefined)
    this.onEvent = options.onEvent ?? (() => undefined)
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
    return data
  }

  async getMessages(timeoutMs = this.requestTimeoutMs): Promise<unknown[]> {
    const data = await this.request({ type: 'get_messages' }, true, timeoutMs)
    if (!isRecord(data) || !Array.isArray(data.messages)) {
      throw new Error('Invalid Pi RPC get_messages response')
    }
    return data.messages
  }

  async prompt(message: string, timeoutMs = this.requestTimeoutMs): Promise<void> {
    await this.request({ type: 'prompt', message }, false, timeoutMs)
  }

  async abort(timeoutMs = this.requestTimeoutMs): Promise<void> {
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
    return data
  }

  async setThinkingLevel(level: string, timeoutMs = this.requestTimeoutMs): Promise<void> {
    await this.request({ type: 'set_thinking_level', level }, false, timeoutMs)
  }

  private request(
    command: { type: PiRpcCommandName; [key: string]: unknown },
    requireData: boolean,
    timeoutMs: number
  ): Promise<unknown> {
    if (this.processFinished || !this.process.stdin.writable) {
      return Promise.reject(new Error('Pi RPC process is not writable'))
    }

    const id = this.nextRequestId()
    const request = { id, ...command }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) {
          return
        }
        reject(new Error(`Timed out waiting for Pi RPC response: ${command.type}`))
      }, timeoutMs)
      timer.unref?.()

      this.pending.set(id, {
        command: command.type,
        requireData,
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
    for (const record of batch.records) {
      this.handleRecord(record)
    }
    for (const error of batch.errors) {
      this.onDiagnostic({ type: 'stdout-parse-error', error })
    }
  }

  private handleRecord(value: unknown): void {
    if (!isRecord(value) || typeof value.type !== 'string') {
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

    if (value.success === false) {
      const detail = typeof value.error === 'string' ? `: ${value.error}` : ''
      pending.reject(new Error(`Pi RPC ${pending.command} failed${detail}`))
      return
    }
    if (value.success !== true || (pending.requireData && !('data' in value))) {
      pending.reject(new Error(`Invalid Pi RPC ${pending.command} response`))
      return
    }

    pending.resolve(value.data)
  }

  private rejectOne(id: string, error: Error): void {
    const pending = this.pending.get(id)
    if (!pending) {
      return
    }
    this.pending.delete(id)
    clearTimeout(pending.timer)
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
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }
}

function isPiRpcModel(value: unknown): value is PiRpcModel {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.provider === 'string'
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}
