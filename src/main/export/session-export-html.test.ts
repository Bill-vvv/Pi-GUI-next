import assert from 'node:assert/strict'
import test from 'node:test'

import { createSessionExportHtml } from './session-export-html.ts'

const finalSignature = JSON.stringify({
  v: 1,
  id: 'answer',
  phase: 'final_answer'
})

const commentarySignature = JSON.stringify({
  v: 1,
  id: 'work',
  phase: 'commentary'
})

test('exports user and final or legacy assistant messages while excluding private process data', () => {
  const html = createSessionExportHtml({
    title: 'Useful session',
    messages: [
      { role: 'system', content: 'SYSTEM SECRET' },
      {
        role: 'user',
        content: '**Question**',
        sessionId: 'session-secret',
        projectPath: '/home/private/complete-project-path'
      },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'THINKING SECRET' },
          {
            type: 'text',
            text: 'COMMENTARY SECRET',
            textSignature: commentarySignature
          },
          {
            type: 'toolCall',
            id: 'tool-1',
            name: 'read',
            arguments: {
              path: '/home/private/complete-project-path',
              hidden: 'TOOL ARG SECRET'
            }
          },
          {
            type: 'text',
            text: 'Final **answer**',
            textSignature: finalSignature
          }
        ],
        usage: { input: 999, cost: 123 },
        hiddenJson: '{"secret":true}'
      },
      {
        role: 'toolResult',
        toolCallId: 'tool-1',
        content: [{ type: 'text', text: 'TOOL RESULT SECRET' }],
        details: { error: 'TOOL ERROR SECRET' }
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Legacy final answer' }]
      }
    ]
  })

  assert.match(html, /<strong>Question<\/strong>/)
  assert.match(html, /Final <strong>answer<\/strong>/)
  assert.match(html, /Legacy final answer/)
  for (const excluded of [
    'SYSTEM SECRET',
    'THINKING SECRET',
    'COMMENTARY SECRET',
    'TOOL ARG SECRET',
    'TOOL RESULT SECRET',
    'TOOL ERROR SECRET',
    '/home/private/complete-project-path',
    'session-secret',
    'hiddenJson',
    '"input":999',
    '"cost":123'
  ]) {
    assert.doesNotMatch(html, new RegExp(escapeRegExp(excluded)))
  }
})

test('escapes title, raw HTML, inline code, and fenced code while preserving safe language', () => {
  const html = createSessionExportHtml({
    title: '<img src=x onerror=alert(1)>',
    messages: [
      {
        role: 'user',
        content: '<script>alert("raw")</script>\n\n`<tag>`\n\n```ts\nconst x = "<unsafe>";\n```'
      }
    ]
  })

  assert.doesNotMatch(html, /<script>/)
  assert.doesNotMatch(html, /<img src=x/)
  assert.match(html, /&lt;script&gt;alert\("raw"\)&lt;\/script&gt;/)
  assert.match(html, /<code>&lt;tag&gt;<\/code>/)
  assert.match(html, /<pre><code class="language-ts">const x = "&lt;unsafe&gt;";<\/code><\/pre>/)
  assert.match(html, /<title>&lt;img src=x onerror=alert\(1\)&gt;<\/title>/)
})

test('allows only normalized external links and never remotely loads Markdown images', () => {
  const html = createSessionExportHtml({
    title: null,
    messages: [{
      role: 'user',
      content: [
        '[safe](https://example.com/a?q=1)',
        '[mail](mailto:person@example.com)',
        '[js](javascript:alert(1))',
        '[data](data:text/html,bad)',
        '[file](file:///tmp/private)',
        '[relative](./local)',
        '[credential](https://user:pass@example.com/)',
        '![remote](https://images.example.com/a.png)',
        '![unsafe](data:image/png;base64,AAAA)'
      ].join('\n\n')
    }]
  })

  assert.match(html, /href="https:\/\/example\.com\/a\?q=1"/)
  assert.match(html, /href="mailto:person@example\.com"/)
  assert.doesNotMatch(html, /href="(?:javascript|data|file):/)
  assert.doesNotMatch(html, /user:pass/)
  assert.doesNotMatch(html, /href="\.\/local"/)
  assert.match(html, /Image: <a href="https:\/\/images\.example\.com\/a\.png"/)
  assert.doesNotMatch(html, /<img[^>]+https:\/\/images\.example\.com/)
  assert.doesNotMatch(html, /<img[^>]+data:image\/png;base64,AAAA/)
  assert.match(html, /\[Image: unsafe\]/)
})

test('keeps valid Pi images inline in block order and drops invalid image data', () => {
  const valid = Buffer.from('offline image').toString('base64')
  const oversized = 'A'.repeat(4.5 * 1024 * 1024 + 4)
  const html = createSessionExportHtml({
    title: 'Images',
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'Before' },
        { type: 'image', mimeType: 'image/png', data: valid },
        { type: 'text', text: 'After' },
        { type: 'image', mimeType: 'image/svg+xml', data: 'PHN2Zz4=' },
        { type: 'image', mimeType: 'image/jpeg', data: 'not base64!!!' },
        { type: 'image', mimeType: 'image/gif', data: '' },
        { type: 'image', mimeType: 'image/webp', data: oversized }
      ]
    }]
  })

  const beforeIndex = html.indexOf('Before')
  const imageIndex = html.indexOf(`data:image/png;base64,${valid}`)
  const afterIndex = html.indexOf('After')
  assert.ok(beforeIndex < imageIndex && imageIndex < afterIndex)
  assert.doesNotMatch(html, /image\/svg\+xml/)
  assert.doesNotMatch(html, /PHN2Zz4=/)
  assert.doesNotMatch(html, /not base64/)
  assert.equal((html.match(/<img /g) ?? []).length, 1)
})

test('serializes GFM tables, task lists, references, and a strict offline CSP', () => {
  const html = createSessionExportHtml({
    title: 'GFM',
    messages: [{
      role: 'assistant',
      content: [{
        type: 'text',
        text: [
          '# Result',
          '',
          '- [x] done',
          '- [ ] pending',
          '',
          '| Name | Value |',
          '| :--- | ---: |',
          '| **one** | ~~two~~ |',
          '',
          '[reference][safe-ref]',
          '',
          '[safe-ref]: https://example.org/path'
        ].join('\n'),
        textSignature: finalSignature
      }]
    }]
  })

  assert.match(html, /<h1>Result<\/h1>/)
  assert.match(html, /<ul><li><span aria-hidden="true">☑<\/span>/)
  assert.match(html, /<span aria-hidden="true">☐<\/span>/)
  assert.match(html, /<table><thead><tr><th style="text-align:left">Name<\/th>/)
  assert.match(html, /<td style="text-align:left"><strong>one<\/strong><\/td>/)
  assert.match(html, /<del>two<\/del>/)
  assert.match(html, /href="https:\/\/example\.org\/path"/)
  assert.match(html, /default-src &#39;none&#39;/)
  assert.match(html, /img-src data:/)
  assert.match(html, /style-src &#39;unsafe-inline&#39;/)
  assert.match(html, /base-uri &#39;none&#39;/)
  assert.match(html, /form-action &#39;none&#39;/)
  assert.match(html, /object-src &#39;none&#39;/)
  assert.match(html, /frame-src &#39;none&#39;/)
  assert.doesNotMatch(html, /<script|connect-src|https?:\/\/[^"]+stylesheet/)
})

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
