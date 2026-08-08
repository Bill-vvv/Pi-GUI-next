import {
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  timingSafeEqual
} from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, realpath } from 'node:fs/promises'
import {
  createServer,
  type IncomingMessage,
  type ServerResponse
} from 'node:http'
import { extname, relative, resolve, sep } from 'node:path'

import type {
  RemoteAccessStatus,
  RemotePairedDevice,
  RemotePairingCode
} from '../../shared/remote-admin-contract.ts'
import type { KernelEvent } from '../../shared/kernel-contract.ts'
import {
  REMOTE_API_PATHS,
  REMOTE_PAIRING_CODE_LENGTH,
  REMOTE_PROTOCOL_VERSION,
  REMOTE_SESSION_COOKIE_NAME,
  isRemoteKernelCommand,
  type RemoteCommandErrorCode,
  type RemoteCommandRequest,
  type RemoteCommandResponse,
  type RemoteEventEnvelope,
  type RemoteKernelCommand,
  type RemotePairRequest,
  type RemoteSessionStatus
} from '../../shared/remote-contract.ts'
import { isKernelCommand } from '../kernel/kernel-command-validation.ts'
import { isRecord } from '../utils/guards.ts'
import { RemoteCommandPolicyError } from './remote-command-policy.ts'
import type { RemoteEnabledConfig } from './remote-config.ts'
import {
  hashRemoteDeviceCredential,
  type RemoteDeviceStore
} from './remote-device-store.ts'

export type RemoteGateway = {
  readonly port: number
  readonly bindHost: string
  publish(event: KernelEvent): void
  getStatus(): RemoteAccessStatus
  createPairingCode(): RemotePairingCode
  revokeDevice(): Promise<RemoteAccessStatus>
  stop(): Promise<void>
}

export type RemoteGatewayHandlers = {
  assertCommandPolicy(command: RemoteKernelCommand): Promise<void>
  dispatchCommand(command: RemoteKernelCommand): Promise<unknown>
}

export type RemoteGatewayOptions = {
  config: RemoteEnabledConfig
  staticRoot: string
  deviceStore: RemoteDeviceStore
  handlers: RemoteGatewayHandlers
  now?: () => number
  randomDeviceCredential?: () => string
  randomPairingCode?: () => string
}

const PAIR_BODY_LIMIT_BYTES = 4 * 1024
const COMMAND_BODY_LIMIT_BYTES = 1 * 1024 * 1024
const PAIR_RATE_LIMIT_WINDOW_MS = 60_000
const PAIR_RATE_LIMIT_MAX = 5
export const REMOTE_DEVICE_ABSOLUTE_TTL_MS = 30 * 24 * 60 * 60 * 1000
export const REMOTE_PAIRING_CODE_TTL_MS = 5 * 60 * 1000
export const REMOTE_PAIRING_MAX_FAILED_ATTEMPTS = 5
/** @deprecated Use REMOTE_DEVICE_ABSOLUTE_TTL_MS */
export const REMOTE_SESSION_ABSOLUTE_TTL_MS = REMOTE_DEVICE_ABSOLUTE_TTL_MS
const SSE_HEARTBEAT_MS = 15_000
const SSE_MAX_BUFFERED_BYTES = 1 * 1024 * 1024
const SSE_MAX_CLIENTS = 4
const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'Pragma': 'no-cache',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), geolocation=(), microphone=(), payment=(), usb=()',
  'Content-Security-Policy': [
    "default-src 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "form-action 'self'"
  ].join('; ')
} as const

type ActivePairingCode = {
  digest: Buffer
  expiresAt: number
  failedAttempts: number
}

type SseClient = {
  res: ServerResponse
  closed: boolean
}

