import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'

import { REMOTE_PAIRING_CODE_LENGTH } from '../../shared/remote-contract.ts'

/*
 * HTTP pieces shared verbatim by the Web Remote and Desktop Host gateways (D-097, narrowed).
 * Authentication, event fan-out, request parsing edges and security header sets stay per gateway.
 */

export const PAIR_BODY_LIMIT_BYTES = 4 * 1024
export const COMMAND_BODY_LIMIT_BYTES = 1 * 1024 * 1024
export const PAIR_RATE_LIMIT_WINDOW_MS = 60_000
export const PAIR_RATE_LIMIT_MAX = 5
export const REMOTE_DEVICE_ABSOLUTE_TTL_MS = 30 * 24 * 60 * 60 * 1000
export const REMOTE_PAIRING_CODE_TTL_MS = 5 * 60 * 1000
export const REMOTE_PAIRING_MAX_FAILED_ATTEMPTS = 5
export const SSE_HEARTBEAT_MS = 15_000
export const SSE_MAX_BUFFERED_BYTES = 1 * 1024 * 1024

export class BodyLimitError extends Error {
  constructor() {
    super('Request body too large.')
    this.name = 'BodyLimitError'
  }
}

export function applySecurityHeaders(res: ServerResponse, headers: Readonly<Record<string, string>>): void {
  for (const [name, value] of Object.entries(headers)) {
    res.setHeader(name, value)
  }
}

export function writeText(res: ServerResponse, statusCode: number, body: string): void {
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'text/plain; charset=utf-8')
  res.end(body)
}

export function writeJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

export function headerValue(req: IncomingMessage, name: string): string | null {
  const value = req.headers[name]
  if (typeof value === 'string') return value
  if (Array.isArray(value) && value.length === 1 && typeof value[0] === 'string') return value[0]
  return null
}

export function isPairingCodeShape(code: string): boolean {
  return new RegExp(`^[0-9]{${REMOTE_PAIRING_CODE_LENGTH}}$`, 'u').test(code)
}

export function normalizePeerAddress(address: string | undefined): string | null {
  if (address === undefined || address.length === 0) return null
  if (address.startsWith('::ffff:')) {
    return address.slice('::ffff:'.length)
  }
  if (address === '::1') return '127.0.0.1'
  return address
}

export function digestPairingCode(machineSecret: string, code: string): Buffer {
  return createHmac('sha256', machineSecret).update(code, 'utf8').digest()
}

export function pairingCodeMatches(
  machineSecret: string,
  code: string,
  expectedDigest: Buffer
): boolean {
  const actual = digestPairingCode(machineSecret, code)
  if (actual.length !== expectedDigest.length) return false
  return timingSafeEqual(actual, expectedDigest)
}

export function timingSafeEqualString(left: string, right: string): boolean {
  const leftHash = createHash('sha256').update(left).digest()
  const rightHash = createHash('sha256').update(right).digest()
  return timingSafeEqual(leftHash, rightHash)
}

/** Start a Server-Sent Events response and confirm the connection. */
export function openEventStream(res: ServerResponse): void {
  res.statusCode = 200
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.write(': connected\n\n')
}

export function listenServer(server: Server, port: number, host: string): Promise<void> {
  return new Promise<void>((resolveListen, rejectListen) => {
    const onError = (error: Error): void => {
      server.off('error', onError)
      rejectListen(error)
    }
    server.once('error', onError)
    server.listen(port, host, () => {
      server.off('error', onError)
      resolveListen()
    })
  })
}

export function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => {
      if (error) rejectClose(error)
      else resolveClose()
    })
  })
}
