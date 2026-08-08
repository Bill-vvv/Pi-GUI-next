import assert from 'node:assert/strict'
import { appendFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { SessionPointer } from './session-pointer.ts'
import {
  readSessionMessagesTailFirst,
  type SessionTranscriptMessagePhase,
  type SessionTranscriptReadRange
} from './session-transcript-tail.ts'

test('reads LF and no-LF EOF transcripts and publishes the newest two user boundaries', async (t) => {
  for (const finalLf of [true, false]) {
    await t.test(finalLf ? 'LF EOF' : 'no-LF EOF', async (t) => {
      const { pointer, write } = await sessionFixture(t)
      const lines = [
        header(pointer.sessionId),
        entry('u1', null, 'message', message('user', 'one')),
        entry('a1', 'u1', 'message', message('assistant', 'one reply')),
        entry('u2', 'a1', 'message', message('user', 'two')),
        entry('a2', 'u2', 'message', message('assistant', 'two reply')),
        entry('u3', 'a2', 'message', message('user', 'unfinished three'))
      ]
      await write(lines, finalLf)

      const tails: SessionTranscriptMessagePhase[] = []
      const full = await readSessionMessagesTailFirst(pointer, {
        onTail: (phase) => {
          tails.push(phase)
        }
      })

      assert.equal(tails.length, 1)
      assert.deepEqual(ids(tails[0]), ['u2', 'a2', 'u3'])
      assert.deepEqual(ids(full), ['u1', 'a1', 'u2', 'a2', 'u3'])
      assert.equal(tails[0]?.messages[2]?.message.content, 'unfinished three')
    })
  }
})

test('tiny sessions publish exactly once at the header with all available messages', async (t) => {
  await t.test('header only', async (t) => {
    const { pointer, write } = await sessionFixture(t)
    await write([header(pointer.sessionId)], false)
    const tails: SessionTranscriptMessagePhase[] = []

    const full = await readSessionMessagesTailFirst(pointer, {
      onTail: (phase) => {
        tails.push(phase)
      }
    })

    assert.equal(tails.length, 1)
    assert.deepEqual(tails[0]?.messages, [])
    assert.deepEqual(full.messages, [])
  })

  await t.test('one user boundary', async (t) => {
    const { pointer, write } = await sessionFixture(t)
    await write([
      header(pointer.sessionId),
      entry('u1', null, 'message', message('user', 'one')),
      entry('a1', 'u1', 'message', message('assistant', 'reply'))
    ])
    const tails: SessionTranscriptMessagePhase[] = []

    const full = await readSessionMessagesTailFirst(pointer, {
      onTail: (phase) => {
        tails.push(phase)
      }
    })

    assert.equal(tails.length, 1)
    assert.deepEqual(ids(tails[0]), ['u1', 'a1'])
    assert.deepEqual(ids(full), ['u1', 'a1'])
  })
})

test('uses the physical final entry as leaf and excludes an abandoned branch', async (t) => {
  const { pointer, write } = await sessionFixture(t)
  await write([
    header(pointer.sessionId),
    entry('u1', null, 'message', message('user', 'root')),
    entry('abandoned', 'u1', 'message', message('assistant', 'old branch')),
    entry('u2', 'u1', 'message', message('user', 'active branch')),
    entry('active', 'u2', 'message', message('assistant', 'kept'))
  ])
  const tails: SessionTranscriptMessagePhase[] = []

  const full = await readSessionMessagesTailFirst(pointer, {
    onTail: (phase) => {
      tails.push(phase)
    }
  })

  assert.equal(tails.length, 1)
  assert.deepEqual(ids(tails[0]), ['u1', 'u2', 'active'])
  assert.deepEqual(ids(full), ['u1', 'u2', 'active'])
})

test('walks through a metadata leaf while retaining stable transcript entry IDs', async (t) => {
  const { pointer, write } = await sessionFixture(t)
  await write([
    header(pointer.sessionId),
    entry('u1', null, 'message', message('user', 'one')),
    entry('a1', 'u1', 'message', message('assistant', 'reply')),
    entry('u2', 'a1', 'message', message('user', 'two')),
    entry('metadata', 'u2', 'session_info', undefined, { name: 'Renamed' })
  ])
  let tail: SessionTranscriptMessagePhase | undefined

  const full = await readSessionMessagesTailFirst(pointer, {
    onTail: (phase) => {
      tail = phase
    }
  })

  assert.deepEqual(ids(tail), ['u1', 'a1', 'u2'])
  assert.deepEqual(ids(full), ['u1', 'a1', 'u2'])
  assert.deepEqual(
    tail?.messages.map(({ entryId }) => entryId),
    full.messages.map(({ entryId }) => entryId)
  )
})

test('strictly decodes complete UTF-8 records across one-byte read boundaries', async (t) => {
  const { pointer, write } = await sessionFixture(t)
  await write([
    header(pointer.sessionId),
    entry('u1', null, 'message', message('user', '你好 👋')),
    entry('a1', 'u1', 'message', message('assistant', '完成'))
  ], false)

  const full = await readSessionMessagesTailFirst(pointer, {
    chunkSizeBytes: 1,
    onTail: () => undefined
  })

  assert.deepEqual(full.messages.map(({ message: value }) => value.content), ['你好 👋', '完成'])
})

test('validates the bounded Session header', async (t) => {
  const { pointer, write } = await sessionFixture(t)
  await write([header('another-session')])

  await assert.rejects(
    readSessionMessagesTailFirst(pointer, { onTail: () => undefined }),
    /does not match/
  )
})

test('rejects damaged records without echoing transcript content', async (t) => {
  await t.test('invalid UTF-8', async (t) => {
    const { pointer } = await sessionFixture(t)
    const rawHeader = Buffer.from(JSON.stringify(header(pointer.sessionId)))
    const damagedEntry = Buffer.concat([
      Buffer.from('{"type":"message","id":"secret-id","parentId":null,"message":{"role":"user","content":"'),
      Buffer.from([0xc3, 0x28]),
      Buffer.from('"}}')
    ])
    await writeFile(pointer.sessionFile, Buffer.concat([rawHeader, Buffer.from('\n'), damagedEntry]))

    await assert.rejects(
      readSessionMessagesTailFirst(pointer, { onTail: () => undefined, chunkSizeBytes: 3 }),
      (error: Error) => /UTF-8 entry/.test(error.message) && !error.message.includes('secret')
    )
  })

  await t.test('invalid JSON', async (t) => {
    const { pointer } = await sessionFixture(t)
    await writeFile(
      pointer.sessionFile,
      `${JSON.stringify(header(pointer.sessionId))}\n{"secret":"do-not-echo", nope}\n`
    )

    await assert.rejects(
      readSessionMessagesTailFirst(pointer, { onTail: () => undefined }),
      (error: Error) => /JSON entry/.test(error.message) && !error.message.includes('do-not-echo')
    )
  })
})

test('publishes the tail before discovering older full-transcript graph failures', async (t) => {
  const cases: Array<{ name: string; older: Record<string, unknown>[]; error: RegExp }> = [
    {
      name: 'duplicate ID',
      older: [
        entry('duplicate', null, 'custom'),
        entry('duplicate', null, 'custom')
      ],
      error: /Duplicate/
    },
    {
      name: 'missing parent',
      older: [entry('orphan', 'missing', 'custom')],
      error: /missing parent/
    },
    {
      name: 'parent cycle',
      older: [
        entry('cycle-1', 'cycle-2', 'custom'),
        entry('cycle-2', 'cycle-1', 'custom')
      ],
      error: /parent cycle/
    }
  ]

  for (const failure of cases) {
    await t.test(failure.name, async (t) => {
      const { pointer, write } = await sessionFixture(t)
      await write([
        header(pointer.sessionId),
        ...failure.older,
        entry('u1', null, 'message', message('user', 'one')),
        entry('a1', 'u1', 'message', message('assistant', 'reply')),
        entry('u2', 'a1', 'message', message('user', 'two')),
        entry('a2', 'u2', 'message', message('assistant', 'reply'))
      ])
      const tails: SessionTranscriptMessagePhase[] = []

      await assert.rejects(
        readSessionMessagesTailFirst(pointer, {
          chunkSizeBytes: 32,
          onTail: (phase) => {
            tails.push(phase)
          }
        }),
        failure.error
      )
      assert.equal(tails.length, 1)
      assert.deepEqual(ids(tails[0]), ['u1', 'a1', 'u2', 'a2'])
    })
  }
})

test('supports cancellation between positional reads and after tail publication', async (t) => {
  await t.test('between reads', async (t) => {
    const { pointer, write } = await sessionFixture(t)
    await write([
      header(pointer.sessionId),
      entry('u1', null, 'message', message('user', 'x'.repeat(512))),
      entry('a1', 'u1', 'message', message('assistant', 'y'.repeat(512)))
    ])
    const controller = new AbortController()
    let tailCalls = 0

    await assert.rejects(
      readSessionMessagesTailFirst(pointer, {
        signal: controller.signal,
        chunkSizeBytes: 32,
        onRead: ({ source }) => {
          if (source === 'reverse') controller.abort()
        },
        onTail: () => {
          tailCalls += 1
        }
      }),
      (error: Error) => error.name === 'AbortError'
    )
    assert.equal(tailCalls, 0)
  })

  await t.test('after tail', async (t) => {
    const { pointer, write } = await sessionFixture(t)
    await write([
      header(pointer.sessionId),
      entry('u1', null, 'message', message('user', 'one')),
      entry('u2', 'u1', 'message', message('user', 'two'))
    ])
    const controller = new AbortController()
    let tailCalls = 0

    await assert.rejects(
      readSessionMessagesTailFirst(pointer, {
        signal: controller.signal,
        onTail: () => {
          tailCalls += 1
          controller.abort()
        }
      }),
      (error: Error) => error.name === 'AbortError'
    )
    assert.equal(tailCalls, 1)
  })
})

test('excludes appends after the single captured EOF', async (t) => {
  const { pointer, write } = await sessionFixture(t)
  await write([
    header(pointer.sessionId),
    entry('u1', null, 'message', message('user', 'captured')),
    entry('a1', 'u1', 'message', message('assistant', 'captured reply'))
  ])
  let appended = false
  let tail: SessionTranscriptMessagePhase | undefined

  const full = await readSessionMessagesTailFirst(pointer, {
    chunkSizeBytes: 16,
    onRead: () => {
      if (appended) return
      appended = true
      appendFileSync(
        pointer.sessionFile,
        `${JSON.stringify(entry('u2', 'a1', 'message', message('user', 'late append')))}\n`
      )
    },
    onTail: (phase) => {
      tail = phase
    }
  })

  assert.equal(appended, true)
  assert.deepEqual(ids(tail), ['u1', 'a1'])
  assert.deepEqual(ids(full), ['u1', 'a1'])
})

test('reads every byte in the captured generation exactly once without a second full scan', async (t) => {
  const { pointer, write } = await sessionFixture(t)
  const text = await write([
    header(pointer.sessionId),
    entry('u1', null, 'message', message('user', 'one'.repeat(80))),
    entry('a1', 'u1', 'message', message('assistant', 'reply'.repeat(80))),
    entry('u2', 'a1', 'message', message('user', 'two'.repeat(80))),
    entry('a2', 'u2', 'message', message('assistant', 'done'.repeat(80)))
  ])
  const reads: SessionTranscriptReadRange[] = []

  const full = await readSessionMessagesTailFirst(pointer, {
    chunkSizeBytes: 17,
    onRead: (range) => reads.push(range),
    onTail: () => undefined
  })

  const ordered = [...reads].sort((left, right) => left.position - right.position)
  let expectedPosition = 0
  for (const read of ordered) {
    assert.equal(read.position, expectedPosition)
    expectedPosition += read.bytesRead
  }
  assert.equal(expectedPosition, Buffer.byteLength(text))
  assert.equal(reads.reduce((total, read) => total + read.bytesRead, 0), Buffer.byteLength(text))
  assert.equal(full.capturedEof, Buffer.byteLength(text))
  assert.ok(reads.some(({ source }) => source === 'header'))
  assert.ok(reads.some(({ source }) => source === 'reverse'))
})

test('handles a long one-user active chain without rescanning prior branch entries', async (t) => {
  const { pointer, write } = await sessionFixture(t)
  const chainLength = 12_000
  const lines: unknown[] = [
    header(pointer.sessionId),
    entry('u1', null, 'message', message('user', 'root'))
  ]
  let parentId = 'u1'
  for (let index = 0; index < chainLength; index += 1) {
    const id = `metadata-${index}`
    lines.push(entry(id, parentId, 'session_info', undefined, { index }))
    parentId = id
  }
  lines.push(entry('a1', parentId, 'message', message('assistant', 'final reply')))
  await write(lines)
  let tailCalls = 0

  const full = await readSessionMessagesTailFirst(pointer, {
    chunkSizeBytes: 4 * 1024,
    onTail: () => {
      tailCalls += 1
    }
  })

  assert.equal(tailCalls, 1)
  assert.deepEqual(ids(full), ['u1', 'a1'])
})

test('assembles a large JSONL record from tiny chunks without quadratic fragment prepends', async (t) => {
  const { pointer, write } = await sessionFixture(t)
  const content = `start-${'界'.repeat(90_000)}-end`
  await write([
    header(pointer.sessionId),
    entry('u1', null, 'message', message('user', content))
  ], false)
  let reverseReads = 0

  const full = await readSessionMessagesTailFirst(pointer, {
    chunkSizeBytes: 17,
    onRead: ({ source }) => {
      if (source === 'reverse') reverseReads += 1
    },
    onTail: () => undefined
  })

  assert.equal(full.messages[0]?.message.content, content)
  assert.ok(reverseReads > 10_000)
})

test('bounds the first-line header read and does not expose its contents in errors', async (t) => {
  const { pointer } = await sessionFixture(t)
  await writeFile(pointer.sessionFile, `{"type":"session","id":"${pointer.sessionId}","secret":"${'x'.repeat(17 * 1024)}"}`)

  await assert.rejects(
    readSessionMessagesTailFirst(pointer, { onTail: () => undefined, chunkSizeBytes: 127 }),
    (error: Error) => /header/.test(error.message) && !error.message.includes('secret')
  )
})

async function sessionFixture(t: test.TestContext): Promise<{
  pointer: SessionPointer
  write: (lines: unknown[], finalLf?: boolean) => Promise<string>
}> {
  const root = await mkdtemp(join(tmpdir(), 'pi-gui-session-transcript-tail-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const pointer: SessionPointer = {
    projectPath: root,
    sessionFile: join(root, 'session.jsonl'),
    sessionId: 'session-1',
    sessionName: null
  }
  return {
    pointer,
    write: async (lines, finalLf = true) => {
      const text = `${lines.map((line) => JSON.stringify(line)).join('\n')}${finalLf ? '\n' : ''}`
      await writeFile(pointer.sessionFile, text)
      return text
    }
  }
}

function ids(phase: SessionTranscriptMessagePhase | undefined): string[] {
  return phase?.messages.map(({ entryId }) => entryId) ?? []
}

function header(id: string): Record<string, unknown> {
  return { type: 'session', version: 3, id, timestamp: '2026-07-22T00:00:00.000Z', cwd: '/tmp' }
}

function message(role: string, content: string): Record<string, unknown> {
  return { role, content }
}

function entry(
  id: string,
  parentId: string | null,
  type: string,
  messageValue?: unknown,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return { type, id, parentId, timestamp: '2026-07-22T00:00:00.000Z', ...extra, message: messageValue }
}
