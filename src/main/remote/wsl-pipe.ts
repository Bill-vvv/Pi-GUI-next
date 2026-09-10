import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { StringDecoder } from 'node:string_decoder'
import type { Readable, Writable } from 'node:stream'

import { KERNEL_COMMAND_CHANNEL, KERNEL_EVENT_CHANNEL, OPEN_EXTERNAL_CHANNEL, PROVIDER_AUTH_EVENT_CHANNEL } from '../../shared/kernel-contract.ts'
import { GIT_COMMAND_CHANNEL } from '../../shared/git-contract.ts'
import { REMOTE_ADMIN_COMMAND_CHANNEL } from '../../shared/remote-admin-contract.ts'

export const WSL_COMMAND_CHANNELS = [KERNEL_COMMAND_CHANNEL, GIT_COMMAND_CHANNEL, REMOTE_ADMIN_COMMAND_CHANNEL, OPEN_EXTERNAL_CHANNEL] as const
const EVENT_CHANNELS = new Set([KERNEL_EVENT_CHANNEL, PROVIDER_AUTH_EVENT_CHANNEL])
const COMMAND_CHANNELS = new Set<string>(WSL_COMMAND_CHANNELS)
const PREFIX = '@pi-gui-wsl@'
const VERSION = 1
const MAX_FRAME_BYTES = 32 * 1024 * 1024
const MAX_PENDING = 64
const ID_PATTERN = /^[0-9a-f-]{36}$/u

export function wslBuildFingerprint(mainFile: string): string {
  return createHash('sha256').update(readFileSync(mainFile)).digest('hex')
}

