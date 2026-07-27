import assert from 'node:assert/strict'
import test from 'node:test'

import type {
  KernelSessionPreview,
  KernelState
} from '../../../shared/kernel-contract.ts'
import {
  SessionRuntimeController,
  nextDesiredRuntimeEnsureAfterCompletion,
  runtimeEnsureTargetsEqual,
  type RuntimeEnsureTarget,
  type SessionRuntimeSnapshot
} from './session-runtime-controller.ts'

const PROJECT_A = '/tmp/project-a'
const SESSION_A = '/tmp/session-a.jsonl'
const SESSION_B = '/tmp/session-b.jsonl'

test('a completed runtime target absorbs same-target requests queued while it ran', () => {
  const newTarget: RuntimeEnsureTarget = { kind: 'new', projectKey: PROJECT_A }
  const sessionTarget: RuntimeEnsureTarget = {
    kind: 'session',
    projectKey: PROJECT_A,
    sessionKey: SESSION_A
  }

  assert.equal(nextDesiredRuntimeEnsureAfterCompletion(newTarget, newTarget), null)
  assert.equal(nextDesiredRuntimeEnsureAfterCompletion(sessionTarget, sessionTarget), null)
  assert.equal(
    runtimeEnsureTargetsEqual(
      sessionTarget,
      { kind: 'session', projectKey: PROJECT_A, sessionKey: SESSION_A }
    ),
    true
  )
})

test('runtime target identity includes the project and preserves a different later target', () => {
  const nextSession: RuntimeEnsureTarget = {
    kind: 'session',
    projectKey: PROJECT_A,
    sessionKey: SESSION_B
  }

  assert.deepEqual(
    nextDesiredRuntimeEnsureAfterCompletion(
      nextSession,
      { kind: 'new', projectKey: PROJECT_A }
    ),
    nextSession
  )
  assert.equal(
    runtimeEnsureTargetsEqual(
      { kind: 'new', projectKey: PROJECT_A },
      { kind: 'new', projectKey: '/tmp/project-b' }
    ),
    false
  )
})

test('rapid settled A to B navigation starts only B and rejects the superseded waiter', async () => {
  const harness = createHarness(kernelState())
  const waitingForA = harness.controller.activate(SESSION_A, 'settled')
  const rejectedA = assert.rejects(waitingForA, /Session activation superseded/)
  const waitingForB = harness.controller.activate(SESSION_B, 'settled')

  await rejectedA
  assert.equal(harness.timers.size, 1)
  harness.runOnlyTimer()
  await waitingForB

  assert.deepEqual(harness.activateCalls, [SESSION_B])
})

test('an already-live target only clears its preview shell', async () => {
  const harness = createHarness(kernelState({
    activeSessionKey: SESSION_A,
    runtimeStatus: 'ready'
  }))
  await harness.controller.preview(SESSION_A)

  await harness.controller.activate(SESSION_A)

  assert.deepEqual(harness.activateCalls, [])
  assert.equal(harness.snapshot.sessionViewTarget, null)
  assert.equal(harness.snapshot.sessionPreview, null)
})

test('a stale preview response cannot replace the latest target', async () => {
  const previewA = deferred<KernelSessionPreview>()
  const harness = createHarness(kernelState(), {
    previewSession: (sessionKey) => (
      sessionKey === SESSION_A
        ? previewA.promise
        : Promise.resolve(sessionPreview(sessionKey))
    )
  })
  const waitingForA = harness.controller.preview(SESSION_A)
  await harness.controller.preview(SESSION_B)

  previewA.resolve(sessionPreview(SESSION_A))
  await waitingForA

  assert.equal(harness.snapshot.sessionViewTarget?.kind, 'session')
  assert.equal(
    harness.snapshot.sessionViewTarget?.kind === 'session'
      ? harness.snapshot.sessionViewTarget.sessionKey
      : null,
    SESSION_B
  )
  assert.equal(harness.snapshot.sessionPreview?.sessionKey, SESSION_B)
})

