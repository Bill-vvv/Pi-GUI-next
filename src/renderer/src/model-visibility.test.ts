import assert from 'node:assert/strict'
import test from 'node:test'

import { modelVisibilityKey, withModelsVisible } from './model-visibility.ts'

test('batch visibility hides or shows every listed model in one update', () => {
  const unrelated = modelVisibilityKey('other', 'kept-hidden')
  const models = [
    { provider: 'openai', modelId: 'a' },
    { provider: 'openai', modelId: 'b' }
  ]

  const hidden = withModelsVisible(new Set([unrelated]), models, false)
  assert.deepEqual(
    [...hidden].sort(),
    [unrelated, modelVisibilityKey('openai', 'a'), modelVisibilityKey('openai', 'b')].sort()
  )

  const shown = withModelsVisible(hidden, models, true)
  assert.deepEqual([...shown], [unrelated])
})

test('batch visibility never mutates the previous set', () => {
  const previous = new Set<string>()
  withModelsVisible(previous, [{ provider: 'p', modelId: 'm' }], false)
  assert.equal(previous.size, 0)
})
