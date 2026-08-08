import {
  isKernelSnapshot,
  type KernelConversationPage,
  type KernelEvent,
  type KernelMessageImage,
  type KernelMutationAck,
  type KernelSnapshot
} from '../shared/kernel-contract.ts'
import {
  REMOTE_API_PATHS,
  REMOTE_PROTOCOL_VERSION,
  type RemoteCommandErrorCode,
  type RemoteKernelCommand,
  type RemoteSessionStatus
} from '../shared/remote-contract.ts'

export type { RemoteSessionStatus }

export class RemoteTransportError extends Error {
  readonly code: RemoteCommandErrorCode | 'http' | 'protocol' | 'network'
  readonly status: number | null

  constructor(
    message: string,
    code: RemoteCommandErrorCode | 'http' | 'protocol' | 'network' = 'protocol',
    status: number | null = null
  ) {
    super(message)
    this.name = 'RemoteTransportError'
    this.code = code
    this.status = status
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseRemoteSessionStatus(value: unknown): RemoteSessionStatus {
  if (!isPlainObject(value)) {
    throw new RemoteTransportError('Remote session status must be an object.')
  }
  if (value.protocolVersion !== REMOTE_PROTOCOL_VERSION) {
    throw new RemoteTransportError(
      `Unsupported remote protocol version: ${String(value.protocolVersion)}.`
    )
  }
  if (typeof value.authenticated !== 'boolean') {
    throw new RemoteTransportError('Remote session status.authenticated must be a boolean.')
  }
  return {
    protocolVersion: REMOTE_PROTOCOL_VERSION,
    authenticated: value.authenticated
  }
}

export function parseRemoteCommandResponse(value: unknown, requestId: string): unknown {
  if (!isPlainObject(value)) {
    throw new RemoteTransportError('Remote command response must be an object.')
  }
  if (value.protocolVersion !== REMOTE_PROTOCOL_VERSION) {
    throw new RemoteTransportError(
      `Unsupported remote protocol version: ${String(value.protocolVersion)}.`
    )
  }
  if (value.requestId !== requestId) {
    throw new RemoteTransportError(
      `Remote command response requestId mismatch: expected ${requestId}, got ${String(value.requestId)}.`
    )
  }
  if (value.ok === true) {
    return value.value
  }
  if (value.ok === false) {
    const error = value.error
    if (!isPlainObject(error) || typeof error.message !== 'string' || typeof error.code !== 'string') {
      throw new RemoteTransportError('Remote command error payload is invalid.')
    }
    throw new RemoteTransportError(error.message, error.code as RemoteCommandErrorCode)
  }
  throw new RemoteTransportError('Remote command response.ok must be a boolean.')
}

export function parseRemoteEventEnvelope(value: unknown): KernelEvent {
  if (!isPlainObject(value)) {
    throw new RemoteTransportError('Remote event envelope must be an object.')
  }
  if (value.protocolVersion !== REMOTE_PROTOCOL_VERSION) {
    throw new RemoteTransportError(
      `Unsupported remote protocol version: ${String(value.protocolVersion)}.`
    )
  }
  if (!isPlainObject(value.event) || typeof value.event.type !== 'string') {
    throw new RemoteTransportError('Remote event envelope.event is invalid.')
  }
  return value.event as KernelEvent
}

export function parseKernelSnapshotResponse(value: unknown): KernelSnapshot {
  if (!isKernelSnapshot(value)) {
    throw new RemoteTransportError('Remote state response is not a KernelSnapshot.')
  }
  return value
}

export function parseKernelConversationPage(value: unknown): KernelConversationPage {
  if (
    !isPlainObject(value) ||
    typeof value.projectKey !== 'string' ||
    value.projectKey.length === 0 ||
    typeof value.sessionKey !== 'string' ||
    value.sessionKey.length === 0 ||
    typeof value.sessionId !== 'string' ||
    value.sessionId.length === 0 ||
    typeof value.beforeEntryId !== 'string' ||
    value.beforeEntryId.length === 0 ||
    !Number.isSafeInteger(value.beforeIndex) ||
    !Number.isSafeInteger(value.startIndex) ||
    (value.startIndex as number) < 0 ||
    (value.beforeIndex as number) <= (value.startIndex as number) ||
    !Array.isArray(value.entries) ||
    value.entries.length === 0 ||
    (value.startIndex as number) + value.entries.length !== value.beforeIndex ||
    value.entries.some((entry) => !isPlainObject(entry) || typeof entry.id !== 'string' || entry.id.length === 0)
  ) {
    throw new RemoteTransportError('Remote conversation page is invalid.')
  }
  return value as unknown as KernelConversationPage
}

export function parseKernelMutationAck(value: unknown): KernelMutationAck {
  if (!isPlainObject(value) || typeof value.revision !== 'number' || !Number.isInteger(value.revision) || value.revision < 0) {
    throw new RemoteTransportError('Remote mutation ack is invalid.')
  }
  return { revision: value.revision }
}

export function parseKernelMessageImage(value: unknown): KernelMessageImage {
  if (
    !isPlainObject(value) ||
    typeof value.mimeType !== 'string' ||
    typeof value.data !== 'string' ||
    typeof value.name !== 'string' ||
    typeof value.path !== 'string'
  ) {
    throw new RemoteTransportError('Remote image payload is invalid.')
  }
  return {
    mimeType: value.mimeType,
    data: value.data,
    name: value.name,
    path: value.path
  }
}

export function createRequestId(): string {
  return crypto.randomUUID()
}

type RemoteClientOptions = {
  fetchImpl?: typeof fetch
  eventSourceFactory?: (url: string) => EventSource
}

export class RemoteClient {
  private readonly fetchImpl: typeof fetch
  private readonly eventSourceFactory: (url: string) => EventSource
  private readonly unauthorizedListeners = new Set<(error: RemoteTransportError) => void>()

  constructor(options: RemoteClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch.bind(globalThis)
    this.eventSourceFactory = options.eventSourceFactory ?? ((url) => new EventSource(url))
  }

  onUnauthorized(listener: (error: RemoteTransportError) => void): () => void {
    this.unauthorizedListeners.add(listener)
    return () => {
      this.unauthorizedListeners.delete(listener)
    }
  }

  async getSession(): Promise<RemoteSessionStatus> {
    const response = await this.request('GET', REMOTE_API_PATHS.session)
    return parseRemoteSessionStatus(response)
  }

  async pair(code: string): Promise<RemoteSessionStatus> {
    try {
      const response = await this.request('POST', REMOTE_API_PATHS.pair, { code })
      return parseRemoteSessionStatus(response)
    } catch (error) {
      if (error instanceof RemoteTransportError && error.status === 401) {
        throw new RemoteTransportError('配对码无效、已过期或已失效。', 'unauthorized', 401)
      }
      if (error instanceof RemoteTransportError && error.status === 429) {
        throw new RemoteTransportError('尝试次数过多，请稍后再试。', 'unauthorized', 429)
      }
      throw error
    }
  }

  async logout(): Promise<void> {
    await this.request('POST', REMOTE_API_PATHS.logout)
  }

  async getState(): Promise<KernelSnapshot> {
    const response = await this.request('GET', REMOTE_API_PATHS.state)
    return parseKernelSnapshotResponse(response)
  }

  async command(command: RemoteKernelCommand): Promise<unknown> {
    const requestId = createRequestId()
    const body = {
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      requestId,
      command
    }
    const response = await this.request('POST', REMOTE_API_PATHS.command, body)
    return parseRemoteCommandResponse(response, requestId)
  }

  subscribe(
    onEvent: (event: KernelEvent) => void,
    onError: (error: Error) => void
  ): () => void {
    const source = this.eventSourceFactory(REMOTE_API_PATHS.events)
    let closed = false

    source.onmessage = (message) => {
      if (closed) return
      try {
        const payload = JSON.parse(message.data) as unknown
        onEvent(parseRemoteEventEnvelope(payload))
      } catch (error) {
        onError(error instanceof Error ? error : new RemoteTransportError(String(error)))
      }
    }

    source.onerror = () => {
      if (closed) return
      onError(new RemoteTransportError('Remote event stream disconnected.', 'network'))
    }

    return () => {
      closed = true
      source.close()
    }
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    let response: Response
    try {
      response = await this.fetchImpl(path, {
        method,
        credentials: 'same-origin',
        headers: body === undefined
          ? { Accept: 'application/json' }
          : {
              Accept: 'application/json',
              'Content-Type': 'application/json'
            },
        body: body === undefined ? undefined : JSON.stringify(body)
      })
    } catch (error) {
      throw new RemoteTransportError(
        error instanceof Error ? error.message : String(error),
        'network'
      )
    }

    const text = await response.text()
    let payload: unknown = null
    if (text.length > 0) {
      try {
        payload = JSON.parse(text) as unknown
      } catch {
        if (!response.ok) {
          const error = new RemoteTransportError(
            `Remote ${method} ${path} failed with HTTP ${response.status}.`,
            'http',
            response.status
          )
          this.reportUnauthorized(path, error)
          throw error
        }
        throw new RemoteTransportError(
          `Remote ${method} ${path} returned non-JSON body.`,
          'protocol',
          response.status
        )
      }
    }

    if (!response.ok) {
      const message = extractErrorMessage(payload) ??
        `Remote ${method} ${path} failed with HTTP ${response.status}.`
      const error = new RemoteTransportError(message, 'http', response.status)
      this.reportUnauthorized(path, error)
      throw error
    }

    return payload
  }

  private reportUnauthorized(path: string, error: RemoteTransportError): void {
    if (error.status !== 401 || path === REMOTE_API_PATHS.pair) return
    for (const listener of this.unauthorizedListeners) {
      try {
        listener(error)
      } catch {
        // Session invalidation listeners must not replace the transport failure.
      }
    }
  }
}

function extractErrorMessage(payload: unknown): string | null {
  if (!isPlainObject(payload)) return null
  if (isPlainObject(payload.error) && typeof payload.error.message === 'string') {
    return payload.error.message
  }
  if (typeof payload.message === 'string') return payload.message
  return null
}

export type RemoteCommand = RemoteKernelCommand
