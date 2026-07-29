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
  const source = await verifierSource()
  assert.match(
    source,
    /replace-tool-metadata'[\s\S]*stringChars\(patch\.expected\)\s*\+\s*stringChars\(patch\.metadata\)/
  )
})

test('verify-linux-release reports and enforces bounded state batches', async () => {
  const source = await verifierSource()
  assert.match(source, /stateBatchEvents/)
  assert.match(source, /stateBatchMembers/)
  assert.match(source, /maxStateBatchSize/)
  assert.match(source, /maxBatchSize\s*>\s*64/)
  assert.match(source, /E_MEMORY_STATE_BATCH_BOUNDS/)
})

async function verifierSource() {
  return import('node:fs/promises').then((fs) =>
    fs.readFile(new URL('./verify-linux-release.mjs', import.meta.url), 'utf8')
  )
}
