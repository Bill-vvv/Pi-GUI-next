/**
 * Package-local quiescence provider constants and pure helpers.
 *
 * Multi Advisor must remain a standalone installable package: do not import the
 * monorepo sibling `pi-gui-runtime-quiescence` at runtime. Contract equivalence
 * with the app-owned protocol module is covered by tests.
 */

export const QUIESCENCE_PROTOCOL_VERSION = 1
export const LEASE_PROTOCOL_VERSION = 1
export const PROVIDER_ID_MULTI_ADVISOR = "pi-gui-multi-advisor"
export const PROVIDER_QUERY_EVENT = "pi-gui.runtime-quiescence/provider-query/v1"
export const PROVIDER_REPLY_EVENT_PREFIX = "pi-gui.runtime-quiescence/provider-reply/v1:"
export const PROVIDER_REGISTER_EVENT = "pi-gui.runtime-quiescence/provider-register/v1"
export const PROVIDER_LEASE_PREPARE_EVENT =
  "pi-gui.runtime-hibernate-lease/provider-prepare/v1"
export const PROVIDER_LEASE_COMMIT_EVENT =
  "pi-gui.runtime-hibernate-lease/provider-commit/v1"
export const PROVIDER_LEASE_RELEASE_EVENT =
  "pi-gui.runtime-hibernate-lease/provider-release/v1"
export const PROVIDER_LEASE_REPLY_EVENT_PREFIX =
  "pi-gui.runtime-hibernate-lease/provider-reply/v1:"

export const MIN_NONCE_LENGTH = 1
export const MAX_NONCE_LENGTH = 128
export const MIN_REQUEST_ID_LENGTH = 1
export const MAX_REQUEST_ID_LENGTH = 160
export const MIN_PROVIDER_ID_LENGTH = 1
export const MAX_PROVIDER_ID_LENGTH = 64
export const PROVIDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/u
export const MAX_REASON_LENGTH = 256

/**
 * @param {unknown} raw
 * @returns {{ version: 1, requestId: string, nonce?: string } | null}
 */
export function parseProviderQueryEvent(raw) {
  if (!isPlainObject(raw)) return null
  if (hasUnknownKeys(raw, ["version", "requestId", "nonce"])) return null
  if (raw.version !== QUIESCENCE_PROTOCOL_VERSION) return null
  if (!isValidRequestId(raw.requestId)) return null
  /** @type {{ version: 1, requestId: string, nonce?: string }} */
  const query = { version: QUIESCENCE_PROTOCOL_VERSION, requestId: raw.requestId }
  if (raw.nonce !== undefined) {
    if (!isValidNonce(raw.nonce)) return null
    query.nonce = raw.nonce
  }
  return query
}

/**
 * @param {string} providerId
 */
export function buildProviderRegister(providerId) {
  if (!isValidProviderId(providerId)) {
    throw new Error("Provider id is out of bounds.")
  }
  return {
    version: QUIESCENCE_PROTOCOL_VERSION,
    providerId,
  }
}

/**
 * @param {object} input
 * @param {string} input.requestId
 * @param {string} input.providerId
 * @param {"idle" | "busy" | "unknown"} input.state
 * @param {string} [input.reason]
 */
export function buildProviderReply(input) {
  if (!isValidRequestId(input.requestId)) {
    throw new Error("Provider reply requestId is out of bounds.")
  }
  if (!isValidProviderId(input.providerId)) {
    throw new Error("Provider reply providerId is out of bounds.")
  }
  if (input.state !== "idle" && input.state !== "busy" && input.state !== "unknown") {
    throw new Error("Provider reply state is invalid.")
  }
  /** @type {{ version: 1, requestId: string, providerId: string, state: "idle" | "busy" | "unknown", reason?: string }} */
  const reply = {
    version: QUIESCENCE_PROTOCOL_VERSION,
    requestId: input.requestId,
    providerId: input.providerId,
    state: input.state,
  }
  if (input.reason !== undefined) {
    if (!isSafeProviderReason(input.reason)) {
      throw new Error("Provider reply reason is out of bounds or contains path separators.")
    }
    reply.reason = input.reason
  }
  return reply
}

/**
 * @param {string} requestId
 */
export function providerReplyEventName(requestId) {
  if (!isValidRequestId(requestId)) {
    throw new Error("Provider reply event requestId is out of bounds.")
  }
  return `${PROVIDER_REPLY_EVENT_PREFIX}${requestId}`
}

