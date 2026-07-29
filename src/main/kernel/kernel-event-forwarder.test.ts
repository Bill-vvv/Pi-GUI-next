import assert from 'node:assert/strict'
import test from 'node:test'

import type {
  KernelEvent,
  KernelState,
  KernelStateEvent,
  KernelStatePatch
} from '../../shared/kernel-contract.ts'
import {
  createKernelEventForwarder,
  DEFAULT_STATE_BATCH_WINDOW_MS,
  MAX_STATE_BATCH_EVENTS
} from './kernel-event-forwarder.ts'

test('state forwarding uses an 8 ms window without delaying a lone event further', () => {
  const harness = createHarness()
  harness.forward(stateChanged(1))
  assert.equal(harness.sent.length, 0)
  assert.equal(harness.scheduled[0]?.delayMs, 8)
  assert.equal(DEFAULT_STATE_BATCH_WINDOW_MS, 8)

  harness.runNextTimer()
  assert.deepEqual(harness.sent, [stateChanged(1)])
})

test('state events share one bounded envelope in revision order', () => {
  const harness = createHarness()
  harness.forward(statePatched(1))
  harness.forward(statePatched(2))
  harness.forward(statePatched(3))
  harness.runNextTimer()

  assert.deepEqual(harness.sent, [{
    type: 'kernel.state-batch',
    events: [statePatched(1), statePatched(2), statePatched(3)]
  }])
})

test('a newer full state supersedes older pending state and keeps later patches', () => {
  const harness = createHarness()
  harness.forward(stateChanged(1))
  harness.forward(statePatched(2))
  harness.forward(stateChanged(3))
  harness.forward(statePatched(4))
  harness.runNextTimer()

  assert.deepEqual(harness.sent, [{
    type: 'kernel.state-batch',
    events: [stateChanged(3), statePatched(4)]
  }])
})

test('domain events flush pending state first and preserve the ordering barrier', () => {
  const harness = createHarness()
  harness.forward(statePatched(1))
  harness.forward({
    type: 'kernel.compaction-started',
    projectKey: '/tmp/project',
    sessionKey: '/tmp/session.jsonl',
    reason: 'manual'
  })

  assert.deepEqual(harness.sent.map((event) => event.type), [
    'kernel.state-patched',
    'kernel.compaction-started'
  ])
  assert.equal(harness.pendingTimers(), 0)
})

test('the pre-send queue never exceeds 64 state events', () => {
  const harness = createHarness()
  for (let revision = 1; revision <= MAX_STATE_BATCH_EVENTS; revision += 1) {
    harness.forward(statePatched(revision))
  }

  assert.equal(harness.sent.length, 1)
  const batch = harness.sent[0]
  assert.equal(batch?.type, 'kernel.state-batch')
  assert.equal(batch?.type === 'kernel.state-batch' ? batch.events.length : 0, 64)
  assert.equal(harness.pendingTimers(), 0)
})

test('dispose drops delayed state and delayed send failures stay isolated', () => {
  const harness = createHarness({ throwOnSend: true })
  harness.forward(statePatched(1))
  assert.doesNotThrow(() => harness.runNextTimer())

  const disposed = createHarness()
  disposed.forward(statePatched(1))
  disposed.dispose()
  disposed.runNextTimer()
  disposed.forward(statePatched(2))
  assert.deepEqual(disposed.sent, [])
})

function createHarness(options?: { throwOnSend?: boolean }) {
  const sent: KernelEvent[] = []
  const scheduled: Array<{ callback: () => void; delayMs: number; cancelled: boolean }> = []
  const forwarder = createKernelEventForwarder({
    send: (event) => {
      if (options?.throwOnSend === true) throw new Error('Renderer destroyed')
      sent.push(event)
    },
    schedule: (callback, delayMs) => {
      const timer = { callback, delayMs, cancelled: false }
      scheduled.push(timer)
      return timer
    },
    cancel: (handle) => {
      ;(handle as { cancelled: boolean }).cancelled = true
    }
  })
  return {
    sent,
    scheduled,
    forward: forwarder.forward,
    dispose: forwarder.dispose,
    runNextTimer: () => {
      const timer = scheduled.find((candidate) => !candidate.cancelled)
      if (timer === undefined) return
      timer.cancelled = true
      timer.callback()
    },
    pendingTimers: () => scheduled.filter((timer) => !timer.cancelled).length
  }
}

function stateChanged(revision: number): KernelStateEvent {
  return {
    type: 'kernel.state-changed',
    revision,
    state: { revision } as unknown as KernelState
  }
}

function statePatched(revision: number): KernelStateEvent {
  return {
    type: 'kernel.state-patched',
    revision,
    patch: {
      projectKey: '/tmp/project',
      sessionKey: '/tmp/session.jsonl',
      runtime: { status: revision % 2 === 0 ? 'ready' : 'running' }
    } as KernelStatePatch
  } as KernelStateEvent
}
