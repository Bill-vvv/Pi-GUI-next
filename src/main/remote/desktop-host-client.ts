import { randomUUID } from 'node:crypto'

import {
  isKernelSnapshot,
  type KernelEvent,
  type KernelSnapshot
} from '../../shared/kernel-contract.ts'
import {
  DESKTOP_HOST_API_PATHS,
  DESKTOP_HOST_CONTROLLER_HEADER,
  DESKTOP_HOST_CONTROLLER_ID_PATTERN,
  DESKTOP_HOST_KERNEL_COMMAND_TYPES,
  DESKTOP_HOST_PROTOCOL_VERSION,
  type DesktopHostCapabilities,
  type DesktopHostCommandErrorCode,
  type DesktopHostCommandRequest,
  type DesktopHostCommandResponse,
  type DesktopHostControlIdentity,
  type DesktopHostEventEnvelope,
  type DesktopHostKernelCommand,
  type DesktopHostPairResponse,
  type DesktopHostSessionStatus
} from '../../shared/desktop-host-contract.ts'

export type DesktopHostClientErrorCode =
  | DesktopHostCommandErrorCode
  | 'http'
  | 'network'
  | 'protocol'

export class DesktopHostClientError extends Error {
  readonly code: DesktopHostClientErrorCode
  readonly status: number | null

  constructor(
    message: string,
    code: DesktopHostClientErrorCode = 'protocol',
    status: number | null = null
  ) {
    super(message)
    this.name = 'DesktopHostClientError'
    this.code = code
    this.status = status
  }
}

export type DesktopHostEventStream = {
  readonly closed: Promise<void>
  close(): Promise<void>
}

export type DesktopHostClientOptions = {
  localPort: number
  compatibility: DesktopHostCompatibility
  fetchImpl?: typeof fetch
  requestTimeoutMs?: number
  eventIdleTimeoutMs?: number
}

export type DesktopHostCompatibility = {
  productVersion: string
  buildCommit: string
}

const MAX_JSON_RESPONSE_BYTES = 2 * 1024 * 1024
const MAX_SSE_BUFFER_CHARS = 2 * 1024 * 1024
const MAX_SSE_EVENT_CHARS = 1 * 1024 * 1024
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const DEFAULT_EVENT_IDLE_TIMEOUT_MS = 45_000
const CREDENTIAL_PATTERN = /^[A-Za-z0-9_-]{32,256}$/u
const PAIRING_CODE_PATTERN = /^\d{6}$/u
const COMMAND_ERROR_CODES = new Set<DesktopHostCommandErrorCode>([
  'bad-request',
  'unauthorized',
  'forbidden',
  'conflict',
  'unavailable',
  'internal'
])
const COMMAND_TYPES = new Set<string>(DESKTOP_HOST_KERNEL_COMMAND_TYPES)
const KERNEL_EVENT_TYPES = new Set<string>([
  'kernel.state-changed',
  'kernel.state-patched',
  'kernel.state-batch',
  'kernel.pi-package-install',
  'kernel.compaction-started',
  'kernel.compaction-ended'
])

export class DesktopHostClient {
  private readonly baseUrl: string
  private readonly compatibility: DesktopHostCompatibility
  private readonly fetchImpl: typeof fetch
  private readonly requestTimeoutMs: number
  private readonly eventIdleTimeoutMs: number
  private compatibilityVerified = false
  private credential: string | null

  constructor(options: DesktopHostClientOptions) {
    if (!Number.isInteger(options.localPort) || options.localPort < 1 || options.localPort > 65_535) {
      throw new Error('Desktop Host local port must be an integer between 1 and 65535.')
    }
    this.baseUrl = `http://127.0.0.1:${options.localPort}`
    this.compatibility = parseCompatibility(options.compatibility)
    this.fetchImpl = options.fetchImpl ?? fetch.bind(globalThis)
    this.requestTimeoutMs = parseTimeout(
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      'Desktop Host request timeout'
    )
    this.eventIdleTimeoutMs = parseTimeout(
      options.eventIdleTimeoutMs ?? DEFAULT_EVENT_IDLE_TIMEOUT_MS,
      'Desktop Host event idle timeout'
    )
    this.credential = null
  }

