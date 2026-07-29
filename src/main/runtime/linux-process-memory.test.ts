import assert from 'node:assert/strict'
import test from 'node:test'

import {
  readLinuxProcessMemoryBytes,
  smapsFieldBytes
} from './linux-process-memory.ts'

test('smapsFieldBytes converts kibibyte fields to canonical bytes', () => {
  const sample = [
    'Rss:                1234 kB',
    'Pss:                 567 kB',
    'Pss_Anon:            400 kB'
  ].join('\n')

  assert.equal(smapsFieldBytes(sample, 'Rss'), 1234 * 1024)
  assert.equal(smapsFieldBytes(sample, 'Pss'), 567 * 1024)
})

test('smapsFieldBytes rejects missing or malformed fields', () => {
  assert.equal(smapsFieldBytes('Rss: not-a-number kB', 'Rss'), null)
  assert.equal(smapsFieldBytes('Rss: -1 kB', 'Rss'), null)
  assert.equal(smapsFieldBytes('Pss: 12 MB', 'Pss'), null)
  assert.equal(smapsFieldBytes('', 'Rss'), null)
})

test('smapsFieldBytes rejects unsafe kibibyte values and multiplied overflow', () => {
  const maxSafeKibibytes = Math.floor(Number.MAX_SAFE_INTEGER / 1024)
  assert.equal(
    smapsFieldBytes(`Rss: ${maxSafeKibibytes} kB`, 'Rss'),
    maxSafeKibibytes * 1024
  )
  assert.equal(Number.isSafeInteger(maxSafeKibibytes * 1024), true)
  assert.equal(
    smapsFieldBytes(`Rss: ${maxSafeKibibytes + 1} kB`, 'Rss'),
    null
  )
  assert.equal(
    smapsFieldBytes(`Pss: ${Number.MAX_SAFE_INTEGER} kB`, 'Pss'),
    null
  )
  // Larger-than-safe integer decimal tokens must not coerce into finite bytes.
  assert.equal(
    smapsFieldBytes('Rss: 9007199254740993 kB', 'Rss'),
    null
  )
})

test('readLinuxProcessMemoryBytes validates pid before touching /proc', async () => {
  assert.deepEqual(await readLinuxProcessMemoryBytes(0), {
    ok: false,
    reason: 'invalid-pid'
  })
  assert.deepEqual(await readLinuxProcessMemoryBytes(-3), {
    ok: false,
    reason: 'invalid-pid'
  })
  assert.deepEqual(await readLinuxProcessMemoryBytes(1.5), {
    ok: false,
    reason: 'invalid-pid'
  })
})

test('readLinuxProcessMemoryBytes samples the current process on Linux', async () => {
  if (process.platform !== 'linux') {
    assert.deepEqual(await readLinuxProcessMemoryBytes(process.pid), {
      ok: false,
      reason: 'platform-unsupported'
    })
    return
  }

  const result = await readLinuxProcessMemoryBytes(process.pid)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(Number.isInteger(result.memory.rssBytes), true)
  assert.equal(Number.isInteger(result.memory.pssBytes), true)
  assert.ok(result.memory.rssBytes > 0)
  assert.ok(result.memory.pssBytes > 0)
  assert.ok(result.memory.pssBytes <= result.memory.rssBytes * 4)
})

test('readLinuxProcessMemoryBytes reports process-gone for missing pids on Linux', async () => {
  if (process.platform !== 'linux') return

  const result = await readLinuxProcessMemoryBytes(2_147_483_646)
  assert.deepEqual(result, { ok: false, reason: 'process-gone' })
})