test('an old activation failure cannot overwrite a newer target', async () => {
  const activationA = deferred<KernelState>()
  const harness = createHarness(kernelState(), {
    activateSession: (sessionKey) => {
      if (sessionKey === SESSION_A) return activationA.promise
      return Promise.resolve(kernelState({
        activeSessionKey: SESSION_B,
        runtimeStatus: 'ready'
      }))
    }
  })
  await harness.controller.preview(SESSION_A)
  const waitingForA = harness.controller.activate(SESSION_A)
  const rejectedA = assert.rejects(waitingForA, /old activation failed/)
  await harness.controller.preview(SESSION_B)
  const waitingForB = harness.controller.activate(SESSION_B)

  activationA.reject(new Error('old activation failed'))
  await rejectedA
  await waitingForB

  assert.deepEqual(harness.activateCalls, [SESSION_A, SESSION_B])
  assert.deepEqual(harness.errors, [])
  assert.equal(harness.snapshot.sessionViewTarget, null)
})

test('command responses before or after Kernel events never regress state', async () => {
  const lateResponse = deferred<KernelState>()
  const lateHarness = createHarness(kernelState(), {
    activateSession: () => lateResponse.promise
  })
  const waitingForLateResponse = lateHarness.controller.activate(SESSION_A)
  const eventState = kernelState({
    activeSessionKey: SESSION_A,
    runtimeStatus: 'running'
  })
  lateHarness.emitKernelState(eventState)
  lateResponse.resolve(kernelState({
    activeSessionKey: SESSION_A,
    runtimeStatus: 'ready'
  }))
  await waitingForLateResponse
  assert.equal(lateHarness.appliedStates.length, 0)
  assert.equal(lateHarness.currentState, eventState)

  const responseState = kernelState({
    activeSessionKey: SESSION_B,
    runtimeStatus: 'ready'
  })
  const earlyHarness = createHarness(kernelState(), {
    activateSession: () => Promise.resolve(responseState)
  })
  await earlyHarness.controller.activate(SESSION_B)
  assert.equal(earlyHarness.currentState, responseState)
  const newerEventState = kernelState({
    activeSessionKey: SESSION_B,
    runtimeStatus: 'running'
  })
  earlyHarness.emitKernelState(newerEventState)
  assert.equal(earlyHarness.currentState, newerEventState)
})

test('waitForIdle cancels an unstarted settle timer for project switch or archive', async () => {
  const harness = createHarness(kernelState())
  const waiting = harness.controller.activate(SESSION_A, 'settled')
  const rejected = assert.rejects(waiting, /Session activation superseded/)

  await harness.controller.waitForIdle()
  await rejected

  assert.equal(harness.timers.size, 0)
  assert.deepEqual(harness.activateCalls, [])
})

test('cold start resumes the persisted active Session instead of creating a new one', async () => {
  const initialState = kernelState({
    activeSessionKey: SESSION_A,
    runtimeStatus: 'stopped'
  })
  const harness = createHarness(initialState)

  harness.controller.reconcileKernelState(initialState, true)
  await harness.controller.ensureInitialRuntime()

  assert.equal(harness.snapshot.sessionViewTarget, null)
  assert.equal(harness.startCalls, 0)
  assert.deepEqual(harness.activateCalls, [SESSION_A])
})

test('cold start creates a Session only when the restored Project has no active Session', async () => {
  const initialState = kernelState({ runtimeStatus: 'stopped' })
  const harness = createHarness(initialState)

  harness.controller.reconcileKernelState(initialState, true)
  await harness.controller.ensureInitialRuntime()

  assert.equal(harness.startCalls, 1)
  assert.deepEqual(harness.activateCalls, [])
})

test('cold start keeps the restored Session target and reports resume failures', async () => {
  const initialState = kernelState({
    activeSessionKey: SESSION_A,
    runtimeStatus: 'stopped'
  })
  const harness = createHarness(initialState, {
    activateSession: () => Promise.reject(new Error('resume failed'))
  })

  harness.controller.reconcileKernelState(initialState, true)
  await assert.rejects(harness.controller.ensureInitialRuntime(), /resume failed/)

  assert.equal(harness.snapshot.sessionViewTarget?.kind, 'session')
  assert.deepEqual(harness.errors.map((error) => String(error)), ['Error: resume failed'])
  assert.deepEqual(harness.completedActions, [
    { action: 'activate-session', succeeded: false }
  ])
})

test('materializing a provisional Session exits the synthetic new view', async () => {
  const provisionalState = kernelState({
    activeSessionKey: '/tmp/provisional-session.jsonl',
    runtimeStatus: 'starting'
  })
  const harness = createHarness(kernelState({
    activeSessionKey: '/tmp/previous-session.jsonl',
    runtimeStatus: 'ready'
  }), {
    startSession: () => Promise.resolve(provisionalState)
  })

  const start = harness.controller.start()
  assert.equal(harness.snapshot.sessionViewTarget?.kind, 'new')
  await start

  assert.equal(harness.snapshot.sessionViewTarget, null)
  assert.equal(harness.currentState, provisionalState)
})