export async function startRemoteGateway(options: RemoteGatewayOptions): Promise<RemoteGateway> {
  const config = options.config
  const deviceStore = options.deviceStore
  const now = options.now ?? Date.now
  const randomDeviceCredential = options.randomDeviceCredential ??
    (() => randomBytes(32).toString('base64url'))
  const randomPairingCode = options.randomPairingCode ??
    (() => String(randomInt(0, 10 ** REMOTE_PAIRING_CODE_LENGTH)).padStart(REMOTE_PAIRING_CODE_LENGTH, '0'))
  const staticRoot = resolve(options.staticRoot)
  const staticRootRealPath = await assertStaticRoot(staticRoot)
  let pairingCode: ActivePairingCode | null = null
  const pairAttempts = new Map<string, number[]>()
  const sseClients = new Set<SseClient>()
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null
  let closed = false
  let authMutationChain: Promise<void> = Promise.resolve()

  const runAuthMutation = async <T>(operation: () => Promise<T>): Promise<T> => {
    const run = authMutationChain.then(operation, operation)
    authMutationChain = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  const closeSseClients = (): void => {
    for (const client of sseClients) {
      client.closed = true
      client.res.end()
    }
    sseClients.clear()
  }

  const currentPairedDevice = (): RemotePairedDevice | null => {
    const device = deviceStore.getDevice()
    if (device === null) return null
    if (now() >= device.expiresAt) return null
    return {
      pairedAt: device.pairedAt,
      expiresAt: device.expiresAt
    }
  }

  const getStatus = (): RemoteAccessStatus => ({
    enabled: true,
    publicOrigin: config.publicOrigin,
    device: currentPairedDevice()
  })

  const createPairingCode = (): RemotePairingCode => {
    const code = randomPairingCode()
    if (!isPairingCodeShape(code)) {
      throw new Error('Pairing code generator must produce exactly 6 digits.')
    }
    const expiresAt = now() + REMOTE_PAIRING_CODE_TTL_MS
    pairingCode = {
      digest: digestPairingCode(config.token, code),
      expiresAt,
      failedAttempts: 0
    }
    return { code, expiresAt }
  }

  const revokeDevice = async (): Promise<RemoteAccessStatus> => runAuthMutation(async () => {
    pairingCode = null
    try {
      await deviceStore.clearDevice()
    } finally {
      closeSseClients()
    }
    return getStatus()
  })

  const server = createServer((req, res) => {
    void handleRequest(req, res).catch((error: unknown) => {
      if (res.headersSent) {
        res.destroy()
        return
      }
      writeText(res, 500, 'Internal Server Error')
      console.error('[Remote] request failed.', error)
    })
  })

  const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    applySecurityHeaders(res)

    const peer = normalizePeerAddress(req.socket.remoteAddress)
    if (peer === null || peer !== config.trustedProxyIp) {
      writeText(res, 403, 'Forbidden')
      return
    }

    const forwardedProto = headerValue(req, 'x-forwarded-proto')
    const forwardedHost = headerValue(req, 'x-forwarded-host')
    if (forwardedProto !== 'https' || forwardedHost !== config.publicHost) {
      writeText(res, 400, 'Bad Request')
      return
    }

    const method = req.method ?? ''
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const pathname = url.pathname

    if (method === 'GET' && pathname === REMOTE_API_PATHS.session) {
      handleSession(req, res)
      return
    }
    if (method === 'POST' && pathname === REMOTE_API_PATHS.pair) {
      await handlePair(req, res, peer)
      return
    }
    if (method === 'POST' && pathname === REMOTE_API_PATHS.logout) {
      await handleLogout(req, res)
      return
    }
    if (method === 'GET' && pathname === REMOTE_API_PATHS.state) {
      await handleState(req, res)
      return
    }
    if (method === 'POST' && pathname === REMOTE_API_PATHS.command) {
      await handleCommand(req, res)
      return
    }
    if (method === 'GET' && pathname === REMOTE_API_PATHS.events) {
      handleEvents(req, res)
      return
    }
    if (pathname.startsWith('/api/')) {
      writeText(res, 404, 'Not Found')
      return
    }
    if (method === 'GET') {
      await handleStatic(req, res, pathname)
      return
    }

    writeText(res, 405, 'Method Not Allowed')
  }

  const requireExactOrigin = (req: IncomingMessage, res: ServerResponse): boolean => {
    const origin = headerValue(req, 'origin')
    if (origin !== config.publicOrigin) {
      writeText(res, 403, 'Forbidden')
      return false
    }
    return true
  }

  const readSessionCookie = (req: IncomingMessage): string | null => {
    const raw = headerValue(req, 'cookie')
    if (raw === null) return null
    for (const part of raw.split(';')) {
      const trimmed = part.trim()
      const eq = trimmed.indexOf('=')
      if (eq <= 0) continue
      const name = trimmed.slice(0, eq)
      if (name !== REMOTE_SESSION_COOKIE_NAME) continue
      return trimmed.slice(eq + 1)
    }
    return null
  }

  const isAuthenticatedCredential = (credential: string | null): boolean => {
    const device = deviceStore.getDevice()
    if (device === null || now() >= device.expiresAt) return false
    if (credential === null || credential.length === 0) return false
    const credentialHash = hashRemoteDeviceCredential(credential)
    return timingSafeEqualHex(credentialHash, device.credentialHash)
  }

  const isAuthenticated = (req: IncomingMessage): boolean =>
    isAuthenticatedCredential(readSessionCookie(req))

  const handleSession = (req: IncomingMessage, res: ServerResponse): void => {
    const status: RemoteSessionStatus = {
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      authenticated: isAuthenticated(req)
    }
    writeJson(res, 200, status)
  }

  const handlePair = async (
    req: IncomingMessage,
    res: ServerResponse,
    peer: string
  ): Promise<void> => {
    if (!requireExactOrigin(req, res)) return
    if (!isJsonRequest(req)) {
      writeText(res, 415, 'Unsupported Media Type')
      return
    }
    if (!checkPairRateLimit(peer, now, pairAttempts)) {
      writeText(res, 429, 'Too Many Requests')
      return
    }
    let body: unknown
    try {
      body = await readJsonBody(req, PAIR_BODY_LIMIT_BYTES)
    } catch (error) {
      if (error instanceof BodyLimitError) {
        writeText(res, 413, 'Payload Too Large')
        return
      }
      writeText(res, 400, 'Bad Request')
      return
    }
    if (!isPairRequest(body)) {
      writeText(res, 401, 'Unauthorized')
      return
    }

    const paired = await runAuthMutation(async (): Promise<{
      credential: string
      expiresAt: number
    } | null> => {
      const active = pairingCode
      if (
        active === null ||
        now() >= active.expiresAt ||
        active.failedAttempts >= REMOTE_PAIRING_MAX_FAILED_ATTEMPTS
      ) {
        pairingCode = null
        return null
      }

      if (!pairingCodeMatches(config.token, body.code, active.digest)) {
        active.failedAttempts += 1
        if (active.failedAttempts >= REMOTE_PAIRING_MAX_FAILED_ATTEMPTS) {
          pairingCode = null
        }
        return null
      }

      pairingCode = null
      const credential = randomDeviceCredential()
      if (!/^[A-Za-z0-9_-]{32,256}$/u.test(credential)) {
        throw new Error('Device credential generator must produce 32 to 256 base64url characters.')
      }
      const pairedAt = now()
      const expiresAt = pairedAt + REMOTE_DEVICE_ABSOLUTE_TTL_MS
      await deviceStore.replaceDevice({
        credentialHash: hashRemoteDeviceCredential(credential),
        pairedAt,
        expiresAt
      })
      closeSseClients()
      return { credential, expiresAt }
    })

    if (paired === null) {
      writeText(res, 401, 'Unauthorized')
      return
    }

    const status: RemoteSessionStatus = {
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      authenticated: true
    }
    res.setHeader('Set-Cookie', serializeSessionCookie(paired.credential, paired.expiresAt, now()))
    writeJson(res, 200, status)
  }

  const handleLogout = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!requireExactOrigin(req, res)) return
    const credential = readSessionCookie(req)
    const revoked = await runAuthMutation(async (): Promise<boolean> => {
      if (!isAuthenticatedCredential(credential)) return false
      try {
        await deviceStore.clearDevice()
      } finally {
        closeSseClients()
      }
      return true
    })
    if (!revoked) {
      writeText(res, 401, 'Unauthorized')
      return
    }
    res.setHeader('Set-Cookie', clearSessionCookie())
    const status: RemoteSessionStatus = {
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      authenticated: false
    }
    writeJson(res, 200, status)
  }

  const handleState = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!isAuthenticated(req)) {
      writeText(res, 401, 'Unauthorized')
      return
    }
    const command = { type: 'kernel.get-state' } as const
    await options.handlers.assertCommandPolicy(command)
    if (!isAuthenticated(req)) {
      writeText(res, 401, 'Unauthorized')
      return
    }
    const value = await options.handlers.dispatchCommand(command)
    if (!isAuthenticated(req)) {
      writeText(res, 401, 'Unauthorized')
      return
    }
    writeJson(res, 200, value)
  }

  const handleCommand = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!requireExactOrigin(req, res)) return
    if (!isJsonRequest(req)) {
      writeText(res, 415, 'Unsupported Media Type')
      return
    }
    if (!isAuthenticated(req)) {
      writeCommandError(res, null, 'unauthorized', 'Authentication required.', 401)
      return
    }

    let body: unknown
    try {
      body = await readJsonBody(req, COMMAND_BODY_LIMIT_BYTES)
    } catch (error) {
      if (error instanceof BodyLimitError) {
        writeText(res, 413, 'Payload Too Large')
        return
      }
      writeCommandError(res, null, 'bad-request', 'Invalid JSON body.', 400)
      return
    }

    if (!isCommandRequest(body)) {
      writeCommandError(res, null, 'bad-request', 'Invalid command request.', 400)
      return
    }

    const requestId = body.requestId
    if (!isKernelCommand(body.command)) {
      writeCommandError(res, requestId, 'bad-request', 'Unsupported kernel command.', 400)
      return
    }
    if (!isRemoteKernelCommand(body.command)) {
      writeCommandError(res, requestId, 'forbidden', 'Command is not allowed over remote.', 403)
      return
    }

    try {
      await options.handlers.assertCommandPolicy(body.command)
      if (!isAuthenticated(req)) {
        writeCommandError(res, requestId, 'unauthorized', 'Authentication required.', 401)
        return
      }
      const value = await options.handlers.dispatchCommand(body.command)
      if (!isAuthenticated(req)) {
        writeCommandError(res, requestId, 'unauthorized', 'Authentication required.', 401)
        return
      }
      const response: RemoteCommandResponse = {
        protocolVersion: REMOTE_PROTOCOL_VERSION,
        requestId,
        ok: true,
        value
      }
      res.statusCode = 200
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.end(JSON.stringify(response))
    } catch (error) {
      if (!isAuthenticated(req)) {
        writeCommandError(res, requestId, 'unauthorized', 'Authentication required.', 401)
        return
      }
      if (error instanceof RemoteCommandPolicyError) {
        writeCommandError(res, requestId, 'forbidden', error.message, 403)
        return
      }
      const internalMessage = error instanceof Error ? error.message : String(error)
      console.error(`[Remote] ${body.command.type} failed.`, error)
      if (/unavailable/i.test(internalMessage)) {
        writeCommandError(
          res,
          requestId,
          'unavailable',
          'Remote control is unavailable until the desktop Kernel is ready.',
          503
        )
        return
      }
      writeCommandError(
        res,
        requestId,
        'bad-request',
        'Remote command was rejected by the active desktop state.',
        400
      )
    }
  }

  const handleEvents = (req: IncomingMessage, res: ServerResponse): void => {
    if (!isAuthenticated(req)) {
      writeText(res, 401, 'Unauthorized')
      return
    }
    if (sseClients.size >= SSE_MAX_CLIENTS) {
      writeText(res, 429, 'Too Many Requests')
      return
    }
    res.statusCode = 200
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
    res.setHeader('Cache-Control', 'no-cache, no-transform')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    res.write(': connected\n\n')

    const client: SseClient = { res, closed: false }
    sseClients.add(client)
    const close = (): void => {
      if (client.closed) return
      client.closed = true
      sseClients.delete(client)
    }
    req.on('close', close)
    res.on('close', close)
  }

  const handleStatic = async (
    _req: IncomingMessage,
    res: ServerResponse,
    pathname: string
  ): Promise<void> => {
    const decoded = decodePathname(pathname)
    if (decoded === null) {
      writeText(res, 400, 'Bad Request')
      return
    }
    const relativePath = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/u, '')
    const absolute = resolve(staticRoot, relativePath)
    const rel = relative(staticRoot, absolute)
    if (
      rel === '..' ||
      rel.startsWith(`..${sep}`) ||
      absolute === staticRoot ||
      resolve(staticRoot, rel) !== absolute
    ) {
      writeText(res, 403, 'Forbidden')
      return
    }
    let realAbsolute: string
    try {
      const stats = await lstat(absolute)
      if (stats.isSymbolicLink() || !stats.isFile()) {
        writeText(res, 404, 'Not Found')
        return
      }
      realAbsolute = await realpath(absolute)
    } catch {
      writeText(res, 404, 'Not Found')
      return
    }
    const realRel = relative(staticRootRealPath, realAbsolute)
    if (realRel === '..' || realRel.startsWith(`..${sep}`)) {
      writeText(res, 403, 'Forbidden')
      return
    }
    res.statusCode = 200
    res.setHeader('Content-Type', contentTypeFor(realAbsolute))
    const stream = createReadStream(realAbsolute)
    stream.on('error', () => {
      if (res.headersSent) res.destroy()
      else writeText(res, 500, 'Internal Server Error')
    })
    stream.pipe(res)
  }

  const publish = (event: KernelEvent): void => {
    if (closed || sseClients.size === 0) return
    if (currentPairedDevice() === null) {
      closeSseClients()
      return
    }
    const envelope: RemoteEventEnvelope = {
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      event
    }
    const payload = `data: ${JSON.stringify(envelope)}\n\n`
    for (const client of [...sseClients]) {
      if (client.closed) continue
      if (client.res.writableEnded || client.res.destroyed) {
        client.closed = true
        sseClients.delete(client)
        continue
      }
      if (client.res.writableLength > SSE_MAX_BUFFERED_BYTES) {
        client.closed = true
        sseClients.delete(client)
        client.res.destroy(new Error('Remote SSE client too slow.'))
        continue
      }
      const ok = client.res.write(payload)
      if (!ok && client.res.writableLength > SSE_MAX_BUFFERED_BYTES) {
        client.closed = true
        sseClients.delete(client)
        client.res.destroy(new Error('Remote SSE client too slow.'))
      }
    }
  }

  heartbeatTimer = setInterval(() => {
    if (currentPairedDevice() === null && sseClients.size > 0) {
      closeSseClients()
      return
    }
    for (const client of [...sseClients]) {
      if (client.closed || client.res.writableEnded || client.res.destroyed) {
        client.closed = true
        sseClients.delete(client)
        continue
      }
      if (client.res.writableLength > SSE_MAX_BUFFERED_BYTES) {
        client.closed = true
        sseClients.delete(client)
        client.res.destroy(new Error('Remote SSE client too slow.'))
        continue
      }
      client.res.write(': heartbeat\n\n')
    }
  }, SSE_HEARTBEAT_MS)
  heartbeatTimer.unref?.()

  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (error: Error): void => {
      server.off('error', onError)
      rejectListen(error)
    }
    server.once('error', onError)
    server.listen(config.port, config.bindHost, () => {
      server.off('error', onError)
      resolveListen()
    })
  })

  return {
    bindHost: config.bindHost,
    port: config.port,
    publish,
    getStatus,
    createPairingCode,
    revokeDevice,
    async stop() {
      if (closed) return
      closed = true
      if (heartbeatTimer !== null) {
        clearInterval(heartbeatTimer)
        heartbeatTimer = null
      }
      closeSseClients()
      pairingCode = null
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => {
          if (error) rejectClose(error)
          else resolveClose()
        })
      })
    }
  }
}

