import assert from 'node:assert/strict'
import test from 'node:test'

import { readDroppedPromptAttachments } from './prompt-attachments.ts'

test('creates a path reference without reading the full ordinary file', async () => {
  let fullFileRead = false
  const file = {
    name: 'large.txt',
    type: 'text/plain',
    size: 1024 * 1024 * 1024,
    lastModified: 1,
    slice: () => new Blob([new Uint8Array(12)]),
    arrayBuffer: async () => {
      fullFileRead = true
      throw new Error('ordinary file must not be read')
    }
  } as unknown as File

  const attachments = await readDroppedPromptAttachments(
    [file],
    () => '/tmp/large.txt'
  )

  assert.deepEqual(attachments, [{
    type: 'file',
    name: 'large.txt',
    path: '/tmp/large.txt'
  }])
  assert.equal(fullFileRead, false)
})

test('fails fast when an ordinary dropped file has no local path', async () => {
  const file = {
    name: 'notes.txt',
    type: 'text/plain',
    size: 12,
    lastModified: 1,
    slice: () => new Blob([new Uint8Array(12)])
  } as unknown as File

  await assert.rejects(
    readDroppedPromptAttachments([file], () => ''),
    /无法获取文件的本地路径/
  )
})
