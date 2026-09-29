import { randomBytes, randomInt } from 'node:crypto'
import { desktopPairingIdFromHash } from './desktop-device-binding.ts'
import { DESKTOP_ATTACHMENT_COMMAND_TYPES, isDesktopAttachmentCommand, type DesktopAttachmentCommand } from '../../shared/desktop-attachment-contract.ts'
import { DesktopAttachmentError, type DesktopAttachmentOwner } from './desktop-attachment-store.ts'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

import type {
  DesktopHostAccessStatus,
  DesktopHostDeviceSummary,
  RemotePairingCode
} from '../../shared/remote-admin-contract.ts'
import {
  DESKTOP_HOST_API_PATHS,
  DESKTOP_HOST_CONTROLLER_HEADER,
  DESKTOP_HOST_CONTROLLER_ID_PATTERN,
  DESKTOP_HOST_KERNEL_COMMAND_TYPES,
  DESKTOP_HOST_GIT_COMMAND_TYPES,
  DESKTOP_HOST_JSON_RESPONSE_BYTE_LIMIT,
  DESKTOP_HOST_OCCUPIED_MESSAGE,
  DESKTOP_HOST_PAIRING_ID_HEADER,
  DESKTOP_HOST_PAIRING_ID_PATTERN,
  DESKTOP_HOST_PROTOCOL_VERSION,
  normalizeDesktopDeviceLabel,
  isDesktopHostKernelCommand,
  isDesktopHostGitCommand,
  isDesktopHostControlIdentity,
  type DesktopHostCommandErrorCode,
  type DesktopHostCommandRequest,
  type DesktopHostControlIdentity,
  type DesktopHostCommandResponse,
  type DesktopHostEventEnvelope,
  type DesktopHostKernelCommand,
  type DesktopHostGitCommand,
  type DesktopHostPairRequest,
  type DesktopHostPairResponse,
  type DesktopHostSessionStatus
} from '../../shared/desktop-host-contract.ts'
import type { KernelEvent } from '../../shared/kernel-contract.ts'
import { REMOTE_PAIRING_CODE_LENGTH } from '../../shared/remote-contract.ts'
import { isKernelCommand } from '../kernel/kernel-command-validation.ts'
import { isGitCommand } from '../git/git-command-validation.ts'
import { isRecord } from '../utils/guards.ts'
import { RemoteCommandPolicyError } from './remote-command-policy.ts'
import type { DesktopHostEnabledConfig } from './desktop-host-config.ts'
import { hashRemoteDeviceCredential } from './remote-device-store.ts'
import { NOOP_LOGGER, type JsonlLogger, type LogFields, type LogLevel } from '../utils/jsonl-log.ts'
import { DESKTOP_DEVICE_LIMIT, type DesktopDeviceRecord, type DesktopDeviceStore } from './desktop-device-store.ts'
import {
  BodyLimitError,
  COMMAND_BODY_LIMIT_BYTES,
  PAIR_BODY_LIMIT_BYTES,
  PAIR_RATE_LIMIT_MAX,
  PAIR_RATE_LIMIT_WINDOW_MS,
  REMOTE_DEVICE_ABSOLUTE_TTL_MS,
  REMOTE_PAIRING_CODE_TTL_MS,
  REMOTE_PAIRING_MAX_FAILED_ATTEMPTS,
  SSE_HEARTBEAT_MS,
  SSE_MAX_BUFFERED_BYTES,
  applySecurityHeaders,
  closeServer,
  digestPairingCode,
  headerValue,
  isPairingCodeShape,
  listenServer,
  normalizePeerAddress,
  openEventStream,
  pairingCodeMatches,
  timingSafeEqualString,
  writeJson,
  writeText
} from './gateway-common.ts'

export type DesktopHostGateway = {
  readonly bindHost: string
  readonly port: number
  publish(event: KernelEvent): void
  getStatus(): DesktopHostAccessStatus
  /** Currently valid devices; shared by the Settings page and the future local CLI (D-095). */
  listDevices(): DesktopHostDeviceSummary[]
  createPairingCode(): RemotePairingCode
  revokeDevice(deviceId: string): Promise<DesktopHostAccessStatus>
  stop(): Promise<void>
}

