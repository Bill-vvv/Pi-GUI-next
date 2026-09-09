import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('./ExtensionDialog.tsx', import.meta.url), 'utf8')
const styles = await readFile(new URL('./extension-dialog.css', import.meta.url), 'utf8')
const workbenchSource = await readFile(
  new URL('../../composition/Workbench.tsx', import.meta.url),
  'utf8'
)

test('ExtensionDialog derives method-specific initial values without retaining an old request draft', () => {
  assert.match(workbenchSource, /key=\{state\.extensionDialog\.requestId\}/u)
  assert.match(source, /if \(request\.method === 'select'\) return request\.options\[0\] \?\? ''/u)
  assert.match(source, /if \(request\.method === 'editor'\) return request\.prefill \?\? ''/u)
})

test('ExtensionDialog reuses the modal contract and exposes bounded native controls', () => {
  assert.match(source, /useModalDialog\(\{/u)
  assert.match(source, /role="dialog"/u)
  assert.match(source, /aria-modal="true"/u)
  assert.match(source, /aria-busy=\{busy\}/u)
  assert.match(source, /<select/u)
  assert.match(source, /<input/u)
  assert.match(source, /<textarea/u)
  assert.match(source, /maxLength=\{MAX_RESPONSE_CHARS\}/u)
  assert.match(source, /event\.target === event\.currentTarget && !busy/u)
  assert.match(styles, /@media \(max-width: 32rem\)/u)
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/u)
})
