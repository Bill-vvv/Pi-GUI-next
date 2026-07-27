import assert from 'node:assert/strict'
import test from 'node:test'

import {
  nextVisibleSessionCount,
  nextVisibleSessionCountWithRetained,
  resolveVisibleSessionCount,
  selectVisibleSessions
} from './features/project/session-list-visibility.ts'

test('session lists expand in five-item stages and collapse to the default five', () => {
  let requestedVisibleCount: number | undefined

  assert.equal(resolveVisibleSessionCount(40, requestedVisibleCount), 5)

  requestedVisibleCount = nextVisibleSessionCount(40, requestedVisibleCount)
  assert.equal(resolveVisibleSessionCount(40, requestedVisibleCount), 10)

  requestedVisibleCount = nextVisibleSessionCount(40, requestedVisibleCount)
  assert.equal(resolveVisibleSessionCount(40, requestedVisibleCount), 15)

  requestedVisibleCount = undefined
  assert.equal(resolveVisibleSessionCount(40, requestedVisibleCount), 5)
})

test('session list expansion never exceeds the available item count', () => {
  assert.equal(resolveVisibleSessionCount(3), 3)
  assert.equal(nextVisibleSessionCount(8), 8)
  assert.equal(nextVisibleSessionCount(12, 10), 12)
})

test('retained sessions remain visible after runtime-first sorting moves them beyond history pagination', () => {
  const runningOrder = ['target', 'one', 'two', 'three', 'four', 'five'].map((key) => ({ key }))
  assert.deepEqual(
    selectVisibleSessions(runningOrder, resolveVisibleSessionCount(runningOrder.length), new Set()),
    runningOrder.slice(0, 5)
  )

  const settledOrder = ['one', 'two', 'three', 'four', 'five', 'target'].map((key) => ({ key }))
  assert.deepEqual(
    selectVisibleSessions(
      settledOrder,
      resolveVisibleSessionCount(settledOrder.length),
      new Set(['target'])
    ).map(({ key }) => key),
    ['one', 'two', 'three', 'four', 'five', 'target']
  )
})

test('retained sessions preserve kernel order and return to normal pagination once released', () => {
  const sessions = ['one', 'two', 'three', 'four', 'five', 'six', 'seven'].map((key) => ({ key }))

  assert.deepEqual(
    selectVisibleSessions(sessions, 5, new Set(['seven', 'six'])).map(({ key }) => key),
    ['one', 'two', 'three', 'four', 'five', 'six', 'seven']
  )
  assert.deepEqual(
    selectVisibleSessions(sessions, 5, new Set()).map(({ key }) => key),
    ['one', 'two', 'three', 'four', 'five']
  )
})

test('expansion skips retained exceptions and still reveals five hidden history sessions', () => {
  const sessions = Array.from({ length: 15 }, (_, index) => ({ key: String(index + 1) }))
  const retained = new Set(['6', '7', '8', '9', '10'])
  const currentCount = resolveVisibleSessionCount(sessions.length)
  const nextCount = nextVisibleSessionCountWithRetained(sessions, undefined, retained)
  const current = selectVisibleSessions(sessions, currentCount, retained)
  const next = selectVisibleSessions(sessions, nextCount, retained)

  assert.equal(nextCount, 15)
  assert.equal(next.length - current.length, 5)
})