export type DesktopHostGatewayHandlers = {
  dispatchAttachmentCommand?(
    command: DesktopAttachmentCommand, owner: DesktopAttachmentOwner,
    assertCurrentBoundary: () => Promise<void>
  ): Promise<unknown>
  getControlIdentity(): DesktopHostControlIdentity
  assertCommandPolicy(command: DesktopHostKernelCommand): Promise<void>
  dispatchCommand(
    command: DesktopHostKernelCommand,
    assertCurrentBoundary?: () => Promise<void>
  ): Promise<unknown>
  dispatchGitCommand?(
    command: DesktopHostGitCommand,
    assertCurrentBoundary: () => Promise<void>
  ): Promise<unknown>
}

export type DesktopHostGatewayOptions = {
  config: DesktopHostEnabledConfig
  productVersion: string
  buildCommit: string | null
  deviceStore: DesktopDeviceStore
  handlers: DesktopHostGatewayHandlers
  /** Lifecycle and error metadata only; never credentials, pairing codes or device identities (D-099). */
  logger?: JsonlLogger
  now?: () => number
  randomDeviceCredential?: () => string
  randomPairingCode?: () => string
}

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
  /** Authentication hash of the device that owns this control connection. */
  deviceHash: string
  controllerId: string
  res: ServerResponse
  closed: boolean
}