class BodyLimitError extends Error {
  constructor() {
    super('Request body too large.')
    this.name = 'BodyLimitError'
  }
}

function applySecurityHeaders(res: ServerResponse): void {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    res.setHeader(name, value)
  }
}

function writeText(res: ServerResponse, statusCode: number, body: string): void {
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'text/plain; charset=utf-8')
  res.end(body)
}

function writeJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

function writeCommandError(
  res: ServerResponse,
  requestId: string | null,
  code: RemoteCommandErrorCode,
  message: string,
  statusCode: number
): void {
  const response: RemoteCommandResponse = {
    protocolVersion: REMOTE_PROTOCOL_VERSION,
    requestId: requestId ?? '',
    ok: false,
    error: { code, message }
  }
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(response))
}

function headerValue(req: IncomingMessage, name: string): string | null {
  const value = req.headers[name]
  if (typeof value === 'string') return value
  if (Array.isArray(value) && value.length === 1 && typeof value[0] === 'string') return value[0]
  return null
}

function isJsonRequest(req: IncomingMessage): boolean {
  const contentType = headerValue(req, 'content-type')
  return contentType !== null &&
    contentType.split(';', 1)[0]?.trim().toLowerCase() === 'application/json'
}

export function normalizePeerAddress(address: string | undefined): string | null {
  if (address === undefined || address.length === 0) return null
  if (address.startsWith('::ffff:')) {
    return address.slice('::ffff:'.length)
  }
  if (address === '::1') return '127.0.0.1'
  return address
}

