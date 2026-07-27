import assert from 'node:assert/strict'
import test from 'node:test'

import {
  extractToolResultImage,
  findToolResultMessage,
  mergeToolImageAttachments,
  projectToolResultContent,
  validateToolImageBlock
} from './tool-result-images.ts'

/** Minimal valid 1×1 PNG (canonical base64). */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

/** Minimal JPEG signature payload (canonical base64). */
const JPEG_BASE64 = '/9j/2Q=='

test('projects mixed tool text and image content without embedding base64', () => {
  const projected = projectToolResultContent([
    { type: 'text', text: 'generated' },
    { type: 'image', mimeType: 'image/png', data: PNG_BASE64 },
    { type: 'text', text: 'done' }
  ])

  assert.equal(projected.text, 'generated\ndone')
  assert.deepEqual(projected.attachments, [{
    type: 'image',
    name: 'image-1',
    mimeType: 'image/png',
    byteLength: Buffer.from(PNG_BASE64, 'base64').length,
    contentIndex: 1
  }])
  assert.equal(JSON.stringify(projected).includes(PNG_BASE64), false)
})

test('ignores illegal image blocks without dropping sibling text or valid images', () => {
  const projected = projectToolResultContent([
    { type: 'text', text: 'keep-me' },
    { type: 'image', mimeType: 'image/svg+xml', data: PNG_BASE64 },
    { type: 'image', mimeType: 'image/png', data: '' },
    { type: 'image', mimeType: 'image/png', data: 'not-base64!!' },
    { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' }, // text bytes, wrong signature
    { type: 'image', mimeType: 'image/jpeg', data: PNG_BASE64 }, // MIME/signature mismatch
    { type: 'image', mimeType: 'image/png', data: PNG_BASE64 },
    { type: 'unknown', value: 1 }
  ])

  assert.equal(projected.text, 'keep-me')
  assert.equal(projected.attachments.length, 1)
  assert.equal(projected.attachments[0]?.contentIndex, 6)
  assert.equal(projected.attachments[0]?.mimeType, 'image/png')
})

test('accepts jpeg gif and webp signatures when MIME matches', () => {
  const jpeg = validateToolImageBlock(
    { type: 'image', mimeType: 'image/jpeg', data: JPEG_BASE64 },
    3
  )
  assert.equal(jpeg?.mimeType, 'image/jpeg')
  assert.equal(jpeg?.contentIndex, 3)

  // Minimal GIF89a header + a few bytes (not a full GIF but signature check only).
  const gifBytes = Buffer.from('GIF89a' + '\0'.repeat(10), 'binary')
  const gif = validateToolImageBlock(
    { type: 'image', mimeType: 'image/gif', data: gifBytes.toString('base64') },
    0
  )
  assert.equal(gif?.mimeType, 'image/gif')

  const webpHeader = Buffer.alloc(12)
  webpHeader.write('RIFF', 0)
  webpHeader.writeUInt32LE(4, 4)
  webpHeader.write('WEBP', 8)
  const webp = validateToolImageBlock(
    { type: 'image', mimeType: 'image/webp', data: webpHeader.toString('base64') },
    2
  )
  assert.equal(webp?.mimeType, 'image/webp')
  assert.equal(webp?.contentIndex, 2)
})

test('merge keeps prior attachments when the next partial is empty', () => {
  const existing = [{
    type: 'image' as const,
    name: 'image-1',
    mimeType: 'image/png',
    byteLength: 10,
    contentIndex: 1
  }]
  assert.deepEqual(mergeToolImageAttachments(existing, []), existing)
  assert.equal(mergeToolImageAttachments(undefined, []), undefined)
  const next = [{
    type: 'image' as const,
    name: 'image-2',
    mimeType: 'image/png',
    byteLength: 20,
    contentIndex: 2
  }]
  assert.deepEqual(mergeToolImageAttachments(existing, next), next)
})

test('extracts tool images by stable contentIndex from transcript messages', () => {
  const messages = [
    { role: 'user', content: 'please generate' },
    {
      role: 'toolResult',
      toolCallId: 'call-1',
      content: [
        { type: 'text', text: 'ok' },
        { type: 'image', mimeType: 'image/png', data: PNG_BASE64 }
      ]
    }
  ]
  const message = findToolResultMessage(messages, 'call-1')
  const image = extractToolResultImage(message, 1)
  assert.equal(image.mimeType, 'image/png')
  assert.equal(image.data, PNG_BASE64)
  assert.equal(image.name, 'image-2')
  assert.equal(image.path, '')

  assert.throws(
    () => extractToolResultImage(message, 0),
    /invalid/i
  )
  assert.throws(
    () => findToolResultMessage(messages, 'missing'),
    /not found/i
  )
})
