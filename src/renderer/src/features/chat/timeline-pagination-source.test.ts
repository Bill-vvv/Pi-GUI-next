import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = await readFile(new URL('./Timeline.tsx', import.meta.url), 'utf8')

test('Timeline expands local turns before requesting an authoritative page', () => {
  const localBranch = source.indexOf('if (hiddenCompletedTurnCount > 0)')
  const remoteRequest = source.indexOf('await onLoadEarlierConversation()')
  assert.ok(localBranch >= 0)
  assert.ok(remoteRequest > localBranch)
  assert.match(source, /revealScrollHeightRef\.current = viewport\.scrollHeight/)
  assert.match(source, /正在加载更早历史/)
  assert.match(source, /setEarlierConversationError\(unknownErrorMessage\(error\)\)/)
})
