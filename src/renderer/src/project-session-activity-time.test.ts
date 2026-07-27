import assert from 'node:assert/strict'
import test from 'node:test'

import { formatSessionActivityAge } from './features/project/session-activity-time.ts'

const NOW = Date.parse('2026-07-27T14:00:00.000Z')

test('session activity age formats recent epoch timestamps', () => {
  assert.equal(formatSessionActivityAge(NOW, NOW), '刚刚')
  assert.equal(formatSessionActivityAge(NOW - 2 * 60_000, NOW), '2 分钟')
  assert.equal(formatSessionActivityAge(NOW - 2 * 60 * 60_000, NOW), '2 小时')
  assert.equal(formatSessionActivityAge(NOW - 2 * 24 * 60 * 60_000, NOW), '2 天')
})

test('session activity age rejects monotonic process times instead of rendering tens of thousands of days', () => {
  assert.equal(formatSessionActivityAge(2_700_000, NOW), null)
  assert.equal(formatSessionActivityAge(Number.NaN, NOW), null)
})
