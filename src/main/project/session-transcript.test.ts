import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { SessionPointer } from './session-pointer.ts'
import { readSessionActivityAt, readSessionMessages } from './session-transcript.ts'

test('reads messages from a linear session branch', async (t) => {
  const { pointer, write } = await sessionFixture(t)
  const user = { role: 'user', content: 'hello', timestamp: 1 }
  const assistant = { role: 'assistant', content: [{ type: 'text', text: 'hi' }], timestamp: 2 }
  await write([
    header(pointer.sessionId),
    entry('user', null, 'message', user),
    entry('assistant', 'user', 'message', assistant)
  ])

  assert.deepEqual(await readSessionMessages(pointer), [user, assistant])
})

test('uses the final entry as leaf and excludes abandoned branches', async (t) => {
  const { pointer, write } = await sessionFixture(t)
  const root = { role: 'user', content: 'root' }
  const abandoned = { role: 'assistant', content: 'abandoned' }
  const active = { role: 'assistant', content: 'active' }
  await write([
    header(pointer.sessionId),
    entry('root', null, 'message', root),
    entry('old', 'root', 'message', abandoned),
    entry('active', 'root', 'message', active)
  ])

  assert.deepEqual(await readSessionMessages(pointer), [root, active])
})

test('activity time follows the active branch and excludes newer abandoned messages', async (t) => {
  const { pointer, write } = await sessionFixture(t)
  await write([
    header(pointer.sessionId),
    entry('root', null, 'message', { role: 'user', content: 'root' }, {
      timestamp: '2026-07-22T10:00:00.000Z'
    }),
    entry('abandoned', 'root', 'message', { role: 'assistant', content: 'abandoned' }, {
      timestamp: '2026-07-22T12:00:00.000Z'
    }),
    entry('active', 'root', 'message', { role: 'assistant', content: 'active' }, {
      timestamp: '2026-07-22T10:02:00.000Z'
    })
  ])

  assert.equal(
    await readSessionActivityAt(pointer),
    Date.parse('2026-07-22T10:02:00.000Z')
  )
})

test('walks through a non-message metadata leaf', async (t) => {
  const { pointer, write } = await sessionFixture(t)
  const message = { role: 'user', content: 'kept' }
  await write([
    header(pointer.sessionId),
    entry('message', null, 'message', message),
    entry('metadata', 'message', 'session_info', undefined, { name: 'Renamed' })
  ])

  assert.deepEqual(await readSessionMessages(pointer), [message])
})

test('activity time follows the latest message entry despite clock skew and later metadata', async (t) => {
  const { pointer, write } = await sessionFixture(t)
  await write([
    header(pointer.sessionId),
    entry('user', null, 'message', { role: 'user', content: 'hello' }, {
      timestamp: '2026-07-22T02:30:00.000Z'
    }),
    entry('assistant', 'user', 'message', { role: 'assistant', content: 'done' }, {
      timestamp: '2026-07-22T01:01:00.000Z'
    }),
    entry('session-info', 'assistant', 'session_info', undefined, {
      timestamp: '2026-07-22T02:00:00.000Z',
      name: 'Renamed'
    }),
    entry('capabilities', 'session-info', 'custom', undefined, {
      timestamp: '2026-07-22T03:00:00.000Z',
      customType: 'pi-gui.multi-advisor/capabilities'
    })
  ])

  assert.equal(
    await readSessionActivityAt(pointer),
    Date.parse('2026-07-22T01:01:00.000Z')
  )
})

test('activity time accepts only canonical Pi entry timestamps without guessing units', async (t) => {
  const { pointer, write } = await sessionFixture(t)
  const message = { role: 'user', content: 'kept despite invalid activity metadata' }
  const invalidTimestamps: unknown[] = [
    1_785_000_000,
    1_785_000_000_000,
    42,
    '2026-07-22T01:01:00Z',
    '2026-07-22T01:01:00.000+00:00',
    '2026-02-30T01:01:00.000Z'
  ]

  for (const timestamp of invalidTimestamps) {
    await write([
      header(pointer.sessionId),
      entry('message', null, 'message', message, { timestamp })
    ])
    assert.equal(await readSessionActivityAt(pointer), null)
    assert.deepEqual(await readSessionMessages(pointer), [message])
  }
})

test('rejects an invalid header or mismatched session ID', async (t) => {
  const { pointer, write } = await sessionFixture(t)
  await write([{ type: 'metadata', id: pointer.sessionId }])
  await assert.rejects(readSessionMessages(pointer), /header/)

  await write([header('another-session')])
  await assert.rejects(readSessionMessages(pointer), /does not match/)
})

test('rejects damaged JSON without echoing its contents', async (t) => {
  const { pointer } = await sessionFixture(t)
  await writeFile(pointer.sessionFile, `${JSON.stringify(header(pointer.sessionId))}\n{"secret": nope}\n`)

  await assert.rejects(
    readSessionMessages(pointer),
    (error: Error) => /JSON at line 2/.test(error.message) && !error.message.includes('secret')
  )
})

test('rejects duplicate entry IDs', async (t) => {
  const { pointer, write } = await sessionFixture(t)
  await write([
    header(pointer.sessionId),
    entry('same', null, 'message', { role: 'user' }),
    entry('same', null, 'message', { role: 'assistant' })
  ])

  await assert.rejects(readSessionMessages(pointer), /Duplicate/)
})

test('rejects entries whose parent is missing', async (t) => {
  const { pointer, write } = await sessionFixture(t)
  await write([
    header(pointer.sessionId),
    entry('orphan', 'missing', 'message', { role: 'user' })
  ])

  await assert.rejects(readSessionMessages(pointer), /missing parent/)
})

test('rejects parent cycles', async (t) => {
  const { pointer, write } = await sessionFixture(t)
  await write([
    header(pointer.sessionId),
    entry('first', 'second', 'message', { role: 'user' }),
    entry('second', 'first', 'message', { role: 'assistant' })
  ])

  await assert.rejects(readSessionMessages(pointer), /parent cycle/)
})

async function sessionFixture(t: test.TestContext): Promise<{
  pointer: SessionPointer
  write: (lines: unknown[]) => Promise<void>
}> {
  const root = await mkdtemp(join(tmpdir(), 'pi-gui-session-transcript-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const pointer: SessionPointer = {
    projectPath: root,
    sessionFile: join(root, 'session.jsonl'),
    sessionId: 'session-1',
    sessionName: null
  }
  return {
    pointer,
    write: (lines) => writeFile(pointer.sessionFile, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`)
  }
}

function header(id: string): Record<string, unknown> {
  return { type: 'session', version: 3, id, timestamp: '2026-07-22T00:00:00.000Z', cwd: '/tmp' }
}

function entry(
  id: string,
  parentId: string | null,
  type: string,
  message?: unknown,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return { type, id, parentId, timestamp: '2026-07-22T00:00:00.000Z', ...extra, message }
}