  setCredential(credential: string): void {
    this.assertCompatibilityVerified()
    if (!CREDENTIAL_PATTERN.test(credential)) {
      throw new Error('Desktop Host credential must contain 32 to 256 base64url characters.')
    }
    this.credential = credential
  }

  clearCredential(): void {
    this.credential = null
  }

  async verifyCompatibility(): Promise<DesktopHostSessionStatus> {
    this.compatibilityVerified = false
    this.credential = null
    const { response, payload } = await this.requestJson('GET', DESKTOP_HOST_API_PATHS.session, {
      credential: 'none'
    })
    assertOk(response, 'Desktop Host handshake')
    const status = parseSessionStatus(payload)
    assertDesktopHostCompatibility(status, this.compatibility)
    this.compatibilityVerified = true
    return status
  }

  async getSession(): Promise<DesktopHostSessionStatus> {
    this.assertCompatibilityVerified()
    const { response, payload } = await this.requestJson('GET', DESKTOP_HOST_API_PATHS.session, {
      credential: 'optional'
    })
    assertOk(response, 'Desktop Host session')
    const status = parseSessionStatus(payload)
    assertDesktopHostCompatibility(status, this.compatibility)
    return status
  }

  async pair(code: string): Promise<DesktopHostPairResponse> {
    this.assertCompatibilityVerified()
    if (!PAIRING_CODE_PATTERN.test(code)) {
      throw new DesktopHostClientError('Desktop Host pairing code must contain exactly 6 digits.')
    }
    const { response, payload } = await this.requestJson('POST', DESKTOP_HOST_API_PATHS.pair, {
      body: {
        protocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
        productVersion: this.compatibility.productVersion,
        buildCommit: this.compatibility.buildCommit,
        code
      },
      credential: 'none'
    })
    if (!response.ok) throwHttpError(response, 'Desktop Host pairing')
    const paired = parsePairResponse(payload)
    assertDesktopHostCompatibility(paired, this.compatibility)
    this.credential = paired.credential
    return paired
  }

  async logout(): Promise<DesktopHostSessionStatus> {
    const { response, payload } = await this.requestJson('POST', DESKTOP_HOST_API_PATHS.logout, {
      credential: 'required'
    })
    assertOk(response, 'Desktop Host logout')
    const status = parseSessionStatus(payload)
    this.credential = null
    return status
  }

  async getState(controllerId: string): Promise<KernelSnapshot> {
    assertControllerId(controllerId)
    const { response, payload } = await this.requestJson('GET', DESKTOP_HOST_API_PATHS.state, {
      credential: 'required',
      controllerId
    })
    assertOk(response, 'Desktop Host state')
    if (!isKernelSnapshot(payload)) {
      throw new DesktopHostClientError('Desktop Host state response is not a KernelSnapshot.')
    }
    return payload
  }

  async command(
    controllerId: string,
    expectedIdentity: DesktopHostControlIdentity,
    command: DesktopHostKernelCommand,
    requestId = randomUUID()
  ): Promise<unknown> {
    assertControllerId(controllerId)
    if (!DESKTOP_HOST_CONTROLLER_ID_PATTERN.test(requestId)) {
      throw new DesktopHostClientError('Desktop Host request identity must be a UUID.')
    }
    assertControlIdentity(expectedIdentity)
    if (!isRecord(command) || typeof command.type !== 'string' || !COMMAND_TYPES.has(command.type)) {
      throw new DesktopHostClientError('Desktop Host command is not in the advertised protocol allowlist.')
    }
    const body: DesktopHostCommandRequest = {
      protocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
      requestId,
      expectedIdentity,
      command
    }
    const { response, payload } = await this.requestJson('POST', DESKTOP_HOST_API_PATHS.command, {
      body,
      credential: 'required',
      controllerId
    })
    return parseCommandResponse(payload, response.status, requestId)
  }

