import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { SessionPointer } from './session-pointer.ts'
import { readSessionMetadata, readSessionStatistics } from './session-statistics.ts'

test('aggregates every append-order message across branches and metadata', async (t) => {
  const { pointer, write } = await sessionFixture(t)
  await write([
    header(pointer.sessionId),
    entry('root', null, 'message', { role: 'user', content: 'root' }),
    entry('abandoned', 'root', 'message', assistantUsage(
      [{ type: 'toolCall', id: 'old-tool' }],
      { input: 10, output: 2, cacheRead: 3, cacheWrite: 4, cost: { total: 0.25 } }
    )),
    entry('active', 'root', 'message', assistantUsage(
      [{ type: 'text', text: 'active' }, { type: 'toolCall', id: 'active-tool' }],
      { input: 5, output: 6, cacheRead: 7, cacheWrite: 8, cost: { total: 0.5 } }
    )),
    entry('compaction', 'active', 'compaction', undefined, { summary: 'compressed' }),
    entry('tool-result', 'compaction', 'message', { role: 'toolResult', content: [] }),
    entry('custom', 'tool-result', 'message', { role: 'custom', content: 'notice' }),
    entry('metadata', 'custom', 'session_info', undefined, { name: 'renamed' })
  ])

  const statistics = {
    userMessages: 1,
    assistantMessages: 2,
    toolCalls: 2,
    toolResults: 1,
    totalMessages: 5,
    inputTokens: 15,
    outputTokens: 8,
    cacheReadTokens: 10,
    cacheWriteTokens: 12,
    totalTokens: 45,
    cost: 0.75
  }
  assert.deepEqual(await readSessionStatistics(pointer), statistics)
  assert.deepEqual(await readSessionMetadata(pointer), {
    activityAt: Date.parse('2026-07-22T00:00:00.000Z'),
    statistics
  })
})

test('rejects malformed assistant usage without exposing transcript contents', async (t) => {
  const { pointer, write } = await sessionFixture(t)
  const secret = 'sk-secret-token-and-base64'
  await write([
    header(pointer.sessionId),
    entry('assistant', null, 'message', assistantUsage(
      [{ type: 'text', text: secret }],
      { input: -1, output: 2, cacheRead: 3, cacheWrite: 4, cost: { total: 0.25 } }
    ))
  ])

  await assert.rejects(
    readSessionStatistics(pointer),
    (error: Error) => /assistant usage/.test(error.message) && !error.message.includes(secret)
  )
})

test('rejects non-integer tokens and malformed assistant content', async (t) => {
  const { pointer, write } = await sessionFixture(t)
  await write([
    header(pointer.sessionId),
    entry('assistant', null, 'message', assistantUsage(
      [{ type: 'text', text: 'hidden' }],
      { input: 1.5, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } }
    ))
  ])
  await assert.rejects(readSessionStatistics(pointer), /assistant usage/)

  await write([
    header(pointer.sessionId),
    entry('assistant', null, 'message', assistantUsage(
      [null],
      { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } }
    ))
  ])
  await assert.rejects(readSessionStatistics(pointer), /assistant content/)
})

async function sessionFixture(t: test.TestContext): Promise<{
  pointer: SessionPointer
  write: (lines: unknown[]) => Promise<void>
}> {
  const root = await mkdtemp(join(tmpdir(), 'pi-gui-session-statistics-'))
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

function assistantUsage(
  content: unknown,
  usage: unknown
): Record<string, unknown> {
  return { role: 'assistant', content, usage }
}
