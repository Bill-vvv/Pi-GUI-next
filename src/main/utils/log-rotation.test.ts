import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { rotateLogIfLarger } from './log-rotation.ts'

test('logs are kept across starts and rotate to one previous generation above the limit', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-gui-log-rotation-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'wsl-backend.log')

  await rotateLogIfLarger(path, 10)
  await writeFile(path, 'first run\n')
  await rotateLogIfLarger(path, 100)
  assert.equal(await readFile(path, 'utf8'), 'first run\n')

  await writeFile(path, 'x'.repeat(101))
  await writeFile(`${path}.1`, 'older')
  await rotateLogIfLarger(path, 100)
  assert.equal(await readFile(`${path}.1`, 'utf8'), 'x'.repeat(101))
  await assert.rejects(readFile(path), { code: 'ENOENT' })
})
