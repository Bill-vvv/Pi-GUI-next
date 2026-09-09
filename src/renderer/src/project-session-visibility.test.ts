import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  countRevealableSessionListItems,
  filterSessionListItems,
  matchesSessionListTimeFilter,
  selectRevealedSessionListItems,
  sessionListTimeBounds,
  SESSION_LIST_REVEAL_STEP
} from './features/project/session-list-query.ts'

const day = 86_400_000
const sessionListBrowserSource = readFileSync(
  new URL('./features/project/SessionListBrowser.tsx', import.meta.url),
  'utf8'
)
const projectCssSource = readFileSync(
  new URL('./features/project/project.css', import.meta.url),
  'utf8'
)

test('session list search is case-insensitive title substring match on the same list', () => {
  const items = [
    { key: 'a', title: 'VPN 配置', lastActivityAt: 100 },
    { key: 'b', title: '法律讲座', lastActivityAt: 90 },
    { key: 'c', title: 'vpn 排查', lastActivityAt: 80 }
  ]

  assert.deepEqual(
    filterSessionListItems(items, { search: 'vpn', timeFilter: 'all' }, 1_000).map(({ key }) => key),
    ['a', 'c']
  )
})

test('session list time chips partition by local day and week bounds', () => {
  // Wednesday 2026-08-05 12:00 local-equivalent via fixed timestamp construction
  const now = Date.UTC(2026, 7, 5, 12, 0, 0)
  const { dayStart, weekStart } = sessionListTimeBounds(now)

  assert.equal(matchesSessionListTimeFilter(dayStart + 1, 'today', now), true)
  assert.equal(matchesSessionListTimeFilter(dayStart - 1, 'today', now), false)
  assert.equal(matchesSessionListTimeFilter(weekStart + 1, 'week', now), true)
  assert.equal(matchesSessionListTimeFilter(weekStart - 1, 'week', now), false)
  assert.equal(matchesSessionListTimeFilter(weekStart - 1, 'older', now), true)
  assert.equal(matchesSessionListTimeFilter(null, 'older', now), true)
  assert.equal(matchesSessionListTimeFilter(null, 'today', now), false)

  const items = [
    { key: 'today', title: 'today', lastActivityAt: dayStart + hour(1) },
    { key: 'week', title: 'week', lastActivityAt: weekStart + hour(1) },
    { key: 'older', title: 'older', lastActivityAt: weekStart - day },
    { key: 'unknown', title: 'unknown', lastActivityAt: null }
  ]

  assert.deepEqual(
    filterSessionListItems(items, { search: '', timeFilter: 'today' }, now).map(({ key }) => key),
    ['today']
  )
  assert.deepEqual(
    filterSessionListItems(items, { search: '', timeFilter: 'week' }, now).map(({ key }) => key),
    ['today', 'week']
  )
  assert.deepEqual(
    filterSessionListItems(items, { search: '', timeFilter: 'older' }, now).map(({ key }) => key),
    ['older', 'unknown']
  )
})

test('retained sessions stay visible at the front when filters would hide them', () => {
  const now = Date.UTC(2026, 7, 5, 12, 0, 0)
  const { dayStart } = sessionListTimeBounds(now)
  const items = [
    { key: 'current', title: '当前对话', lastActivityAt: dayStart - day * 30 },
    { key: 'fresh', title: '今天的', lastActivityAt: dayStart + 1 }
  ]

  assert.deepEqual(
    filterSessionListItems(
      items,
      { search: '', timeFilter: 'today' },
      now,
      new Set(['current'])
    ).map(({ key }) => key),
    ['current', 'fresh']
  )
})

test('session reveal stays a low-emphasis row control', () => {
  const revealRule = projectCssSource.match(/\.session-list-reveal \{[^}]+\}/s)?.[0]
  const revealHoverRule = projectCssSource.match(/\.session-list-reveal:hover:not\(:disabled\) \{[^}]+\}/s)?.[0]

  assert.ok(revealRule)
  assert.match(revealRule, /width: 100%/)
  assert.match(revealRule, /border: 0/)
  assert.match(revealRule, /background: transparent/)
  assert.match(revealRule, /text-align: left/)
  assert.doesNotMatch(revealRule, /justify-self: center/)
  assert.ok(revealHoverRule)
  assert.match(revealHoverRule, /background: transparent/)
})

test('shared session browser expands all remaining rows and can collapse to the default window', () => {
  assert.match(sessionListBrowserSource, /className="session-list-reveal"/)
  assert.match(sessionListBrowserSource, /展开其余/)
  assert.match(sessionListBrowserSource, /收起至/)
  assert.match(sessionListBrowserSource, /aria-controls=\{itemListId\}/)
  assert.match(sessionListBrowserSource, /aria-expanded=\{canCollapse\}/)
  assert.match(sessionListBrowserSource, /itemCount: canCollapse \? SESSION_LIST_REVEAL_STEP : revealableItemCount/)
  assert.doesNotMatch(sessionListBrowserSource, /useVirtualizer|session-list-scroll/)
})

test('session list reveal shows six ordinary rows while retained rows stay visible outside the window', () => {
  const items = Array.from({ length: 10 }, (_, index) => ({ key: String(index + 1) }))
  const retained = new Set(['10'])

  assert.equal(SESSION_LIST_REVEAL_STEP, 6)
  assert.equal(countRevealableSessionListItems(items, retained), 9)
  assert.deepEqual(
    selectRevealedSessionListItems(items, SESSION_LIST_REVEAL_STEP, retained).map(({ key }) => key),
    ['1', '2', '3', '4', '5', '6', '10']
  )
  assert.deepEqual(
    selectRevealedSessionListItems(items, SESSION_LIST_REVEAL_STEP * 2, retained).map(({ key }) => key),
    items.map(({ key }) => key)
  )
})

function hour(count: number): number {
  return count * 3_600_000
}