/**
 * Best-effort quiescence provider registration + query/lease listener install.
 * Never throws: event-bus failures must not abort Multi Advisor initialization.
 *
 * - If registration succeeds but the listener does not, QUERY sees a registered
 *   provider with missing replies → unknown (fail-closed for hibernate authority).
 * - If both fail, unrelated Advisor behavior continues with no provider surface.
 * - Lease listeners are optional extras on the same bus; QUERY install is unchanged.
 *
 * @param {{ emit?: unknown, on?: unknown }} events
 * @param {(raw: unknown) => void} onQuery
 * @param {{ onPrepare?: (raw: unknown) => void, onCommit?: (raw: unknown) => void, onRelease?: (raw: unknown) => void }} [leaseHandlers]
 * @returns {{ registered: boolean, listening: boolean, leaseListening: boolean }}
 */
export function installQuiescenceProvider(events, onQuery, leaseHandlers = {}) {
  let registered = false
  let listening = false
  let leaseListening = false
  if (events !== null && typeof events === 'object') {
    try {
      if (typeof events.emit === 'function') {
        events.emit(PROVIDER_REGISTER_EVENT, buildProviderRegister(PROVIDER_ID_MULTI_ADVISOR))
        registered = true
      }
    } catch {
      // Registration must never break Advisor review paths.
    }
    try {
      if (typeof events.on === 'function') {
        events.on(PROVIDER_QUERY_EVENT, onQuery)
        listening = true
      }
    } catch {
      // Listener installation must never break Advisor review paths.
    }
    if (typeof events.on === 'function') {
      let leaseOk = true
      if (typeof leaseHandlers.onPrepare === 'function') {
        try {
          events.on(PROVIDER_LEASE_PREPARE_EVENT, leaseHandlers.onPrepare)
        } catch {
          leaseOk = false
        }
      }
      if (typeof leaseHandlers.onCommit === 'function') {
        try {
          events.on(PROVIDER_LEASE_COMMIT_EVENT, leaseHandlers.onCommit)
        } catch {
          leaseOk = false
        }
      }
      if (typeof leaseHandlers.onRelease === 'function') {
        try {
          events.on(PROVIDER_LEASE_RELEASE_EVENT, leaseHandlers.onRelease)
        } catch {
          leaseOk = false
        }
      }
      leaseListening =
        leaseOk &&
        (typeof leaseHandlers.onPrepare === 'function' ||
          typeof leaseHandlers.onCommit === 'function' ||
          typeof leaseHandlers.onRelease === 'function')
    }
  }
  return { registered, listening, leaseListening }
}

/**
 * @param {string} requestId
 */
export function providerLeaseReplyEventName(requestId) {
  if (!isValidRequestId(requestId)) {
    throw new Error('Provider lease reply event requestId is out of bounds.')
  }
  return `${PROVIDER_LEASE_REPLY_EVENT_PREFIX}${requestId}`
}

/**
 * @param {unknown} raw
 * @returns
 *   | {
 *       version: 1,
 *       requestId: string,
 *       sessionId: string,
 *       generation: number,
 *       attemptId: string,
 *       token?: string
 *     }
 *   | null
 */
export function parseProviderLeaseEvent(raw) {
  if (!isPlainObject(raw)) return null
  if (
    hasUnknownKeys(raw, [
      'version',
      'requestId',
      'sessionId',
      'generation',
      'attemptId',
      'token',
    ])
  ) {
    return null
  }
  if (raw.version !== LEASE_PROTOCOL_VERSION) return null
  if (!isValidRequestId(raw.requestId)) return null
  if (typeof raw.sessionId !== 'string' || raw.sessionId.length === 0) return null
  if (
    typeof raw.generation !== 'number' ||
    !Number.isInteger(raw.generation) ||
    raw.generation < 1
  ) {
    return null
  }
  if (typeof raw.attemptId !== 'string' || raw.attemptId.length === 0) return null
  /** @type {{
    version: 1,
    requestId: string,
    sessionId: string,
    generation: number,
    attemptId: string,
    token?: string
  }} */
  const event = {
    version: LEASE_PROTOCOL_VERSION,
    requestId: raw.requestId,
    sessionId: raw.sessionId,
    generation: raw.generation,
    attemptId: raw.attemptId,
  }
  if (raw.token !== undefined) {
    if (typeof raw.token !== 'string' || raw.token.length === 0) return null
    event.token = raw.token
  }
  return event
}

/**
 * @param {object} input
 * @param {string} input.requestId
 * @param {boolean} input.ok
 * @param {string} [input.reason]
 */
export function buildProviderLeaseReply(input) {
  if (!isValidRequestId(input.requestId)) {
    throw new Error('Provider lease reply requestId is out of bounds.')
  }
  if (typeof input.ok !== 'boolean') {
    throw new Error('Provider lease reply ok is invalid.')
  }
  /** @type {{ version: 1, requestId: string, providerId: string, ok: boolean, reason?: string }} */
  const reply = {
    version: LEASE_PROTOCOL_VERSION,
    requestId: input.requestId,
    providerId: PROVIDER_ID_MULTI_ADVISOR,
    ok: input.ok,
  }
  if (!input.ok) {
    if (typeof input.reason !== 'string' || !isSafeProviderReason(input.reason)) {
      throw new Error('Failed provider lease reply requires a safe reason.')
    }
    reply.reason = input.reason
  }
  return reply
}

