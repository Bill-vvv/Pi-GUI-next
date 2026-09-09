import { randomBytes, randomInt } from 'node:crypto'
import {
  createServer,
  type IncomingMessage,
  type ServerResponse
} from 'node:http'

import type {
  DesktopHostAccessStatus,
  RemotePairedDevice,
  RemotePairingCode
} from '../../shared/remote-admin-contract.ts'
import {
  DESKTOP_HOST_API_PATHS,
  DESKTOP_HOST_CONTROLLER_HEADER,
  DESKTOP_HOST_CONTROLLER_ID_PATTERN,
  DESKTOP_HOST_KERNEL_COMMAND_TYPES,
  DESKTOP_HOST_PROTOCOL_VERSION,
  isDesktopHostKernelCommand,
  type DesktopHostCommandErrorCode,
  type DesktopHostCommandRequest,
  type DesktopHostControlIdentity,
  type DesktopHostCommandResponse,
  type DesktopHostEventEnvelope,
  type DesktopHostKernelCommand,
  type DesktopHostPairRequest,
  type DesktopHostPairResponse,
  type DesktopHostSessionStatus
} from '../../shared/desktop-host-contract.ts'
import type { KernelEvent } from '../../shared/kernel-contract.ts'
import { REMOTE_PAIRING_CODE_LENGTH } from '../../shared/remote-contract.ts'
import { isKernelCommand } from '../kernel/kernel-command-validation.ts'
import { isRecord } from '../utils/guards.ts'
import { RemoteCommandPolicyError } from './remote-command-policy.ts'
import type { DesktopHostEnabledConfig } from './desktop-host-config.ts'
import {
  hashRemoteDeviceCredential,
  type RemoteDeviceStore
} from './remote-device-store.ts'
import {
  pairingCodeMatches,
  REMOTE_DEVICE_ABSOLUTE_TTL_MS,
  REMOTE_PAIRING_CODE_TTL_MS,
  REMOTE_PAIRING_MAX_FAILED_ATTEMPTS,
  digestPairingCode,
  normalizePeerAddress,
  timingSafeEqualString
} from './remote-gateway.ts'

export type DesktopHostGateway = {
  readonly bindHost: string
  readonly port: number
  publish(event: KernelEvent): void
  getStatus(): DesktopHostAccessStatus
  createPairingCode(): RemotePairingCode
  revokeDevice(): Promise<DesktopHostAccessStatus>
  stop(): Promise<void>
}

export type DesktopHostGatewayHandlers = {
  getControlIdentity(): DesktopHostControlIdentity
  assertCommandPolicy(command: DesktopHostKernelCommand): Promise<void>
  dispatchCommand(
    command: DesktopHostKernelCommand,
    assertCurrentBoundary?: () => Promise<void>
  ): Promise<unknown>
}

export type DesktopHostGatewayOptions = {
  config: DesktopHostEnabledConfig
  productVersion: string
  buildCommit: string | null
  deviceStore: RemoteDeviceStore
  handlers: DesktopHostGatewayHandlers
  now?: () => number
  randomDeviceCredential?: () => string
  randomPairingCode?: () => string
}

const PAIR_BODY_LIMIT_BYTES = 4 * 1024
const COMMAND_BODY_LIMIT_BYTES = 1 * 1024 * 1024
const PAIR_RATE_LIMIT_WINDOW_MS = 60_000
const PAIR_RATE_LIMIT_MAX = 5
const SSE_HEARTBEAT_MS = 15_000
const SSE_MAX_BUFFERED_BYTES = 1 * 1024 * 1024
const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'Pragma': 'no-cache',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer'
} as const

type ActivePairingCode = {
  digest: Buffer
  expiresAt: number
  failedAttempts: number
}

type ActiveSseClient = {
  controllerId: string
  res: ServerResponse
  closed: boolean
}

