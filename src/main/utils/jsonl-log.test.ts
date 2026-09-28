import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createJsonlLogger } from './jsonl-log.ts'

test('JSON Lines log writes bounded private records and rotates by size', async (t) => {
  const directory = join(await mkdtemp(join(tmpdir(), 'pi-gui-jsonl-log-')), 'logs')
  t.after(() => rm(join(directory, '..'), { recursive: true, force: true }))
  const logger = createJsonlLogger({
    directory,
    name: 'main',
    maxBytes: 400,
    maxRotatedFiles: 2,
    now: () => new Date('2026-09-29T00:00:00.000Z')
  })

  logger.write('info', 'test', 'first', { long: 'x'.repeat(600), skipped: undefined, time: 'not-overridden' })
  const [first] = (await readFile(join(directory, 'main.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
  assert.equal(first.time, '2026-09-29T00:00:00.000Z')
  assert.equal(first.event, 'first')
  assert.equal(first.long.length, 501)
  assert.equal('skipped' in first, false)
  assert.equal((await stat(join(directory, 'main.jsonl'))).mode & 0o777, 0o600)
  assert.equal((await stat(directory)).mode & 0o777, 0o700)

  for (let index = 0; index < 20; index++) logger.write('warn', 'test', `event-${index}`, { index })
  assert.deepEqual((await readdir(directory)).sort(), ['main.1.jsonl', 'main.2.jsonl', 'main.jsonl'])
  for (const name of await readdir(directory)) {
    assert.ok((await stat(join(directory, name))).size <= 400)
  }
  const latest = (await readFile(join(directory, 'main.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
  assert.equal(latest.at(-1).event, 'event-19')
})

test('JSON Lines log never throws when its directory is unusable', async (t) => {
  const file = join(await mkdtemp(join(tmpdir(), 'pi-gui-jsonl-log-bad-')), 'not-a-directory')
  t.after(() => rm(join(file, '..'), { recursive: true, force: true }))
  await (await import('node:fs/promises')).writeFile(file, '')
  const original = console.error
  const errors: unknown[] = []
  console.error = (...args: unknown[]) => { errors.push(args) }
  try {
    const logger = createJsonlLogger({ directory: join(file, 'logs'), name: 'main' })
    logger.write('error', 'test', 'first')
    logger.write('error', 'test', 'second')
  } finally {
    console.error = original
  }
  assert.equal(errors.length, 1)
})
