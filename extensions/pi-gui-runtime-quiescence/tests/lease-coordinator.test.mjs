import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MAX_LEASE_ID_LENGTH,
  MAX_LEASE_TOKEN_SUFFIX_LENGTH,
  createLeaseCoordinator
} from '../src/lease-coordinator.mjs'

const runtimeId = 'rt-7'
const basePrepare = {
  runtimeId,
  requestId: 'request-1',
  inventoryHash: 'sha256:inventory-1',
  requiredExtensionIds: ['ext-a', 'ext-b'],
  deadlineAt: 2_000
}

function setup(options = {}) {
  let now = options.now ?? 1_000
  const coordinator = createLeaseCoordinator({
    runtimeId,
    now: () => now,
    tokenFactory: options.tokenFactory ?? ((kind) => `${kind}-suffix`)
  })
  return {
    coordinator,
    setNow(value) {
      now = value
    }
  }
}

function registerRoster(coordinator) {
  assert.deepEqual(
    coordinator.registerOwner({ runtimeId, extensionId: 'ext-a', ownerId: 'owner-a' }),
    { ok: true, duplicate: false }
  )
  assert.deepEqual(
    coordinator.registerOwner({ runtimeId, extensionId: 'ext-b', ownerId: 'owner-b' }),
    { ok: true, duplicate: false }
  )
}

function work(overrides = {}) {
  return {
    runtimeId,
    ownerId: 'owner-a',
    workId: 'work-1',
    ...overrides
  }
}

function holder(admission, overrides = {}) {
  return {
    ...work(overrides),
    workToken: admission.workToken
  }
}

function prepareThroughDrained(coordinator) {
  registerRoster(coordinator)
  const begun = coordinator.beginPrepare(basePrepare)
  assert.equal(begun.ok, true)
  const completed = coordinator.completePrepare({ ...basePrepare, prepareToken: begun.prepareToken })
  assert.equal(completed.ok, true)
  return { begun, completed }
}

test('admission race has one coordinator-owned holder and active duplicate returns its exact token', () => {
  const { coordinator } = setup()
  registerRoster(coordinator)
  const admitted = coordinator.admitWork(work())
  assert.deepEqual(admitted, { ok: true, duplicate: false, workToken: 'work:1:work-suffix' })
  assert.deepEqual(coordinator.admitWork(work()), {
    ok: true,
    duplicate: true,
    workToken: admitted.workToken
  })
  assert.deepEqual(
    coordinator.admitWork(work({ ownerId: 'owner-b' })),
    { ok: false, reason: 'work-holder-conflict' }
  )
  assert.equal(coordinator.getSnapshot().activeWorkCount, 1)
})

test('released work id gets a new token and delayed old release cannot remove the new holder', () => {
  const { coordinator } = setup({ tokenFactory: () => 'same' })
  registerRoster(coordinator)
  const first = coordinator.admitWork(work())
  assert.deepEqual(first, { ok: true, duplicate: false, workToken: 'work:1:same' })
  assert.deepEqual(coordinator.releaseWork(holder(first)), { ok: true, remainingWorkCount: 0 })
  const second = coordinator.admitWork(work())
  assert.deepEqual(second, { ok: true, duplicate: false, workToken: 'work:2:same' })
  assert.deepEqual(coordinator.releaseWork(holder(first)), {
    ok: false,
    reason: 'work-holder-mismatch'
  })
  assert.equal(coordinator.getSnapshot().activeWorkCount, 1)
  assert.deepEqual(coordinator.checkWorkCommit(holder(second)), { ok: true })
})

test('unknown owner and unsafe identifiers fail closed without exposing input', () => {
  const { coordinator } = setup()
  assert.deepEqual(coordinator.admitWork(work()), { ok: false, reason: 'unknown-owner' })
  const result = coordinator.registerOwner({
    runtimeId,
    extensionId: '/home/private/extension',
    ownerId: 'owner-a'
  })
  assert.deepEqual(result, { ok: false, reason: 'invalid-owner-registration' })
  assert.ok(!JSON.stringify(result).includes('/home/private'))
  assert.deepEqual(
    coordinator.registerOwner({ runtimeId, extensionId: 'x'.repeat(MAX_LEASE_ID_LENGTH + 1), ownerId: 'o' }),
    { ok: false, reason: 'invalid-owner-registration' }
  )
})

