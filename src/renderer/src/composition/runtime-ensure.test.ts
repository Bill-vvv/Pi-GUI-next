import assert from 'node:assert/strict'
import test from 'node:test'

import type {
  KernelConversationEntry,
  KernelConversationState,
  KernelMutationAck,
  KernelSessionPreview,
  KernelState
} from '../../../shared/kernel-contract.ts'
import {
  SessionRuntimeController,
  nextDesiredRuntimeEnsureAfterCompletion,
  runtimeEnsureTargetsEqual,
  sessionSwitchConversation,
  type RuntimeEnsureTarget,
  type SessionRuntimeSnapshot
} from './session-runtime-controller.ts'

const PROJECT_A = '/tmp/project-a'
const SESSION_A = '/tmp/session-a.jsonl'
const SESSION_B = '/tmp/session-b.jsonl'
const SESSION_C = '/tmp/session-c.jsonl'

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

test('a Session switch snapshot keeps only the latest two settled turns', () => {
  const conversation = conversationState([
    messageEntry('u1', 'user'),
    messageEntry('a1', 'assistant'),
    messageEntry('u2', 'user'),
    messageEntry('a2', 'assistant'),
    messageEntry('u3', 'user'),
    messageEntry('a3', 'assistant')
  ])

  assert.deepEqual(
    sessionSwitchConversation(conversation).entries.map(({ id }) => id),
    ['u2', 'a2', 'u3', 'a3']
  )
})

test('a Session switch snapshot preserves command and implicit turn boundaries', () => {
  const conversation = conversationState([
    messageEntry('u1', 'user'),
    messageEntry('a1', 'assistant'),
    commandEntry('command-1'),
    errorEntry('error-1'),
    messageEntry('u2', 'user'),
    messageEntry('a2', 'assistant')
  ])

  assert.deepEqual(
    sessionSwitchConversation(conversation).entries.map(({ id }) => id),
    ['error-1', 'u2', 'a2']
  )
})

test('a running Session switch snapshot keeps the previous turn and complete active run', () => {
  const conversation = conversationState([
    messageEntry('u1', 'user'),
    messageEntry('a1', 'assistant'),
    messageEntry('u2', 'user'),
    messageEntry('a2', 'assistant'),
    messageEntry('u3', 'user'),
    messageEntry('a3', 'assistant', true)
  ], 4)
  const snapshot = sessionSwitchConversation(conversation)

  assert.deepEqual(snapshot.entries.map(({ id }) => id), ['u2', 'a2', 'u3', 'a3'])
  assert.equal(snapshot.activeRunStartIndex, 2)
})

test('a Session selection publishes its target before deferred outgoing cache work', async () => {
  let conversationReads = 0
  const trackedEntries = new Proxy<KernelConversationEntry[]>([
    messageEntry('a-u1', 'user'),
    messageEntry('a-a1', 'assistant'),
    messageEntry('a-u2', 'user'),
    messageEntry('a-a2', 'assistant')
  ], {
    get(target, property, receiver) {
      if (property === 'length' || property === 'slice') conversationReads += 1
      return Reflect.get(target, property, receiver)
    }
  })
  const harness = createHarness(kernelState({
    activeSessionKey: SESSION_A,
    runtimeStatus: 'stopped',
    conversation: conversationState(trackedEntries)
  }))

  const selecting = harness.controller.select(SESSION_B)

  assert.deepEqual(harness.snapshot.sessionViewTarget, {
    kind: 'session',
    projectKey: PROJECT_A,
    sessionKey: SESSION_B
  })
  assert.equal(harness.snapshot.sessionPreview, null)
  assert.equal(conversationReads, 0)
  assert.equal(harness.postTasks.size, 1)

  harness.runAllPostTasks()
  assert.ok(conversationReads > 0)
  harness.runOnlyTimer()
  await selecting
})

test('rapid A to B to C browsing starts preview and activation only for C', async () => {
  const harness = createHarness(kernelState())
  const selectingA = harness.controller.select(SESSION_A)
  const rejectedA = assert.rejects(selectingA, /Session activation superseded/)
  const selectingB = harness.controller.select(SESSION_B)
  const rejectedB = assert.rejects(selectingB, /Session activation superseded/)
  const selectingC = harness.controller.select(SESSION_C)

  await Promise.all([rejectedA, rejectedB])
  assert.deepEqual(harness.previewCalls, [])
  assert.deepEqual(harness.activateCalls, [])
  assert.equal(harness.timers.size, 1)

  harness.runOnlyTimer()
  await selectingC

  assert.deepEqual(harness.previewCalls, [SESSION_C])
  assert.deepEqual(harness.activateCalls, [SESSION_C])
})

