import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'

const vite = await createServer({
  configFile: false,
  root: new URL('../../../../../', import.meta.url).pathname,
  appType: 'custom',
  logLevel: 'error',
  server: { middlewareMode: true }
})
after(async () => vite.close())

const markdownModule = await vite.ssrLoadModule(
  '/src/renderer/src/features/chat/MarkdownMessage.tsx'
) as typeof import('./MarkdownMessage.tsx')
const { MarkdownMessage } = markdownModule

test('Markdown renders absolute Linux report paths as clickable file URLs', () => {
  const html = renderToStaticMarkup(createElement(MarkdownMessage, {
    text: '[REPORT.md](/home/vvv/Projects/report.md)',
    streaming: false
  }))

  assert.match(html, /<a href="file:\/\/\/home\/vvv\/Projects\/report\.md"/)
  assert.match(html, />REPORT\.md<\/a>/)
})

test('Markdown renders inline and display LaTeX with KaTeX', () => {
  const html = renderToStaticMarkup(createElement(MarkdownMessage, {
    text: [
      'Controller output: \\(a_t = W_c [z_t; h_t] + b_c\\).',
      '',
      '\\[',
      '\\begin{bmatrix}',
      'z_t \\\\ h_t',
      '\\end{bmatrix}',
      '\\]'
    ].join('\n'),
    streaming: false
  }))

  assert.match(html, /class="katex"/)
  assert.match(html, /class="katex-display"/)
  assert.match(html, /<annotation encoding="application\/x-tex">a_t = W_c \[z_t; h_t\] \+ b_c<\/annotation>/)
  assert.match(html, /\\begin\{bmatrix\}/)
})

test('streaming Markdown renders math without a completion-only format switch', () => {
  const html = renderToStaticMarkup(createElement(MarkdownMessage, {
    text: '$$\na_t = W_c [z_t; h_t] + b_c\n$$',
    streaming: true
  }))

  assert.match(html, /class="katex-display"/)
})

test('Markdown keeps math-like text in code and blocks trusted KaTeX links', () => {
  const codeHtml = renderToStaticMarkup(createElement(MarkdownMessage, {
    text: '`$a_t$`\n\n```text\n$$\na_t\n$$\n```',
    streaming: false
  }))
  const linkHtml = renderToStaticMarkup(createElement(MarkdownMessage, {
    text: '$\\href{https://example.com}{x}$',
    streaming: false
  }))

  assert.doesNotMatch(codeHtml, /class="katex"/)
  assert.match(codeHtml, /<code>\$a_t\$<\/code>/)
  assert.doesNotMatch(linkHtml, /href="https:\/\/example\.com"/)
})