test('prepare freezes admission and roster mutations while exact owner duplicates stay idempotent', () => {
  const { coordinator } = setup()
  registerRoster(coordinator)
  const admitted = coordinator.admitWork(work())
  const begun = coordinator.beginPrepare(basePrepare)
  assert.deepEqual(begun, {
    ok: true,
    duplicate: false,
    prepareToken: 'prepare:2:prepare-suffix',
    activeWorkCount: 1
  })
  assert.deepEqual(coordinator.registerOwner({ runtimeId, extensionId: 'ext-a', ownerId: 'owner-a' }), {
    ok: true,
    duplicate: true
  })
  assert.deepEqual(coordinator.registerOwner({ runtimeId, extensionId: 'ext-c', ownerId: 'owner-c' }), {
    ok: false,
    reason: 'owner-registration-closed'
  })
  assert.deepEqual(coordinator.registerOwner({ runtimeId, extensionId: 'ext-a', ownerId: 'owner-other' }), {
    ok: false,
    reason: 'owner-registration-closed'
  })
  assert.equal(coordinator.getSnapshot().registeredExtensionCount, 2)
  assert.deepEqual(coordinator.admitWork(work({ workId: 'work-2' })), {
    ok: false,
    reason: 'admission-closed'
  })
  assert.deepEqual(coordinator.checkWorkCommit(holder(admitted)), { ok: true })
  assert.deepEqual(
    coordinator.completePrepare({ ...basePrepare, prepareToken: begun.prepareToken }),
    { ok: false, reason: 'active-work', activeWorkCount: 1 }
  )
  assert.deepEqual(coordinator.releaseWork(holder(admitted)), { ok: true, remainingWorkCount: 0 })
  assert.deepEqual(
    coordinator.completePrepare({ ...basePrepare, prepareToken: begun.prepareToken }),
    { ok: true, duplicate: false, hibernationToken: 'hibernation:3:hibernation-suffix' }
  )
})

test('owner remap conflicts while open without changing the roster', () => {
  const { coordinator } = setup()
  registerRoster(coordinator)
  assert.deepEqual(coordinator.registerOwner({ runtimeId, extensionId: 'ext-a', ownerId: 'owner-other' }), {
    ok: false,
    reason: 'owner-registration-conflict'
  })
  assert.equal(coordinator.getSnapshot().registeredExtensionCount, 2)
  assert.equal(coordinator.beginPrepare(basePrepare).ok, true)
})

test('unknown required extension and incomplete roster fail closed before draining', () => {
  const { coordinator } = setup()
  coordinator.registerOwner({ runtimeId, extensionId: 'ext-a', ownerId: 'owner-a' })
  assert.deepEqual(coordinator.beginPrepare(basePrepare), {
    ok: false,
    reason: 'unknown-required-extension'
  })
  assert.deepEqual(
    coordinator.beginPrepare({ ...basePrepare, requiredExtensionIds: ['ext-a'] }),
    { ok: true, duplicate: false, prepareToken: 'prepare:1:prepare-suffix', activeWorkCount: 0 }
  )
})

test('registered roster omitted from required inventory is rejected', () => {
  const { coordinator } = setup()
  registerRoster(coordinator)
  assert.deepEqual(
    coordinator.beginPrepare({ ...basePrepare, requiredExtensionIds: ['ext-a'] }),
    { ok: false, reason: 'roster-mismatch' }
  )
  assert.equal(coordinator.getSnapshot().state, 'open')
})

test('deadline is enforced at begin, complete, and commit without state mutation', () => {
  const first = setup({ now: 2_000 })
  registerRoster(first.coordinator)
  assert.deepEqual(first.coordinator.beginPrepare(basePrepare), {
    ok: false,
    reason: 'deadline-expired'
  })
  assert.equal(first.coordinator.getSnapshot().state, 'open')

  const second = setup()
  registerRoster(second.coordinator)
  const begun = second.coordinator.beginPrepare(basePrepare)
  second.setNow(2_000)
  assert.deepEqual(
    second.coordinator.completePrepare({ ...basePrepare, prepareToken: begun.prepareToken }),
    { ok: false, reason: 'deadline-expired' }
  )
  assert.equal(second.coordinator.getSnapshot().state, 'draining')

  const third = setup()
  const lease = prepareThroughDrained(third.coordinator)
  third.setNow(2_000)
  assert.deepEqual(
    third.coordinator.commit({ ...basePrepare, hibernationToken: lease.completed.hibernationToken }),
    { ok: false, reason: 'deadline-expired' }
  )
  assert.equal(third.coordinator.getSnapshot().state, 'prepared')
})