export type WslPeerInfo = { platform: string; pid: number; home: string }
type Pending = { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
type WslPipeOptions = {
  input: Readable
  output: Writable
  fingerprint: string
  expectedPlatform: 'linux' | 'win32'
  platform?: string
  readyTimeoutMs?: number
  requestTimeoutMs?: number
  dispatch?(channel: string, value: unknown): unknown | Promise<unknown>
  onEvent?(channel: string, value: unknown): void
}

/** A private, owned wsl.exe stdio pipe. This is not a network or SSH endpoint. */
export class WslPipe {
  readonly ready: Promise<WslPeerInfo>
  readonly closed: Promise<Error | null>
  private resolveReady!: (info: WslPeerInfo) => void
  private rejectReady!: (error: Error) => void
  private resolveClosed!: (error: Error | null) => void
  private readonly pending = new Map<string, Pending>()
  private readonly incoming = new Set<string>()
  private readonly decoder = new StringDecoder('utf8')
  private buffer = ''
  private connected = false
  private ended = false
  private readonly readyTimer: ReturnType<typeof setTimeout>
  private readonly options: WslPipeOptions

  constructor(options: WslPipeOptions) {
    this.options = options
    if (!/^[0-9a-f]{64}$/u.test(options.fingerprint)) throw new Error('WSL build fingerprint is invalid.')
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject })
    this.closed = new Promise((resolve) => { this.resolveClosed = resolve })
    // Startup errors can arrive before the caller awaits ready.
    void this.ready.catch(() => undefined)
    this.readyTimer = setTimeout(() => this.finish(new Error('WSL backend startup timed out.')), options.readyTimeoutMs ?? 90_000)
    options.input.on('data', this.onData)
    options.input.once('end', this.onEnd)
    options.input.once('error', this.onError)
    options.output.once('error', this.onError)
    this.write({ kind: 'hello', fingerprint: options.fingerprint, platform: options.platform ?? process.platform, pid: process.pid, home: homedir() })
  }

  async request(channel: string, value: unknown): Promise<unknown> {
    await this.ready
    if (this.ended) throw new Error('WSL backend is disconnected. The command was not sent.')
    if (!COMMAND_CHANNELS.has(channel)) throw new Error('Unsupported WSL command channel.')
    if (this.pending.size >= MAX_PENDING) throw new Error('Too many pending WSL commands.')
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.finish(new Error('WSL command timed out; its outcome is unknown. Commands are never replayed automatically.'))
      }, this.options.requestTimeoutMs ?? 300_000)
      this.pending.set(id, { resolve, reject, timer })
      this.write({ kind: 'request', id, channel, value })
    })
  }

  publish(channel: string, value: unknown): void {
    if (!EVENT_CHANNELS.has(channel)) throw new Error('Unsupported WSL event channel.')
    if (this.connected && !this.ended) this.write({ kind: 'event', channel, value })
  }

  close(): void { this.finish(null) }

  private readonly onEnd = (): void => this.finish(new Error('WSL backend pipe closed.'))
  private readonly onError = (): void => this.finish(new Error('WSL backend pipe failed.'))
  private readonly onData = (chunk: Buffer): void => {
    if (this.ended) return
    this.buffer += this.decoder.write(chunk)
    // Bound incomplete frames as well as complete frames.
    if (Buffer.byteLength(this.buffer) > MAX_FRAME_BYTES * 2) {
      this.finish(new Error('WSL frame exceeds the size limit.'))
      return
    }
    let newline: number
    while (!this.ended && (newline = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newline).replace(/\r$/u, '')
      this.buffer = this.buffer.slice(newline + 1)
      if (line.length === 0) continue // Electron may emit an initial blank line.
      try {
        if (!line.startsWith(PREFIX) || Buffer.byteLength(line) > MAX_FRAME_BYTES) throw new Error('Invalid WSL frame.')
        this.receive(JSON.parse(line.slice(PREFIX.length)))
      } catch (error) {
        this.finish(error instanceof Error ? error : new Error('Invalid WSL frame.'))
      }
    }
    if (Buffer.byteLength(this.buffer) > MAX_FRAME_BYTES) this.finish(new Error('WSL frame exceeds the size limit.'))
  }

  private receive(message: unknown): void {
    if (!isRecord(message) || message.version !== VERSION) throw new Error('WSL protocol version mismatch.')
    if (message.kind === 'hello') {
      if (this.connected || message.fingerprint !== this.options.fingerprint || message.platform !== this.options.expectedPlatform ||
          !Number.isSafeInteger(message.pid) || (message.pid as number) <= 0 || typeof message.home !== 'string') {
        throw new Error('WSL backend build or platform mismatch. Run the WSL setup script again.')
      }
      this.connected = true
      clearTimeout(this.readyTimer)
      this.resolveReady({ platform: this.options.expectedPlatform, pid: message.pid as number, home: message.home })
      return
    }
    if (!this.connected) throw new Error('WSL command arrived before the compatibility handshake.')
    if (message.kind === 'event') {
      if (typeof message.channel !== 'string' || !EVENT_CHANNELS.has(message.channel)) throw new Error('Invalid WSL event channel.')
      this.options.onEvent?.(message.channel, message.value)
      return
    }
    if (typeof message.id !== 'string' || !ID_PATTERN.test(message.id)) throw new Error('Invalid WSL request identity.')
    if (message.kind === 'response') {
      const pending = this.pending.get(message.id)
      if (pending === undefined || typeof message.ok !== 'boolean' || (!message.ok && typeof message.error !== 'string')) {
        throw new Error('Unexpected WSL response.')
      }
      this.pending.delete(message.id)
      clearTimeout(pending.timer)
      if (message.ok) pending.resolve(message.value)
      else pending.reject(new Error(message.error as string))
      return
    }
    if (message.kind !== 'request' || typeof message.channel !== 'string' || !COMMAND_CHANNELS.has(message.channel) ||
        this.options.dispatch === undefined || this.incoming.has(message.id) || this.incoming.size >= MAX_PENDING) {
      throw new Error('Invalid WSL request.')
    }
    const { id, channel, value } = message
    this.incoming.add(id)
    Promise.resolve().then(() => this.options.dispatch!(channel, value)).then(
      (result) => this.write({ kind: 'response', id, ok: true, value: result ?? null }),
      (error: unknown) => this.write({ kind: 'response', id, ok: false, error: error instanceof Error ? error.message : 'WSL command failed.' })
    ).finally(() => this.incoming.delete(id))
  }

  private write(message: Record<string, unknown>): void {
    if (this.ended) return
    try {
      const line = `${PREFIX}${JSON.stringify({ version: VERSION, ...message })}\n`
      if (Buffer.byteLength(line) > MAX_FRAME_BYTES || this.options.output.writableLength > MAX_FRAME_BYTES * 2) {
        throw new Error('WSL output exceeds the size limit.')
      }
      this.options.output.write(line)
    } catch (error) {
      this.finish(error instanceof Error ? error : new Error('Unable to write WSL frame.'))
    }
  }

  private finish(error: Error | null): void {
    if (this.ended) return
    this.ended = true
    clearTimeout(this.readyTimer)
    const failure = error ?? new Error('WSL connection closed.')
    this.rejectReady(failure)
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(failure) }
    this.pending.clear()
    this.buffer = ''
    this.options.input.off('data', this.onData)
    this.options.input.off('end', this.onEnd)
    this.options.output.end()
    this.resolveClosed(error)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
