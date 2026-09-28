import assert from 'node:assert/strict'
import test from 'node:test'

import { readDroppedPromptAttachments, submitPromptDraft, readDesktopAttachmentData } from './prompt-attachments.ts'

test('remote draft submission routes every mode through opaque IDs and never forwards mixed local paths', async (t) => {
  const globals = globalThis as unknown as { window?: unknown }
  const original = globals.window
  t.after(() => { if (original === undefined) delete globals.window; else globals.window = original })
  const calls: unknown[][] = []
  globals.window = { piGui: { prompt: () => { throw new Error('Unexpected local path submission') } },
    piDesktopClient: { submitAttachments: async (...args: unknown[]) => { calls.push(args); return { revision: 3 } } } }
  const ref = { type: 'uploaded' as const, uploadId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'file', byteCount: 0, kind: 'file' as const }
  for (const mode of ['prompt', 'steer', 'follow-up'] as const) {
    assert.deepEqual(await submitPromptDraft(mode, 'hello', [ref], 'session-A'), { revision: 3 })
    assert.deepEqual(calls.at(-1), [mode, 'hello', [ref.uploadId], 'session-A'])
  }
  await assert.rejects(submitPromptDraft('prompt', '', [ref, { type: 'file', name: 'secret', path: 'C:\\secret' }]), /不能与本机路径/)
  assert.equal(calls.length, 3)
})

test('remote DOM uploads enforce limits before reading bytes and preserve empty files', async () => {
  let read = false
  const large = { name: 'large', size: 16 * 1024 * 1024 + 1, arrayBuffer: async () => { read = true; return new ArrayBuffer(0) } } as File
  await assert.rejects(readDesktopAttachmentData([large]), /16 MiB/)
  assert.equal(read, false)
  const empty = new File([], 'empty.txt')
  assert.deepEqual(await readDesktopAttachmentData([empty]), [{ name: 'empty.txt', data: new Uint8Array() }])
})

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
