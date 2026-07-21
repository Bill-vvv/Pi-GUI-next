import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeExternalUrl } from '../../shared/external-url.ts'

test('external links allow normalized web and email URLs', () => {
  assert.equal(normalizeExternalUrl('https://example.com/a path?q=1#two'), 'https://example.com/a%20path?q=1#two')
  assert.equal(normalizeExternalUrl('mailto:hello@example.com?subject=Pi'), 'mailto:hello@example.com?subject=Pi')
})

test('external links reject executable, local, relative, credentialed, and malformed URLs', () => {
  for (const value of [
    'javascript:alert(1)',
    'data:text/html,hello',
    'file:///tmp/private',
    './relative',
    'https://user:password@example.com',
    'https://example.com\nmalformed',
    ' mailto:hello@example.com'
  ]) {
    assert.equal(normalizeExternalUrl(value), null)
  }
})
