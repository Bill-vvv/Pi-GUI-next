import assert from 'node:assert/strict'
import test from 'node:test'

import {
  countReplaceToolMetadataPayloadChars,
  stringChars
} from './memory-event-metrics.mjs'

test('replace-tool-metadata payload counts expected and metadata together', () => {
  const patch = {
    type: 'replace-tool-metadata',
    expected: { status: 'running', details: 'old' },
    metadata: { status: 'completed', details: 'done', todos: [{ text: 'a' }] }
  }
  const expectedOnly = stringChars(patch.expected)
  const metadataOnly = stringChars(patch.metadata)
  assert.ok(expectedOnly > 0)
  assert.ok(metadataOnly > 0)
  assert.equal(
    countReplaceToolMetadataPayloadChars(patch),
    expectedOnly + metadataOnly
  )
  assert.notEqual(
    countReplaceToolMetadataPayloadChars(patch),
    metadataOnly
  )
})

test('verify-linux-release probe counts expected+metadata for replace-tool-metadata', async () => {
  const source = await import('node:fs/promises').then((fs) =>
    fs.readFile(new URL('./verify-linux-release.mjs', import.meta.url), 'utf8')
  )
  assert.match(
    source,
    /replace-tool-metadata'[\s\S]*stringChars\(patch\.expected\)\s*\+\s*stringChars\(patch\.metadata\)/
  )
})