/**
 * Mutable fence used by Multi Advisor to block new review admission during prepare/commit.
 * Prepare freezes immediately with session/generation/attempt identity. Commit/release bind
 * the host token; stale release with a mismatched identity cannot reopen admission.
 * @returns {{
 *   isFrozen: () => boolean,
 *   startSession: () => number,
 *   endSession: () => void,
 *   prepare: (identity: { sessionId: string, generation: number, attemptId: string, token: string }) => boolean,
 *   commit: (identity: { sessionId: string, generation: number, attemptId: string, token: string }) => boolean,
 *   release: (identity: { sessionId: string, generation: number, attemptId: string, token?: string }) => boolean,
 *   getIdentity: () => { sessionId: string, generation: number, attemptId: string, token: string | null, phase: 'prepared' | 'committed' } | null
 * }}
 */
export function createAdvisorAdmissionFence() {
  /** @type {{ sessionId: string, generation: number, attemptId: string, token: string | null, phase: 'prepared' | 'committed' } | null} */
  let fence = null
  let generation = 1
  let sessionStarted = false
  return {
    isFrozen() {
      return fence !== null
    },
    startSession() {
      if (sessionStarted) generation += 1
      sessionStarted = true
      fence = null
      return generation
    },
    endSession() {
      fence = null
    },
    prepare(identity) {
      if (
        identity.generation !== generation ||
        typeof identity.token !== 'string' ||
        identity.token.length === 0
      ) {
        return false
      }
      if (fence !== null) {
        return (
          fence.sessionId === identity.sessionId &&
          fence.generation === identity.generation &&
          fence.attemptId === identity.attemptId &&
          fence.token === identity.token
        )
      }
      fence = {
        sessionId: identity.sessionId,
        generation: identity.generation,
        attemptId: identity.attemptId,
        token: identity.token,
        phase: 'prepared',
      }
      return true
    },
    commit(identity) {
      if (
        fence === null ||
        fence.sessionId !== identity.sessionId ||
        fence.generation !== identity.generation ||
        fence.attemptId !== identity.attemptId
      ) {
        return false
      }
      fence = {
        ...fence,
        token: identity.token,
        phase: 'committed',
      }
      return true
    },
    release(identity) {
      if (
        fence === null ||
        fence.sessionId !== identity.sessionId ||
        fence.generation !== identity.generation ||
        fence.attemptId !== identity.attemptId
      ) {
        return false
      }
      // Token is published during prepare, so every release requires an exact match.
      if (fence.token === null || identity.token !== fence.token) return false
      fence = null
      return true
    },
    getIdentity() {
      return fence === null ? null : { ...fence }
    },
  }
}

/**
 * @param {unknown} nonce
 * @returns {nonce is string}
 */
export function isValidNonce(nonce) {
  return (
    typeof nonce === "string" &&
    nonce.length >= MIN_NONCE_LENGTH &&
    nonce.length <= MAX_NONCE_LENGTH &&
    !/\s/u.test(nonce) &&
    !/[\r\n]/u.test(nonce)
  )
}

/**
 * @param {unknown} requestId
 * @returns {requestId is string}
 */
export function isValidRequestId(requestId) {
  return (
    typeof requestId === "string" &&
    requestId.length >= MIN_REQUEST_ID_LENGTH &&
    requestId.length <= MAX_REQUEST_ID_LENGTH &&
    !/[\r\n]/u.test(requestId)
  )
}

/**
 * @param {unknown} providerId
 * @returns {providerId is string}
 */
export function isValidProviderId(providerId) {
  return (
    typeof providerId === "string" &&
    providerId.length >= MIN_PROVIDER_ID_LENGTH &&
    providerId.length <= MAX_PROVIDER_ID_LENGTH &&
    PROVIDER_ID_PATTERN.test(providerId)
  )
}

/**
 * @param {unknown} reason
 */
export function isSafeProviderReason(reason) {
  return (
    typeof reason === "string" &&
    reason.length <= MAX_REASON_LENGTH &&
    !/[\/\\\r\n]/u.test(reason)
  )
}

/**
 * @param {unknown} value
 * @param {readonly string[]} allowed
 */
function hasUnknownKeys(value, allowed) {
  if (!isPlainObject(value)) return true
  const allowedSet = new Set(allowed)
  return Object.keys(value).some((key) => !allowedSet.has(key))
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