test('an in-flight stale preview cannot block the latest Session activation', async () => {
  const previewB = deferred<KernelSessionPreview>()
  const activationB = deferred<KernelMutationAck>()
  const harness = createHarness(kernelState(), {
    previewSession: (sessionKey) => sessionKey === SESSION_B
      ? previewB.promise
      : Promise.resolve(sessionPreview(sessionKey)),
    activateSession: (sessionKey) => sessionKey === SESSION_B
      ? activationB.promise
      : Promise.resolve({ revision: 0 })
  })

  const selectingB = harness.controller.select(SESSION_B)
  harness.runOnlyTimer()
  assert.deepEqual(harness.previewCalls, [SESSION_B])
  assert.deepEqual(harness.activateCalls, [SESSION_B])

  const selectingC = harness.controller.select(SESSION_C)
  activationB.resolve({ revision: 0 })
  await selectingB

  harness.runOnlyTimer()
  await selectingC

  assert.deepEqual(harness.activateCalls, [SESSION_B, SESSION_C])
  assert.deepEqual(harness.previewCalls, [SESSION_B, SESSION_C])

  previewB.resolve(sessionPreview(SESSION_B))
  await Promise.resolve()
})

test('a warm historical Session activation also waits for browse settle', async () => {
  const harness = createHarness(kernelState({
    activeSessionKey: SESSION_A,
    runtimeStatus: 'ready'
  }))
  const selecting = harness.controller.select(SESSION_B)

  assert.deepEqual(harness.previewCalls, [])
  assert.deepEqual(harness.activateCalls, [])
  harness.runOnlyTimer()
  await selecting

  assert.deepEqual(harness.previewCalls, [])
  assert.deepEqual(harness.activateCalls, [SESSION_B])
})

test('an active crashed Session resumes immediately without browse settle', async () => {
  const harness = createHarness(kernelState({
    activeSessionKey: SESSION_A,
    runtimeStatus: 'crashed'
  }))

  await harness.controller.activate(SESSION_A, 'immediate')

  assert.equal(harness.timers.size, 0)
  assert.deepEqual(harness.previewCalls, [])
  assert.deepEqual(harness.activateCalls, [SESSION_A])
})

test('an immediate force commit supersedes a different pending browse target', async () => {
  const harness = createHarness(kernelState())
  const selectingA = harness.controller.select(SESSION_A)
  const rejectedA = assert.rejects(selectingA, /Session activation superseded/)

  await harness.controller.activate(SESSION_B, 'immediate')
  await rejectedA

  assert.equal(harness.timers.size, 0)
  assert.deepEqual(harness.previewCalls, [])
  assert.deepEqual(harness.activateCalls, [SESSION_B])
})

test('an immediate ensure forces the pending viewed target now', async () => {
  const harness = createHarness(kernelState())
  const selecting = harness.controller.select(SESSION_A)
  const forcing = harness.controller.activate(SESSION_A, 'immediate')

  assert.equal(harness.timers.size, 0)
  await Promise.all([selecting, forcing])

  assert.deepEqual(harness.previewCalls, [SESSION_A])
  assert.deepEqual(harness.activateCalls, [SESSION_A])
})

test('a removed pending browse target starts neither preview nor activation', async () => {
  const harness = createHarness(kernelState())
  const selecting = harness.controller.select(SESSION_A)

  harness.emitKernelState(withoutSession(kernelState(), SESSION_A))
  harness.runOnlyTimer()
  await selecting

  assert.deepEqual(harness.previewCalls, [])
  assert.deepEqual(harness.activateCalls, [])
  assert.equal(harness.snapshot.sessionViewTarget, null)
})