type HarnessOptions = {
  startSession?: () => Promise<KernelState>
  activateSession?: (sessionKey: string) => Promise<KernelState>
  previewSession?: (sessionKey: string) => Promise<KernelSessionPreview>
}

function createHarness(initialState: KernelState, options: HarnessOptions = {}) {
  let currentState = initialState
  let eventRevision = 0
  let actionPresentationRevision = 0
  let snapshot: SessionRuntimeSnapshot = {
    sessionViewTarget: null,
    sessionPreview: null,
    previewPendingKey: null
  }
  let startCalls = 0
  const activateCalls: string[] = []
  const appliedStates: KernelState[] = []
  const errors: unknown[] = []
  const completedActions: Array<{
    action: 'start-session' | 'activate-session'
    succeeded: boolean
  }> = []
  const timers = new Map<number, () => void>()
  let nextTimer = 0

  const controller = new SessionRuntimeController({
    settleMs: 120,
    getKernelState: () => currentState,
    getEventRevision: () => eventRevision,
    startSession: () => {
      startCalls += 1
      return options.startSession?.() ?? Promise.resolve(currentState)
    },
    activateSession: (sessionKey) => {
      activateCalls.push(sessionKey)
      return options.activateSession?.(sessionKey) ?? Promise.resolve(kernelState({
        activeSessionKey: sessionKey,
        runtimeStatus: 'ready'
      }))
    },
    previewSession: options.previewSession ??
      ((sessionKey) => Promise.resolve(sessionPreview(sessionKey))),
    applyReturnedState: (state, revisionBeforeAction) => {
      if (eventRevision !== revisionBeforeAction) return false
      currentState = state
      appliedStates.push(state)
      return true
    },
    beginActionPresentation: () => {
      actionPresentationRevision += 1
      return actionPresentationRevision
    },
    isActionPresentationCurrent: (revision) =>
      actionPresentationRevision === revision,
    onSnapshot: (nextSnapshot) => {
      snapshot = nextSnapshot
    },
    onError: (error) => {
      if (error !== null) errors.push(error)
    },
    onCompletedAction: (action, succeeded) => {
      completedActions.push({ action, succeeded })
    },
    onClearArchivedPreview: () => undefined,
    setTimer: (callback) => {
      nextTimer += 1
      timers.set(nextTimer, callback)
      return nextTimer as unknown as ReturnType<typeof setTimeout>
    },
    clearTimer: (handle) => {
      timers.delete(handle as unknown as number)
    }
  })

  return {
    controller,
    get startCalls() {
      return startCalls
    },
    activateCalls,
    appliedStates,
    errors,
    completedActions,
    timers,
    get snapshot() {
      return snapshot
    },
    get currentState() {
      return currentState
    },
    emitKernelState(state: KernelState) {
      eventRevision += 1
      currentState = state
      controller.reconcileKernelState(state)
    },
    runOnlyTimer() {
      assert.equal(timers.size, 1)
      const [id, callback] = [...timers.entries()][0]
      timers.delete(id)
      callback()
    }
  }
}

function kernelState(options: {
  activeSessionKey?: string | null
  runtimeStatus?: 'stopped' | 'starting' | 'ready' | 'running' | 'stopping' | 'crashed'
} = {}): KernelState {
  const activeSessionKey = options.activeSessionKey ?? null
  const runtimeStatus = options.runtimeStatus ?? 'stopped'
  const sessionKeys = new Set([
    SESSION_A,
    SESSION_B,
    ...(activeSessionKey === null ? [] : [activeSessionKey])
  ])
  return {
    activeProjectKey: PROJECT_A,
    activeSessionKey,
    sessions: [...sessionKeys].map((key) => ({ key, runtimeStatus })),
    runtime: { status: runtimeStatus },
    conversation: { entries: [], activeRunStartIndex: null }
  } as unknown as KernelState
}

function sessionPreview(sessionKey: string): KernelSessionPreview {
  return {
    projectKey: PROJECT_A,
    sessionKey
  } as unknown as KernelSessionPreview
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}
