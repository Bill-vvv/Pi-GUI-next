import assert from 'node:assert/strict'
import test from 'node:test'

import {
  parseActiveProjectPathToken,
  replaceProjectPathToken
} from './project-path-input.ts'

test('parses unquoted and open quoted project path tokens', () => {
  assert.deepEqual(parseActiveProjectPathToken('@src/app', 8), {
    query: 'src/app',
    start: 0,
    end: 8
  })
  assert.deepEqual(parseActiveProjectPathToken('read @"foo bar', 14), {
    query: 'foo bar',
    start: 5,
    end: 14
  })
  assert.deepEqual(parseActiveProjectPathToken('@', 1), {
    query: '',
    start: 0,
    end: 1
  })
  assert.deepEqual(parseActiveProjectPathToken('@"', 2), {
    query: '',
    start: 0,
    end: 2
  })
})

test('does not treat email or ordinary embedded text as a project path token', () => {
  assert.equal(parseActiveProjectPathToken('@', 0), null)
  assert.equal(parseActiveProjectPathToken('person@example.com', 18), null)
  assert.equal(parseActiveProjectPathToken('prefix@src/file', 15), null)
  assert.equal(parseActiveProjectPathToken('closed @"foo bar" text', 17), null)
  assert.equal(parseActiveProjectPathToken('@"closed" text', 10), null)
})

test('replaces a token around the cursor while preserving surrounding text', () => {
  const input = 'open @src/old.ts after'
  const token = parseActiveProjectPathToken(input, 11)
  assert.deepEqual(token, {
    query: 'src/o',
    start: 5,
    end: 16
  })
  assert.deepEqual(replaceProjectPathToken(input, token!, 'src/new.ts'), {
    value: 'open @src/new.ts after',
    cursor: 16
  })
})

test('formats spaces, quotes, and backslashes through the shared path reference format', () => {
  assert.deepEqual(
    replaceProjectPathToken('use @old now', { query: 'old', start: 4, end: 8 }, 'dir/a "b"\\c.txt'),
    {
      value: 'use @"dir/a \\"b\\"\\\\c.txt" now',
      cursor: 25
    }
  )
})

test('rejects control characters in selected paths', () => {
  assert.throws(
    () => replaceProjectPathToken('@bad', { query: 'bad', start: 0, end: 4 }, 'bad\npath'),
    /unsupported control characters/
  )
})
