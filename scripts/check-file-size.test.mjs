import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { FILE_LINE_LIMIT, checkFileSizes, measure } from './check-file-size.mjs'

test('source files respect the D-098 size rule', () => {
  const baseline = JSON.parse(readFileSync(new URL('./file-size-baseline.json', import.meta.url), 'utf8'))
  const { violations } = checkFileSizes(measure(), baseline)
  assert.deepEqual(violations, [])
})

test('new oversized files and growth of recorded files are violations; shrinking is not', () => {
  const baseline = { 'src/old.ts': 900 }
  assert.deepEqual(checkFileSizes({ 'src/new.ts': FILE_LINE_LIMIT, 'src/old.ts': 900 }, baseline),
    { violations: [], shrinkable: [] })
  const result = checkFileSizes({ 'src/new.ts': FILE_LINE_LIMIT + 1, 'src/old.ts': 901, 'src/other.ts': 10 }, baseline)
  assert.equal(result.violations.length, 2)
  assert.deepEqual(checkFileSizes({ 'src/old.ts': 850 }, baseline).shrinkable, ['src/old.ts: 900 -> 850'])
})
