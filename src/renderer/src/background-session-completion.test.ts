import assert from 'node:assert/strict'
import test from 'node:test'

import type { KernelState } from '../../shared/kernel-contract.ts'
import {
  collectSessionLifecycleObservations,
  indexSessionLifecycles,
  reconcileBackgroundSessionNotifications,
  type SessionLifecycleObservation
} from './features/session/background-session-completion.ts'

const observation = (
  identity: string,
  sessionKey: string,
  runtimeStatus: SessionLifecycleObservation['runtimeStatus']
): SessionLifecycleObservation => ({
  identity,
  projectKey: '/project-a',
  workspaceKind: 'project',
  taskKey: null,
  sessionKey,
  sessionId: 'session-one',
  sessionName: 'Background work',
  runtimeStatus
})

test('a background running-to-ready transition creates a persistent notification', () => {
  const before = [observation('project-a\u0000one', '/sessions/one.jsonl', 'running')]
  const after = [observation('project-a\u0000one', '/sessions/one.jsonl', 'ready')]

  assert.deepEqual(
    reconcileBackgroundSessionNotifications(
      [],
      '/sessions/two.jsonl',
      indexSessionLifecycles(before),
      after
    ),
    [{ ...after[0], outcome: 'completed' }]
  )
})

test('a background running-to-crashed transition creates a failure notification', () => {
  const before = [observation('project-a\u0000one', '/sessions/one.jsonl', 'running')]
  const after = [observation('project-a\u0000one', '/sessions/one.jsonl', 'crashed')]

  assert.deepEqual(
    reconcileBackgroundSessionNotifications(
      [],
      '/sessions/two.jsonl',
      indexSessionLifecycles(before),
      after
    ),
    [{ ...after[0], outcome: 'crashed' }]
  )
})

test('displaying the completed session suppresses and clears its notification', () => {
  const running = observation('project-a\u0000one', '/sessions/one.jsonl', 'running')
  const ready = observation('project-a\u0000one', '/sessions/one.jsonl', 'ready')
  const notification = { ...ready, outcome: 'completed' as const }

  assert.deepEqual(
    reconcileBackgroundSessionNotifications(
      [notification],
      ready.sessionKey,
      indexSessionLifecycles([running]),
      [ready]
    ),
    []
  )
})

test('initial, starting, and user-stopped states do not create completion notifications', () => {
  const ready = observation('project-a\u0000one', '/sessions/one.jsonl', 'ready')
  const stopped = observation('project-a\u0000one', '/sessions/one.jsonl', 'stopped')

  assert.deepEqual(
    reconcileBackgroundSessionNotifications([], null, new Map(), [ready]),
    []
  )
  assert.deepEqual(
    reconcileBackgroundSessionNotifications(
      [],
      null,
      indexSessionLifecycles([
        observation('project-a\u0000one', '/sessions/one.jsonl', 'stopping')
      ]),
      [stopped]
    ),
    []
  )
})

test('notifications follow canonical key migration and remain bounded to the latest three', () => {
  const first = observation('project-a\u0000one', 'provisional:one', 'ready')
  const second = observation('project-a\u0000two', '/sessions/two.jsonl', 'ready')
  const third = observation('project-a\u0000three', '/sessions/three.jsonl', 'ready')
  const fourthRunning = observation('project-a\u0000four', '/sessions/four.jsonl', 'running')
  const fourthReady = { ...fourthRunning, runtimeStatus: 'ready' as const }
  const migratedFirst = { ...first, sessionKey: '/sessions/one.jsonl' }

  const reconciled = reconcileBackgroundSessionNotifications(
    [
      { ...first, outcome: 'completed' },
      { ...second, outcome: 'completed' },
      { ...third, outcome: 'completed' }
    ],
    null,
    indexSessionLifecycles([first, second, third, fourthRunning]),
    [migratedFirst, second, third, fourthReady]
  )

  assert.deepEqual(reconciled, [
    { ...second, outcome: 'completed' },
    { ...third, outcome: 'completed' },
    { ...fourthReady, outcome: 'completed' }
  ])
})

test('session collection preserves Task routing metadata', () => {
  const state = {
    activeProjectKey: '/tasks/task-a',
    projects: [{
      path: '/tasks/task-a',
      workspaceKind: 'task' as const,
      taskKey: 'task-a',
      sessions: [{
        key: '/sessions/task-a.jsonl',
        id: 'task-session',
        name: null,
        lastActivityAt: 1,
        runtimeStatus: 'ready' as const,
        awaitingUserInput: false,
        statistics: null
      }]
    }],
    sessions: []
  } satisfies Pick<KernelState, 'projects' | 'activeProjectKey' | 'sessions'>

  assert.deepEqual(collectSessionLifecycleObservations(state), [{
    identity: '/tasks/task-a\u0000task-session',
    projectKey: '/tasks/task-a',
    workspaceKind: 'task',
    taskKey: 'task-a',
    sessionKey: '/sessions/task-a.jsonl',
    sessionId: 'task-session',
    sessionName: null,
    runtimeStatus: 'ready'
  }])
})

test('session collection uses the active project summary as the freshest source', () => {
  const background = observation('project-a\u0000one', '/sessions/old.jsonl', 'running')
  const active = observation('project-a\u0000one', '/sessions/current.jsonl', 'ready')
  const state = {
    activeProjectKey: '/project-a',
    projects: [{
      path: '/project-a',
      sessions: [{
        key: background.sessionKey,
        id: background.sessionId,
        name: background.sessionName,
        lastActivityAt: 1,
        runtimeStatus: background.runtimeStatus,
        awaitingUserInput: false,
        statistics: null
      }]
    }],
    sessions: [{
      key: active.sessionKey,
      id: active.sessionId,
      name: active.sessionName,
      lastActivityAt: 2,
      runtimeStatus: active.runtimeStatus,
      awaitingUserInput: false,
      statistics: null
    }]
  } satisfies Pick<KernelState, 'projects' | 'activeProjectKey' | 'sessions'>

  assert.deepEqual(collectSessionLifecycleObservations(state), [{
    ...active,
    identity: '/project-a\u0000session-one',
    projectKey: '/project-a'
  }])
})
