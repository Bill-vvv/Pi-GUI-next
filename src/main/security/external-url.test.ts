import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeExternalUrl, normalizeOpenTarget } from '../../shared/external-url.ts'

test('external links allow normalized web and email URLs', () => {
  assert.equal(normalizeExternalUrl('https://example.com/a path?q=1#two'), 'https://example.com/a%20path?q=1#two')
  assert.equal(normalizeExternalUrl('mailto:hello@example.com?subject=Pi'), 'mailto:hello@example.com?subject=Pi')
})

test('user-opened links also allow normalized local Linux file targets', () => {
  assert.equal(
    normalizeOpenTarget('/home/vvv/Projects/report file.md'),
    'file:///home/vvv/Projects/report%20file.md'
  )
  assert.equal(
    normalizeOpenTarget('file:///home/vvv/Projects/report file.md'),
    'file:///home/vvv/Projects/report%20file.md'
  )
  assert.equal(normalizeExternalUrl('/home/vvv/Projects/report.md'), null)
  assert.equal(normalizeExternalUrl('file:///home/vvv/Projects/report.md'), null)
})

test('links reject executable, relative, remote-file, credentialed, and malformed URLs', () => {
  for (const value of [
    'javascript:alert(1)',
    'data:text/html,hello',
    './relative',
    'file://server/share/report.md',
    'https://user:password@example.com',
    'https://example.com\nmalformed',
    ' mailto:hello@example.com'
  ]) {
    assert.equal(normalizeOpenTarget(value), null)
  }
})
