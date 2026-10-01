import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { SessionMetadataCache } from './session-metadata-cache.ts'
import type { SessionPointer } from './session-pointer.ts'
import { readSessionMetadata, readSessionStatistics } from './session-statistics.ts'
import { readSessionActivityAt } from './session-transcript.ts'

async function fixture(t: test.TestContext): Promise<{ root: string, cachePath: string, pointer: SessionPointer }> {
  const root = await mkdtemp(join(tmpdir(), 'pi-gui-session-metadata-cache-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return {
    root,
    cachePath: join(root, 'cache', 'session-metadata-cache.json'),
    pointer: { projectPath: root, sessionFile: join(root, 'session.jsonl'), sessionId: 'session-1', sessionName: null }
  }
}

function transcript(sessionId: string, messages: Array<{ id: string, at: string, input: number }>): string {
  const lines: unknown[] = [{ type: 'session', version: 3, id: sessionId, timestamp: '2026-07-22T00:00:00.000Z', cwd: '/tmp' }]
  let parentId: string | null = null
  for (const message of messages) {
    lines.push({
      type: 'message',
      id: message.id,
      parentId,
      timestamp: message.at,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: message.id }],
        usage: { input: message.input, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.5 } }
      }
    })
    parentId = message.id
  }
  return `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`
}

async function uncached(pointer: SessionPointer) {
  const settle = <T>(promise: Promise<T>) => promise.then((value) => ({ value }), (error: Error) => ({ error: error.message }))
  return {
    activityAt: await readSessionActivityAt(pointer),
    statistics: await settle(readSessionStatistics(pointer)),
    metadata: await settle(readSessionMetadata(pointer))
  }
}

async function cached(cache: SessionMetadataCache, pointer: SessionPointer) {
  const settle = <T>(promise: Promise<T>) => promise.then((value) => ({ value }), (error: Error) => ({ error: error.message }))
  return {
    activityAt: await cache.readSessionActivityAt(pointer),
    statistics: await settle(cache.readSessionStatistics(pointer)),
    metadata: await settle(cache.readSessionMetadata(pointer))
  }
}

test('results equal the uncached readers, survive a restart and are not re-read while the file is unchanged', async (t) => {
  const { cachePath, pointer } = await fixture(t)
  await writeFile(pointer.sessionFile, transcript('session-1', [{ id: 'a', at: '2026-07-22T01:00:00.000Z', input: 5 }]))
  // Whole-second times so restoring them below reproduces the exact stamp.
  const fixedTime = new Date('2026-07-22T05:00:00.000Z')
  await utimes(pointer.sessionFile, fixedTime, fixedTime)
  const expected = await uncached(pointer)
  assert.equal(expected.activityAt, Date.parse('2026-07-22T01:00:00.000Z'))

  const first = await SessionMetadataCache.open(cachePath)
  assert.deepEqual(await cached(first, pointer), expected)
  await first.flush()
  assert.equal((await stat(cachePath)).mode & 0o777, 0o600)

  // Same inode, size and modification time but different bytes: a reopened cache must not read the file.
  const replaced = transcript('session-1', [{ id: 'b', at: '2026-07-22T09:00:00.000Z', input: 5 }])
  assert.equal(Buffer.byteLength(replaced), (await stat(pointer.sessionFile)).size)
  await writeFile(pointer.sessionFile, replaced)
  await utimes(pointer.sessionFile, fixedTime, fixedTime)
  const reopened = await SessionMetadataCache.open(cachePath)
  assert.deepEqual(await cached(reopened, pointer), expected)

  // An append changes the stamp and is read again.
  await writeFile(pointer.sessionFile, transcript('session-1', [
    { id: 'a', at: '2026-07-22T01:00:00.000Z', input: 5 },
    { id: 'c', at: '2026-07-22T02:00:00.000Z', input: 7 }
  ]))
  const appended = await uncached(pointer)
  assert.equal(appended.activityAt, Date.parse('2026-07-22T02:00:00.000Z'))
  assert.deepEqual(await cached(reopened, pointer), appended)
})

test('invalid transcripts, Session id mismatches and missing files fail exactly like the uncached readers', async (t) => {
  const { cachePath, pointer, root } = await fixture(t)
  const cache = await SessionMetadataCache.open(cachePath)

  await writeFile(pointer.sessionFile, transcript('session-1', [{ id: 'a', at: '2026-07-22T01:00:00.000Z', input: -1 }]))
  const invalidUsage = await uncached(pointer)
  assert.ok('error' in invalidUsage.statistics)
  assert.deepEqual(await cached(cache, pointer), invalidUsage)

  const other = { ...pointer, sessionId: 'session-2' }
  const mismatch = await uncached(other)
  assert.ok('error' in mismatch.metadata)
  assert.deepEqual(await cached(cache, other), mismatch)

  const missing = { ...pointer, sessionFile: join(root, 'missing.jsonl') }
  assert.deepEqual(await cached(cache, missing), await uncached(missing))
})

test('a corrupt cache file is ignored and only Sessions read by this process are kept', async (t) => {
  const { cachePath, pointer, root } = await fixture(t)
  await writeFile(pointer.sessionFile, transcript('session-1', [{ id: 'a', at: '2026-07-22T01:00:00.000Z', input: 5 }]))
  const second: SessionPointer = { ...pointer, sessionFile: join(root, 'second.jsonl'), sessionId: 'session-2' }
  await writeFile(second.sessionFile, transcript('session-2', [{ id: 'a', at: '2026-07-22T03:00:00.000Z', input: 1 }]))

  await (await import('node:fs/promises')).mkdir(join(root, 'cache'))
  await writeFile(cachePath, '{ not json')
  const first = await SessionMetadataCache.open(cachePath)
  assert.deepEqual(await cached(first, pointer), await uncached(pointer))
  assert.equal(await first.readSessionActivityAt(second), Date.parse('2026-07-22T03:00:00.000Z'))
  await first.flush()
  assert.deepEqual(Object.keys(JSON.parse(await readFile(cachePath, 'utf8')).entries).sort(), [pointer.sessionFile, second.sessionFile].sort())

  // The next run reads only the first Session; the removed one drops out when something changes.
  const next = await SessionMetadataCache.open(cachePath)
  await next.readSessionActivityAt(pointer)
  await writeFile(pointer.sessionFile, transcript('session-1', [
    { id: 'a', at: '2026-07-22T01:00:00.000Z', input: 5 },
    { id: 'b', at: '2026-07-22T04:00:00.000Z', input: 5 }
  ]))
  await next.readSessionActivityAt(pointer)
  await next.flush()
  assert.deepEqual(Object.keys(JSON.parse(await readFile(cachePath, 'utf8')).entries), [pointer.sessionFile])
})