export async function startDesktopHostGateway(
  options: DesktopHostGatewayOptions
): Promise<DesktopHostGateway> {
  if (
    typeof options.productVersion !== 'string' ||
    options.productVersion.length === 0 ||
    options.productVersion.length > 128
  ) {
    throw new Error('Desktop Host product version must contain 1 to 128 characters.')
  }
  if (
    options.buildCommit !== null &&
    (
      typeof options.buildCommit !== 'string' ||
      options.buildCommit.length === 0 ||
      options.buildCommit.length > 128 ||
      /[\r\n\0]/u.test(options.buildCommit)
    )
  ) {
    throw new Error('Desktop Host build commit must be null or 1 to 128 safe characters.')
  }

  const { config, deviceStore } = options
  const now = options.now ?? Date.now
  const randomDeviceCredential = options.randomDeviceCredential ??
    (() => randomBytes(32).toString('base64url'))
  const randomPairingCode = options.randomPairingCode ??
    (() => String(randomInt(0, 10 ** REMOTE_PAIRING_CODE_LENGTH)).padStart(
      REMOTE_PAIRING_CODE_LENGTH,
      '0'
    ))
  let pairingCode: ActivePairingCode | null = null
  let pairAttempts: number[] = []
  let activeSseClient: ActiveSseClient | null = null
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null
  let authMutationChain: Promise<void> = Promise.resolve()
  let closed = false

  const runAuthMutation = async <T>(operation: () => Promise<T>): Promise<T> => {
    const run = authMutationChain.then(operation, operation)
    authMutationChain = run.then(() => undefined, () => undefined)
    return run
  }

  const currentPairedDevice = (): RemotePairedDevice | null => {
    const device = deviceStore.getDevice()
    if (device === null || now() >= device.expiresAt) return null
    return { pairedAt: device.pairedAt, expiresAt: device.expiresAt }
  }

  const getStatus = (): DesktopHostAccessStatus => ({
    enabled: true,
    endpoint: `http://${config.bindHost}:${config.port}`,
    device: currentPairedDevice()
  })

  const closeActiveController = (): void => {
    const client = activeSseClient
    activeSseClient = null
    if (client === null || client.closed) return
    client.closed = true
    client.res.end()
  }

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

  const revokeDevice = async (): Promise<DesktopHostAccessStatus> => runAuthMutation(async () => {
    pairingCode = null
    try {
      await deviceStore.clearDevice()
    } finally {
      closeActiveController()
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
      console.error('[Desktop Host] request failed.', error)
    })
  })

  const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    applySecurityHeaders(res)
    const peer = normalizePeerAddress(req.socket.remoteAddress)
    if (peer !== config.bindHost) {
      writeText(res, 403, 'Forbidden')
      return
    }

    const method = req.method ?? ''
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
    if (method === 'GET' && pathname === DESKTOP_HOST_API_PATHS.session) {
      handleSession(req, res)
      return
    }
    if (method === 'POST' && pathname === DESKTOP_HOST_API_PATHS.pair) {
      await handlePair(req, res)
      return
    }
    if (method === 'POST' && pathname === DESKTOP_HOST_API_PATHS.logout) {
      await handleLogout(req, res)
      return
    }
    if (method === 'GET' && pathname === DESKTOP_HOST_API_PATHS.state) {
      await handleState(req, res)
      return
    }
    if (method === 'POST' && pathname === DESKTOP_HOST_API_PATHS.command) {
      await handleCommand(req, res)
      return
    }
    if (method === 'GET' && pathname === DESKTOP_HOST_API_PATHS.events) {
      handleEvents(req, res)
      return
    }
    if (pathname.startsWith('/api/')) {
      writeText(res, 404, 'Not Found')
      return
    }
    writeText(res, 404, 'Not Found')
  }

  const isAuthenticatedCredential = (credential: string | null): boolean => {
    const device = deviceStore.getDevice()
    if (device === null || now() >= device.expiresAt) return false
    if (credential === null || credential.length === 0) return false
    return timingSafeEqualString(
      hashRemoteDeviceCredential(credential),
      device.credentialHash
    )
  }

  const readBearerCredential = (req: IncomingMessage): string | null => {
    const authorization = headerValue(req, 'authorization')
    if (authorization === null) return null
    const match = /^Bearer ([A-Za-z0-9_-]{32,256})$/u.exec(authorization)
    return match?.[1] ?? null
  }

  const isAuthenticated = (req: IncomingMessage): boolean =>
    isAuthenticatedCredential(readBearerCredential(req))

  const readControllerId = (req: IncomingMessage): string | null => {
    const value = headerValue(req, DESKTOP_HOST_CONTROLLER_HEADER)
    return value !== null && DESKTOP_HOST_CONTROLLER_ID_PATTERN.test(value) ? value : null
  }

  const controllerBoundaryError = (
    req: IncomingMessage
  ): DesktopHostCommandBoundaryError | null => {
    const controllerId = readControllerId(req)
    if (controllerId === null) {
      return new DesktopHostCommandBoundaryError(
        'bad-request',
        'A valid desktop controller identity is required.',
        400
      )
    }
    if (activeSseClient === null || activeSseClient.controllerId !== controllerId) {
      return new DesktopHostCommandBoundaryError(
        'conflict',
        'Controller event stream is not active.',
        409
      )
    }
    return null
  }

  const requireActiveController = (
    req: IncomingMessage,
    res: ServerResponse
  ): string | null => {
    const error = controllerBoundaryError(req)
    if (error !== null) {
      writeText(res, error.status, error.message)
      return null
    }
    return readControllerId(req)
  }

  const sessionStatus = (authenticated: boolean): DesktopHostSessionStatus => ({
    protocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
    productVersion: options.productVersion,
    buildCommit: options.buildCommit,
    authenticated,
    capabilities: {
      kernelCommandTypes: DESKTOP_HOST_KERNEL_COMMAND_TYPES
    }
  })

  const handleSession = (req: IncomingMessage, res: ServerResponse): void => {
    writeJson(res, 200, sessionStatus(isAuthenticated(req)))
  }

  const handlePair = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!isJsonRequest(req)) {
      writeText(res, 415, 'Unsupported Media Type')
      return
    }
    pairAttempts = pairAttempts.filter((attemptAt) => now() - attemptAt < PAIR_RATE_LIMIT_WINDOW_MS)
    if (pairAttempts.length >= PAIR_RATE_LIMIT_MAX) {
      writeText(res, 429, 'Too Many Requests')
      return
    }
    pairAttempts.push(now())
    let body: unknown
    try {
      body = await readJsonBody(req, PAIR_BODY_LIMIT_BYTES)
    } catch (error) {
      writeText(res, error instanceof BodyLimitError ? 413 : 400, error instanceof BodyLimitError
        ? 'Payload Too Large'
        : 'Bad Request')
      return
    }
    if (!isPairRequest(body)) {
      writeText(res, 401, 'Unauthorized')
      return
    }
    if (
      body.productVersion !== options.productVersion ||
      body.buildCommit !== options.buildCommit
    ) {
      writeText(res, 409, 'Desktop Host build is incompatible.')
      return
    }

    const paired = await runAuthMutation(async (): Promise<DesktopHostPairResponse | null> => {
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
        if (active.failedAttempts >= REMOTE_PAIRING_MAX_FAILED_ATTEMPTS) pairingCode = null
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
      closeActiveController()
      return {
        protocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
        productVersion: options.productVersion,
        buildCommit: options.buildCommit,
        credential,
        expiresAt,
        capabilities: {
          kernelCommandTypes: DESKTOP_HOST_KERNEL_COMMAND_TYPES
        }
      }
    })

    if (paired === null) {
      writeText(res, 401, 'Unauthorized')
      return
    }
    writeJson(res, 200, paired)
  }

  const handleLogout = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const credential = readBearerCredential(req)
    const revoked = await runAuthMutation(async (): Promise<boolean> => {
      if (!isAuthenticatedCredential(credential)) return false
      try {
        await deviceStore.clearDevice()
      } finally {
        closeActiveController()
      }
      return true
    })
    if (!revoked) {
      writeText(res, 401, 'Unauthorized')
      return
    }
    writeJson(res, 200, sessionStatus(false))
  }

  const handleState = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!isAuthenticated(req)) {
      writeText(res, 401, 'Unauthorized')
      return
    }
    if (requireActiveController(req, res) === null) return
    const command = { type: 'kernel.get-state' } as const
    await options.handlers.assertCommandPolicy(command)
    if (!isAuthenticated(req)) {
      writeText(res, 401, 'Unauthorized')
      return
    }
    if (requireActiveController(req, res) === null) return
    const value = await options.handlers.dispatchCommand(command)
    if (!isAuthenticated(req)) {
      writeText(res, 401, 'Unauthorized')
      return
    }
    if (requireActiveController(req, res) === null) return
    writeJson(res, 200, value)
  }

  const handleCommand = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!isJsonRequest(req)) {
      writeCommandError(
        res,
        null,
        'bad-request',
        'Content-Type application/json is required.',
        415
      )
      return
    }
    if (!isAuthenticated(req)) {
      writeCommandError(res, null, 'unauthorized', 'Authentication required.', 401)
      return
    }
    const initialBoundaryError = controllerBoundaryError(req)
    if (initialBoundaryError !== null) {
      writeCommandBoundaryError(res, null, initialBoundaryError)
      return
    }

    let body: unknown
    try {
      body = await readJsonBody(req, COMMAND_BODY_LIMIT_BYTES)
    } catch (error) {
      if (error instanceof BodyLimitError) {
        writeCommandError(res, null, 'bad-request', 'Command payload is too large.', 413)
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
    if (!isDesktopHostKernelCommand(body.command)) {
      writeCommandError(res, requestId, 'forbidden', 'Command is not allowed over Desktop Host.', 403)
      return
    }

    const assertCurrentController = async (): Promise<void> => {
      if (!isAuthenticated(req)) {
        throw new DesktopHostCommandBoundaryError(
          'unauthorized',
          'Authentication required.',
          401
        )
      }
      const controllerError = controllerBoundaryError(req)
      if (controllerError !== null) throw controllerError
    }
    const assertCurrentBoundary = async (): Promise<void> => {
      await assertCurrentController()
      if (!sameControlIdentity(options.handlers.getControlIdentity(), body.expectedIdentity)) {
        throw new DesktopHostCommandBoundaryError(
          'conflict',
          'Desktop Host state changed; resync before sending another command.',
          409
        )
      }
    }

    try {
      await assertCurrentBoundary()
      await options.handlers.assertCommandPolicy(body.command)
      await assertCurrentBoundary()
      const value = await options.handlers.dispatchCommand(body.command, assertCurrentBoundary)
      await assertCurrentController()
      const response: DesktopHostCommandResponse = {
        protocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
        requestId,
        ok: true,
        value
      }
      writeJson(res, 200, response)
    } catch (error) {
      if (error instanceof DesktopHostCommandBoundaryError) {
        writeCommandBoundaryError(res, requestId, error)
        return
      }
      if (!isAuthenticated(req)) {
        writeCommandError(res, requestId, 'unauthorized', 'Authentication required.', 401)
        return
      }
      if (error instanceof RemoteCommandPolicyError) {
        writeCommandError(res, requestId, 'forbidden', error.message, 403)
        return
      }
      const internalMessage = error instanceof Error ? error.message : String(error)
      console.error(`[Desktop Host] ${body.command.type} failed.`, error)
      if (/unavailable/iu.test(internalMessage)) {
        writeCommandError(
          res,
          requestId,
          'unavailable',
          'Desktop Host control is unavailable until the Linux Kernel is ready.',
          503
        )
        return
      }
      writeCommandError(
        res,
        requestId,
        'bad-request',
        'Desktop Host command was rejected by the active Linux state.',
        400
      )
    }
  }

  const handleEvents = (req: IncomingMessage, res: ServerResponse): void => {
    if (!isAuthenticated(req)) {
      writeText(res, 401, 'Unauthorized')
      return
    }
    const controllerId = readControllerId(req)
    if (controllerId === null) {
      writeText(res, 400, 'Bad Request')
      return
    }
    if (
      activeSseClient !== null &&
      activeSseClient.controllerId !== controllerId
    ) {
      writeText(res, 409, 'Another desktop controller is active.')
      return
    }
    if (activeSseClient !== null) closeActiveController()

    res.statusCode = 200
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
    res.setHeader('Cache-Control', 'no-cache, no-transform')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    res.write(': connected\n\n')

    const client: ActiveSseClient = { controllerId, res, closed: false }
    activeSseClient = client
    const close = (): void => {
      if (client.closed) return
      client.closed = true
      if (activeSseClient === client) activeSseClient = null
    }
    req.on('close', close)
    res.on('close', close)
  }

  const publish = (event: KernelEvent): void => {
    const client = activeSseClient
    if (closed || client === null) return
    if (currentPairedDevice() === null) {
      closeActiveController()
      return
    }
    if (client.closed || client.res.writableEnded || client.res.destroyed) {
      closeActiveController()
      return
    }
    if (client.res.writableLength > SSE_MAX_BUFFERED_BYTES) {
      client.res.destroy(new Error('Desktop Host SSE client too slow.'))
      closeActiveController()
      return
    }
    const envelope: DesktopHostEventEnvelope = {
      protocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
      event
    }
    client.res.write(`data: ${JSON.stringify(envelope)}\n\n`)
  }

  heartbeatTimer = setInterval(() => {
    const client = activeSseClient
    if (client === null) return
    if (currentPairedDevice() === null) {
      closeActiveController()
      return
    }
    if (
      client.closed ||
      client.res.writableEnded ||
      client.res.destroyed ||
      client.res.writableLength > SSE_MAX_BUFFERED_BYTES
    ) {
      closeActiveController()
      return
    }
    client.res.write(': heartbeat\n\n')
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
      closeActiveController()
      pairingCode = null
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => error ? rejectClose(error) : resolveClose())
      })
    }
  }
}

