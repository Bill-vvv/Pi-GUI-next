import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { GIT_FILE_READ_MAX_BYTES } from '../../shared/git-contract.ts'
import { readRepositoryFile } from './git-file-reader.ts'

test('file reader bounds content and never follows leaf, parent or root symlinks or waits for a FIFO', {
  skip: process.platform !== 'linux', timeout: 5_000
}, async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'pi-file-reader-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  const root = join(base, 'project')
  await mkdir(join(root, '目录'), { recursive: true })
  await writeFile(join(root, '目录', '中文 file.txt'), '全文\nline 2\n')
  assert.equal(Buffer.from(await readRepositoryFile(root, '目录/中文 file.txt')).toString(), '全文\nline 2\n')
  await writeFile(join(root, 'empty'), '')
  assert.equal((await readRepositoryFile(root, 'empty')).byteLength, 0)
  await writeFile(join(root, 'limit'), 'x'.repeat(GIT_FILE_READ_MAX_BYTES))
  assert.equal((await readRepositoryFile(root, 'limit')).byteLength, GIT_FILE_READ_MAX_BYTES)
  await writeFile(join(root, 'over'), 'x'.repeat(GIT_FILE_READ_MAX_BYTES + 1))
  await assert.rejects(readRepositoryFile(root, 'over'), { code: 'output-limit' })
  const outside = join(base, 'private')
  await mkdir(outside)
  await writeFile(join(outside, 'secret'), 'must-not-disclose')
  await symlink(join(outside, 'secret'), join(root, 'leaf'))
  await symlink(outside, join(root, 'parent'))
  await symlink(root, join(base, 'root-link'))
  for (const path of ['leaf', 'parent/secret', '目录']) {
    await assert.rejects(readRepositoryFile(root, path), { code: 'unsupported' })
  }
  await assert.rejects(readRepositoryFile(join(base, 'root-link'), 'empty'), { code: 'unsupported' })
  for (const path of ['../private/secret', '/etc/passwd', '目录/../empty', 'x\0y']) {
    await assert.rejects(readRepositoryFile(root, path), { code: 'invalid-path' })
  }
  await assert.rejects(readRepositoryFile(root, 'missing'), { code: 'stale' })
  await promisify(execFile)('mkfifo', [join(root, 'pipe')])
  await assert.rejects(readRepositoryFile(root, 'pipe'), { code: 'unsupported' })
})
