import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { listProjectDirectories } from './project-directory-service.ts'
import { PROJECT_DIRECTORY_ENTRY_LIMIT, PROJECT_DIRECTORY_SCAN_LIMIT } from '../../shared/project-directory-contract.ts'
import { isKernelCommand } from '../kernel/kernel-command-validation.ts'
import { isRemoteKernelCommand } from '../../shared/remote-contract.ts'

test('Host directory listing is canonical, contains directories only, and reports broken links', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-directory-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, '中文 项目'))
  await mkdir(join(root, '.hidden'))
  await writeFile(join(root, 'file.txt'), 'not a directory')
  await symlink(join(root, '中文 项目'), join(root, 'linked'))
  await symlink(join(root, 'file.txt'), join(root, 'file-link'))
  await symlink(join(root, 'missing'), join(root, 'broken'))
  const listing = await listProjectDirectories(root)
  assert.equal(listing.ok, true)
  if (!listing.ok) return
  assert.equal(listing.path, root)
  assert.equal(listing.parentPath, dirname(root))
  assert.deepEqual(new Set(listing.entries.map((entry) => entry.name)), new Set(['中文 项目', '.hidden', 'linked']))
  assert.equal(listing.entries.find((entry) => entry.name === 'linked')?.symbolicLink, true)
  assert.equal(listing.inaccessibleLinks, 1)
  const linked = await listProjectDirectories(join(root, 'linked'))
  assert.ok(linked.ok)
  assert.equal(linked.path, join(root, '中文 项目'))
})

test('missing, file, invalid and unreadable directories produce explicit errors', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-directory-errors-'))
  const denied = join(root, 'denied')
  t.after(async () => { await chmod(denied, 0o700); await rm(root, { recursive: true, force: true }) })
  await mkdir(denied)
  await writeFile(join(root, 'file'), 'file')
  for (const [path, code] of [[join(root, 'missing'), 'not-found'], [join(root, 'file'), 'not-directory'],
    ['C:\\project', 'invalid-path'], ['../project', 'invalid-path'], ['/tmp/a\0b', 'invalid-path']] as const) {
    const result = await listProjectDirectories(path)
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.code, code)
  }
  await chmod(denied, 0)
  if (process.getuid?.() !== 0) {
    const result = await listProjectDirectories(denied)
    assert.ok(!result.ok)
    assert.equal(result.code, 'access-denied')
  }
})

test('directory enumeration bounds both visible entries and scanned files', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-directory-bounds-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const folders = join(root, 'folders')
  const files = join(root, 'files')
  await mkdir(folders)
  await mkdir(files)
  await Promise.all(Array.from({ length: PROJECT_DIRECTORY_ENTRY_LIMIT + 1 }, (_, i) => mkdir(join(folders, `d${i}`))))
  await Promise.all(Array.from({ length: PROJECT_DIRECTORY_SCAN_LIMIT + 1 }, (_, i) => writeFile(join(files, `f${i}`), '')))
  const result = await listProjectDirectories(folders)
  assert.ok(result.ok)
  assert.equal(result.entries.length, PROJECT_DIRECTORY_ENTRY_LIMIT)
  assert.equal(result.truncated, true)
  const scanned = await listProjectDirectories(files)
  assert.ok(scanned.ok)
  assert.equal(scanned.entries.length, 0)
  assert.equal(scanned.truncated, true)
})

test('unsupported directory names are reported as incomplete and canonical link targets are validated', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-directory-names-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const unsupported = join(root, 'line\nbreak')
  await mkdir(unsupported)
  await symlink(unsupported, join(root, 'link'))
  const result = await listProjectDirectories(root)
  assert.ok(result.ok)
  assert.equal(result.truncated, true)
  assert.ok(!result.entries.some((entry) => entry.path.includes('\n')))
  const linked = await listProjectDirectories(join(root, 'link'))
  assert.ok(!linked.ok)
  assert.equal(linked.code, 'invalid-path')
})

test('directory command schema rejects extra fields and Windows paths, and Web Remote remains closed', () => {
  assert.equal(isKernelCommand({ type: 'kernel.list-project-directories' }), true)
  assert.equal(isKernelCommand({ type: 'kernel.list-project-directories', directoryPath: '/home/user' }), true)
  for (const invalid of [
    { type: 'kernel.list-project-directories', directoryPath: 'C:\\project' },
    { type: 'kernel.list-project-directories', directoryPath: '/', extra: true },
    { type: 'kernel.list-project-directories', directoryPath: '/'.repeat(4097) }
  ]) assert.equal(isKernelCommand(invalid), false)
  assert.equal(isRemoteKernelCommand({ type: 'kernel.list-project-directories' }), false)
  assert.equal(isRemoteKernelCommand({ type: 'kernel.add-project', projectPath: '/home/user' }), false)
  assert.equal(isRemoteKernelCommand({ type: 'kernel.resolve-project-trust', requestId: 'id', choice: 'cancel' }), false)
})
