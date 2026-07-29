import assert from 'node:assert/strict'
import test from 'node:test'

import type {
  KernelState,
  KernelStatePatch
} from '../../shared/kernel-contract.ts'
import { awaitMutationAck } from './kernel/await-mutation-ack.ts'
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

test('production awaitMutationAck rejects stale results and waits through the barrier', async () => {
  await assert.rejects(
    () => awaitMutationAck(async () => ({ projects: [] }) as never, null),
    /stale preload/
  )
  await assert.rejects(
    () => awaitMutationAck(async () => 2 as never, null),
    /stale preload/
  )

  const harness = createBarrierHarness()
  harness.barrier.handleSnapshot({
    revision: 1,
    state: baseState({ activeSessionKey: '/tmp/session.jsonl' })
  })
  harness.barrier.handleEvent({
    type: 'kernel.state-patched',
    revision: 2,
    patch: runtimePatch('running', '/tmp/session.jsonl')
  })

  const waiting = awaitMutationAck(
    async () => ({ revision: 2, draft: 'hello', cancelled: false }),
    harness.barrier
  )
  let settled = false
  void waiting.then(() => {
    settled = true
  })
  await Promise.resolve()
  assert.equal(settled, false)

  harness.flushFrames()
  const result = await waiting
  assert.equal(settled, true)
  assert.equal(result.revision, 2)
  assert.equal(result.draft, 'hello')
  assert.equal(harness.barrier.getAppliedRevision(), 2)
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

test('mixed full-state and later patch batch preserves revision and ack semantics', async () => {
  const harness = createBarrierHarness()
  const sessionKey = '/tmp/batched.jsonl'
  const waiting = harness.barrier.waitForAck({ revision: 2 })
  let settled = false
  void waiting.then(() => {
    settled = true
  })

  harness.barrier.handleEvent({
    type: 'kernel.state-batch',
    events: [
      {
        type: 'kernel.state-changed',
        revision: 1,
        state: baseState({ activeSessionKey: sessionKey })
      },
      {
        type: 'kernel.state-patched',
        revision: 2,
        patch: runtimePatch('running', sessionKey)
      }
    ]
  })

  await Promise.resolve()
  assert.equal(harness.barrier.getAppliedRevision(), 1)
  assert.equal(settled, false)
  assert.equal(harness.frames.length, 1)
  harness.flushFrames()
  await waiting
  assert.equal(harness.barrier.getAppliedRevision(), 2)
  assert.equal(harness.latest()?.activeSessionKey, sessionKey)
  assert.equal(harness.latest()?.runtime.status, 'running')
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

test('initialized barrier ignores stale or equal recovery snapshots; newer event wins', async () => {
  const harness = createBarrierHarness()
  harness.barrier.handleSnapshot({
    revision: 2,
    state: baseState({ activeSessionKey: '/tmp/applied.jsonl' })
  })
  harness.barrier.handleEvent({
    type: 'kernel.state-changed',
    revision: 4,
    state: baseState({ activeSessionKey: '/tmp/event.jsonl' })
  })

  harness.barrier.handleSnapshot({
    revision: 3,
    state: baseState({ activeSessionKey: '/tmp/stale-resync.jsonl' })
  })
  harness.barrier.handleSnapshot({
    revision: 4,
    state: baseState({ activeSessionKey: '/tmp/equal-resync.jsonl' })
  })

  assert.equal(harness.barrier.getAppliedRevision(), 4)
  assert.equal(harness.latest()?.activeSessionKey, '/tmp/event.jsonl')

  harness.nextSnapshot = {
    revision: 3,
    state: baseState({ activeSessionKey: '/tmp/late-stale.jsonl' })
  }
  harness.barrier.handleEvent({
    type: 'kernel.state-patched',
    revision: 6,
    patch: runtimePatch('running', null)
  })
  await harness.waitForIdle()
  assert.equal(harness.fetchCalls, 1)
  assert.equal(harness.barrier.getAppliedRevision(), 4)
  assert.equal(harness.latest()?.activeSessionKey, '/tmp/event.jsonl')
})

test('hung resync rejects waiters after a finite deadline and late fetch is ignored', async () => {
  let resolveFetch!: (value: { revision: number; state: KernelState }) => void
  const harness = createBarrierHarness({
    waitTimeoutMs: 5,
    resyncTimeoutMs: 15,
    fetchSnapshot: () =>
      new Promise((resolve) => {
        resolveFetch = resolve
      })
  })
  harness.barrier.handleSnapshot({ revision: 1, state: baseState() })

  await assert.rejects(
    () => harness.barrier.waitForAck({ revision: 9 }),
    /resync timed out|Timed out waiting/
  )
  assert.equal(harness.barrier.getAppliedRevision(), 1)

  resolveFetch({
    revision: 9,
    state: baseState({ activeSessionKey: '/tmp/late.jsonl' })
  })
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(harness.barrier.getAppliedRevision(), 1)
  assert.equal(harness.latest()?.activeSessionKey, null)
})

test('multiple waiters and dispose do not leak or hang', async () => {
  const harness = createBarrierHarness({ waitTimeoutMs: 60_000 })
  harness.barrier.handleSnapshot({ revision: 1, state: baseState() })
  const first = harness.barrier.waitForAck({ revision: 4 })
  const second = harness.barrier.waitForAck({ revision: 5 })
  harness.barrier.dispose()
  await assert.rejects(() => first, /disposed/)
  await assert.rejects(() => second, /disposed/)
  await assert.rejects(
    () => harness.barrier.waitForAck({ revision: 6 }),
    /disposed/
  )
})

test('gap-triggered recovery reports failures through onRecoveryError', async () => {
  const recoveryErrors: unknown[] = []
  const harness = createBarrierHarness({
    onRecoveryError: (error) => recoveryErrors.push(error),
    fetchSnapshot: async () => {
      throw new Error('snapshot unavailable')
    }
  })
  harness.barrier.handleSnapshot({ revision: 1, state: baseState() })
  harness.barrier.handleEvent({
    type: 'kernel.state-patched',
    revision: 3,
    patch: runtimePatch('running', null)
  })
  for (let attempt = 0; attempt < 50 && recoveryErrors.length === 0; attempt += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }
  assert.equal(harness.fetchCalls, 1)
  assert.equal(recoveryErrors.length, 1)
  assert.match(String(recoveryErrors[0]), /snapshot unavailable/)
  assert.equal(harness.barrier.getAppliedRevision(), 1)
})

test('pending patch queue overflow discards the diff queue and resyncs once', async () => {
  const harness = createBarrierHarness({ maxPendingPatches: 2 })
  harness.barrier.handleSnapshot({ revision: 1, state: baseState() })
  harness.nextSnapshot = {
    revision: 10,
    state: baseState({ activeSessionKey: '/tmp/overflow.jsonl' })
  }

  harness.barrier.handleEvent({
    type: 'kernel.state-patched',
    revision: 2,
    patch: runtimePatch('running', null)
  })
  harness.barrier.handleEvent({
    type: 'kernel.state-patched',
    revision: 3,
    patch: runtimePatch('ready', null)
  })
  // Contiguous queue is still capped: third entry overflows before flush.
  harness.barrier.handleEvent({
    type: 'kernel.state-patched',
    revision: 4,
    patch: runtimePatch('running', null)
  })
  await harness.waitForIdle()
  assert.equal(harness.fetchCalls, 1)
  assert.equal(harness.barrier.getAppliedRevision(), 10)
  assert.equal(harness.latest()?.activeSessionKey, '/tmp/overflow.jsonl')
})

function createBarrierHarness(options?: {
  waitTimeoutMs?: number
  resyncTimeoutMs?: number
  maxPendingPatches?: number
  onRecoveryError?: (error: unknown) => void
  fetchSnapshot?: () => Promise<unknown>
}) {
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
      if (options?.fetchSnapshot !== undefined) return options.fetchSnapshot()
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
    waitTimeoutMs: options?.waitTimeoutMs,
    resyncTimeoutMs: options?.resyncTimeoutMs,
    maxPendingPatches: options?.maxPendingPatches,
    onRecoveryError: options?.onRecoveryError
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
      for (let attempt = 0; attempt < 50; attempt += 1) {
        if (fetchCalls > 0 && frames.length === 0) {
          // Allow rejection/reporting microtasks after fetch settles.
          await Promise.resolve()
          await Promise.resolve()
          return
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 0))
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