test('invalid token suffix fails closed without consuming sequence or mutating lease state', () => {
  const suffixes = ['bad/suffix', 'good', 'x'.repeat(MAX_LEASE_TOKEN_SUFFIX_LENGTH + 1), 'hibernate']
  const { coordinator } = setup({ tokenFactory: () => suffixes.shift() })
  registerRoster(coordinator)
  assert.deepEqual(coordinator.admitWork(work()), { ok: false, reason: 'token-factory-invalid' })
  assert.equal(coordinator.getSnapshot().activeWorkCount, 0)
  const admitted = coordinator.admitWork(work())
  assert.equal(admitted.workToken, 'work:1:good')
  assert.equal(coordinator.releaseWork(holder(admitted)).ok, true)
  const begun = coordinator.beginPrepare(basePrepare)
  assert.deepEqual(begun, { ok: false, reason: 'token-factory-invalid' })
  assert.equal(coordinator.getSnapshot().state, 'open')
  const retried = coordinator.beginPrepare(basePrepare)
  assert.equal(retried.prepareToken, 'prepare:2:hibernate')
})

test('wrong and stale tokens never mutate coordinator state', () => {
  const { coordinator } = setup()
  registerRoster(coordinator)
  const begun = coordinator.beginPrepare(basePrepare)
  assert.deepEqual(
    coordinator.completePrepare({ ...basePrepare, prepareToken: 'wrong-token' }),
    { ok: false, reason: 'prepare-token-mismatch' }
  )
  assert.equal(coordinator.getSnapshot().state, 'draining')
  assert.deepEqual(
    coordinator.release({ ...basePrepare, token: 'wrong-token' }),
    { ok: false, reason: 'release-token-mismatch' }
  )
  assert.equal(coordinator.getSnapshot().state, 'draining')
})

test('commit validates exact fields, no work, and is idempotent', () => {
  const { coordinator } = setup()
  const { completed } = prepareThroughDrained(coordinator)
  const exact = { ...basePrepare, hibernationToken: completed.hibernationToken }
  assert.deepEqual(
    coordinator.commit({ ...exact, inventoryHash: 'sha256:other' }),
    { ok: false, reason: 'prepare-mismatch' }
  )
  assert.equal(coordinator.getSnapshot().state, 'prepared')
  assert.deepEqual(coordinator.commit(exact), { ok: true, duplicate: false })
  assert.equal(coordinator.getSnapshot().state, 'committed')
  assert.deepEqual(coordinator.commit(exact), { ok: true, duplicate: true })
})

test('stop-failure release from committed requires exact token, hash, and request id', () => {
  const { coordinator } = setup()
  const { completed } = prepareThroughDrained(coordinator)
  const commit = { ...basePrepare, hibernationToken: completed.hibernationToken }
  assert.equal(coordinator.commit(commit).ok, true)
  assert.deepEqual(
    coordinator.release({ ...basePrepare, inventoryHash: 'sha256:other', token: completed.hibernationToken }),
    { ok: false, reason: 'prepare-mismatch' }
  )
  assert.deepEqual(
    coordinator.release({ ...basePrepare, requestId: 'request-other', token: completed.hibernationToken }),
    { ok: false, reason: 'prepare-mismatch' }
  )
  assert.equal(coordinator.getSnapshot().state, 'committed')
  const release = { ...basePrepare, token: completed.hibernationToken }
  assert.deepEqual(coordinator.release(release), { ok: true, duplicate: false })
  assert.deepEqual(coordinator.release(release), { ok: true, duplicate: true })
})