function checkPairRateLimit(
  peer: string,
  now: () => number,
  attempts: Map<string, number[]>
): boolean {
  const ts = now()
  const windowStart = ts - PAIR_RATE_LIMIT_WINDOW_MS
  const recent = (attempts.get(peer) ?? []).filter((value) => value >= windowStart)
  if (recent.length >= PAIR_RATE_LIMIT_MAX) {
    attempts.set(peer, recent)
    return false
  }
  recent.push(ts)
  attempts.set(peer, recent)
  return true
}

async function readJsonBody(req: IncomingMessage, limit: number): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buffer.length
    if (total > limit) {
      req.resume()
      throw new BodyLimitError()
    }
    chunks.push(buffer)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  return JSON.parse(raw) as unknown
}

function isPairRequest(value: unknown): value is RemotePairRequest {
  return isRecord(value) &&
    Object.keys(value).length === 1 &&
    typeof value.code === 'string' &&
    isPairingCodeShape(value.code)
}

function isPairingCodeShape(code: string): boolean {
  return new RegExp(`^[0-9]{${REMOTE_PAIRING_CODE_LENGTH}}$`, 'u').test(code)
}

function isCommandRequest(value: unknown): value is RemoteCommandRequest {
  return isRecord(value) &&
    value.protocolVersion === REMOTE_PROTOCOL_VERSION &&
    typeof value.requestId === 'string' &&
    value.requestId.length > 0 &&
    value.requestId.length <= 128 &&
    !value.requestId.includes('\0') &&
    isRecord(value.command) &&
    typeof value.command.type === 'string' &&
    Object.keys(value).length === 3
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

function timingSafeEqualHex(left: string, right: string): boolean {
  if (!/^[0-9a-f]+$/u.test(left) || !/^[0-9a-f]+$/u.test(right)) return false
  if (left.length !== right.length || left.length === 0 || left.length % 2 !== 0) return false
  const leftBuffer = Buffer.from(left, 'hex')
  const rightBuffer = Buffer.from(right, 'hex')
  if (leftBuffer.length !== rightBuffer.length) return false
  return timingSafeEqual(leftBuffer, rightBuffer)
}

function serializeSessionCookie(credential: string, expiresAt: number, nowMs: number): string {
  const maxAgeSeconds = Math.max(0, Math.floor((expiresAt - nowMs) / 1000))
  const expires = new Date(expiresAt).toUTCString()
  return `${REMOTE_SESSION_COOKIE_NAME}=${credential}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}; Expires=${expires}`
}

function clearSessionCookie(): string {
  return `${REMOTE_SESSION_COOKIE_NAME}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`
}

function decodePathname(pathname: string): string | null {
  try {
    return decodeURIComponent(pathname)
  } catch {
    return null
  }
}

async function assertStaticRoot(staticRoot: string): Promise<string> {
  let rootStats
  let indexStats
  let rootRealPath
  try {
    rootStats = await lstat(staticRoot)
    indexStats = await lstat(resolve(staticRoot, 'index.html'))
    rootRealPath = await realpath(staticRoot)
  } catch (error) {
    throw new Error(
      `Remote static output is unavailable at ${staticRoot}: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new Error(`Remote static output must be a regular directory: ${staticRoot}`)
  }
  if (indexStats.isSymbolicLink() || !indexStats.isFile()) {
    throw new Error(`Remote static output must contain a regular index.html: ${staticRoot}`)
  }
  return rootRealPath
}

function contentTypeFor(filePath: string): string {
  switch (extname(filePath).toLowerCase()) {
    case '.html':
      return 'text/html; charset=utf-8'
    case '.js':
      return 'text/javascript; charset=utf-8'
    case '.css':
      return 'text/css; charset=utf-8'
    case '.json':
      return 'application/json; charset=utf-8'
    case '.svg':
      return 'image/svg+xml'
    case '.png':
      return 'image/png'
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.webp':
      return 'image/webp'
    case '.woff2':
      return 'font/woff2'
    case '.woff':
      return 'font/woff'
    case '.ttf':
      return 'font/ttf'
    default:
      return 'application/octet-stream'
  }
}
