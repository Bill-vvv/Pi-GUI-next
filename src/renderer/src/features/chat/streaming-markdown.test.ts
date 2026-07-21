import assert from 'node:assert/strict'
import test from 'node:test'

import { buildStreamingMarkdownModel } from './streaming-markdown.ts'

test('append-only streaming reuses completed top-level Markdown blocks', () => {
  const first = buildStreamingMarkdownModel('First paragraph.\n\nSecond')
  const next = buildStreamingMarkdownModel('First paragraph.\n\nSecond paragraph.', first)

  assert.equal(next.blocks[0], first.blocks[0])
  assert.equal(next.blocks[0]?.format, 'markdown')
  assert.equal(next.blocks.at(-1)?.stable, false)
})

test('an oversized paragraph stays complete and bypasses streaming Markdown parsing', () => {
  const text = '*'.repeat(16_385)
  const model = buildStreamingMarkdownModel(text)

  assert.equal(model.wholeDocument, false)
  assert.equal(model.blocks.length, 1)
  assert.equal(model.blocks[0]?.format, 'plain-text')
  assert.equal(model.blocks[0]?.stable, false)
  assert.equal(model.blocks[0]?.text, text)
})

test('an oversized tail preserves and reuses completed Markdown blocks', () => {
  const first = buildStreamingMarkdownModel('First paragraph.\n\ntail')
  const text = `First paragraph.\n\n${'tail'.repeat(4_097)}`
  const next = buildStreamingMarkdownModel(text, first)

  assert.equal(next.blocks[0], first.blocks[0])
  assert.equal(next.blocks.at(-1)?.format, 'plain-text')
  assert.equal(next.blocks.map((block) => block.text).join(''), text)
})

test('lists and CommonMark fence variants stay intact as top-level blocks', () => {
  const list = buildStreamingMarkdownModel('- first\n\n- second')
  assert.equal(list.blocks.length, 1)

  const fenced = buildStreamingMarkdownModel('   ~~~ts\nconst value = 1\n   ~~~\n\nAfter')
  assert.equal(fenced.blocks.length, 2)
  assert.equal(fenced.blocks[0]?.stable, true)
  assert.match(fenced.blocks[0]?.text ?? '', /~~~ts/)
})

test('document-wide link definitions keep the message in one parser document', () => {
  const model = buildStreamingMarkdownModel('[Pi][site]\n\n[site]: https://example.com')

  assert.equal(model.wholeDocument, true)
  assert.equal(model.blocks.length, 1)
  assert.equal(model.blocks[0]?.text, model.sourceText)
})

test('document-wide definitions enter bounded plain-text mode over budget', () => {
  const initial = buildStreamingMarkdownModel('[Pi][site]\n\n[site]: https://example.com')
  const text = `${initial.sourceText}\n${'x'.repeat(16_385)}`
  const model = buildStreamingMarkdownModel(text, initial)

  assert.equal(initial.wholeDocument, true)
  assert.equal(model.wholeDocument, false)
  assert.equal(model.blocks.length, 1)
  assert.equal(model.blocks[0]?.format, 'plain-text')
  assert.equal(model.blocks[0]?.text, text)
})

test('a non-prefix rewrite reparses instead of reusing stale blocks', () => {
  const first = buildStreamingMarkdownModel('Old paragraph.\n\nTail')
  const next = buildStreamingMarkdownModel('New paragraph.\n\nTail', first)

  assert.notEqual(next.blocks[0], first.blocks[0])
  assert.match(next.blocks[0]?.text ?? '', /^New paragraph/)
})

test('a non-prefix rewrite over budget discards stale blocks and preserves the rewrite', () => {
  const first = buildStreamingMarkdownModel('Old paragraph.\n\nTail')
  const text = `New paragraph.\n\n${'x'.repeat(16_385)}`
  const next = buildStreamingMarkdownModel(text, first)

  assert.notEqual(next.blocks[0], first.blocks[0])
  assert.equal(next.blocks.length, 1)
  assert.equal(next.blocks[0]?.format, 'plain-text')
  assert.equal(next.blocks[0]?.text, text)
})