export async function startDesktopHostGateway(
  options: DesktopHostGatewayOptions
): Promise<DesktopHostGateway> {
  const logger = options.logger ?? NOOP_LOGGER
  const log = (level: LogLevel, event: string, fields?: LogFields): void =>
    logger.write(level, 'desktop-host-gateway', event, fields)
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

  const validDevices = (): DesktopDeviceRecord[] => {
    const time = now()
    return deviceStore.getDevices().filter((device) => device.expiresAt > time)
  }

  const isValidDevice = (credentialHash: string): boolean =>
    validDevices().some((device) => device.credentialHash === credentialHash)

  const listDevices = (): DesktopHostDeviceSummary[] => validDevices()
    .sort((left, right) => left.pairedAt - right.pairedAt)
    .map((device) => ({
      deviceId: desktopPairingIdFromHash(device.credentialHash),
      label: device.label,
      pairedAt: device.pairedAt,
      expiresAt: device.expiresAt,
      controlling: activeSseClient !== null && !activeSseClient.closed &&
        activeSseClient.deviceHash === device.credentialHash
    }))

  const getStatus = (): DesktopHostAccessStatus => ({
    enabled: true,
    endpoint: `http://${config.bindHost}:${config.port}`,
    devices: listDevices()
  })

  /** Close the control connection, or only when it belongs to the given device. */
  const closeActiveController = (deviceHash?: string): void => {
    const client = activeSseClient
    if (client !== null && deviceHash !== undefined && client.deviceHash !== deviceHash) return
    activeSseClient = null
    if (client === null || client.closed) return
    client.closed = true
    client.res.end()
  }

  const createPairingCode = (): RemotePairingCode => {
    if (validDevices().length >= DESKTOP_DEVICE_LIMIT) {
      throw new Error(`Host 已有 ${DESKTOP_DEVICE_LIMIT} 台配对设备，请先撤销一台。`)
    }
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

  const revokeDevice = async (deviceId: string): Promise<DesktopHostAccessStatus> => runAuthMutation(async () => {
    const device = validDevices().find((entry) => desktopPairingIdFromHash(entry.credentialHash) === deviceId)
    if (device === undefined) throw new Error('设备不存在或已撤销。')
    try {
      // The store denies the device in memory before persisting; a failed write
      // still leaves it unauthorized and a repeated revoke retries the write.
      await deviceStore.revokeDevice(device.credentialHash)
    } finally {
      closeActiveController(device.credentialHash)
    }
    log('info', 'device-revoked')
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
    applySecurityHeaders(res, SECURITY_HEADERS)
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

  /** Authentication hash of the valid device owning this credential, or null. */
  const authenticatedDevice = (credential: string | null): string | null => {
    if (credential === null || credential.length === 0) return null
    const credentialHash = hashRemoteDeviceCredential(credential)
    let matched: string | null = null
    // Compare against every record so timing does not reveal which slot matched.
    for (const device of validDevices()) {
      if (timingSafeEqualString(credentialHash, device.credentialHash)) matched = device.credentialHash
    }
    return matched
  }

  const readBearerCredential = (req: IncomingMessage): string | null => {
    const authorization = headerValue(req, 'authorization')
    if (authorization === null) return null
    const match = /^Bearer ([A-Za-z0-9_-]{32,256})$/u.exec(authorization)
    return match?.[1] ?? null
  }

  const requestDevice = (req: IncomingMessage): string | null =>
    authenticatedDevice(readBearerCredential(req))

  const readControllerId = (req: IncomingMessage): string | null => {
    const value = headerValue(req, DESKTOP_HOST_CONTROLLER_HEADER)
    return value !== null && DESKTOP_HOST_CONTROLLER_ID_PATTERN.test(value) ? value : null
  }

  const controllerBoundaryError = (
    req: IncomingMessage,
    deviceHash: string
  ): DesktopHostCommandBoundaryError | null => {
    const controllerId = readControllerId(req)
    if (controllerId === null) {
      return new DesktopHostCommandBoundaryError(
        'bad-request',
        'A valid desktop controller identity is required.',
        400
      )
    }
    // A controller id is bound to the device that opened it; another device cannot borrow it.
    if (activeSseClient === null || activeSseClient.controllerId !== controllerId ||
      activeSseClient.deviceHash !== deviceHash) {
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
    res: ServerResponse,
    deviceHash: string
  ): string | null => {
    const error = controllerBoundaryError(req, deviceHash)
    if (error !== null) {
      writeText(res, error.status, error.message)
      return null
    }
    return readControllerId(req)
  }

  const sessionStatus = (authenticated: boolean, pairingKnown: boolean | null): DesktopHostSessionStatus => ({
    protocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
    productVersion: options.productVersion,
    buildCommit: options.buildCommit,
    authenticated,
    pairingKnown,
    capabilities: {
      kernelCommandTypes: DESKTOP_HOST_KERNEL_COMMAND_TYPES,
      ...(options.handlers.dispatchGitCommand ? { gitCommandTypes: DESKTOP_HOST_GIT_COMMAND_TYPES } : {}),
      ...(options.handlers.dispatchAttachmentCommand ? { attachmentCommandTypes: DESKTOP_ATTACHMENT_COMMAND_TYPES } : {})
    }
  })

  const handleSession = (req: IncomingMessage, res: ServerResponse): void => {
    const claimedPairingId = headerValue(req, DESKTOP_HOST_PAIRING_ID_HEADER)
    if (req.headers[DESKTOP_HOST_PAIRING_ID_HEADER] !== undefined &&
      (claimedPairingId === null || !DESKTOP_HOST_PAIRING_ID_PATTERN.test(claimedPairingId))) {
      writeText(res, 400, 'Bad Request')
      return
    }
    // Answer only for the identity the client already holds; never list other devices.
    const pairingKnown = claimedPairingId === null
      ? null
      : validDevices().some((device) => desktopPairingIdFromHash(device.credentialHash) === claimedPairingId)
    writeJson(res, 200, sessionStatus(requestDevice(req) !== null, pairingKnown))
  }

  const handlePair = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!isJsonRequest(req)) {
      writeText(res, 415, 'Unsupported Media Type')
      return
    }
    pairAttempts = pairAttempts.filter((attemptAt) => now() - attemptAt < PAIR_RATE_LIMIT_WINDOW_MS)
    if (pairAttempts.length >= PAIR_RATE_LIMIT_MAX) {
      log('warn', 'pair-rejected', { reason: 'rate-limit' })
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
      log('warn', 'pair-rejected', { reason: 'incompatible-build' })
      writeText(res, 409, 'Desktop Host build is incompatible.')
      return
    }

    const paired = await runAuthMutation(async (): Promise<DesktopHostPairResponse | 'full' | null> => {
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

      if (validDevices().length >= DESKTOP_DEVICE_LIMIT) return 'full'
      pairingCode = null
      const credential = randomDeviceCredential()
      if (!/^[A-Za-z0-9_-]{32,256}$/u.test(credential)) {
        throw new Error('Device credential generator must produce 32 to 256 base64url characters.')
      }
      const pairedAt = now()
      const expiresAt = pairedAt + REMOTE_DEVICE_ABSOLUTE_TTL_MS
      // A new device is added beside existing ones and never takes over the control connection.
      await deviceStore.addDevice({
        credentialHash: hashRemoteDeviceCredential(credential),
        pairedAt,
        expiresAt,
        label: normalizeDesktopDeviceLabel(body.label)
      })
      return {
        protocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
        productVersion: options.productVersion,
        buildCommit: options.buildCommit,
        credential,
        expiresAt,
        capabilities: {
          kernelCommandTypes: DESKTOP_HOST_KERNEL_COMMAND_TYPES,
          ...(options.handlers.dispatchGitCommand ? { gitCommandTypes: DESKTOP_HOST_GIT_COMMAND_TYPES } : {}),
      ...(options.handlers.dispatchAttachmentCommand ? { attachmentCommandTypes: DESKTOP_ATTACHMENT_COMMAND_TYPES } : {})
        }
      }
    })

    if (paired === 'full') {
      log('warn', 'pair-rejected', { reason: 'device-limit' })
      writeText(res, 409, `Desktop Host already has ${DESKTOP_DEVICE_LIMIT} paired devices. Revoke a device before pairing another.`)
      return
    }
    if (paired === null) {
      log('warn', 'pair-rejected', { reason: 'code' })
      writeText(res, 401, 'Unauthorized')
      return
    }
    log('info', 'paired')
    writeJson(res, 200, paired)
  }

  const handleLogout = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const credential = readBearerCredential(req)
    const revoked = await runAuthMutation(async (): Promise<boolean> => {
      const deviceHash = authenticatedDevice(credential)
      if (deviceHash === null) return false
      // Logout revokes only this device; another device's control connection is unaffected.
      try {
        await deviceStore.revokeDevice(deviceHash)
      } finally {
        closeActiveController(deviceHash)
      }
      return true
    })
    if (!revoked) {
      log('warn', 'auth-failed', { endpoint: 'logout' })
      writeText(res, 401, 'Unauthorized')
      return
    }
    log('info', 'device-logged-out')
    writeJson(res, 200, sessionStatus(false, false))
  }

  const handleState = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const deviceHash = requestDevice(req)
    const stillAuthorized = (): boolean => {
      if (deviceHash === null || requestDevice(req) !== deviceHash) {
        writeText(res, 401, 'Unauthorized')
        return false
      }
      return requireActiveController(req, res, deviceHash) !== null
    }
    if (!stillAuthorized()) return
    const command = { type: 'kernel.get-state' } as const
    await options.handlers.assertCommandPolicy(command)
    if (!stillAuthorized()) return
    const value = await options.handlers.dispatchCommand(command)
    if (!stillAuthorized()) return
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
    const deviceHash = requestDevice(req)
    if (deviceHash === null) {
      writeCommandError(res, null, 'unauthorized', 'Authentication required.', 401)
      return
    }
    const initialBoundaryError = controllerBoundaryError(req, deviceHash)
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
    if (!isKernelCommand(body.command) && !isGitCommand(body.command) && !isDesktopAttachmentCommand(body.command)) {
      writeCommandError(res, requestId, 'bad-request', 'Unsupported Desktop Host command.', 400)
      return
    }
    if (!isDesktopHostKernelCommand(body.command) &&
      !(isDesktopHostGitCommand(body.command) && options.handlers.dispatchGitCommand) &&
      !(isDesktopAttachmentCommand(body.command) && options.handlers.dispatchAttachmentCommand)) {
      writeCommandError(res, requestId, 'forbidden', 'Command is not allowed over Desktop Host.', 403)
      return
    }

    const assertCurrentController = async (): Promise<void> => {
      if (requestDevice(req) !== deviceHash) {
        throw new DesktopHostCommandBoundaryError(
          'unauthorized',
          'Authentication required.',
          401
        )
      }
      const controllerError = controllerBoundaryError(req, deviceHash)
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
      let value: unknown
      if (isDesktopAttachmentCommand(body.command)) {
        value = await options.handlers.dispatchAttachmentCommand!(body.command,
          { ...body.expectedIdentity, controllerId: readControllerId(req)! }, assertCurrentBoundary)
        if (body.command.type !== 'attachment.submit') await assertCurrentBoundary()
      } else if (isDesktopHostGitCommand(body.command)) {
        if (body.command.type === 'git.execute-commit' && body.command.request.mode !== 'commit') {
          throw new RemoteCommandPolicyError('Desktop Git supports ordinary commit only; push and amend are unavailable.')
        }
        if (body.command.projectKey !== body.expectedIdentity.projectKey) {
          throw new RemoteCommandPolicyError('Git command must target the observed active Project.')
        }
        value = await options.handlers.dispatchGitCommand!(body.command, assertCurrentBoundary)
        // Reads must not disclose results after navigation, disconnect or revocation.
        await assertCurrentBoundary()
      } else {
        await options.handlers.assertCommandPolicy(body.command)
        await assertCurrentBoundary()
        value = await options.handlers.dispatchCommand(body.command, assertCurrentBoundary)
      }
      await assertCurrentController()
      const response: DesktopHostCommandResponse = {
        protocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
        requestId,
        ok: true,
        value
      }
      if (isDesktopHostGitCommand(body.command) &&
        Buffer.byteLength(JSON.stringify(response)) > DESKTOP_HOST_JSON_RESPONSE_BYTE_LIMIT) {
        writeCommandError(res, requestId, 'unavailable', 'Git result exceeded the Desktop Host response size limit.', 503)
        return
      }
      writeJson(res, 200, response)
    } catch (error) {
      if (error instanceof DesktopHostCommandBoundaryError) {
        writeCommandBoundaryError(res, requestId, error)
        return
      }
      if (requestDevice(req) !== deviceHash) {
        writeCommandError(res, requestId, 'unauthorized', 'Authentication required.', 401)
        return
      }
      if (error instanceof RemoteCommandPolicyError) {
        writeCommandError(res, requestId, 'forbidden', error.message, 403)
        return
      }
      if (error instanceof DesktopAttachmentError) {
        writeCommandError(res, requestId, 'bad-request', error.message, 400)
        return
      }
      const internalMessage = error instanceof Error ? error.message : String(error)
      console.error(`[Desktop Host] ${body.command.type} failed.`, error)
      log('error', 'command-failed', { commandType: body.command.type })
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
    const deviceHash = requestDevice(req)
    if (deviceHash === null) {
      writeText(res, 401, 'Unauthorized')
      return
    }
    const controllerId = readControllerId(req)
    if (controllerId === null) {
      writeText(res, 400, 'Bad Request')
      return
    }
    // One control connection at a time: no preemption and no queue (R12).
    if (activeSseClient !== null && activeSseClient.deviceHash !== deviceHash) {
      log('info', 'controller-occupied')
      writeText(res, 409, DESKTOP_HOST_OCCUPIED_MESSAGE)
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

    openEventStream(res)

    const client: ActiveSseClient = { deviceHash, controllerId, res, closed: false }
    activeSseClient = client
    log('info', 'controller-connected')
    const close = (): void => {
      if (client.closed) return
      client.closed = true
      if (activeSseClient === client) activeSseClient = null
      log('info', 'controller-closed')
    }
    req.on('close', close)
    res.on('close', close)
  }

  const publish = (event: KernelEvent): void => {
    const client = activeSseClient
    if (closed || client === null) return
    if (!isValidDevice(client.deviceHash)) {
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
    if (!isValidDevice(client.deviceHash)) {
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

  await listenServer(server, config.port, config.bindHost)
  log('info', 'listening', { port: config.port })

  return {
    bindHost: config.bindHost,
    port: config.port,
    publish,
    getStatus,
    listDevices,
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
      await closeServer(server)
    }
  }
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
  if (!isRecord(value)) return false
  const keys = Object.keys(value).length
  // The optional label is normalized later; an unusable name never rejects pairing.
  if (keys === 5 ? typeof value.label !== 'string' : keys !== 4) return false
  return isRecord(value) &&
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

function isCommandRequest(value: unknown): value is DesktopHostCommandRequest {
  if (!isRecord(value) || Object.keys(value).length !== 4) return false
  if (value.protocolVersion !== DESKTOP_HOST_PROTOCOL_VERSION) return false
  if (
    typeof value.requestId !== 'string' ||
    value.requestId.length === 0 ||
    value.requestId.length > 256
  ) return false
  return isDesktopHostControlIdentity(value.expectedIdentity) && isRecord(value.command)
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
