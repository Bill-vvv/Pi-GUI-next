import assert from 'node:assert/strict'
import test from 'node:test'

import type {
  KernelState,
  KernelStatePatch
} from '../../shared/kernel-contract.ts'
import {
  KernelRevisionBarrier,
  parseKernelMutationAck,
  parseKernelSnapshot
} from './kernel/kernel-revision-barrier.ts'
import { applyStatePatches } from './kernel/kernel-state-patches.ts'

test('wire validators reject stale full KernelState results and bare numbers', () => {
  assert.equal(parseKernelMutationAck({ revision: 3 }).revision, 3)
  assert.throws(() => parseKernelMutationAck({ projects: [] }), /stale preload/)
  assert.throws(() => parseKernelMutationAck(2), /stale preload/)
  assert.throws(() => parseKernelMutationAck({ revision: -1 }), /stale preload/)
  assert.throws(() => parseKernelMutationAck({ revision: 1.5 }), /stale preload/)

  const state = baseState()
  assert.equal(parseKernelSnapshot({ revision: 0, state }).revision, 0)
  assert.throws(() => parseKernelSnapshot(state), /stale preload/)
  assert.throws(() => parseKernelSnapshot({ revision: 1 }), /stale preload/)
})

test('ack before event does not settle until the matching revision is applied', async () => {
  const harness = createBarrierHarness()
  const waiting = harness.barrier.waitForAck({ revision: 2 })
  let settled = false
  void waiting.then(() => {
    settled = true
  })

  await Promise.resolve()
  assert.equal(settled, false)
  assert.equal(harness.applied.length, 0)

  harness.barrier.handleEvent({
    type: 'kernel.state-changed',
    revision: 1,
    state: baseState({ activeSessionKey: '/tmp/one.jsonl' })
  })
  await Promise.resolve()
  assert.equal(settled, false)
  assert.equal(harness.barrier.getAppliedRevision(), 1)

  harness.barrier.handleEvent({
    type: 'kernel.state-changed',
    revision: 2,
    state: baseState({ activeSessionKey: '/tmp/two.jsonl' })
  })
  await waiting
  assert.equal(settled, true)
  assert.equal(harness.barrier.getAppliedRevision(), 2)
  assert.equal(harness.latest()?.activeSessionKey, '/tmp/two.jsonl')
})

test('event before ack settles immediately at the already-applied revision', async () => {
  const harness = createBarrierHarness()
  harness.barrier.handleEvent({
    type: 'kernel.state-changed',
    revision: 4,
    state: baseState({ activeSessionKey: '/tmp/ready.jsonl' })
  })
  assert.equal(harness.barrier.getAppliedRevision(), 4)

  const started = Date.now()
  await harness.barrier.waitForAck({ revision: 4 })
  assert.ok(Date.now() - started < 50)
})

test('no-op ack at the current applied revision completes without resync', async () => {
  const harness = createBarrierHarness()
  harness.barrier.handleSnapshot({ revision: 1, state: baseState() })
  assert.equal(harness.fetchCalls, 0)
  await harness.barrier.waitForAck({ revision: 1 })
  assert.equal(harness.fetchCalls, 0)
  assert.equal(harness.barrier.getAppliedRevision(), 1)
})

test('RAF-delayed patch application holds ack settlement until the frame flushes', async () => {
  const harness = createBarrierHarness()
  const sessionKey = '/tmp/session.jsonl'
  harness.barrier.handleSnapshot({
    revision: 1,
    state: baseState({ activeSessionKey: sessionKey })
  })

  harness.barrier.handleEvent({
    type: 'kernel.state-patched',
    revision: 2,
    patch: runtimePatch('running', sessionKey)
  })
  const waiting = harness.barrier.waitForAck({ revision: 2 })
  let settled = false
  void waiting.then(() => {
    settled = true
  })
  await Promise.resolve()
  assert.equal(settled, false)
  assert.equal(harness.barrier.getAppliedRevision(), 1)
  assert.equal(harness.frames.length, 1)

  harness.flushFrames()
  await waiting
  assert.equal(settled, true)
  assert.equal(harness.barrier.getAppliedRevision(), 2)
  assert.equal(harness.latest()?.runtime.status, 'running')
})