test('identical prepare fields with repeating suffix reject old draining release against new lease', () => {
  const { coordinator } = setup({ tokenFactory: () => 'same' })
  registerRoster(coordinator)
  const first = coordinator.beginPrepare(basePrepare)
  assert.equal(first.prepareToken, 'prepare:1:same')
  assert.deepEqual(coordinator.release({ ...basePrepare, token: first.prepareToken }), {
    ok: true,
    duplicate: false
  })
  const second = coordinator.beginPrepare(basePrepare)
  assert.equal(second.prepareToken, 'prepare:2:same')
  assert.deepEqual(coordinator.release({ ...basePrepare, token: first.prepareToken }), {
    ok: false,
    reason: 'release-token-mismatch'
  })
  assert.equal(coordinator.getSnapshot().state, 'draining')
  assert.equal(coordinator.beginPrepare(basePrepare).prepareToken, second.prepareToken)
})

test('identical prepared fields with repeating suffix reject old commit and release against new lease', () => {
  const { coordinator } = setup({ tokenFactory: () => 'same' })
  registerRoster(coordinator)
  const firstBegin = coordinator.beginPrepare(basePrepare)
  const firstComplete = coordinator.completePrepare({ ...basePrepare, prepareToken: firstBegin.prepareToken })
  assert.equal(firstComplete.hibernationToken, 'hibernation:2:same')
  assert.equal(coordinator.release({ ...basePrepare, token: firstComplete.hibernationToken }).ok, true)

  const secondBegin = coordinator.beginPrepare(basePrepare)
  const secondComplete = coordinator.completePrepare({ ...basePrepare, prepareToken: secondBegin.prepareToken })
  assert.equal(secondBegin.prepareToken, 'prepare:3:same')
  assert.equal(secondComplete.hibernationToken, 'hibernation:4:same')
  assert.deepEqual(
    coordinator.commit({ ...basePrepare, hibernationToken: firstComplete.hibernationToken }),
    { ok: false, reason: 'hibernation-token-mismatch' }
  )
  assert.deepEqual(coordinator.release({ ...basePrepare, token: firstComplete.hibernationToken }), {
    ok: false,
    reason: 'release-token-mismatch'
  })
  assert.equal(coordinator.getSnapshot().state, 'prepared')
  assert.deepEqual(
    coordinator.commit({ ...basePrepare, hibernationToken: secondComplete.hibernationToken }),
    { ok: true, duplicate: false }
  )
})

test('late work commit is allowed only while its admitted draining holder remains exact', () => {
  const { coordinator } = setup()
  registerRoster(coordinator)
  const admitted = coordinator.admitWork(work())
  const begun = coordinator.beginPrepare(basePrepare)
  assert.deepEqual(coordinator.checkWorkCommit(holder(admitted)), { ok: true })
  assert.equal(coordinator.releaseWork(holder(admitted)).ok, true)
  const completed = coordinator.completePrepare({ ...basePrepare, prepareToken: begun.prepareToken })
  assert.equal(completed.ok, true)
  assert.deepEqual(coordinator.checkWorkCommit(holder(admitted)), {
    ok: false,
    reason: 'work-not-admitted'
  })
})

test('runtimeId mismatch fails every generation-fenced operation without mutation', () => {
  const { coordinator } = setup()
  registerRoster(coordinator)
  assert.deepEqual(
    coordinator.admitWork(work({ runtimeId: 'rt-stale' })),
    { ok: false, reason: 'runtime-mismatch' }
  )
  assert.deepEqual(
    coordinator.beginPrepare({ ...basePrepare, runtimeId: 'rt-stale' }),
    { ok: false, reason: 'runtime-mismatch' }
  )
  assert.equal(coordinator.getSnapshot().state, 'open')
  assert.equal(coordinator.getSnapshot().activeWorkCount, 0)
})

test('duplicate prepare and complete return the original exact tokens', () => {
  const { coordinator } = setup()
  registerRoster(coordinator)
  const begun = coordinator.beginPrepare(basePrepare)
  assert.deepEqual(coordinator.beginPrepare({ ...basePrepare, requiredExtensionIds: ['ext-b', 'ext-a'] }), {
    ok: true,
    duplicate: true,
    prepareToken: begun.prepareToken,
    activeWorkCount: 0
  })
  const completed = coordinator.completePrepare({ ...basePrepare, prepareToken: begun.prepareToken })
  assert.deepEqual(
    coordinator.completePrepare({ ...basePrepare, prepareToken: begun.prepareToken }),
    { ok: true, duplicate: true, hibernationToken: completed.hibernationToken }
  )
})
