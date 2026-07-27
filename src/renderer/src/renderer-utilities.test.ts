import assert from 'node:assert/strict'
import test from 'node:test'

import { formatUsd } from './format-usd.ts'
import {
  isThinkingLevel,
  localizedThinkingLevelLabel,
  technicalThinkingLevelLabel,
  THINKING_LEVELS
} from './thinking-level.ts'
import { unknownErrorMessage } from './unknown-error-message.ts'

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
