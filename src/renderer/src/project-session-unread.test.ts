import assert from 'node:assert/strict'
import test from 'node:test'

import {
  indexSessionActivity,
  reconcileUnreadSessionKeys,
  type SessionActivityObservation
} from './features/project/session-unread-state.ts'

const session = (
  identity: string,
  sessionKey: string,
  lastActivityAt: number | null,
  runtimeStatus: SessionActivityObservation['runtimeStatus'] = 'ready'
): SessionActivityObservation => ({ identity, sessionKey, lastActivityAt, runtimeStatus })

test('initial session activity establishes a baseline without marking history unread', () => {
  const observations = [
    session('project-a\u0000one', '/sessions/one.jsonl', 100),
    session('project-a\u0000two', '/sessions/two.jsonl', 200)
  ]

  assert.deepEqual(
    [...reconcileUnreadSessionKeys(new Set(), null, new Map(), observations)],
    []
  )
})

test('hydrating historical activity after a null baseline does not mark the session unread', () => {
  const before = [session('project-a\u0000one', '/sessions/one.jsonl', null)]
  const after = [session('project-a\u0000one', '/sessions/one.jsonl', 100)]

  assert.deepEqual(
    [...reconcileUnreadSessionKeys(
      new Set(),
      '/sessions/two.jsonl',
      indexSessionActivity(before),
      after
    )],
    []
  )
})

test('a newer message marks an undisplayed session unread without observing a running frame', () => {
  const before = [session('project-a\u0000one', '/sessions/one.jsonl', 100)]
  const after = [session('project-a\u0000one', '/sessions/one.jsonl', 200)]

  assert.deepEqual(
    [...reconcileUnreadSessionKeys(
      new Set(),
      '/sessions/two.jsonl',
      indexSessionActivity(before),
      after
    )],
    ['/sessions/one.jsonl']
  )
})

test('a completed background run marks the session unread without a timestamp advance', () => {
  const before = [session('project-a\u0000one', '/sessions/one.jsonl', 100, 'running')]
  const after = [session('project-a\u0000one', '/sessions/one.jsonl', 100, 'ready')]

  assert.deepEqual(
    [...reconcileUnreadSessionKeys(
      new Set(),
      '/sessions/two.jsonl',
      indexSessionActivity(before),
      after
    )],
    ['/sessions/one.jsonl']
  )
})

test('a crashed background run marks the session unread without a timestamp advance', () => {
  const before = [session('project-a\u0000one', '/sessions/one.jsonl', 100, 'running')]
  const after = [session('project-a\u0000one', '/sessions/one.jsonl', 100, 'crashed')]

  assert.deepEqual(
    [...reconcileUnreadSessionKeys(
      new Set(),
      '/sessions/two.jsonl',
      indexSessionActivity(before),
      after
    )],
    ['/sessions/one.jsonl']
  )
})

test('viewing a session clears its unread marker even when its activity advances', () => {
  const before = [session('project-a\u0000one', '/sessions/one.jsonl', 100)]
  const after = [session('project-a\u0000one', '/sessions/one.jsonl', 200)]

  assert.deepEqual(
    [...reconcileUnreadSessionKeys(
      new Set(['/sessions/one.jsonl']),
      '/sessions/one.jsonl',
      indexSessionActivity(before),
      after
    )],
    []
  )
})

test('provisional-to-canonical key migration preserves unread identity', () => {
  const before = [session('project-a\u0000one', 'provisional:one', 100)]
  const after = [session('project-a\u0000one', '/sessions/one.jsonl', 200)]

  assert.deepEqual(
    [...reconcileUnreadSessionKeys(
      new Set(['provisional:one']),
      '/sessions/two.jsonl',
      indexSessionActivity(before),
      after
    )],
    ['/sessions/one.jsonl']
  )
})

test('unchanged, older, and removed session activity do not leave false unread markers', () => {
  const before = [
    session('project-a\u0000one', '/sessions/one.jsonl', 200),
    session('project-a\u0000removed', '/sessions/removed.jsonl', 300)
  ]
  const after = [session('project-a\u0000one', '/sessions/one.jsonl', 100)]

  assert.deepEqual(
    [...reconcileUnreadSessionKeys(
      new Set(['/sessions/removed.jsonl']),
      null,
      indexSessionActivity(before),
      after
    )],
    []
  )
})
