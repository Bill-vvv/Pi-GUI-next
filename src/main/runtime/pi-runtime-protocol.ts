import type { PiRpcExtensionEvent } from '../pi-rpc/pi-rpc-data.ts'
import type { RuntimeHostEvent, RuntimeHostState } from './runtime-host.ts'
import type { SharedPiRuntimeOptions } from './shared-pi-host.ts'

/*
 * Main <-> Pi Runtime process protocol (D-094). Main sends plain objects over the Node IPC
 * channel. The child sends each message as one pre-serialized JSON string so it can bound
 * its unsent backlog exactly (D-099); payloads keep the JSON semantics of the retired RPC path.
 */

export const PI_RUNTIME_REMOTE_METHODS = [
  'send',
  'stop',
  'getLoadedExtensions',
  'queryQuiescence',
  'prepareHibernation',
  'commitHibernation',
  'releaseHibernation'
] as const

export type PiRuntimeRemoteMethod = typeof PI_RUNTIME_REMOTE_METHODS[number]

export type PiRuntimeRequest =
  | { type: 'start'; id: number; runtimeId: string; options: SharedPiRuntimeOptions }
  | { type: 'call'; id: number; runtimeId: string; method: PiRuntimeRemoteMethod; args: unknown[] }
  | { type: 'dispose'; id: number }

export type PiRuntimeMessage =
  | { type: 'ready'; pid: number; version: string }
  | { type: 'response'; id: number; ok: true; value: unknown; state?: RuntimeHostState }
  | { type: 'response'; id: number; ok: false; message: string; state?: RuntimeHostState }
  | { type: 'event'; runtimeId: string; event: RuntimeHostEvent; state: RuntimeHostState }
  | { type: 'extension-event'; runtimeId: string; event: PiRpcExtensionEvent }

/** Unsent child-to-Main characters before the child treats Main as stalled and exits. */
export const PI_RUNTIME_OUTPUT_BACKLOG_LIMIT_CHARS = 64 * 1024 * 1024
/** Main requests awaiting a child response before Main treats the child as failed. */
export const PI_RUNTIME_PENDING_REQUEST_LIMIT = 1024
/** Child exit code when its output backlog limit is exceeded. */
export const PI_RUNTIME_EXIT_OUTPUT_BACKLOG = 70
/** Child exit code when Host disposal failed after replying. */
export const PI_RUNTIME_EXIT_DISPOSE_FAILED = 71
export const PI_RUNTIME_LOG_DIRECTORY_ENV = 'PI_GUI_LOG_DIRECTORY'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isRequestId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

export function isPiRuntimeRequest(value: unknown): value is PiRuntimeRequest {
  if (!isRecord(value) || !isRequestId(value.id)) return false
  if (value.type === 'dispose') return true
  if (typeof value.runtimeId !== 'string' || value.runtimeId.length === 0) return false
  if (value.type === 'start') return isRecord(value.options)
  return value.type === 'call' &&
    (PI_RUNTIME_REMOTE_METHODS as readonly unknown[]).includes(value.method) &&
    Array.isArray(value.args)
}

export function parsePiRuntimeMessage(text: unknown): PiRuntimeMessage | null {
  if (typeof text !== 'string') return null
  let value: unknown
  try { value = JSON.parse(text) } catch { return null }
  if (!isRecord(value)) return null
  switch (value.type) {
    case 'ready':
      return typeof value.pid === 'number' && typeof value.version === 'string' ? value as PiRuntimeMessage : null
    case 'response':
      if (!isRequestId(value.id)) return null
      if (value.ok === true) return value as PiRuntimeMessage
      return value.ok === false && typeof value.message === 'string' ? value as PiRuntimeMessage : null
    case 'event':
      return typeof value.runtimeId === 'string' && isRecord(value.event) && isRecord(value.state)
        ? value as PiRuntimeMessage
        : null
    case 'extension-event':
      return typeof value.runtimeId === 'string' && isRecord(value.event) ? value as PiRuntimeMessage : null
    default:
      return null
  }
}