test('revision gap triggers one snapshot resync instead of an unbounded queue', async () => {
  const harness = createBarrierHarness()
  harness.barrier.handleSnapshot({ revision: 1, state: baseState() })
  harness.nextSnapshot = {
    revision: 4,
    state: baseState({ activeSessionKey: '/tmp/recovered.jsonl' })
  }

  harness.barrier.handleEvent({
    type: 'kernel.state-patched',
    revision: 3,
    patch: runtimePatch('running', null)
  })
  await harness.waitForIdle()
  assert.equal(harness.fetchCalls, 1)
  assert.equal(harness.barrier.getAppliedRevision(), 4)
  assert.equal(harness.latest()?.activeSessionKey, '/tmp/recovered.jsonl')
  assert.equal(harness.frames.length, 0)
})

test('missing event wait timeout performs one targeted full snapshot resync', async () => {
  const harness = createBarrierHarness({ waitTimeoutMs: 5 })
  harness.barrier.handleSnapshot({ revision: 1, state: baseState() })
  harness.nextSnapshot = {
    revision: 5,
    state: baseState({ activeSessionKey: '/tmp/timeout-recovered.jsonl' })
  }

  await harness.barrier.waitForAck({ revision: 5 })
  assert.equal(harness.fetchCalls, 1)
  assert.equal(harness.barrier.getAppliedRevision(), 5)
  assert.equal(harness.latest()?.activeSessionKey, '/tmp/timeout-recovered.jsonl')
})

test('subscription events can race the first snapshot without guessing counters', () => {
  const harness = createBarrierHarness()
  harness.barrier.handleEvent({
    type: 'kernel.state-changed',
    revision: 2,
    state: baseState({ activeSessionKey: '/tmp/from-event.jsonl' })
  })
  harness.barrier.handleSnapshot({
    revision: 1,
    state: baseState({ activeSessionKey: '/tmp/from-snapshot.jsonl' })
  })
  assert.equal(harness.barrier.getAppliedRevision(), 2)
  assert.equal(harness.latest()?.activeSessionKey, '/tmp/from-event.jsonl')
  assert.equal(harness.applied.filter((entry) => entry.initializing).length, 1)
})

function createBarrierHarness(options?: { waitTimeoutMs?: number }) {
  const applied: Array<{ state: KernelState; revision: number; initializing: boolean }> = []
  const frames: Array<() => void> = []
  let fetchCalls = 0
  let nextSnapshot = {
    revision: 0,
    state: baseState()
  }
  const barrier = new KernelRevisionBarrier({
    applyState: (state, meta) => {
      applied.push({ state, revision: meta.revision, initializing: meta.initializing })
    },
    applyPatches: (state, patches) =>
      applyStatePatches(state, patches.map((entry) => entry.patch)),
    fetchSnapshot: async () => {
      fetchCalls += 1
      return nextSnapshot
    },
    scheduleFrame: (callback) => {
      frames.push(callback)
      return frames.length
    },
    cancelFrame: (handle) => {
      const index = Number(handle) - 1
      if (Number.isInteger(index) && index >= 0) frames[index] = () => undefined
    },
    waitTimeoutMs: options?.waitTimeoutMs
  })

  return {
    barrier,
    applied,
    frames,
    get fetchCalls() {
      return fetchCalls
    },
    set nextSnapshot(value: { revision: number; state: KernelState }) {
      nextSnapshot = value
    },
    latest: () => applied.at(-1)?.state ?? null,
    flushFrames: () => {
      const pending = frames.splice(0, frames.length)
      for (const frame of pending) frame()
    },
    waitForIdle: async () => {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        if (fetchCalls > 0 && frames.length === 0) return
        await Promise.resolve()
      }
    }
  }
}

function baseState(overrides?: {
  activeSessionKey?: string | null
}): KernelState {
  return {
    activeProjectKey: '/tmp/project',
    activeSessionKey: overrides?.activeSessionKey ?? null,
    runtime: { status: 'ready' },
    session: { settled: true },
    conversation: { entries: [], activeRunStartIndex: null }
  } as unknown as KernelState
}

function runtimePatch(
  status: 'running' | 'ready',
  sessionKey: string | null
): KernelStatePatch {
  return {
    projectKey: '/tmp/project',
    sessionKey,
    runtime: {
      status,
      executable: null,
      version: null,
      stderrChars: 0,
      stderrSummary: null,
      lastError: null,
      exitCode: null,
      exitSignal: null
    }
  }
}