  async openEventStream(
    controllerId: string,
    onEvent: (event: KernelEvent) => void
  ): Promise<DesktopHostEventStream> {
    assertControllerId(controllerId)
    const controller = new AbortController()
    let closeRequested = false
    let connectTimedOut = false
    const connectTimeout = setTimeout(() => {
      connectTimedOut = true
      controller.abort()
    }, this.requestTimeoutMs)
    connectTimeout.unref?.()
    let response: Response
    try {
      response = await this.fetchImpl(this.url(DESKTOP_HOST_API_PATHS.events), {
        method: 'GET',
        redirect: 'error',
        cache: 'no-store',
        signal: controller.signal,
        headers: this.headers({
          accept: 'text/event-stream',
          credential: 'required',
          controllerId
        })
      })
    } catch (error) {
      if (connectTimedOut) {
        throw new DesktopHostClientError('Desktop Host event stream connection timed out.', 'network')
      }
      throw networkError(error)
    } finally {
      clearTimeout(connectTimeout)
    }
    if (!response.ok) {
      controller.abort()
      throwHttpError(response, 'Desktop Host event stream')
    }
    const contentType = response.headers.get('content-type') ?? ''
    if (!/^text\/event-stream(?:;|$)/iu.test(contentType) || response.body === null) {
      controller.abort()
      throw new DesktopHostClientError('Desktop Host event stream returned an invalid content type.')
    }

    const closed = consumeSse(
      response.body,
      onEvent,
      () => closeRequested,
      this.eventIdleTimeoutMs,
      () => controller.abort()
    ).catch((error: unknown) => {
      if (closeRequested && isAbortError(error)) return
      throw error instanceof DesktopHostClientError ? error : networkError(error)
    })

    return {
      closed,
      async close() {
        if (closeRequested) return closed
        closeRequested = true
        controller.abort()
        await closed
      }
    }
  }

  private async requestJson(
    method: 'GET' | 'POST',
    path: string,
    options: {
      body?: unknown
      credential: 'none' | 'optional' | 'required'
      controllerId?: string
    }
  ): Promise<{ response: Response; payload: unknown }> {
    const controller = new AbortController()
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, this.requestTimeoutMs)
    timeout.unref?.()
    try {
      const response = await this.fetchImpl(this.url(path), {
        method,
        redirect: 'error',
        cache: 'no-store',
        signal: controller.signal,
        headers: this.headers({
          accept: 'application/json',
          credential: options.credential,
          controllerId: options.controllerId,
          json: options.body !== undefined
        }),
        body: options.body === undefined ? undefined : JSON.stringify(options.body)
      })
      const contentType = response.headers.get('content-type') ?? ''
      if (!/^application\/json(?:;|$)/iu.test(contentType)) {
        if (!response.ok) throwHttpError(response, `Desktop Host ${method} ${path}`)
        throw new DesktopHostClientError(
          `Desktop Host ${method} ${path} returned an invalid content type.`,
          'protocol',
          response.status
        )
      }
      return {
        response,
        payload: await readBoundedJson(response)
      }
    } catch (error) {
      if (timedOut) {
        throw new DesktopHostClientError(`Desktop Host ${method} ${path} timed out.`, 'network')
      }
      throw networkError(error)
    } finally {
      clearTimeout(timeout)
    }
  }

  private headers(options: {
    accept: string
    credential: 'none' | 'optional' | 'required'
    controllerId?: string
    json?: boolean
  }): Record<string, string> {
    const headers: Record<string, string> = { Accept: options.accept }
    if (options.json === true) headers['Content-Type'] = 'application/json'
    if (options.controllerId !== undefined) {
      headers[DESKTOP_HOST_CONTROLLER_HEADER] = options.controllerId
    }
    if (options.credential === 'required' && this.credential === null) {
      throw new DesktopHostClientError('Desktop Host device is not paired.', 'unauthorized')
    }
    if (options.credential !== 'none' && this.credential !== null) {
      headers.Authorization = `Bearer ${this.credential}`
    }
    return headers
  }

  private assertCompatibilityVerified(): void {
    if (!this.compatibilityVerified) {
      throw new DesktopHostClientError(
        'Desktop Host compatibility must be verified before using a device credential.'
      )
    }
  }

  private url(path: string): string {
    return this.baseUrl + path
  }
}

export function assertDesktopHostCompatibility(
  status: DesktopHostSessionStatus | DesktopHostPairResponse,
  expected: DesktopHostCompatibility
): void {
  if (status.productVersion !== expected.productVersion) {
    throw new DesktopHostClientError(
      `Desktop Host product version mismatch: expected ${expected.productVersion}, got ${status.productVersion}.`
    )
  }
  if (status.buildCommit !== expected.buildCommit) {
    throw new DesktopHostClientError(
      `Desktop Host build commit mismatch: expected ${expected.buildCommit}, got ${String(status.buildCommit)}.`
    )
  }
}