function applySecurityHeaders(res: ServerResponse): void {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    res.setHeader(name, value)
  }
}

function headerValue(req: IncomingMessage, name: string): string | null {
  const value = req.headers[name]
  if (typeof value === 'string') return value
  if (Array.isArray(value) && value.length === 1) return value[0] ?? null
  return null
}

function isJsonRequest(req: IncomingMessage): boolean {
  const contentType = headerValue(req, 'content-type')
  return contentType !== null && /^application\/json(?:;|$)/iu.test(contentType)
}

async function readJsonBody(req: IncomingMessage, limit: number): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > limit) throw new BodyLimitError()
    chunks.push(buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

function isPairRequest(value: unknown): value is DesktopHostPairRequest {
  return isRecord(value) &&
    Object.keys(value).length === 4 &&
    value.protocolVersion === DESKTOP_HOST_PROTOCOL_VERSION &&
    isSafeBuildIdentity(value.productVersion) &&
    isSafeBuildIdentity(value.buildCommit) &&
    typeof value.code === 'string' &&
    isPairingCodeShape(value.code)
}

function isSafeBuildIdentity(value: unknown): value is string {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 128 &&
    !/[\r\n\0]/u.test(value)
}

function isPairingCodeShape(code: string): boolean {
  return code.length === REMOTE_PAIRING_CODE_LENGTH && /^\d+$/u.test(code)
}

function isCommandRequest(value: unknown): value is DesktopHostCommandRequest {
  if (!isRecord(value) || Object.keys(value).length !== 4) return false
  if (value.protocolVersion !== DESKTOP_HOST_PROTOCOL_VERSION) return false
  if (
    typeof value.requestId !== 'string' ||
    value.requestId.length === 0 ||
    value.requestId.length > 256
  ) return false
  return isControlIdentity(value.expectedIdentity) && isRecord(value.command)
}

function isControlIdentity(value: unknown): value is DesktopHostControlIdentity {
  return isRecord(value) &&
    Object.keys(value).length === 2 &&
    isNullableBoundedIdentity(value.projectKey) &&
    isNullableBoundedIdentity(value.sessionKey)
}

function isNullableBoundedIdentity(value: unknown): value is string | null {
  return value === null || (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 4_096 &&
    !value.includes('\0')
  )
}

function sameControlIdentity(
  current: DesktopHostControlIdentity,
  expected: DesktopHostControlIdentity
): boolean {
  return current.projectKey === expected.projectKey && current.sessionKey === expected.sessionKey
}

function writeCommandBoundaryError(
  res: ServerResponse,
  requestId: string | null,
  error: DesktopHostCommandBoundaryError
): void {
  writeCommandError(res, requestId, error.code, error.message, error.status)
}

function writeCommandError(
  res: ServerResponse,
  requestId: string | null,
  code: DesktopHostCommandErrorCode,
  message: string,
  status: number
): void {
  const response: DesktopHostCommandResponse = {
    protocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
    requestId,
    ok: false,
    error: { code, message }
  }
  writeJson(res, status, response)
}

function writeJson(res: ServerResponse, status: number, value: unknown): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(value))
}

function writeText(res: ServerResponse, status: number, value: string): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'text/plain; charset=utf-8')
  res.end(value)
}

class DesktopHostCommandBoundaryError extends Error {
  readonly code: DesktopHostCommandErrorCode
  readonly status: number

  constructor(code: DesktopHostCommandErrorCode, message: string, status: number) {
    super(message)
    this.name = 'DesktopHostCommandBoundaryError'
    this.code = code
    this.status = status
  }
}

class BodyLimitError extends Error {
  constructor() {
    super('Request body too large.')
    this.name = 'BodyLimitError'
  }
}
