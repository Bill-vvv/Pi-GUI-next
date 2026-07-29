const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/u

export const LEASE_COORDINATOR_STATES = Object.freeze([
  'open',
  'draining',
  'prepared',
  'committed'
])
export const MAX_LEASE_ID_LENGTH = 128
export const MAX_LEASE_TOKEN_SUFFIX_LENGTH = 64
export const MAX_REGISTERED_OWNER_COUNT = 32
export const MAX_REQUIRED_EXTENSION_COUNT = 32
export const MAX_ACTIVE_WORK_COUNT = 256

/**
 * Pure, process-local coordinator for one app-owned Runtime generation.
 * The caller must pass the Main-owned process-lifetime runtimeId; this module
 * deliberately creates no second generation number or UUID.
 */
export function createLeaseCoordinator(options) {
  return new RuntimeLeaseCoordinator(options)
}

export class RuntimeLeaseCoordinator {
  #runtimeId
  #now
  #tokenFactory
  #state = 'open'
  #ownersByExtension = new Map()
  #ownerIds = new Set()
  #registrationRevision = 0
  #workById = new Map()
  #prepare = null
  #lastReleased = null
  #lastTokenSequence = 0

  constructor({ runtimeId, now = Date.now, tokenFactory }) {
    if (!isSafeId(runtimeId) || typeof now !== 'function' || typeof tokenFactory !== 'function') {
      throw new TypeError('Invalid lease coordinator options')
    }
    this.#runtimeId = runtimeId
    this.#now = now
    this.#tokenFactory = tokenFactory
  }