export function desktopHostControlIdentity(snapshot: KernelSnapshot): DesktopHostControlIdentity {
  return {
    projectKey: snapshot.state.activeProjectKey,
    sessionKey: snapshot.state.activeSessionKey
  }
}

function parseSessionStatus(value: unknown): DesktopHostSessionStatus {
  const record = requireExactRecord(value, [
    'protocolVersion',
    'productVersion',
    'buildCommit',
    'authenticated',
    'capabilities'
  ], 'Desktop Host session status')
  if (record.protocolVersion !== DESKTOP_HOST_PROTOCOL_VERSION) {
    throw new DesktopHostClientError(
      `Unsupported Desktop Host protocol version: ${String(record.protocolVersion)}.`
    )
  }
  if (typeof record.authenticated !== 'boolean') {
    throw new DesktopHostClientError('Desktop Host session authenticated flag is invalid.')
  }
  return {
    protocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
    productVersion: parseProductVersion(record.productVersion),
    buildCommit: parseBuildCommit(record.buildCommit),
    authenticated: record.authenticated,
    capabilities: parseCapabilities(record.capabilities)
  }
}

function parsePairResponse(value: unknown): DesktopHostPairResponse {
  const record = requireExactRecord(value, [
    'protocolVersion',
    'productVersion',
    'buildCommit',
    'credential',
    'expiresAt',
    'capabilities'
  ], 'Desktop Host pair response')
  if (record.protocolVersion !== DESKTOP_HOST_PROTOCOL_VERSION) {
    throw new DesktopHostClientError(
      `Unsupported Desktop Host protocol version: ${String(record.protocolVersion)}.`
    )
  }
  if (typeof record.credential !== 'string' || !CREDENTIAL_PATTERN.test(record.credential)) {
    throw new DesktopHostClientError('Desktop Host pair response credential is invalid.')
  }
  if (!Number.isSafeInteger(record.expiresAt) || (record.expiresAt as number) <= 0) {
    throw new DesktopHostClientError('Desktop Host pair response expiry is invalid.')
  }
  return {
    protocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
    productVersion: parseProductVersion(record.productVersion),
    buildCommit: parseBuildCommit(record.buildCommit),
    credential: record.credential,
    expiresAt: record.expiresAt as number,
    capabilities: parseCapabilities(record.capabilities)
  }
}

function parseCapabilities(value: unknown): DesktopHostCapabilities {
  const record = requireExactRecord(value, ['kernelCommandTypes'], 'Desktop Host capabilities')
  if (
    !Array.isArray(record.kernelCommandTypes) ||
    record.kernelCommandTypes.some((command) => typeof command !== 'string' || !COMMAND_TYPES.has(command)) ||
    new Set(record.kernelCommandTypes).size !== record.kernelCommandTypes.length
  ) {
    throw new DesktopHostClientError('Desktop Host command capabilities are invalid.')
  }
  return {
    kernelCommandTypes: record.kernelCommandTypes as DesktopHostCapabilities['kernelCommandTypes']
  }
}

function parseCommandResponse(
  value: unknown,
  status: number,
  requestId: string
): unknown {
  const record = requireExactRecord(
    value,
    ['protocolVersion', 'requestId', 'ok', recordHasTrueOk(value) ? 'value' : 'error'],
    'Desktop Host command response'
  )
  if (record.protocolVersion !== DESKTOP_HOST_PROTOCOL_VERSION) {
    throw new DesktopHostClientError(
      `Unsupported Desktop Host protocol version: ${String(record.protocolVersion)}.`,
      'protocol',
      status
    )
  }
  if (record.ok === true) {
    if (record.requestId !== requestId) {
      throw new DesktopHostClientError(
        `Desktop Host command response requestId mismatch: expected ${requestId}, got ${String(record.requestId)}.`,
        'protocol',
        status
      )
    }
    if (status < 200 || status >= 300) {
      throw new DesktopHostClientError('Desktop Host returned a successful command body with an error status.')
    }
    return record.value
  }
  if (record.ok !== false) {
    throw new DesktopHostClientError('Desktop Host command response ok flag is invalid.')
  }
  if (record.requestId !== null && record.requestId !== requestId) {
    throw new DesktopHostClientError(
      `Desktop Host command response requestId mismatch: expected ${requestId}, got ${String(record.requestId)}.`,
      'protocol',
      status
    )
  }
  const error = requireExactRecord(record.error, ['code', 'message'], 'Desktop Host command error')
  if (
    typeof error.code !== 'string' ||
    !COMMAND_ERROR_CODES.has(error.code as DesktopHostCommandErrorCode) ||
    typeof error.message !== 'string' ||
    error.message.length === 0 ||
    error.message.length > 512
  ) {
    throw new DesktopHostClientError('Desktop Host command error payload is invalid.')
  }
  throw new DesktopHostClientError(
    error.message,
    error.code as DesktopHostCommandErrorCode,
    status
  )
}

