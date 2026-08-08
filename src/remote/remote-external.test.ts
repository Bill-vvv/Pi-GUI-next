import assert from 'node:assert/strict'
import { test } from 'node:test'

import { normalizeExternalUrl } from '../shared/external-url.ts'

test('remote external allowlist rejects file and local paths', () => {
  assert.equal(normalizeExternalUrl('https://example.com/docs'), 'https://example.com/docs')
  assert.equal(normalizeExternalUrl('http://example.com'), 'http://example.com/')
  assert.equal(normalizeExternalUrl('mailto:user@example.com'), 'mailto:user@example.com')
  assert.equal(normalizeExternalUrl('file:///home/vvv/report.md'), null)
  assert.equal(normalizeExternalUrl('/home/vvv/report.md'), null)
  assert.equal(normalizeExternalUrl('javascript:alert(1)'), null)
})
