import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createOperationLeaseController,
  installOperationLeaseProvider
} from '../src/quiescence-provider.mjs'

const PROVIDER_ID = 'pi-gui-ask'
const PREPARE = 'pi-gui.runtime-hibernate-lease/provider-prepare/v1'
const COMMIT = 'pi-gui.runtime-hibernate-lease/provider-commit/v1'
const RELEASE = 'pi-gui.runtime-hibernate-lease/provider-release/v1'
const REPLY_PREFIX = 'pi-gui.runtime-hibernate-lease/provider-reply/v1:'

function identity(overrides = {}) {
  return {
    version: 1,
    requestId: 'request-1',
    sessionId: 'session-1',
    generation: 1,
    attemptId: 'attempt-1',
    token: 'token-1234',
    ...overrides
  }
}

function createBus() {
  const listeners = new Map()
  const emitted = []
  return {
    emitted,
    on(name, listener) {
      const set = listeners.get(name) ?? new Set()
      set.add(listener)
      listeners.set(name, set)
      return () => set.delete(listener)
    },
    emit(name, payload) {
      emitted.push({ name, payload })
      for (const listener of [...(listeners.get(name) ?? [])]) listener(payload)
    }
  }
}

function lastReply(bus, requestId) {
  return bus.emitted.filter(({ name }) => name === `${REPLY_PREFIX}${requestId}`).at(-1)?.payload
}

test('no event bus leaves ordinary operation admission unchanged', () => {
  const controller = createOperationLeaseController()
  assert.equal(installOperationLeaseProvider(undefined, PROVIDER_ID, controller), false)
  const finish = controller.beginOperation()
  assert.equal(typeof finish, 'function')
  finish()
  assert.equal(controller.activeCount(), 0)
})

test('active operation blocks prepare without leaving a frozen fence', () => {
  const controller = createOperationLeaseController()
  const bus = createBus()
  assert.equal(installOperationLeaseProvider(bus, PROVIDER_ID, controller), true)
  const finish = controller.beginOperation()
  assert.equal(typeof finish, 'function')

  bus.emit(PREPARE, identity())
  assert.deepEqual(lastReply(bus, 'request-1'), {
    version: 1,
    requestId: 'request-1',
    providerId: PROVIDER_ID,
    ok: false,
    reason: 'operation-active-or-fenced'
  })
  assert.equal(controller.isFrozen(), false)
  finish()
})

test('prepare freezes new work and commit/release require exact generation attempt and token', () => {
  const controller = createOperationLeaseController()
  const bus = createBus()
  installOperationLeaseProvider(bus, PROVIDER_ID, controller)

  bus.emit(PREPARE, identity())
  assert.equal(lastReply(bus, 'request-1')?.ok, true)
  assert.equal(controller.isFrozen(), true)
  assert.equal(controller.beginOperation(), null)

  bus.emit(COMMIT, identity({ requestId: 'request-2' }))
  assert.equal(lastReply(bus, 'request-2')?.ok, true)

  bus.emit(RELEASE, identity({ requestId: 'request-stale', token: 'token-stale' }))
  assert.equal(lastReply(bus, 'request-stale')?.ok, false)
  assert.equal(controller.isFrozen(), true)

  bus.emit(RELEASE, identity({ requestId: 'request-3' }))
  assert.equal(lastReply(bus, 'request-3')?.ok, true)
  assert.equal(controller.isFrozen(), false)
  const finish = controller.beginOperation()
  assert.equal(typeof finish, 'function')
  finish()
})

test('same-ID session restart rejects delayed prepare from the old lifecycle', () => {
  const controller = createOperationLeaseController()
  const bus = createBus()
  installOperationLeaseProvider(bus, PROVIDER_ID, controller)
  assert.equal(controller.startSession(), 1)
  controller.endSession()
  assert.equal(controller.startSession(), 2)

  bus.emit(PREPARE, identity({ requestId: 'request-stale-generation' }))
  assert.equal(lastReply(bus, 'request-stale-generation')?.ok, false)
  assert.equal(controller.isFrozen(), false)

  bus.emit(PREPARE, identity({ requestId: 'request-generation-2', generation: 2 }))
  assert.equal(lastReply(bus, 'request-generation-2')?.ok, true)
  assert.equal(controller.isFrozen(), true)
})