function recordHasTrueOk(value: unknown): boolean {
  return isRecord(value) && value.ok === true
}

// Kernel DTO internals remain the same-build shared contract. This boundary validates
// framing, the versioned envelope, and the known event discriminator after requiring
// an exact non-null build commit during the compatibility handshake.
function parseEventEnvelope(value: unknown): DesktopHostEventEnvelope {
  const record = requireExactRecord(value, ['protocolVersion', 'event'], 'Desktop Host event envelope')
  if (record.protocolVersion !== DESKTOP_HOST_PROTOCOL_VERSION) {
    throw new DesktopHostClientError(
      `Unsupported Desktop Host protocol version: ${String(record.protocolVersion)}.`
    )
  }
  if (
    !isRecord(record.event) ||
    typeof record.event.type !== 'string' ||
    !KERNEL_EVENT_TYPES.has(record.event.type)
  ) {
    throw new DesktopHostClientError('Desktop Host event payload is invalid.')
  }
  return {
    protocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
    event: record.event as KernelEvent
  }
}

async function consumeSse(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: KernelEvent) => void,
  isCloseRequested: () => boolean,
  idleTimeoutMs: number,
  abort: () => void
): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let buffer = ''
  while (true) {
    const { done, value } = await readSseChunk(reader, idleTimeoutMs, abort)
    if (done) break
    try {
      buffer += decoder.decode(value, { stream: true })
    } catch {
      throw new DesktopHostClientError('Desktop Host event stream is not valid UTF-8.')
    }
    if (buffer.length > MAX_SSE_BUFFER_CHARS) {
      throw new DesktopHostClientError('Desktop Host event stream exceeded its buffer limit.')
    }
    while (true) {
      const match = /\r?\n\r?\n/u.exec(buffer)
      if (match === null || match.index === undefined) break
      const frame = buffer.slice(0, match.index)
      buffer = buffer.slice(match.index + match[0].length)
      parseSseFrame(frame, onEvent)
    }
  }
  try {
    buffer += decoder.decode()
  } catch {
    throw new DesktopHostClientError('Desktop Host event stream is not valid UTF-8.')
  }
  if (buffer.trim().length > 0) {
    throw new DesktopHostClientError('Desktop Host event stream ended with an incomplete frame.')
  }
  if (!isCloseRequested()) {
    throw new DesktopHostClientError('Desktop Host event stream disconnected.', 'network')
  }
}

async function readSseChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
  abort: () => void
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timeout: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new DesktopHostClientError(
            `Desktop Host event stream was idle for ${timeoutMs} milliseconds.`,
            'network'
          ))
          abort()
        }, timeoutMs)
        timeout.unref?.()
      })
    ])
  } finally {
    if (timeout !== null) clearTimeout(timeout)
  }
}

function parseSseFrame(frame: string, onEvent: (event: KernelEvent) => void): void {
  if (frame.length > MAX_SSE_EVENT_CHARS) {
    throw new DesktopHostClientError('Desktop Host event exceeded its size limit.')
  }
  const data: string[] = []
  for (const line of frame.split(/\r?\n/u)) {
    if (line.length === 0 || line.startsWith(':')) continue
    if (line === 'data') data.push('')
    else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /u, ''))
  }
  if (data.length === 0) return
  let payload: unknown
  try {
    payload = JSON.parse(data.join('\n')) as unknown
  } catch {
    throw new DesktopHostClientError('Desktop Host event contains invalid JSON.')
  }
  onEvent(parseEventEnvelope(payload).event)
}

