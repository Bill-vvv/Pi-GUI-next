import assert from 'node:assert/strict'
import test from 'node:test'

import { formatDuration } from './format-duration.ts'
import { formatUsd } from './format-usd.ts'
import {
  isThinkingLevel,
  localizedThinkingLevelLabel,
  technicalThinkingLevelLabel,
  THINKING_LEVELS
} from './thinking-level.ts'
import { unknownErrorMessage } from './unknown-error-message.ts'
import {
  formatPercent,
  formatTokenCount,
  normalizeContextPercent
} from './usage-formatters.ts'

test('unknownErrorMessage preserves Error messages and stringifies other values', () => {
  assert.equal(unknownErrorMessage(new Error('boom')), 'boom')
  assert.equal(unknownErrorMessage(new Error('')), '')
  assert.equal(unknownErrorMessage('failure'), 'failure')
  assert.equal(unknownErrorMessage(42), '42')
  assert.equal(unknownErrorMessage(null), 'null')
  assert.equal(unknownErrorMessage({ reason: 'failure' }), '[object Object]')
})

test('formatUsd preserves the existing small-positive precision rule', () => {
  assert.equal(formatUsd(0), '$0.00')
  assert.equal(formatUsd(0.001), '$0.0010')
  assert.equal(formatUsd(0.0099), '$0.0099')
  assert.equal(formatUsd(0.01), '$0.01')
  assert.equal(formatUsd(1), '$1.00')
  assert.equal(formatUsd(-1), '$-1.00')
  assert.equal(formatUsd(Number.NaN), '—')
  assert.equal(formatUsd(Number.POSITIVE_INFINITY), '—')
})

test('duration formatting rejects invalid values and preserves normal units', () => {
  assert.equal(formatDuration(Number.NaN), '—')
  assert.equal(formatDuration(Number.POSITIVE_INFINITY), '—')
  assert.equal(formatDuration(-1), '—')
  assert.equal(formatDuration(0), '0ms')
  assert.equal(formatDuration(2_300), '2.3s')
  assert.equal(formatDuration(60_000), '1m 0s')
})

test('usage formatting rejects invalid counts and keeps percentages internally consistent', () => {
  assert.equal(formatTokenCount(null), '—')
  assert.equal(formatTokenCount(1.5), '—')
  assert.equal(formatTokenCount(Number.MAX_SAFE_INTEGER + 1), '—')
  assert.equal(formatTokenCount(12_345), '12,345')
  assert.equal(formatTokenCount(999, 'compact'), '999')
  assert.equal(formatTokenCount(1_000, 'compact'), '1k')
  assert.equal(formatTokenCount(1_250, 'compact'), '1.25k')
  assert.equal(formatTokenCount(12_500, 'compact'), '12.5k')
  assert.equal(formatTokenCount(125_000, 'compact'), '125k')
  assert.equal(formatTokenCount(999_999, 'compact'), '1m')
  assert.equal(formatTokenCount(1_250_000, 'compact'), '1.25m')
  assert.equal(formatTokenCount(2_500_000_000, 'compact'), '2.5b')
  assert.equal(normalizeContextPercent(Number.NaN), null)
  assert.equal(normalizeContextPercent(-1), null)
  assert.equal(normalizeContextPercent(150), 100)
  assert.equal(formatPercent(150), '100.0%')
})

test('thinking levels expose the canonical order, guards, and labels', () => {
  const localized = ['关闭', '最小', '低', '中', '高', '极高', '最高']
  const technical = ['Off', 'Minimal', 'Low', 'Medium', 'High', 'Extra High', 'Max']

  assert.deepEqual(THINKING_LEVELS, [
    'off',
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh',
    'max'
  ])
  assert.deepEqual(THINKING_LEVELS.map(localizedThinkingLevelLabel), localized)
  assert.deepEqual(THINKING_LEVELS.map(technicalThinkingLevelLabel), technical)
  for (const level of THINKING_LEVELS) assert.equal(isThinkingLevel(level), true)
  assert.equal(isThinkingLevel('inherit'), false)
  assert.equal(isThinkingLevel(''), false)
  assert.equal(isThinkingLevel('unknown'), false)
})