test('a live Session target is visible immediately and reuses its two-turn snapshot', async () => {
  const activationA = deferred<KernelMutationAck>()
  const stateA = kernelState({
    activeSessionKey: SESSION_A,
    runtimeStatus: 'ready',
    conversation: conversationState([
      messageEntry('a-u1', 'user'),
      messageEntry('a-a1', 'assistant'),
      messageEntry('a-u2', 'user'),
      messageEntry('a-a2', 'assistant'),
      messageEntry('a-u3', 'user'),
      messageEntry('a-a3', 'assistant')
    ])
  })
  const stateB = kernelState({
    activeSessionKey: SESSION_B,
    runtimeStatus: 'ready',
    conversation: conversationState([
      messageEntry('b-u1', 'user'),
      messageEntry('b-a1', 'assistant')
    ])
  })
  let harness!: ReturnType<typeof createHarness>
  harness = createHarness(stateA, {
    activateSession: async (sessionKey) => {
      if (sessionKey === SESSION_A) return activationA.promise
      harness.emitKernelState(stateB)
      return { revision: 1 }
    }
  })

  await harness.controller.activate(SESSION_B)
  harness.runAllPostTasks()
  const openingA = harness.controller.select(SESSION_A)

  assert.deepEqual(harness.snapshot.sessionViewTarget, {
    kind: 'session',
    projectKey: PROJECT_A,
    sessionKey: SESSION_A
  })
  assert.equal(harness.snapshot.previewPendingKey, SESSION_A)
  assert.equal(harness.snapshot.sessionPreview?.sessionKey, SESSION_A)
  assert.deepEqual(
    harness.snapshot.sessionPreview?.conversation.entries.map(({ id }) => id),
    ['a-u2', 'a-a2', 'a-u3', 'a-a3']
  )

  harness.runOnlyTimer()
  harness.emitKernelState(kernelState({
    activeSessionKey: SESSION_A,
    runtimeStatus: 'starting'
  }))
  assert.equal(harness.snapshot.sessionPreview?.sessionKey, SESSION_A)
  assert.equal(harness.snapshot.previewPendingKey, SESSION_A)

  harness.emitKernelState(stateA)
  activationA.resolve({ revision: 2 })
  await openingA

  assert.equal(harness.snapshot.sessionViewTarget, null)
  assert.equal(harness.snapshot.sessionPreview, null)
  assert.equal(harness.snapshot.previewPendingKey, null)
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

test('a prompt-time activation joins the same Session startup already in flight', async () => {
  const activation = deferred<KernelMutationAck>()
  const harness = createHarness(kernelState(), {
    activateSession: () => activation.promise
  })
  await harness.controller.preview(SESSION_A)

  const opening = harness.controller.activate(SESSION_A)
  harness.emitKernelState(kernelState({
    activeSessionKey: SESSION_A,
    runtimeStatus: 'starting'
  }))
  let promptGateSettled = false
  const promptGate = harness.controller.activate(SESSION_A).then(() => {
    promptGateSettled = true
  })

  await Promise.resolve()
  assert.equal(promptGateSettled, false)
  assert.deepEqual(harness.activateCalls, [SESSION_A])

  harness.emitKernelState(kernelState({
    activeSessionKey: SESSION_A,
    runtimeStatus: 'ready'
  }))
  activation.resolve({ revision: 1 })
  await Promise.all([opening, promptGate])

  assert.equal(promptGateSettled, true)
  assert.deepEqual(harness.activateCalls, [SESSION_A])
})

test('a Session removed by the latest Project refresh never reaches preview or activation IPC', async () => {
  let previewCalls = 0
  const harness = createHarness(withoutSession(kernelState(), SESSION_A), {
    previewSession: async (sessionKey) => {
      previewCalls += 1
      return sessionPreview(sessionKey)
    }
  })

  await harness.controller.preview(SESSION_A)
  await harness.controller.activate(SESSION_A, 'settled')

  assert.equal(previewCalls, 0)
  assert.deepEqual(harness.activateCalls, [])
  assert.equal(harness.timers.size, 0)
  assert.equal(harness.snapshot.sessionViewTarget, null)
  assert.deepEqual(harness.errors, [])
  assert.deepEqual(harness.completedActions, [])
})

test('a Session removed while activation is settling does not reach activation IPC', async () => {
  const harness = createHarness(kernelState())
  await harness.controller.preview(SESSION_A)
  const waiting = harness.controller.activate(SESSION_A, 'settled')

  harness.emitKernelState(withoutSession(kernelState(), SESSION_A))
  harness.runOnlyTimer()
  await waiting

  assert.deepEqual(harness.activateCalls, [])
  assert.equal(harness.snapshot.sessionViewTarget, null)
  assert.deepEqual(harness.errors, [])
  assert.deepEqual(harness.completedActions, [])
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
  const activationA = deferred<KernelMutationAck>()
  let harness!: ReturnType<typeof createHarness>
  harness = createHarness(kernelState(), {
    activateSession: async (sessionKey) => {
      if (sessionKey === SESSION_A) return activationA.promise
      harness.emitKernelState(kernelState({
        activeSessionKey: SESSION_B,
        runtimeStatus: 'ready'
      }))
      return { revision: 1 }
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

test('mutation acks never regress state published by Kernel events', async () => {
  const lateResponse = deferred<KernelMutationAck>()
  const lateHarness = createHarness(kernelState(), {
    activateSession: () => lateResponse.promise
  })
  const waitingForLateResponse = lateHarness.controller.activate(SESSION_A)
  const eventState = kernelState({
    activeSessionKey: SESSION_A,
    runtimeStatus: 'running'
  })
  lateHarness.emitKernelState(eventState)
  // A stale invoke result carries only a revision ack and must not overwrite events.
  lateResponse.resolve({ revision: 1 })
  await waitingForLateResponse
  assert.equal(lateHarness.currentState, eventState)

  const responseState = kernelState({
    activeSessionKey: SESSION_B,
    runtimeStatus: 'ready'
  })
  let earlyHarness!: ReturnType<typeof createHarness>
  earlyHarness = createHarness(kernelState(), {
    activateSession: async () => {
      // Successful mutations publish state before the ack resolves.
      earlyHarness.emitKernelState(responseState)
      return { revision: 2 }
    }
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

test('the synthetic new view remains until the first prompt lists the provisional Session', async () => {
  const provisionalState = kernelState({
    activeSessionKey: '/tmp/provisional-session.jsonl',
    activeSessionListed: false,
    runtimeStatus: 'ready'
  })
  let harness!: ReturnType<typeof createHarness>
  harness = createHarness(kernelState({
    activeSessionKey: '/tmp/previous-session.jsonl',
    runtimeStatus: 'ready'
  }), {
    startSession: async () => {
      // Match IPC timing: yield once before the published event is applied.
      await Promise.resolve()
      harness.emitKernelState(provisionalState)
      return { revision: 1 }
    }
  })

  const start = harness.controller.start()
  assert.equal(harness.snapshot.sessionViewTarget?.kind, 'new')
  await start

  assert.deepEqual(harness.snapshot.sessionViewTarget, {
    kind: 'new',
    projectKey: PROJECT_A,
    prepared: true,
    sawProvisional: true
  })
  assert.equal(harness.currentState, provisionalState)

  harness.emitKernelState(kernelState({
    activeSessionKey: '/tmp/provisional-session.jsonl',
    activeSessionListed: true,
    runtimeStatus: 'running'
  }))
  assert.equal(harness.snapshot.sessionViewTarget, null)
})

type HarnessOptions = {
  startSession?: () => Promise<KernelMutationAck>
  activateSession?: (sessionKey: string) => Promise<KernelMutationAck>
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
  const previewCalls: string[] = []
  const errors: unknown[] = []
  const completedActions: Array<{
    action: 'start-session' | 'activate-session'
    succeeded: boolean
  }> = []
  const timers = new Map<number, () => void>()
  const postTasks = new Map<number, () => void>()
  let nextTimer = 0
  let nextPostTask = 0

  const publishState = (state: KernelState): KernelMutationAck => {
    eventRevision += 1
    currentState = state
    return { revision: eventRevision }
  }

  const controller = new SessionRuntimeController({
    settleMs: 120,
    getKernelState: () => currentState,
    startSession: async () => {
      startCalls += 1
      if (options.startSession !== undefined) return options.startSession()
      return { revision: eventRevision }
    },
    activateSession: async (sessionKey) => {
      activateCalls.push(sessionKey)
      if (options.activateSession !== undefined) return options.activateSession(sessionKey)
      return publishState(kernelState({
        activeSessionKey: sessionKey,
        runtimeStatus: 'ready'
      }))
    },
    previewSession: (sessionKey) => {
      previewCalls.push(sessionKey)
      return options.previewSession?.(sessionKey) ?? Promise.resolve(sessionPreview(sessionKey))
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
    },
    setPostTask: (callback) => {
      nextPostTask += 1
      postTasks.set(nextPostTask, callback)
      return nextPostTask as unknown as ReturnType<typeof setTimeout>
    },
    clearPostTask: (handle) => {
      postTasks.delete(handle as unknown as number)
    }
  })

  return {
    controller,
    get startCalls() {
      return startCalls
    },
    activateCalls,
    previewCalls,
    errors,
    completedActions,
    timers,
    postTasks,
    get snapshot() {
      return snapshot
    },
    get currentState() {
      return currentState
    },
    emitKernelState(state: KernelState) {
      publishState(state)
      controller.reconcileKernelState(state)
    },
    runOnlyTimer() {
      assert.equal(timers.size, 1)
      const [id, callback] = [...timers.entries()][0]
      timers.delete(id)
      callback()
    },
    runAllPostTasks() {
      while (postTasks.size > 0) {
        const tasks = [...postTasks.entries()]
        postTasks.clear()
        for (const [, callback] of tasks) callback()
      }
    }
  }
}

function kernelState(options: {
  activeSessionKey?: string | null
  activeSessionListed?: boolean
  runtimeStatus?: 'stopped' | 'starting' | 'ready' | 'running' | 'stopping' | 'crashed'
  conversation?: KernelConversationState
} = {}): KernelState {
  const activeSessionKey = options.activeSessionKey ?? null
  const runtimeStatus = options.runtimeStatus ?? 'stopped'
  const sessionKeys = new Set([
    SESSION_A,
    SESSION_B,
    SESSION_C,
    ...(activeSessionKey === null ? [] : [activeSessionKey])
  ])
  const summaries = [...sessionKeys].map((key) => ({
    key,
    id: sessionId(key),
    name: null,
    runtimeStatus
  }))
  const listedSessionKeys = new Set([...sessionKeys].filter((key) =>
    options.activeSessionListed !== false || key !== activeSessionKey
  ))
  return {
    projects: [{
      path: PROJECT_A,
      sessions: summaries.filter(({ key }) => listedSessionKeys.has(key))
    }],
    activeProjectKey: PROJECT_A,
    activeSessionKey,
    sessions: summaries,
    runtime: { status: runtimeStatus },
    session: {
      id: activeSessionKey === null ? null : sessionId(activeSessionKey),
      name: null
    },
    conversation: options.conversation ?? conversationState([])
  } as unknown as KernelState
}

function sessionPreview(sessionKey: string): KernelSessionPreview {
  return {
    projectKey: PROJECT_A,
    sessionKey,
    sessionId: sessionId(sessionKey),
    sessionName: null,
    conversation: conversationState([])
  }
}

function sessionId(sessionKey: string): string {
  if (sessionKey === SESSION_A) return 'session-a'
  if (sessionKey === SESSION_B) return 'session-b'
  if (sessionKey === SESSION_C) return 'session-c'
  return `session:${sessionKey}`
}

function conversationState(
  entries: KernelConversationEntry[],
  activeRunStartIndex: number | null = null
): KernelConversationState {
  return { entries, activeRunStartIndex }
}

function messageEntry(
  id: string,
  role: 'user' | 'assistant',
  streaming = false
): KernelConversationEntry {
  return {
    id,
    kind: 'message',
    role,
    text: id,
    timestamp: 1,
    streaming,
    stopReason: null,
    error: null
  }
}

function commandEntry(id: string): KernelConversationEntry {
  return {
    id,
    kind: 'command',
    commandId: id,
    name: id,
    argument: '',
    source: 'gui',
    text: id,
    timestamp: 1
  }
}

function errorEntry(id: string): KernelConversationEntry {
  return {
    id,
    kind: 'error',
    title: id,
    message: id,
    source: 'agent',
    timestamp: 1
  }
}

function withoutSession(state: KernelState, sessionKey: string): KernelState {
  return {
    ...state,
    sessions: state.sessions.filter(({ key }) => key !== sessionKey),
    projects: state.projects.map((project) => ({
      ...project,
      sessions: project.sessions?.filter(({ key }) => key !== sessionKey)
    }))
  }
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