async function readBoundedJson(response: Response): Promise<unknown> {
  if (response.body === null) {
    throw new DesktopHostClientError('Desktop Host returned an empty JSON response.', 'protocol', response.status)
  }
  const contentLength = response.headers.get('content-length')
  if (contentLength !== null) {
    const parsed = Number(contentLength)
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > MAX_JSON_RESPONSE_BYTES) {
      throw new DesktopHostClientError('Desktop Host JSON response exceeds its size limit.', 'protocol', response.status)
    }
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_JSON_RESPONSE_BYTES) {
      await reader.cancel()
      throw new DesktopHostClientError('Desktop Host JSON response exceeds its size limit.', 'protocol', response.status)
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new DesktopHostClientError('Desktop Host JSON response is not valid UTF-8.', 'protocol', response.status)
  }
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new DesktopHostClientError('Desktop Host returned invalid JSON.', 'protocol', response.status)
  }
}

function parseCompatibility(value: DesktopHostCompatibility): DesktopHostCompatibility {
  if (!isRecord(value) || Object.keys(value).length !== 2) {
    throw new Error('Desktop Host compatibility must contain exactly productVersion and buildCommit.')
  }
  const buildCommit = parseBuildCommit(value.buildCommit)
  if (buildCommit === null) {
    throw new Error('Desktop Host client requires a known non-null build commit.')
  }
  return {
    productVersion: parseProductVersion(value.productVersion),
    buildCommit
  }
}

function parseTimeout(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1 || value > 300_000) {
    throw new Error(`${label} must be an integer between 1 and 300000 milliseconds.`)
  }
  return value
}

function assertControlIdentity(value: DesktopHostControlIdentity): void {
  if (!isRecord(value) || Object.keys(value).length !== 2) {
    throw new DesktopHostClientError('Desktop Host control identity is invalid.')
  }
  for (const identity of [value.projectKey, value.sessionKey]) {
    if (
      identity !== null &&
      (
        typeof identity !== 'string' ||
        identity.length === 0 ||
        identity.length > 4_096 ||
        identity.includes('\0')
      )
    ) {
      throw new DesktopHostClientError('Desktop Host control identity is invalid.')
    }
  }
}

function parseProductVersion(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 128 ||
    /[\r\n\0]/u.test(value)
  ) {
    throw new DesktopHostClientError('Desktop Host product version is invalid.')
  }
  return value
}

function parseBuildCommit(value: unknown): string | null {
  if (value === null) return null
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 128 ||
    /[\r\n\0]/u.test(value)
  ) {
    throw new DesktopHostClientError('Desktop Host build commit is invalid.')
  }
  return value
}

function requireExactRecord(
  value: unknown,
  keys: readonly string[],
  label: string
): Record<string, unknown> {
  if (!isRecord(value)) throw new DesktopHostClientError(`${label} must be an object.`)
  const actualKeys = Object.keys(value).sort()
  const expectedKeys = [...keys].sort()
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new DesktopHostClientError(`${label} fields are invalid.`)
  }
  return value
}

function assertControllerId(controllerId: string): void {
  if (!DESKTOP_HOST_CONTROLLER_ID_PATTERN.test(controllerId)) {
    throw new DesktopHostClientError('Desktop Host controller identity must be a UUID.')
  }
}

function assertOk(response: Response, label: string): void {
  if (!response.ok) throwHttpError(response, label)
}

function throwHttpError(response: Response, label: string): never {
  const code: DesktopHostClientErrorCode = response.status === 401
    ? 'unauthorized'
    : response.status === 403
      ? 'forbidden'
      : response.status === 409
        ? 'conflict'
        : response.status === 503
          ? 'unavailable'
          : 'http'
  throw new DesktopHostClientError(
    `${label} failed with HTTP ${response.status}.`,
    code,
    response.status
  )
}

function networkError(error: unknown): DesktopHostClientError {
  if (error instanceof DesktopHostClientError) return error
  return new DesktopHostClientError(
    error instanceof Error ? error.message : String(error),
    'network'
  )
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