  getSnapshot() {
    return Object.freeze({
      runtimeId: this.#runtimeId,
      state: this.#state,
      registeredExtensionCount: this.#ownersByExtension.size,
      activeWorkCount: this.#workById.size,
      prepare: this.#prepare === null
        ? null
        : Object.freeze({
            requestId: this.#prepare.requestId,
            inventoryHash: this.#prepare.inventoryHash,
            requiredExtensionIds: Object.freeze([...this.#prepare.requiredExtensionIds]),
            deadlineAt: this.#prepare.deadlineAt
          })
    })
  }

  registerOwner(input) {
    if (!this.#matchesRuntime(input)) return fail('runtime-mismatch')
    if (!isSafeId(input?.extensionId) || !isSafeId(input?.ownerId)) {
      return fail('invalid-owner-registration')
    }
    const existing = this.#ownersByExtension.get(input.extensionId)
    if (existing === input.ownerId) return ok({ duplicate: true })
    if (this.#state !== 'open') return fail('owner-registration-closed')
    if (existing !== undefined) return fail('owner-registration-conflict')
    if (this.#ownersByExtension.size >= MAX_REGISTERED_OWNER_COUNT) {
      return fail('owner-count-limit')
    }
    this.#ownersByExtension.set(input.extensionId, input.ownerId)
    this.#ownerIds.add(input.ownerId)
    this.#registrationRevision += 1
    return ok({ duplicate: false })
  }

  admitWork(input) {
    if (!this.#matchesRuntime(input)) return fail('runtime-mismatch')
    if (!isSafeId(input?.ownerId) || !isSafeId(input?.workId)) {
      return fail('invalid-work-holder')
    }
    const existing = this.#workById.get(input.workId)
    if (existing !== undefined) {
      return existing.ownerId === input.ownerId
        ? ok({ duplicate: true, workToken: existing.workToken })
        : fail('work-holder-conflict')
    }
    if (this.#state !== 'open') return fail('admission-closed')
    if (!this.#ownerIds.has(input.ownerId)) return fail('unknown-owner')
    if (this.#workById.size >= MAX_ACTIVE_WORK_COUNT) return fail('work-count-limit')
    const made = this.#makeToken('work')
    if (!made.ok) return made
    this.#workById.set(input.workId, {
      ownerId: input.ownerId,
      workToken: made.token
    })
    return ok({ duplicate: false, workToken: made.token })
  }

  checkWorkCommit(input) {
    if (!this.#matchesRuntime(input)) return fail('runtime-mismatch')
    if (!isSafeId(input?.ownerId) || !isSafeId(input?.workId) || !isSafeId(input?.workToken)) {
      return fail('invalid-work-holder')
    }
    const holder = this.#workById.get(input.workId)
    if (holder === undefined) return fail('work-not-admitted')
    if (holder.ownerId !== input.ownerId || holder.workToken !== input.workToken) {
      return fail('work-holder-mismatch')
    }
    if (this.#state !== 'open' && this.#state !== 'draining') {
      return fail('work-commit-closed')
    }
    return ok()
  }

  releaseWork(input) {
    if (!this.#matchesRuntime(input)) return fail('runtime-mismatch')
    if (!isSafeId(input?.ownerId) || !isSafeId(input?.workId) || !isSafeId(input?.workToken)) {
      return fail('invalid-work-holder')
    }
    const holder = this.#workById.get(input.workId)
    if (holder === undefined) return fail('work-not-admitted')
    if (holder.ownerId !== input.ownerId || holder.workToken !== input.workToken) {
      return fail('work-holder-mismatch')
    }
    if (this.#state !== 'open' && this.#state !== 'draining') {
      return fail('work-release-closed')
    }
    this.#workById.delete(input.workId)
    return ok({ remainingWorkCount: this.#workById.size })
  }

  beginPrepare(input) {
    const normalized = this.#normalizePrepareFields(input)
    if (!normalized.ok) return normalized
    const fields = normalized.fields

    if (this.#state !== 'open') {
      if (
        this.#state === 'draining' &&
        this.#prepare !== null &&
        matchesPrepareFields(this.#prepare, fields)
      ) {
        return ok({
          duplicate: true,
          prepareToken: this.#prepare.prepareToken,
          activeWorkCount: this.#workById.size
        })
      }
      return fail('prepare-in-progress')
    }
    const deadline = this.#checkDeadline(fields.deadlineAt)
    if (deadline !== null) return deadline
    const roster = this.#checkRequiredRoster(fields.requiredExtensionIds)
    if (roster !== null) return roster

    const made = this.#makeToken('prepare')
    if (!made.ok) return made
    this.#prepare = {
      ...fields,
      prepareToken: made.token,
      hibernationToken: null,
      registrationRevision: this.#registrationRevision,
      rosterKey: this.#rosterKey()
    }
    this.#lastReleased = null
    this.#state = 'draining'
    return ok({
      duplicate: false,
      prepareToken: made.token,
      activeWorkCount: this.#workById.size
    })
  }

  completePrepare(input) {
    const matched = this.#matchActivePrepare(input, 'prepareToken')
    if (!matched.ok) return matched
    const prepare = matched.prepare

    if (this.#state === 'prepared' || this.#state === 'committed') {
      return ok({ duplicate: true, hibernationToken: prepare.hibernationToken })
    }
    if (this.#state !== 'draining') return fail('prepare-not-draining')
    const deadline = this.#checkDeadline(prepare.deadlineAt)
    if (deadline !== null) return deadline
    const roster = this.#checkRosterDrift(prepare)
    if (roster !== null) return roster
    if (this.#workById.size !== 0) {
      return fail('active-work', { activeWorkCount: this.#workById.size })
    }

    const made = this.#makeToken('hibernation')
    if (!made.ok) return made
    prepare.hibernationToken = made.token
    this.#state = 'prepared'
    return ok({ duplicate: false, hibernationToken: made.token })
  }

  commit(input) {
    const matched = this.#matchActivePrepare(input, 'hibernationToken')
    if (!matched.ok) return matched
    const prepare = matched.prepare
    if (prepare.hibernationToken === null) return fail('not-prepared')
    if (this.#state === 'committed') return ok({ duplicate: true })
    if (this.#state !== 'prepared') return fail('not-prepared')
    const deadline = this.#checkDeadline(prepare.deadlineAt)
    if (deadline !== null) return deadline
    const roster = this.#checkRosterDrift(prepare)
    if (roster !== null) return roster
    if (this.#workById.size !== 0) {
      return fail('active-work', { activeWorkCount: this.#workById.size })
    }
    this.#state = 'committed'
    return ok({ duplicate: false })
  }

  release(input) {
    if (!this.#matchesRuntime(input)) return fail('runtime-mismatch')
    const normalized = normalizePrepareFields(input)
    if (!normalized.ok) return normalized
    const token = input?.token
    if (!isSafeId(token)) return fail('invalid-release-token')

    if (this.#state === 'open') {
      return this.#lastReleased !== null &&
        matchesPrepareFields(this.#lastReleased, normalized.fields) &&
        this.#lastReleased.token === token
        ? ok({ duplicate: true })
        : fail('stale-release')
    }
    if (this.#prepare === null || !matchesPrepareFields(this.#prepare, normalized.fields)) {
      return fail('prepare-mismatch')
    }
    const expectedToken = this.#state === 'draining'
      ? this.#prepare.prepareToken
      : this.#prepare.hibernationToken
    if (expectedToken === null || token !== expectedToken) return fail('release-token-mismatch')

    this.#lastReleased = { ...normalized.fields, token }
    this.#prepare = null
    this.#state = 'open'
    return ok({ duplicate: false })
  }

  #matchesRuntime(input) {
    return input !== null && typeof input === 'object' && input.runtimeId === this.#runtimeId
  }

  #normalizePrepareFields(input) {
    if (!this.#matchesRuntime(input)) return fail('runtime-mismatch')
    return normalizePrepareFields(input)
  }

  #matchActivePrepare(input, tokenField) {
    const normalized = this.#normalizePrepareFields(input)
    if (!normalized.ok) return normalized
    if (this.#prepare === null) return fail('stale-prepare')
    if (!matchesPrepareFields(this.#prepare, normalized.fields)) return fail('prepare-mismatch')
    const token = input?.[tokenField]
    if (!isSafeId(token) || token !== this.#prepare[tokenField]) {
      return fail(`${tokenField === 'prepareToken' ? 'prepare' : 'hibernation'}-token-mismatch`)
    }
    return { ok: true, prepare: this.#prepare }
  }

  #checkRequiredRoster(requiredExtensionIds) {
    for (const extensionId of requiredExtensionIds) {
      if (!this.#ownersByExtension.has(extensionId)) return fail('unknown-required-extension')
    }
    if (requiredExtensionIds.length !== this.#ownersByExtension.size) {
      return fail('roster-mismatch')
    }
    return null
  }

  #checkRosterDrift(prepare) {
    if (
      prepare.registrationRevision !== this.#registrationRevision ||
      prepare.rosterKey !== this.#rosterKey()
    ) {
      return fail('roster-drift')
    }
    return this.#checkRequiredRoster(prepare.requiredExtensionIds)
  }

  #rosterKey() {
    return [...this.#ownersByExtension.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([extensionId, ownerId]) => `${extensionId}:${ownerId}`)
      .join('|')
  }

  #checkDeadline(deadlineAt) {
    const now = this.#now()
    if (!Number.isSafeInteger(now) || now < 0) return fail('clock-invalid')
    return now >= deadlineAt ? fail('deadline-expired') : null
  }

  #makeToken(kind) {
    if (
      !Number.isSafeInteger(this.#lastTokenSequence) ||
      this.#lastTokenSequence < 0 ||
      this.#lastTokenSequence >= Number.MAX_SAFE_INTEGER
    ) {
      return fail('token-sequence-exhausted')
    }
    let suffix
    try {
      suffix = this.#tokenFactory(kind)
    } catch {
      return fail('token-factory-invalid')
    }
    if (!isSafeTokenSuffix(suffix)) return fail('token-factory-invalid')
    const sequence = this.#lastTokenSequence + 1
    const token = `${kind}:${sequence}:${suffix}`
    if (!isSafeId(token)) return fail('token-factory-invalid')
    this.#lastTokenSequence = sequence
    return ok({ token })
  }
}

function normalizePrepareFields(input) {
  if (input === null || typeof input !== 'object') return fail('invalid-prepare-request')
  if (!isSafeId(input.requestId) || !isSafeId(input.inventoryHash)) {
    return fail('invalid-prepare-request')
  }
  if (!Array.isArray(input.requiredExtensionIds)) return fail('invalid-required-extensions')
  if (input.requiredExtensionIds.length > MAX_REQUIRED_EXTENSION_COUNT) {
    return fail('required-extension-count-limit')
  }
  if (!Number.isSafeInteger(input.deadlineAt) || input.deadlineAt < 0) {
    return fail('invalid-deadline')
  }
  const requiredExtensionIds = []
  const seen = new Set()
  for (const extensionId of input.requiredExtensionIds) {
    if (!isSafeId(extensionId)) return fail('invalid-required-extension-id')
    if (seen.has(extensionId)) return fail('duplicate-required-extension-id')
    seen.add(extensionId)
    requiredExtensionIds.push(extensionId)
  }
  requiredExtensionIds.sort()
  return {
    ok: true,
    fields: {
      runtimeId: input.runtimeId,
      requestId: input.requestId,
      inventoryHash: input.inventoryHash,
      requiredExtensionIds,
      deadlineAt: input.deadlineAt
    }
  }
}

function matchesPrepareFields(left, right) {
  return left.runtimeId === right.runtimeId &&
    left.requestId === right.requestId &&
    left.inventoryHash === right.inventoryHash &&
    left.deadlineAt === right.deadlineAt &&
    arraysEqual(left.requiredExtensionIds, right.requiredExtensionIds)
}

function arraysEqual(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function isSafeId(value) {
  return typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= MAX_LEASE_ID_LENGTH &&
    SAFE_ID_PATTERN.test(value)
}

function isSafeTokenSuffix(value) {
  return typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= MAX_LEASE_TOKEN_SUFFIX_LENGTH &&
    SAFE_ID_PATTERN.test(value)
}

function ok(extra = {}) {
  return { ok: true, ...extra }
}

function fail(reason, extra = {}) {
  return { ok: false, reason, ...extra }
}
