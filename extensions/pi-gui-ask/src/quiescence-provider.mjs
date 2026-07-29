const PROTOCOL_VERSION = 1
const PROVIDER_QUERY_EVENT = 'pi-gui.runtime-quiescence/provider-query/v1'
const PROVIDER_REPLY_EVENT_PREFIX = 'pi-gui.runtime-quiescence/provider-reply/v1:'
const PROVIDER_REGISTER_EVENT = 'pi-gui.runtime-quiescence/provider-register/v1'
const PROVIDER_LEASE_PREPARE_EVENT = 'pi-gui.runtime-hibernate-lease/provider-prepare/v1'
const PROVIDER_LEASE_COMMIT_EVENT = 'pi-gui.runtime-hibernate-lease/provider-commit/v1'
const PROVIDER_LEASE_RELEASE_EVENT = 'pi-gui.runtime-hibernate-lease/provider-release/v1'
const PROVIDER_LEASE_REPLY_EVENT_PREFIX = 'pi-gui.runtime-hibernate-lease/provider-reply/v1:'
const MAX_ID_LENGTH = 256
const TOKEN_PATTERN = /^[A-Za-z0-9._:-]+$/u

/**
 * A package-local operation fence. It is inert unless installOperationLeaseProvider
 * successfully attaches to Pi's event bus, so ordinary extension behavior is unchanged
 * on hosts without that bus.
 */
export function createOperationLeaseController() {
  let activeOperations = 0
  let fence = null
  let generation = 1
  let sessionStarted = false

  return {
    startSession() {
      if (sessionStarted) generation += 1
      sessionStarted = true
      fence = null
      return generation
    },
    endSession() {
      fence = null
    },
    beginOperation() {
      if (fence !== null) return null
      activeOperations += 1
      let finished = false
      return () => {
        if (finished) return
        finished = true
        activeOperations = Math.max(0, activeOperations - 1)
      }
    },
    activeCount() {
      return activeOperations
    },
    isFrozen() {
      return fence !== null
    },
    prepare(identity) {
      if (!isIdentity(identity, true)) return false
      if (identity.generation !== generation) return false
      if (fence !== null) return sameIdentity(fence, identity)
      fence = { ...identity, phase: 'prepared' }
      if (activeOperations !== 0) {
        fence = null
        return false
      }
      return true
    },
    commit(identity) {
      if (!isIdentity(identity, true) || fence === null) return false
      if (!sameIdentity(fence, identity)) return false
      fence = { ...fence, phase: 'committed' }
      return true
    },
    release(identity) {
      if (!isIdentity(identity, true) || fence === null) return false
      if (!sameIdentity(fence, identity)) return false
      fence = null
      return true
    }
  }
}

export function installOperationLeaseProvider(events, providerId, controller) {
  if (!isEventBus(events) || !isProviderId(providerId)) return false
  try {
    events.on(PROVIDER_QUERY_EVENT, (raw) => {
      if (!isQuery(raw)) return
      emitSafely(events, `${PROVIDER_REPLY_EVENT_PREFIX}${raw.requestId}`, {
        version: PROTOCOL_VERSION,
        requestId: raw.requestId,
        providerId,
        state: controller.activeCount() === 0 ? 'idle' : 'busy',
        ...(controller.activeCount() === 0 ? {} : { reason: 'operation-active' })
      })
    })
    events.on(PROVIDER_LEASE_PREPARE_EVENT, (raw) => {
      const event = parseLeaseEvent(raw, true)
      if (event === null) return
      const ok = controller.prepare(event)
      replyLease(events, providerId, event.requestId, ok, ok ? undefined : 'operation-active-or-fenced')
    })
    events.on(PROVIDER_LEASE_COMMIT_EVENT, (raw) => {
      const event = parseLeaseEvent(raw, true)
      if (event === null) return
      const ok = controller.commit(event)
      replyLease(events, providerId, event.requestId, ok, ok ? undefined : 'lease-identity-mismatch')
    })
    events.on(PROVIDER_LEASE_RELEASE_EVENT, (raw) => {
      const event = parseLeaseEvent(raw, true)
      if (event === null) return
      const ok = controller.release(event)
      replyLease(events, providerId, event.requestId, ok, ok ? undefined : 'lease-identity-mismatch')
    })
    events.emit(PROVIDER_REGISTER_EVENT, { version: PROTOCOL_VERSION, providerId })
    return true
  } catch {
    return false
  }
}

function replyLease(events, providerId, requestId, ok, reason) {
  emitSafely(events, `${PROVIDER_LEASE_REPLY_EVENT_PREFIX}${requestId}`, {
    version: PROTOCOL_VERSION,
    requestId,
    providerId,
    ok,
    ...(reason === undefined ? {} : { reason })
  })
}

function emitSafely(events, name, payload) {
  try {
    events.emit(name, payload)
  } catch {
    // Provider telemetry must not break the extension's primary behavior.
  }
}

function parseLeaseEvent(raw, requireToken) {
  if (!isRecord(raw) || raw.version !== PROTOCOL_VERSION) return null
  const allowed = new Set(['version', 'requestId', 'sessionId', 'generation', 'attemptId', 'token'])
  if (Object.keys(raw).some((key) => !allowed.has(key))) return null
  const identity = {
    requestId: raw.requestId,
    sessionId: raw.sessionId,
    generation: raw.generation,
    attemptId: raw.attemptId,
    token: raw.token
  }
  return isIdentity(identity, requireToken) ? identity : null
}

function isQuery(raw) {
  if (!isRecord(raw)) return false
  const allowed = new Set(['version', 'requestId', 'nonce'])
  return Object.keys(raw).every((key) => allowed.has(key)) &&
    raw.version === PROTOCOL_VERSION && isBoundedString(raw.requestId)
}

function isIdentity(value, requireToken) {
  return isRecord(value) &&
    isBoundedString(value.requestId) && isBoundedString(value.sessionId) &&
    Number.isInteger(value.generation) && value.generation >= 1 && isBoundedString(value.attemptId) &&
    (!requireToken || (isBoundedString(value.token) && TOKEN_PATTERN.test(value.token)))
}

function sameIdentity(left, right) {
  return left.sessionId === right.sessionId && left.generation === right.generation &&
    left.attemptId === right.attemptId && left.token === right.token
}

function isEventBus(events) {
  return isRecord(events) && typeof events.on === 'function' && typeof events.emit === 'function'
}

function isProviderId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,63}$/u.test(value)
}

function isBoundedString(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH && !/[\r\n]/u.test(value)
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
