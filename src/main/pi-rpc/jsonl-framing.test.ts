import assert from 'node:assert/strict'
import test from 'node:test'
import { LfJsonlParser } from './jsonl-framing.ts'

test('parses UTF-8 records across byte chunks and multiple records per chunk', () => {
  const parser = new LfJsonlParser()
  const bytes = Buffer.from('{"value":"你好🙂"}\n{"value":2}\n')
  const split = bytes.indexOf(Buffer.from('🙂')) + 2

  const partialBatch = parser.push(bytes.subarray(0, split))
  assert.deepEqual(partialBatch.records, [])
  assert.deepEqual(partialBatch.recordByteLengths, [])
  const batch = parser.push(bytes.subarray(split))

  assert.deepEqual(batch.errors, [])
  assert.deepEqual(batch.records, [{ value: '你好🙂' }, { value: 2 }])
  assert.deepEqual(batch.recordByteLengths, [
    Buffer.byteLength('{"value":"你好🙂"}\n'),
    Buffer.byteLength('{"value":2}\n')
  ])
})

test('accepts CRLF and skips empty LF records', () => {
  const parser = new LfJsonlParser()
  const batch = parser.push('\n{"ok":true}\r\n\r\n')

  assert.deepEqual(batch.errors, [])
  assert.deepEqual(batch.records, [{ ok: true }])
  assert.deepEqual(batch.recordByteLengths, [Buffer.byteLength('{"ok":true}\r\n')])
})

test('reports an invalid record and continues at the next LF', () => {
  const parser = new LfJsonlParser()
  const batch = parser.push('not-json\n{"ok":true}\n')

  assert.equal(batch.errors.length, 1)
  assert.match(batch.errors[0]?.message ?? '', /Failed to parse Pi RPC JSONL record/)
  assert.deepEqual(batch.records, [{ ok: true }])
  assert.deepEqual(batch.recordByteLengths, [Buffer.byteLength('{"ok":true}\n')])
})

test('reports a bounded preview for an unterminated record on end', () => {
  const parser = new LfJsonlParser()
  parser.push('x'.repeat(200))

  const batch = parser.end()

  assert.equal(batch.errors.length, 1)
  assert.deepEqual(batch.recordByteLengths, [])
  assert.match(batch.errors[0]?.message ?? '', /unterminated JSONL record \(200 chars\)/)
  assert.match(batch.errors[0]?.message ?? '', /x{120}…/)
  assert.doesNotMatch(batch.errors[0]?.message ?? '', /x{121}/)
})

test('does not treat U+2028 as a record separator', () => {
  const parser = new LfJsonlParser()
  const batch = parser.push('{"value":"before after"}\n')

  assert.deepEqual(batch.errors, [])
  assert.deepEqual(batch.records, [{ value: 'before after' }])
  assert.deepEqual(batch.recordByteLengths, [Buffer.byteLength('{"value":"before after"}\n')])
})

test('does not treat U+2029 as a record separator', () => {
  const parser = new LfJsonlParser()
  const batch = parser.push('{"value":"before after"}\n')

  assert.deepEqual(batch.errors, [])
  assert.deepEqual(batch.records, [{ value: 'before after' }])
  assert.deepEqual(batch.recordByteLengths, [Buffer.byteLength('{"value":"before after"}\n')])
})
