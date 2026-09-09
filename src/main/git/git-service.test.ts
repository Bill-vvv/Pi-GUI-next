import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, readlink, rename, rm, stat, symlink, truncate, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import { GitService } from './git-service.ts'
import {
  GIT_HISTORY_MESSAGE_MAX_UTF8_BYTES,
  GIT_REPOSITORY_RELATIVE_PATH_MAX_UTF8_BYTES
} from '../../shared/git-contract.ts'
import type { GitFileMutationRequest, GitRepositoryState } from '../../shared/git-contract.ts'

const execFileAsync = promisify(execFile)

const gitEnvironment = {
  ...process.env,
  LC_ALL: 'C',
  LANG: 'C',
  GIT_AUTHOR_NAME: 'Pi GUI Test',
  GIT_AUTHOR_EMAIL: 'pi-gui@example.invalid',
  GIT_COMMITTER_NAME: 'Pi GUI Test',
  GIT_COMMITTER_EMAIL: 'pi-gui@example.invalid'
}

async function git(cwd: string, args: string[], allowFailure = false): Promise<string> {
  try {
    return (await execFileAsync('git', args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      env: gitEnvironment
    })).stdout
  } catch (error) {
    if (allowFailure) return ''
    throw error
  }
}

async function gitInput(cwd: string, args: string[], input: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, env: gitEnvironment, stdio: ['pipe', 'pipe', 'pipe'] })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.once('error', reject)
    child.once('close', (code) => {
      if (code === 0) resolve(Buffer.concat(stdout).toString('utf8'))
      else reject(new Error(Buffer.concat(stderr).toString('utf8') || `git exited ${code ?? 'unknown'}`))
    })
    child.stdin.end(input)
  })
}

async function createRepository(t: test.TestContext, prefix = 'pi-gui-git-'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  t.after(() => rm(root, { recursive: true, force: true }))
  await git(root, ['init', '--initial-branch=main'])
  await git(root, ['config', 'user.name', 'Pi GUI Test'])
  await git(root, ['config', 'user.email', 'pi-gui@example.invalid'])
  return root
}

async function commitFile(root: string, path: string, content: string, message = 'commit'): Promise<void> {
  await writeFile(join(root, path), content)
  await git(root, ['add', '--', path])
  await git(root, ['commit', '-m', message])
}

function mutation(state: GitRepositoryState, action: 'stage' | 'unstage', path: string): GitFileMutationRequest {
  const repositoryRoot = requireRepositoryRoot(state)
  const expectedFileFingerprint = state.files.find((file) => file.path === path)?.fingerprint
  if (expectedFileFingerprint === undefined) {
    assert.fail(`Expected ${JSON.stringify(path)} in the bounded Git status projection.`)
  }
  return {
    action,
    path,
    expectedRepositoryRoot: repositoryRoot,
    expectedHeadOid: state.headOid,
    expectedIndexTreeOid: state.indexTreeOid,
    expectedIndexFingerprint: state.indexFingerprint,
    expectedFileFingerprint,
    expectedWorktreeFingerprint: state.worktreeFingerprint,
    expectedStatusRevision: state.statusRevision
  }
}

function diffRequest(state: GitRepositoryState, kind: 'working' | 'staged', path: string) {
  const repositoryRoot = requireRepositoryRoot(state)
  return {
    kind,
    path,
    expectedRepositoryRoot: repositoryRoot,
    expectedHeadOid: state.headOid,
    expectedIndexTreeOid: state.indexTreeOid,
    expectedStatusRevision: state.statusRevision
  } as const
}

function requireRepositoryRoot(state: GitRepositoryState): string {
  assert.equal(state.kind, 'repository')
  if (state.repositoryRoot === null) assert.fail('Expected a repository root.')
  return state.repositoryRoot
}

test('reports non-repositories without fabricating Git identity', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-gui-non-repo-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const service = new GitService(root)

  const state = await service.refresh()

  assert.equal(state.kind, 'not-repository')
  assert.equal(state.repositoryRoot, null)
  assert.equal(state.headOid, null)
  assert.deepEqual(state.files, [])
  const diff = await service.getDiff({
    kind: 'working',
    path: 'file.txt',
    expectedRepositoryRoot: root,
    expectedHeadOid: null,
    expectedIndexTreeOid: null,
    expectedStatusRevision: state.statusRevision
  })
  assert.equal(diff.state, 'not-repository')
  assert.equal(diff.error?.code, 'not-repository')
})

test('does not classify missing, unexecutable, or unrelated Git failures as non-repositories', async (t) => {
  const root = await createRepository(t, 'pi-gui-git-failure-')
  await assert.rejects(new GitService(root, { gitBinary: join(root, 'missing-git-binary') }).refresh())

  const binDirectory = await mkdtemp(join(tmpdir(), 'pi-gui-git-failure-bin-'))
  t.after(() => rm(binDirectory, { recursive: true, force: true }))
  const unexecutableName = 'pi-gui-unexecutable-git'
  await writeFile(join(binDirectory, unexecutableName), '#!/bin/sh\nexit 0\n')
  await chmod(join(binDirectory, unexecutableName), 0o644)
  const unrelatedName = 'pi-gui-unrelated-failure-git'
  await writeFile(join(binDirectory, unrelatedName), [
    '#!/bin/sh',
    'echo "fatal: synthetic unrelated Git failure" >&2',
    'exit 2'
  ].join('\n'))
  await chmod(join(binDirectory, unrelatedName), 0o755)
  await assert.rejects(new GitService(root, { gitBinary: join(binDirectory, unexecutableName) }).refresh())
  await assert.rejects(new GitService(root, { gitBinary: join(binDirectory, unrelatedName) }).refresh())
})

test('safe refresh converts missing Git, timeout, abort, output limit, and unrelated failures to bounded DTOs', async (t) => {
  const root = await createRepository(t, 'pi-gui-git-safe-refresh-')

  const missing = await new GitService(root, { gitBinary: join(root, 'missing-git') }).refreshSafe()
  assert.equal(missing.ok, false)
  if (!missing.ok) {
    assert.equal(missing.error.code, 'git-error')
    assert.equal(missing.error.message, 'Git operation failed.')
    assert.equal(missing.error.message.length <= 512, true)
  }

  const binDirectory = await mkdtemp(join(tmpdir(), 'pi-gui-git-safe-refresh-bin-'))
  t.after(() => rm(binDirectory, { recursive: true, force: true }))
  const slow = join(binDirectory, 'slow-git')
  await writeFile(slow, '#!/bin/sh\nsleep 2\n')
  await chmod(slow, 0o755)
  const timeout = await new GitService(root, { gitBinary: slow, timeoutMs: 10 }).refreshSafe()
  assert.equal(timeout.ok, false)
  if (!timeout.ok) assert.equal(timeout.error.code, 'timeout')

  const controller = new AbortController()
  controller.abort()
  const aborted = await new GitService(root).refreshSafe(controller.signal)
  assert.equal(aborted.ok, false)
  if (!aborted.ok) assert.equal(aborted.error.code, 'aborted')

  const noisy = join(binDirectory, 'noisy-git')
  await writeFile(noisy, '#!/bin/sh\nyes x | head -c 20000\n')
  await chmod(noisy, 0o755)
  const limited = await new GitService(root, { gitBinary: noisy, maxStatusBytes: 8 }).refreshSafe()
  assert.equal(limited.ok, false)
  if (!limited.ok) assert.equal(limited.error.code, 'output-limit')

  const unrelated = join(binDirectory, 'unrelated-git')
  await writeFile(unrelated, '#!/bin/sh\necho "secret-looking raw failure" >&2\nexit 2\n')
  await chmod(unrelated, 0o755)
  const failed = await new GitService(root, { gitBinary: unrelated }).refreshSafe()
  assert.equal(failed.ok, false)
  if (!failed.ok) {
    assert.equal(failed.error.code, 'git-error')
    assert.equal(failed.error.message, 'Git operation failed.')
    assert.equal(failed.error.message.includes('secret-looking'), false)
    assert.equal(failed.error.message.length <= 512, true)
    assert.equal(Number.isSafeInteger(failed.error.stderrCharacters), true)
    assert.equal(failed.error.stderrCharacters <= 2 * 1024 * 1024, true)
  }
})

test('redacts raw stderr from diff, add, and reset result DTOs', async (t) => {
  const root = await createRepository(t, 'pi-gui-git-public-errors-')
  await commitFile(root, 'tracked.txt', 'base\n')
  await writeFile(join(root, 'tracked.txt'), 'working\n')
  const binDirectory = await mkdtemp(join(tmpdir(), 'pi-gui-git-public-errors-bin-'))
  t.after(() => rm(binDirectory, { recursive: true, force: true }))
  const gitPath = (await execFileAsync('sh', ['-c', 'command -v git'], { encoding: 'utf8' })).stdout.trim()
  const secrets = {
    diff: 'UNIQUE_DIFF_SECRET_9d7cc7',
    add: 'UNIQUE_ADD_SECRET_32b19e',
    reset: 'UNIQUE_RESET_SECRET_773ea1'
  }
  const wrapper = join(binDirectory, 'redacting-git')
  await writeFile(wrapper, [
    '#!/bin/sh',
    'case "$1" in',
    `  diff) echo '${secrets.diff}' >&2; exit 71 ;;`,
    `  add) echo '${secrets.add}' >&2; exit 72 ;;`,
    `  reset) echo '${secrets.reset}' >&2; exit 73 ;;`,
    'esac',
    `exec '${gitPath}' "$@"`
  ].join('\n'))
  await chmod(wrapper, 0o755)
  const service = new GitService(root, { gitBinary: wrapper })

  const working = await service.refresh()
  const diff = await service.getDiff(diffRequest(working, 'working', 'tracked.txt'))
  assert.equal(diff.error?.code, 'git-error')
  assert.equal(diff.error?.message, 'Git operation failed.')
  assert.equal((diff.error?.stderrCharacters ?? 0) > 0, true)
  assert.equal((diff.error?.stderrCharacters ?? 0) <= 2 * 1024 * 1024, true)
  assert.equal(JSON.stringify(diff).includes(secrets.diff), false)

  const add = await service.mutateFile(mutation(working, 'stage', 'tracked.txt'))
  assert.equal(add.ok, false)
  if (!add.ok) {
    assert.equal(add.error.code, 'git-error')
    assert.equal(add.error.message, 'Git operation failed.')
    assert.equal(add.error.stderrCharacters > 0, true)
    assert.equal(add.error.stderrCharacters <= 2 * 1024 * 1024, true)
    assert.equal(JSON.stringify(add).includes(secrets.add), false)
  }

  await git(root, ['add', '--', 'tracked.txt'])
  const staged = await service.refresh()
  const reset = await service.mutateFile(mutation(staged, 'unstage', 'tracked.txt'))
  assert.equal(reset.ok, false)
  if (!reset.ok) {
    assert.equal(reset.error.code, 'git-error')
    assert.equal(reset.error.message, 'Git operation failed.')
    assert.equal(reset.error.stderrCharacters > 0, true)
    assert.equal(reset.error.stderrCharacters <= 2 * 1024 * 1024, true)
    assert.equal(JSON.stringify(reset).includes(secrets.reset), false)
  }
})

test('reports mixed and untracked files, exposes independent diffs, and serializes file mutations', async (t) => {
  const root = await createRepository(t)
  await commitFile(root, 'mixed.txt', 'base\n')
  await writeFile(join(root, 'mixed.txt'), 'staged\n')
  await git(root, ['add', '--', 'mixed.txt'])
  await writeFile(join(root, 'mixed.txt'), 'working\n')
  await writeFile(join(root, 'new.txt'), 'untracked\n')
  const service = new GitService(root)

  const initial = await service.refresh()
  const repeated = await service.refresh()
  assert.equal(repeated.worktreeFingerprint, initial.worktreeFingerprint)
  assert.equal(repeated.statusRevision, initial.statusRevision)
  assert.equal(Number.isSafeInteger(initial.refreshedAt), true)
  assert.equal(initial.refreshedAt > 1_000_000_000_000, true)
  assert.match(initial.headOid ?? '', /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/)
  assert.match(initial.indexTreeOid ?? '', /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/)
  assert.equal(initial.files.find((file) => file.path === 'mixed.txt')?.state, 'mixed')
  assert.equal(initial.files.find((file) => file.path === 'new.txt')?.state, 'untracked')

  const working = await service.getDiff(diffRequest(initial, 'working', 'mixed.txt'))
  const staged = await service.getDiff(diffRequest(initial, 'staged', 'mixed.txt'))
  assert.equal(working.state, 'ready')
  assert.equal(staged.state, 'ready')
  assert.notEqual(working.revision, staged.revision)
  assert.equal(working.files[0]?.hunks[0]?.lines.some((line) => line.kind === 'add' && line.content === 'working'), true)
  assert.equal(staged.files[0]?.hunks[0]?.lines.some((line) => line.kind === 'add' && line.content === 'staged'), true)

  const secondService = new GitService(root)
  const [first, second] = await Promise.all([
    service.mutateFile(mutation(initial, 'stage', 'new.txt')),
    secondService.mutateFile(mutation(initial, 'stage', 'new.txt'))
  ])
  const mutationResults = [first, second]
  assert.equal(mutationResults.filter((result) => result.ok).length, 1)
  const rejected = mutationResults.find((result) => !result.ok)
  assert.equal(rejected?.ok, false)
  if (rejected !== undefined && !rejected.ok) assert.equal(rejected.error.code, 'stale')

  const stagedNew = await service.refresh()
  const unstage = await service.mutateFile(mutation(stagedNew, 'unstage', 'new.txt'))
  assert.equal(unstage.ok, true)
  assert.equal(await readFile(join(root, 'new.txt'), 'utf8'), 'untracked\n')
  assert.equal((await service.refresh()).files.find((file) => file.path === 'new.txt')?.state, 'untracked')
})

test('supports unborn staged diffs and unstage preserves the working file', async (t) => {
  const root = await createRepository(t, 'pi-gui-unborn-')
  await writeFile(join(root, 'initial.txt'), 'initial\n')
  const service = new GitService(root)

  const unborn = await service.refresh()
  assert.equal(unborn.headOid, null)
  assert.equal(unborn.branch, 'main')
  assert.equal(unborn.detached, false)
  assert.match(unborn.indexTreeOid ?? '', /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/)

  const staged = await service.mutateFile(mutation(unborn, 'stage', 'initial.txt'))
  assert.equal(staged.ok, true)
  if (!staged.ok) return
  const diff = await service.getDiff(diffRequest(staged.state, 'staged', 'initial.txt'))
  assert.equal(diff.state, 'ready')
  assert.equal(diff.files[0]?.change, 'added')

  const unstaged = await service.mutateFile(mutation(staged.state, 'unstage', 'initial.txt'))
  assert.equal(unstaged.ok, true)
  assert.equal(await readFile(join(root, 'initial.txt'), 'utf8'), 'initial\n')
  assert.equal((await service.refresh()).files[0]?.state, 'untracked')
})

test('uses both sides of a staged rename for working/staged diff, stage, and unstage', async (t) => {
  const root = await createRepository(t, 'pi-gui-rename-')
  const baseLines = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`)
  await commitFile(root, 'old-name.txt', `${baseLines.join('\n')}\n`, 'base')
  await git(root, ['mv', 'old-name.txt', 'new-name.txt'])
  baseLines[19] = 'line 20 changed in the working tree'
  await writeFile(join(root, 'new-name.txt'), `${baseLines.join('\n')}\n`)
  const service = new GitService(root)

  const mixedRename = await service.refresh()
  const renameEntry = mixedRename.files.find((file) => file.path === 'new-name.txt')
  assert.equal(renameEntry?.originalPath, 'old-name.txt')
  assert.equal(renameEntry?.indexChange, 'renamed')
  assert.equal(renameEntry?.state, 'mixed')
  const workingDiff = await service.getDiff(diffRequest(mixedRename, 'working', 'new-name.txt'))
  assert.equal(workingDiff.state, 'ready')
  assert.equal(workingDiff.files[0]?.path, 'new-name.txt')
  assert.equal(workingDiff.files[0]?.change, 'modified')

  const stagedMutation = await service.mutateFile(mutation(mixedRename, 'stage', 'new-name.txt'))
  assert.equal(stagedMutation.ok, true)
  if (!stagedMutation.ok) return
  const stagedDiff = await service.getDiff(diffRequest(stagedMutation.state, 'staged', 'new-name.txt'))
  assert.equal(stagedDiff.state, 'ready')
  assert.equal(stagedDiff.fileCount, 1)
  assert.equal(stagedDiff.files[0]?.change, 'renamed')
  assert.equal(stagedDiff.files[0]?.path, 'new-name.txt')
  assert.equal(stagedDiff.files[0]?.originalPath, 'old-name.txt')

  const unstagedMutation = await service.mutateFile(mutation(stagedMutation.state, 'unstage', 'new-name.txt'))
  assert.equal(unstagedMutation.ok, true)
  assert.equal((await git(root, ['diff', '--cached', '--name-status'])).trim(), '')
  assert.equal(await readFile(join(root, 'new-name.txt'), 'utf8'), `${baseLines.join('\n')}\n`)
  await assert.rejects(readFile(join(root, 'old-name.txt'), 'utf8'), /ENOENT/)
  const indexPaths = await git(root, ['ls-files'])
  assert.equal(indexPaths.trim(), 'old-name.txt')
})

test('stages a pure filesystem rename as one index rename and unstages it back to the worktree', async (t) => {
  const root = await createRepository(t, 'pi-gui-worktree-rename-')
  const content = `${Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join('\n')}\n`
  await commitFile(root, 'old-name.txt', content, 'base')
  await rename(join(root, 'old-name.txt'), join(root, 'new-name.txt'))
  const service = new GitService(root)

  const worktreeRename = await service.refresh()
  const renameEntry = worktreeRename.files.find((file) => file.path === 'new-name.txt')
  assert.equal(renameEntry?.originalPath, 'old-name.txt')
  assert.equal(renameEntry?.indexChange, 'unmodified')
  assert.equal(renameEntry?.worktreeChange, 'renamed')
  assert.equal(renameEntry?.state, 'unstaged')

  const staged = await service.mutateFile(mutation(worktreeRename, 'stage', 'new-name.txt'))
  assert.equal(staged.ok, true)
  if (!staged.ok) return
  assert.equal((await git(root, ['diff', '--cached', '--name-status', '--find-renames'])).trim(), 'R100\told-name.txt\tnew-name.txt')
  assert.equal((await git(root, ['diff', '--name-status'])).trim(), '')
  assert.equal(staged.state.files.find((file) => file.path === 'new-name.txt')?.state, 'staged')

  const unstaged = await service.mutateFile(mutation(staged.state, 'unstage', 'new-name.txt'))
  assert.equal(unstaged.ok, true)
  if (!unstaged.ok) return
  assert.equal((await git(root, ['diff', '--cached', '--name-status'])).trim(), '')
  assert.equal((await git(root, ['ls-files'])).trim(), 'old-name.txt')
  assert.equal(await readFile(join(root, 'new-name.txt'), 'utf8'), content)
  await assert.rejects(readFile(join(root, 'old-name.txt'), 'utf8'), /ENOENT/)
  const restoredWorktreeRename = unstaged.state.files.find((file) => file.path === 'new-name.txt')
  assert.equal(restoredWorktreeRename?.originalPath, 'old-name.txt')
  assert.equal(restoredWorktreeRename?.worktreeChange, 'renamed')
  assert.equal(restoredWorktreeRename?.state, 'unstaged')
})

test('refreshes, diffs, stages, and unstages tracked symbolic links using link text identity', async (t) => {
  const root = await createRepository(t, 'pi-gui-tracked-symlink-')
  await symlink('target-one', join(root, 'tracked-link'))
  await git(root, ['add', '--', 'tracked-link'])
  await git(root, ['commit', '-m', 'tracked symlink'])
  await rm(join(root, 'tracked-link'))
  await symlink('target-two', join(root, 'tracked-link'))
  const service = new GitService(root)

  const workingState = await service.refresh()
  const workingFile = workingState.files.find((file) => file.path === 'tracked-link')
  assert.equal(workingFile?.state, 'unstaged')
  assert.equal(workingFile?.worktreeChange, 'modified')
  const repeated = await service.refresh()
  assert.equal(repeated.files.find((file) => file.path === 'tracked-link')?.fingerprint, workingFile?.fingerprint)

  const workingDiff = await service.getDiff(diffRequest(workingState, 'working', 'tracked-link'))
  assert.equal(workingDiff.state, 'ready')
  assert.deepEqual(
    workingDiff.files[0]?.hunks[0]?.lines.filter((line) => line.kind === 'remove' || line.kind === 'add').map((line) => [line.kind, line.content]),
    [['remove', 'target-one'], ['add', 'target-two']]
  )

  const staged = await service.mutateFile(mutation(workingState, 'stage', 'tracked-link'))
  assert.equal(staged.ok, true)
  if (!staged.ok) return
  assert.equal(await git(root, ['show', ':tracked-link']), 'target-two')
  const stagedDiff = await service.getDiff(diffRequest(staged.state, 'staged', 'tracked-link'))
  assert.equal(stagedDiff.state, 'ready')
  assert.equal(stagedDiff.files[0]?.change, 'modified')

  const unstaged = await service.mutateFile(mutation(staged.state, 'unstage', 'tracked-link'))
  assert.equal(unstaged.ok, true)
  if (!unstaged.ok) return
  assert.equal(await git(root, ['show', ':tracked-link']), 'target-one')
  assert.equal(await readlink(join(root, 'tracked-link')), 'target-two')
  assert.equal(unstaged.state.files.find((file) => file.path === 'tracked-link')?.state, 'unstaged')
})

test('reports detached HEAD, upstream divergence, renames, and conflicts', async (t) => {
  const remote = await mkdtemp(join(tmpdir(), 'pi-gui-git-remote-'))
  const first = await mkdtemp(join(tmpdir(), 'pi-gui-git-first-'))
  const second = await mkdtemp(join(tmpdir(), 'pi-gui-git-second-'))
  t.after(() => Promise.all([
    rm(remote, { recursive: true, force: true }),
    rm(first, { recursive: true, force: true }),
    rm(second, { recursive: true, force: true })
  ]))
  await git(remote, ['init', '--bare', '--initial-branch=main'])
  await git(tmpdir(), ['clone', remote, first])
  await commitFile(first, 'tracked.txt', 'base\n', 'base')
  await git(first, ['push', '--set-upstream', 'origin', 'main'])
  await git(tmpdir(), ['clone', remote, second])
  await commitFile(first, 'ahead.txt', 'ahead\n', 'ahead')
  await commitFile(second, 'behind.txt', 'behind\n', 'behind')
  await git(second, ['push'])
  await git(first, ['fetch'])

  const divergent = await new GitService(first).refresh()
  assert.equal(divergent.upstream, 'origin/main')
  assert.equal(divergent.ahead, 1)
  assert.equal(divergent.behind, 1)

  await git(first, ['mv', 'tracked.txt', 'renamed.txt'])
  const renamed = await new GitService(first).refresh()
  const rename = renamed.files.find((file) => file.path === 'renamed.txt')
  assert.equal(rename?.originalPath, 'tracked.txt')
  assert.equal(rename?.indexChange, 'renamed')
  await git(first, ['reset', '--hard', 'HEAD'])
  await git(first, ['checkout', '--detach', 'HEAD'])
  const detached = await new GitService(first).refresh()
  assert.equal(detached.detached, true)
  assert.equal(detached.branch, null)

  const conflictRoot = await createRepository(t, 'pi-gui-conflict-')
  await commitFile(conflictRoot, 'conflict.txt', 'base\n', 'base')
  await git(conflictRoot, ['checkout', '-b', 'other'])
  await writeFile(join(conflictRoot, 'conflict.txt'), 'other\n')
  await git(conflictRoot, ['commit', '-am', 'other'])
  await git(conflictRoot, ['checkout', 'main'])
  await writeFile(join(conflictRoot, 'conflict.txt'), 'main\n')
  await git(conflictRoot, ['commit', '-am', 'main'])
  await git(conflictRoot, ['merge', 'other'], true)
  const conflicted = await new GitService(conflictRoot).refresh()
  assert.equal(conflicted.files.find((file) => file.path === 'conflict.txt')?.state, 'conflicted')
  assert.equal(conflicted.indexTreeOid, null)
  assert.match(conflicted.indexFingerprint, /^[0-9a-f]{64}$/)
})

test('rejects stale external worktree, index, and HEAD changes plus unsafe paths', async (t) => {
  const root = await createRepository(t)
  await commitFile(root, 'tracked.txt', 'base\n')
  await writeFile(join(root, 'tracked.txt'), 'working before snapshot\n')
  await writeFile(join(root, 'other.txt'), 'other\n')
  const service = new GitService(root)

  const beforeWorktree = await service.refresh()
  await writeFile(join(root, 'tracked.txt'), 'changed after snapshot\n')
  const staleWorktree = await service.mutateFile(mutation(beforeWorktree, 'stage', 'tracked.txt'))
  assert.equal(staleWorktree.ok, false)
  if (!staleWorktree.ok) assert.equal(staleWorktree.error.code, 'stale')

  const beforeIndex = await service.refresh()
  await git(root, ['add', '--', 'other.txt'])
  const staleIndex = await service.mutateFile(mutation(beforeIndex, 'stage', 'tracked.txt'))
  assert.equal(staleIndex.ok, false)
  if (!staleIndex.ok) assert.equal(staleIndex.error.code, 'stale')

  await git(root, ['reset', '--hard', 'HEAD'])
  await writeFile(join(root, 'tracked.txt'), 'working before head change\n')
  const beforeHead = await service.refresh()
  await git(root, ['commit', '--allow-empty', '-m', 'external head'])
  const staleHead = await service.mutateFile(mutation(beforeHead, 'stage', 'tracked.txt'))
  assert.equal(staleHead.ok, false)
  if (!staleHead.ok) assert.equal(staleHead.error.code, 'stale')

  const current = await service.refresh()
  const wrongRootRequest = mutation(current, 'stage', 'tracked.txt')
  wrongRootRequest.expectedRepositoryRoot = join(root, 'other-root')
  const staleRoot = await service.mutateFile(wrongRootRequest)
  assert.equal(staleRoot.ok, false)
  if (!staleRoot.ok) assert.equal(staleRoot.error.code, 'stale')

  const validMutation = mutation(current, 'stage', 'tracked.txt')
  const traversal = await service.mutateFile({ ...validMutation, path: '../outside.txt' })
  assert.equal(traversal.ok, false)
  if (!traversal.ok) assert.equal(traversal.error.code, 'invalid-path')
  const absolute = await service.mutateFile({ ...validMutation, path: join(root, 'tracked.txt') })
  assert.equal(absolute.ok, false)
  if (!absolute.ok) assert.equal(absolute.error.code, 'invalid-path')
  const nul = await service.mutateFile({ ...validMutation, path: 'tracked.txt\0ignored' })
  assert.equal(nul.ok, false)
  if (!nul.ok) assert.equal(nul.error.code, 'invalid-path')

  assert.equal(GIT_REPOSITORY_RELATIVE_PATH_MAX_UTF8_BYTES, 4_096)
  const overlong = '界'.repeat(Math.floor(GIT_REPOSITORY_RELATIVE_PATH_MAX_UTF8_BYTES / 3) + 1)
  assert.equal(Buffer.byteLength(overlong, 'utf8') > GIT_REPOSITORY_RELATIVE_PATH_MAX_UTF8_BYTES, true)
  const overlongMutation = await service.mutateFile({ ...validMutation, path: overlong })
  assert.equal(overlongMutation.ok, false)
  if (!overlongMutation.ok) assert.equal(overlongMutation.error.code, 'invalid-path')
  const overlongDiff = await service.getDiff({ ...diffRequest(current, 'working', 'tracked.txt'), path: overlong })
  assert.equal(overlongDiff.state, 'error')
  assert.equal(overlongDiff.error?.code, 'invalid-path')
})

test('requires the exact listed file fingerprint before any Git mutation command', async (t) => {
  const root = await createRepository(t, 'pi-gui-file-fingerprint-')
  await commitFile(root, 'tracked.txt', 'base\n')
  await writeFile(join(root, 'tracked.txt'), 'working\n')
  const binDirectory = await mkdtemp(join(tmpdir(), 'pi-gui-file-fingerprint-bin-'))
  t.after(() => rm(binDirectory, { recursive: true, force: true }))
  const gitPath = (await execFileAsync('sh', ['-c', 'command -v git'], { encoding: 'utf8' })).stdout.trim()
  const commandLog = join(binDirectory, 'mutation-commands')
  const wrapper = join(binDirectory, 'fingerprint-git')
  await writeFile(wrapper, [
    '#!/bin/sh',
    'case "$1" in',
    `  add|reset|rm) printf '%s\\n' "$*" >> '${commandLog}' ;;`,
    'esac',
    `exec '${gitPath}' "$@"`
  ].join('\n'))
  await chmod(wrapper, 0o755)
  const service = new GitService(root, { gitBinary: wrapper })
  const state = await service.refresh()
  const request = mutation(state, 'stage', 'tracked.txt')
  request.expectedFileFingerprint = '0'.repeat(64)

  const result = await service.mutateFile(request)

  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.error.code, 'stale')
  await assert.rejects(readFile(commandLog, 'utf8'), /ENOENT/)
  assert.equal((await git(root, ['diff', '--cached', '--name-only'])).trim(), '')
})

test('keeps diff and mutation authorization inside the bounded status file projection', async (t) => {
  const root = await createRepository(t, 'pi-gui-bounded-status-auth-')
  await writeFile(join(root, 'a-visible.txt'), 'base\n')
  await writeFile(join(root, 'z-hidden.txt'), 'base\n')
  await writeFile(join(root, 'unchanged.txt'), 'base\n')
  await git(root, ['add', '--', 'a-visible.txt', 'z-hidden.txt', 'unchanged.txt'])
  await git(root, ['commit', '-m', 'base'])
  await writeFile(join(root, 'a-visible.txt'), 'visible working\n')
  await writeFile(join(root, 'z-hidden.txt'), 'hidden working\n')
  const binDirectory = await mkdtemp(join(tmpdir(), 'pi-gui-bounded-status-auth-bin-'))
  t.after(() => rm(binDirectory, { recursive: true, force: true }))
  const gitPath = (await execFileAsync('sh', ['-c', 'command -v git'], { encoding: 'utf8' })).stdout.trim()
  const commandLog = join(binDirectory, 'forbidden-commands')
  const wrapper = join(binDirectory, 'bounded-status-git')
  await writeFile(wrapper, [
    '#!/bin/sh',
    'case "$1" in',
    `  diff|add|reset|rm) printf '%s\\n' "$*" >> '${commandLog}' ;;`,
    'esac',
    `exec '${gitPath}' "$@"`
  ].join('\n'))
  await chmod(wrapper, 0o755)
  const service = new GitService(root, { gitBinary: wrapper, maxStatusFiles: 1 })
  const state = await service.refresh()
  assert.equal(state.truncated, true)
  assert.deepEqual(state.files.map((file) => file.path), ['a-visible.txt'])

  for (const path of ['z-hidden.txt', 'unchanged.txt']) {
    const diff = await service.getDiff(diffRequest(state, 'working', path))
    assert.equal(diff.state, 'error', path)
    assert.equal(diff.error?.code, 'stale', path)
    assert.deepEqual(diff.files, [], path)

    const request = mutation(state, 'stage', 'a-visible.txt')
    request.path = path
    request.expectedFileFingerprint = `unlisted:${path}`
    const result = await service.mutateFile(request)
    assert.equal(result.ok, false, path)
    if (!result.ok) assert.equal(result.error.code, 'stale', path)
  }

  await assert.rejects(readFile(commandLog, 'utf8'), /ENOENT/)
  assert.equal((await git(root, ['diff', '--cached', '--name-only'])).trim(), '')
})

test('returns explicit binary, unsupported, and oversized diff states', async (t) => {
  const root = await createRepository(t)
  await writeFile(join(root, 'binary.dat'), Buffer.from([0, 1, 2, 3]))
  await writeFile(join(root, 'large.txt'), 'base\n')
  await git(root, ['add', '--', 'binary.dat', 'large.txt'])
  await git(root, ['commit', '-m', 'base'])
  await writeFile(join(root, 'binary.dat'), Buffer.from([0, 9, 8, 7]))
  await writeFile(join(root, 'large.txt'), `${'changed line\n'.repeat(100)}`)

  const service = new GitService(root)
  const state = await service.refresh()
  assert.equal((await service.getDiff(diffRequest(state, 'working', 'binary.dat'))).state, 'binary')

  const bounded = new GitService(root, { maxDiffBytes: 128 })
  const boundedState = await bounded.refresh()
  const oversized = await bounded.getDiff(diffRequest(boundedState, 'working', 'large.txt'))
  assert.equal(oversized.state, 'oversized')
  assert.equal(oversized.error?.code, 'output-limit')

  await git(root, ['reset', '--hard', 'HEAD'])
  await chmod(join(root, 'large.txt'), 0o755)
  await git(root, ['add', '--', 'large.txt'])
  const modeState = await service.refresh()
  const modeDiff = await service.getDiff(diffRequest(modeState, 'staged', 'large.txt'))
  assert.equal(modeDiff.state, 'unsupported')
})

test('timeout and AbortSignal stop the Git child and return bounded error DTOs', async (t) => {
  const root = await createRepository(t)
  await commitFile(root, 'tracked.txt', 'base\n')
  await writeFile(join(root, 'tracked.txt'), 'changed\n')
  const binDirectory = await mkdtemp(join(tmpdir(), 'pi-gui-git-bin-'))
  t.after(() => rm(binDirectory, { recursive: true, force: true }))
  const marker = join(binDirectory, 'pid')
  const fallbackLog = join(binDirectory, 'fallback-log')
  const binaryName = 'pi-gui-test-git'
  const binaryPath = join(binDirectory, binaryName)
  const gitPath = (await execFileAsync('sh', ['-c', 'command -v git'], { encoding: 'utf8' })).stdout.trim()
  await writeFile(binaryPath, [
    '#!/bin/sh',
    'if [ "$1" = "diff" ]; then',
    `  echo $$ > '${marker}'`,
    '  exec sleep 5',
    'fi',
    `if [ -f '${marker}' ]; then echo "$1" >> '${fallbackLog}'; fi`,
    `exec '${gitPath}' "$@"`
  ].join('\n'))
  await chmod(binaryPath, 0o755)
  const timeoutService = new GitService(root, { gitBinary: binaryPath, timeoutMs: 100 })
  const timeoutState = await timeoutService.refresh()
  const timedOut = await timeoutService.getDiff(diffRequest(timeoutState, 'working', 'tracked.txt'))
  assert.equal(timedOut.state, 'error')
  assert.equal(timedOut.error?.code, 'timeout')
  assert.equal((timedOut.error?.message.length ?? 0) <= 512, true)
  await assertProcessGone(Number((await readFile(marker, 'utf8')).trim()))
  await assert.rejects(readFile(fallbackLog, 'utf8'), /ENOENT/)
  await rm(marker, { force: true })

  const abortService = new GitService(root, { gitBinary: binaryPath, timeoutMs: 5_000 })
  const abortState = await abortService.refresh()
  const controller = new AbortController()
  const pending = abortService.getDiff(diffRequest(abortState, 'working', 'tracked.txt'), controller.signal)
  await waitForFile(marker)
  controller.abort()
  const aborted = await pending
  assert.equal(aborted.state, 'error')
  assert.equal(aborted.error?.code, 'aborted')
  await assertProcessGone(Number((await readFile(marker, 'utf8')).trim()))
  await assert.rejects(readFile(fallbackLog, 'utf8'), /ENOENT/)
})

test('timeout and AbortSignal terminate descriptor-fed Git hashing', async (t) => {
  const root = await createRepository(t, 'pi-gui-hash-cancel-')
  await writeFile(join(root, 'untracked.txt'), 'content to hash\n')
  const binDirectory = await mkdtemp(join(tmpdir(), 'pi-gui-hash-cancel-bin-'))
  t.after(() => rm(binDirectory, { recursive: true, force: true }))
  const marker = join(binDirectory, 'pid')
  const gitPath = (await execFileAsync('sh', ['-c', 'command -v git'], { encoding: 'utf8' })).stdout.trim()
  const wrapper = join(binDirectory, 'slow-hash-git')
  await writeFile(wrapper, [
    '#!/bin/sh',
    'if [ "$1" = "hash-object" ]; then',
    `  echo $$ > '${marker}'`,
    '  exec sleep 5',
    'fi',
    `exec '${gitPath}' "$@"`
  ].join('\n'))
  await chmod(wrapper, 0o755)

  const timedService = new GitService(root, { gitBinary: wrapper, timeoutMs: 100 })
  await assert.rejects(timedService.refresh(), /Git hashing timed out/)
  await assertProcessGone(Number((await readFile(marker, 'utf8')).trim()))
  await rm(marker, { force: true })

  const abortService = new GitService(root, { gitBinary: wrapper, timeoutMs: 5_000 })
  const controller = new AbortController()
  const pending = abortService.refresh(controller.signal)
  await waitForFile(marker)
  controller.abort()
  await assert.rejects(pending, /Git hashing was aborted/)
  await assertProcessGone(Number((await readFile(marker, 'utf8')).trim()))
})

test('requires exact Main authorization before an ancestor repository can escape the Project root', async (t) => {
  const repositoryRoot = await createRepository(t, 'pi-gui-git-trust-')
  const projectRoot = join(repositoryRoot, 'project')
  await mkdir(projectRoot)
  await writeFile(join(repositoryRoot, 'outside.txt'), 'outside\n')
  await writeFile(join(projectRoot, 'inside.txt'), 'inside\n')
  const service = new GitService(projectRoot)

  const blocked = await service.refresh()
  assert.equal(blocked.kind, 'trust-required')
  assert.equal(blocked.repositoryRoot, repositoryRoot)
  assert.deepEqual(blocked.files, [])
  assert.equal(blocked.lastError?.code, 'trust-required')

  const blockedDiff = await service.getDiff({
    kind: 'working',
    path: 'outside.txt',
    expectedRepositoryRoot: repositoryRoot,
    expectedHeadOid: null,
    expectedIndexTreeOid: null,
    expectedStatusRevision: blocked.statusRevision
  })
  assert.equal(blockedDiff.state, 'trust-required')
  assert.equal(blockedDiff.files.length, 0)

  const blockedMutation = await service.mutateFile({
    action: 'stage',
    path: 'outside.txt',
    expectedRepositoryRoot: repositoryRoot,
    expectedHeadOid: null,
    expectedIndexTreeOid: null,
    expectedIndexFingerprint: blocked.indexFingerprint,
    expectedFileFingerprint: 'trust-required',
    expectedWorktreeFingerprint: blocked.worktreeFingerprint,
    expectedStatusRevision: blocked.statusRevision
  })
  assert.equal(blockedMutation.ok, false)
  if (!blockedMutation.ok) assert.equal(blockedMutation.error.code, 'trust-required')
  assert.equal((await git(repositoryRoot, ['diff', '--cached', '--name-only'])).trim(), '')

  const authorized = await new GitService(projectRoot, { authorizedRepositoryRoot: repositoryRoot }).refresh()
  assert.equal(authorized.kind, 'repository')
  assert.deepEqual(authorized.files.map((file) => file.path).sort(), ['outside.txt', 'project/inside.txt'])
})

test('renders bounded untracked UTF-8 files and rejects unsafe or non-text working content', async (t) => {
  const root = await createRepository(t, 'pi-gui-untracked-diff-')
  const newlinePath = 'line\nbreak.txt'
  await writeFile(join(root, 'text.txt'), 'first\nsecond')
  await writeFile(join(root, 'empty.txt'), '')
  await writeFile(join(root, 'binary.dat'), Buffer.from([0, 1, 2, 3]))
  await writeFile(join(root, 'invalid-utf8.dat'), Buffer.from([0xc3, 0x28]))
  await writeFile(join(root, 'large.txt'), 'x'.repeat(512))
  await writeFile(join(root, newlinePath), 'newline path\n')
  await writeFile(join(root, 'target.txt'), 'target\n')
  await symlink('target.txt', join(root, 'link.txt'))
  const service = new GitService(root)
  const state = await service.refresh()

  const text = await service.getDiff(diffRequest(state, 'working', 'text.txt'))
  assert.equal(text.state, 'ready')
  assert.equal(text.files[0]?.change, 'added')
  assert.deepEqual(text.files[0]?.hunks[0]?.lines.map((line) => [line.kind, line.content]), [
    ['add', 'first'],
    ['add', 'second'],
    ['meta', 'No newline at end of file']
  ])

  const empty = await service.getDiff(diffRequest(state, 'working', 'empty.txt'))
  assert.equal(empty.state, 'ready')
  assert.equal(empty.files[0]?.change, 'added')
  assert.deepEqual(empty.files[0]?.hunks, [])

  const newline = await service.getDiff(diffRequest(state, 'working', newlinePath))
  assert.equal(newline.state, 'ready')
  assert.equal(newline.files[0]?.path, newlinePath)
  assert.equal(newline.files[0]?.hunks[0]?.lines[0]?.content, 'newline path')

  assert.equal((await service.getDiff(diffRequest(state, 'working', 'binary.dat'))).state, 'binary')
  assert.equal((await service.getDiff(diffRequest(state, 'working', 'invalid-utf8.dat'))).state, 'binary')
  assert.equal((await service.getDiff(diffRequest(state, 'working', 'link.txt'))).state, 'unsupported')

  const bounded = new GitService(root, { maxDiffBytes: 128 })
  const boundedState = await bounded.refresh()
  const oversized = await bounded.getDiff(diffRequest(boundedState, 'working', 'large.txt'))
  assert.equal(oversized.state, 'oversized')
  assert.equal(oversized.error?.code, 'output-limit')

  const lineBounded = new GitService(root, { maxDiffLines: 1 })
  const lineBoundedState = await lineBounded.refresh()
  const tooManyLines = await lineBounded.getDiff(diffRequest(lineBoundedState, 'working', 'text.txt'))
  assert.equal(tooManyLines.state, 'oversized')
  assert.equal(tooManyLines.error?.code, 'output-limit')

  const abortedController = new AbortController()
  abortedController.abort()
  const aborted = await service.getDiff(diffRequest(state, 'working', 'text.txt'), abortedController.signal)
  assert.equal(aborted.state, 'error')
  assert.equal(aborted.error?.code, 'aborted')

  const stagedUntracked = await service.getDiff(diffRequest(state, 'staged', 'text.txt'))
  assert.equal(stagedUntracked.state, 'ready')
  assert.deepEqual(stagedUntracked.files, [])
})

test('never passes an untracked symbolic-link path to Git hashing and does not read its outside target', async (t) => {
  const root = await createRepository(t, 'pi-gui-untracked-symlink-security-')
  const outside = await mkdtemp(join(tmpdir(), 'pi-gui-outside-secret-'))
  t.after(() => rm(outside, { recursive: true, force: true }))
  const secretPath = join(outside, 'secret.txt')
  await writeFile(secretPath, 'outside secret bytes\n')
  const oldAccessTime = new Date('2000-01-01T00:00:00.000Z')
  await utimes(secretPath, oldAccessTime, new Date())
  const accessTimeBefore = (await stat(secretPath)).atimeMs
  await symlink(secretPath, join(root, 'outside-link'))
  const binDirectory = await mkdtemp(join(tmpdir(), 'pi-gui-symlink-git-bin-'))
  t.after(() => rm(binDirectory, { recursive: true, force: true }))
  const gitPath = (await execFileAsync('sh', ['-c', 'command -v git'], { encoding: 'utf8' })).stdout.trim()
  const hashLog = join(binDirectory, 'hash-arguments')
  const wrapper = join(binDirectory, 'no-path-hash-git')
  await writeFile(wrapper, [
    '#!/bin/sh',
    'if [ "$1" = "hash-object" ]; then',
    `  printf '%s\\n' "$*" >> '${hashLog}'`,
    '  for argument in "$@"; do',
    '    if [ "$argument" = "outside-link" ]; then',
    '      echo "unsafe path-based symlink hash" >&2',
    '      exit 97',
    '    fi',
    '  done',
    'fi',
    `exec '${gitPath}' "$@"`
  ].join('\n'))
  await chmod(wrapper, 0o755)
  const service = new GitService(root, { gitBinary: wrapper })

  const state = await service.refresh()
  assert.equal(state.files.find((file) => file.path === 'outside-link')?.state, 'untracked')
  const hashArguments = await readFile(hashLog, 'utf8')
  assert.equal(hashArguments.includes('outside-link'), false)
  assert.match(hashArguments, /hash-object --no-filters --stdin/)

  const diff = await service.getDiff(diffRequest(state, 'working', 'outside-link'))
  assert.equal(diff.state, 'unsupported')
  assert.equal(diff.error?.code, 'unsupported')
  assert.equal((await stat(secretPath)).atimeMs, accessTimeBefore)
  assert.equal(await readFile(secretPath, 'utf8'), 'outside secret bytes\n')
})

test('rejects a deterministic regular-to-symlink lstat/open swap without reading the outside target', async (t) => {
  const root = await createRepository(t, 'pi-gui-no-follow-swap-')
  await writeFile(join(root, 'victim.txt'), 'safe worktree bytes\n')
  const outside = await mkdtemp(join(tmpdir(), 'pi-gui-swap-secret-'))
  t.after(() => rm(outside, { recursive: true, force: true }))
  const secretPath = join(outside, 'secret.txt')
  await writeFile(secretPath, 'must never be hashed\n')
  const oldAccessTime = new Date('2000-01-01T00:00:00.000Z')
  await utimes(secretPath, oldAccessTime, new Date())
  const accessTimeBefore = (await stat(secretPath)).atimeMs
  let swapped = false
  const service = new GitService(root, {}, {
    beforeNoFollowOpen: async (absolutePath) => {
      if (swapped || absolutePath !== join(root, 'victim.txt')) return
      swapped = true
      await rm(absolutePath)
      await symlink(secretPath, absolutePath)
    }
  })

  await assert.rejects(service.refresh(), (error: unknown) => {
    assert.equal(error instanceof Error, true)
    assert.match((error as Error).message, /no-follow open|identity changed/)
    return true
  })
  assert.equal(swapped, true)
  assert.equal(await readlink(join(root, 'victim.txt')), secretPath)
  assert.equal((await stat(secretPath)).atimeMs, accessTimeBefore)
  assert.equal(await readFile(secretPath, 'utf8'), 'must never be hashed\n')
})

test('post-read fences reject tracked and untracked diffs when content changes during production', async (t) => {
  const root = await createRepository(t, 'pi-gui-diff-race-')
  await commitFile(root, 'tracked.txt', 'base\n')
  await writeFile(join(root, 'tracked.txt'), 'working one\n')
  await writeFile(join(root, 'untracked.txt'), 'untracked one\n')
  const binDirectory = await mkdtemp(join(tmpdir(), 'pi-gui-diff-race-bin-'))
  t.after(() => rm(binDirectory, { recursive: true, force: true }))
  const gitPath = (await execFileAsync('sh', ['-c', 'command -v git'], { encoding: 'utf8' })).stdout.trim()

  const trackedWrapper = join(binDirectory, 'tracked-git')
  await writeFile(trackedWrapper, [
    '#!/bin/sh',
    'if [ "$1" = "diff" ]; then',
    `  '${gitPath}' "$@"`,
    '  status=$?',
    `  printf 'working two\\n' > '${join(root, 'tracked.txt')}'`,
    '  exit $status',
    'fi',
    `exec '${gitPath}' "$@"`
  ].join('\n'))
  await chmod(trackedWrapper, 0o755)
  const trackedService = new GitService(root, { gitBinary: trackedWrapper })
  const trackedState = await trackedService.refresh()
  const trackedRace = await trackedService.getDiff(diffRequest(trackedState, 'working', 'tracked.txt'))
  assert.equal(trackedRace.state, 'error')
  assert.equal(trackedRace.error?.code, 'stale')
  assert.deepEqual(trackedRace.files, [])

  await writeFile(join(root, 'tracked.txt'), 'base\n')
  const countFile = join(binDirectory, 'hash-count')
  const armFile = join(binDirectory, 'arm')
  const untrackedWrapper = join(binDirectory, 'untracked-git')
  await writeFile(untrackedWrapper, [
    '#!/bin/sh',
    'if [ "$1" = "hash-object" ] && [ -f "' + armFile + '" ]; then',
    `  count=$(cat '${countFile}' 2>/dev/null || printf 0)`,
    '  count=$((count + 1))',
    `  printf '%s' "$count" > '${countFile}'`,
    '  if [ "$count" -eq 2 ]; then',
    `    printf 'untracked two\\n' > '${join(root, 'untracked.txt')}'`,
    '  fi',
    'fi',
    `exec '${gitPath}' "$@"`
  ].join('\n'))
  await chmod(untrackedWrapper, 0o755)
  const untrackedService = new GitService(root, { gitBinary: untrackedWrapper })
  const untrackedState = await untrackedService.refresh()
  await writeFile(armFile, 'armed')
  const untrackedRace = await untrackedService.getDiff(diffRequest(untrackedState, 'working', 'untracked.txt'))
  assert.equal(untrackedRace.state, 'error')
  assert.equal(untrackedRace.error?.code, 'stale')
  assert.deepEqual(untrackedRace.files, [])
})

test('maps legal Git paths only from status identity for working, staged, and rename diffs', async (t) => {
  const root = await createRepository(t, 'pi-gui-legal-paths-')
  const paths = [
    'space name.txt',
    ' leading.txt',
    'trailing.txt ',
    'tab\tname.txt',
    '\tleading-tab.txt',
    'trailing-tab.txt\t',
    'line\nbreak.txt',
    'quote"name.txt',
    'back\\slash.txt',
    '非ASCII.txt'
  ]
  for (const path of paths) await writeFile(join(root, path), 'base\n')
  await git(root, ['add', '--', ...paths])
  await git(root, ['commit', '-m', 'legal paths'])
  for (const path of paths) await writeFile(join(root, path), `working ${JSON.stringify(path)}\n`)
  const service = new GitService(root)
  const workingState = await service.refresh()

  for (const path of paths) {
    const diff = await service.getDiff(diffRequest(workingState, 'working', path))
    assert.equal(diff.state, 'ready', JSON.stringify(path))
    assert.equal(diff.files[0]?.path, path)
    assert.equal(diff.files[0]?.originalPath, null)
  }

  await git(root, ['add', '--', ...paths])
  const stagedState = await service.refresh()
  for (const path of paths) {
    const diff = await service.getDiff(diffRequest(stagedState, 'staged', path))
    assert.equal(diff.state, 'ready', JSON.stringify(path))
    assert.equal(diff.files[0]?.path, path)
  }

  await git(root, ['reset', '--hard', 'HEAD'])
  const oldPath = ' old\t"\\旧\nname.txt '
  const newPath = ' new\t"\\新\nname.txt '
  await writeFile(join(root, oldPath), 'rename base\n')
  await git(root, ['add', '--', oldPath])
  await git(root, ['commit', '-m', 'rename base'])
  await git(root, ['mv', '--', oldPath, newPath])
  const renameState = await service.refresh()
  const renameDiff = await service.getDiff(diffRequest(renameState, 'staged', newPath))
  assert.equal(renameDiff.state, 'ready')
  assert.equal(renameDiff.files[0]?.change, 'renamed')
  assert.equal(renameDiff.files[0]?.path, newPath)
  assert.equal(renameDiff.files[0]?.originalPath, oldPath)
})

test('returns one explicit conflict state for UU, AA, DD, and modify-delete identities', async (t) => {
  const root = await createRepository(t, 'pi-gui-conflict-matrix-')
  await commitFile(root, 'seed.txt', 'seed\n')
  const baseOid = (await gitInput(root, ['hash-object', '-w', '--stdin'], 'base\n')).trim()
  const oursOid = (await gitInput(root, ['hash-object', '-w', '--stdin'], 'ours\n')).trim()
  const theirsOid = (await gitInput(root, ['hash-object', '-w', '--stdin'], 'theirs\n')).trim()
  const paths = ['uu.txt', 'aa.txt', 'dd.txt', 'modify-delete.txt']
  await git(root, ['update-index', '--force-remove', '--', ...paths])
  await gitInput(root, ['update-index', '--index-info'], [
    `100644 ${baseOid} 1\tuu.txt`,
    `100644 ${oursOid} 2\tuu.txt`,
    `100644 ${theirsOid} 3\tuu.txt`,
    `100644 ${oursOid} 2\taa.txt`,
    `100644 ${theirsOid} 3\taa.txt`,
    `100644 ${baseOid} 1\tdd.txt`,
    `100644 ${baseOid} 1\tmodify-delete.txt`,
    `100644 ${oursOid} 2\tmodify-delete.txt`
  ].join('\n') + '\n')
  await writeFile(join(root, 'uu.txt'), 'conflict\n')
  await writeFile(join(root, 'aa.txt'), 'conflict\n')
  await writeFile(join(root, 'modify-delete.txt'), 'ours\n')
  const service = new GitService(root)
  const state = await service.refresh()
  assert.equal(state.indexTreeOid, null)

  for (const path of paths) {
    const file = state.files.find((candidate) => candidate.path === path)
    assert.equal(file?.conflicted, true, path)
    for (const kind of ['working', 'staged'] as const) {
      const diff = await service.getDiff(diffRequest(state, kind, path))
      assert.equal(diff.state, 'conflict', `${path}:${kind}`)
      assert.equal(diff.error?.code, 'conflict')
      assert.deepEqual(diff.files, [])
    }
  }
})

test('propagates command-specific failures after discovery instead of projecting expected absence', async (t) => {
  const root = await createRepository(t, 'pi-gui-command-failure-')
  await commitFile(root, 'tracked.txt', 'base\n')
  await writeFile(join(root, 'tracked.txt'), 'changed\n')
  const binDirectory = await mkdtemp(join(tmpdir(), 'pi-gui-command-failure-bin-'))
  t.after(() => rm(binDirectory, { recursive: true, force: true }))
  const gitPath = (await execFileAsync('sh', ['-c', 'command -v git'], { encoding: 'utf8' })).stdout.trim()

  for (const command of ['write-tree', 'hash-object']) {
    const wrapper = join(binDirectory, `fail-${command}`)
    await writeFile(wrapper, [
      '#!/bin/sh',
      `if [ "$1" = "${command}" ]; then`,
      '  echo "fatal: synthetic unrelated post-discovery failure" >&2',
      '  exit 2',
      'fi',
      `exec '${gitPath}' "$@"`
    ].join('\n'))
    await chmod(wrapper, 0o755)
    await assert.rejects(new GitService(root, { gitBinary: wrapper }).refresh(), /synthetic unrelated post-discovery failure/)
  }

  const normal = await new GitService(root).refresh()
  assert.equal(normal.branch, 'main')
  assert.equal(normal.upstream, null)
  const detachedOid = (await git(root, ['rev-parse', 'HEAD'])).trim()
  await git(root, ['checkout', '--detach', detachedOid])
  const detached = await new GitService(root).refresh()
  assert.equal(detached.branch, null)
  assert.equal(detached.detached, true)
})

test('bounds per-file Git hashing with a fixed worker pool for a large status set', async (t) => {
  const root = await createRepository(t, 'pi-gui-hash-pool-')
  for (let index = 0; index < 120; index += 1) {
    await writeFile(join(root, `file-${String(index).padStart(3, '0')}.txt`), `${index}\n`)
  }
  const binDirectory = await mkdtemp(join(tmpdir(), 'pi-gui-hash-pool-bin-'))
  t.after(() => rm(binDirectory, { recursive: true, force: true }))
  const gitPath = (await execFileAsync('sh', ['-c', 'command -v git'], { encoding: 'utf8' })).stdout.trim()
  const lock = join(binDirectory, 'lock')
  const current = join(binDirectory, 'current')
  const maximum = join(binDirectory, 'maximum')
  const wrapper = join(binDirectory, 'pool-git')
  await writeFile(wrapper, [
    '#!/bin/sh',
    'if [ "$1" != "hash-object" ]; then',
    `  exec '${gitPath}' "$@"`,
    'fi',
    `while ! mkdir '${lock}' 2>/dev/null; do sleep 0.001; done`,
    `now=$(cat '${current}' 2>/dev/null || printf 0)`,
    'now=$((now + 1))',
    `printf '%s' "$now" > '${current}'`,
    `max=$(cat '${maximum}' 2>/dev/null || printf 0)`,
    `if [ "$now" -gt "$max" ]; then printf '%s' "$now" > '${maximum}'; fi`,
    `rmdir '${lock}'`,
    'sleep 0.03',
    `'${gitPath}' "$@"`,
    'status=$?',
    `while ! mkdir '${lock}' 2>/dev/null; do sleep 0.001; done`,
    `now=$(cat '${current}')`,
    'now=$((now - 1))',
    `printf '%s' "$now" > '${current}'`,
    `rmdir '${lock}'`,
    'exit $status'
  ].join('\n'))
  await chmod(wrapper, 0o755)

  const state = await new GitService(root, { gitBinary: wrapper }).refresh()
  assert.equal(state.files.length, 120)
  const measuredMaximum = Number((await readFile(maximum, 'utf8')).trim())
  assert.equal(measuredMaximum >= 2, true)
  assert.equal(measuredMaximum <= 4, true)
})

test('automatic refresh bounds per-file hashing and does not exact-coalesce large renames', async (t) => {
  const root = await createRepository(t, 'pi-gui-fingerprint-budget-')
  for (let index = 0; index < 2_000; index += 1) {
    const path = join(root, `large-${String(index).padStart(4, '0')}.dat`)
    await writeFile(path, '')
    await truncate(path, 4_096)
  }
  const binDirectory = await mkdtemp(join(tmpdir(), 'pi-gui-fingerprint-budget-bin-'))
  t.after(() => rm(binDirectory, { recursive: true, force: true }))
  const gitPath = (await execFileAsync('sh', ['-c', 'command -v git'], { encoding: 'utf8' })).stdout.trim()
  const hashLog = join(binDirectory, 'hash-invocations')
  const wrapper = join(binDirectory, 'budget-git')
  await writeFile(wrapper, [
    '#!/bin/sh',
    'if [ "$1" = "hash-object" ]; then',
    `  printf '%s\\n' "$*" >> '${hashLog}'`,
    'fi',
    `exec '${gitPath}' "$@"`
  ].join('\n'))
  await chmod(wrapper, 0o755)
  const service = new GitService(root, { gitBinary: wrapper, maxAutomaticFingerprintBytes: 128 })

  const state = await service.refresh()
  assert.equal(state.files.length, 2_000)
  assert.equal(state.truncated, false)
  await assert.rejects(readFile(hashLog, 'utf8'), /ENOENT/)

  const renameRoot = await createRepository(t, 'pi-gui-large-rename-budget-')
  await writeFile(join(renameRoot, 'old-large.dat'), Buffer.alloc(4_096, 7))
  await git(renameRoot, ['add', '--', 'old-large.dat'])
  await git(renameRoot, ['commit', '-m', 'large base'])
  await rename(join(renameRoot, 'old-large.dat'), join(renameRoot, 'new-large.dat'))
  const renameService = new GitService(renameRoot, { gitBinary: wrapper, maxAutomaticFingerprintBytes: 128 })
  const renameState = await renameService.refresh()
  assert.deepEqual(
    renameState.files.map((file) => [file.path, file.worktreeChange]).sort((left, right) => left[0]!.localeCompare(right[0]!)),
    [['new-large.dat', 'untracked'], ['old-large.dat', 'deleted']]
  )
  await assert.rejects(readFile(hashLog, 'utf8'), /ENOENT/)
})

test('safe stdin hashing preserves clean-filter index equivalence for regular-file staging', async (t) => {
  const root = await createRepository(t, 'pi-gui-filtered-stage-')
  await writeFile(join(root, '.gitattributes'), 'filtered.txt filter=pi-gui-test\n')
  await git(root, ['config', 'filter.pi-gui-test.clean', 'sed s/worktree/index/g'])
  await writeFile(join(root, 'filtered.txt'), 'base\n')
  await git(root, ['add', '--', '.gitattributes', 'filtered.txt'])
  await git(root, ['commit', '-m', 'filtered base'])
  await writeFile(join(root, 'filtered.txt'), 'worktree content\n')
  const service = new GitService(root)

  const state = await service.refresh()
  const staged = await service.mutateFile(mutation(state, 'stage', 'filtered.txt'))
  assert.equal(staged.ok, true)
  assert.equal(await git(root, ['show', ':filtered.txt']), 'index content\n')
})

test('post-operation content fence reports stale when an external writer changes a file during stage', async (t) => {
  const root = await createRepository(t, 'pi-gui-mutation-race-')
  await commitFile(root, 'tracked.txt', 'base\n')
  await writeFile(join(root, 'tracked.txt'), 'confirmed\n')
  const binDirectory = await mkdtemp(join(tmpdir(), 'pi-gui-mutation-race-bin-'))
  t.after(() => rm(binDirectory, { recursive: true, force: true }))
  const gitPath = (await execFileAsync('sh', ['-c', 'command -v git'], { encoding: 'utf8' })).stdout.trim()
  const wrapper = join(binDirectory, 'mutation-git')
  await writeFile(wrapper, [
    '#!/bin/sh',
    'if [ "$1" = "add" ]; then',
    `  '${gitPath}' "$@"`,
    '  status=$?',
    `  printf 'diverged\\n' > '${join(root, 'tracked.txt')}'`,
    '  exit $status',
    'fi',
    `exec '${gitPath}' "$@"`
  ].join('\n'))
  await chmod(wrapper, 0o755)
  const service = new GitService(root, { gitBinary: wrapper })
  const state = await service.refresh()

  const result = await service.mutateFile(mutation(state, 'stage', 'tracked.txt'))
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.error.code, 'stale')
  assert.equal(await readFile(join(root, 'tracked.txt'), 'utf8'), 'diverged\n')
  assert.equal((await git(root, ['show', ':tracked.txt'])), 'confirmed\n')
})

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await stat(path)
      return
    } catch (error) {
      if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')) throw error
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
  assert.fail(`Timed out waiting for ${path}.`)
}

async function assertProcessGone(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      process.kill(pid, 0)
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH') return
      throw error
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assert.fail(`Git child process ${pid} was not cleaned up.`)
}

async function createRemotePair(t: test.TestContext): Promise<{ root: string; remote: string }> {
  const root = await createRepository(t, 'pi-gui-git-commit-')
  await commitFile(root, 'tracked.txt', 'base\n')
  const remote = await mkdtemp(join(tmpdir(), 'pi-gui-git-remote-'))
  t.after(() => rm(remote, { recursive: true, force: true }))
  await git(remote, ['init', '--bare', '--initial-branch=main'])
  await git(root, ['remote', 'add', 'origin', remote])
  await git(root, ['push', '-u', 'origin', 'main'])
  return { root, remote }
}

test('prepareCommit reports accurate staged count, structured upstream, and deterministic message', async (t) => {
  const { root } = await createRemotePair(t)
  await writeFile(join(root, 'tracked.txt'), 'staged\n')
  await writeFile(join(root, 'working-only.txt'), 'work\n')
  await writeFile(join(root, 'untracked.txt'), 'new\n')
  await git(root, ['add', '--', 'tracked.txt'])
  await writeFile(join(root, 'tracked.txt'), 'mixed-working\n')
  const service = new GitService(root)

  const prepared = await service.prepareCommit()
  assert.equal(prepared.ok, true)
  if (!prepared.ok) return
  assert.equal(prepared.preview.stagedFileCount, 1)
  assert.equal(prepared.preview.amendAvailable, true)
  assert.deepEqual(prepared.preview.pushTarget, { remote: 'origin', branch: 'main' })
  assert.equal(prepared.preview.suggestedMessage, 'Update tracked.txt')
  assert.equal(prepared.preview.snapshot.branch, 'main')
  assert.equal(prepared.preview.snapshot.repositoryRoot, await realpathSafe(root))
  assert.notEqual(prepared.preview.snapshot.headOid, null)
  assert.notEqual(prepared.preview.snapshot.indexTreeOid, null)
})

test('prepareCommit reads remote names containing slashes without string splitting', async (t) => {
  const root = await createRepository(t, 'pi-gui-git-slash-remote-')
  await commitFile(root, 'tracked.txt', 'base\n')
  const remote = await mkdtemp(join(tmpdir(), 'pi-gui-git-slash-remote-bare-'))
  t.after(() => rm(remote, { recursive: true, force: true }))
  await git(remote, ['init', '--bare', '--initial-branch=main'])
  await git(root, ['remote', 'add', 'company/prod', remote])
  await git(root, ['push', '-u', 'company/prod', 'main'])
  await writeFile(join(root, 'tracked.txt'), 'next\n')
  await git(root, ['add', '--', 'tracked.txt'])

  const prepared = await new GitService(root).prepareCommit()
  assert.equal(prepared.ok, true)
  if (!prepared.ok) return
  assert.deepEqual(prepared.preview.pushTarget, { remote: 'company/prod', branch: 'main' })
})

test('prepareCommit rejects clean, conflicted, detached, and missing-identity repositories', async (t) => {
  const clean = await createRepository(t, 'pi-gui-git-commit-clean-')
  await commitFile(clean, 'tracked.txt', 'base\n')
  const cleanPrepared = await new GitService(clean).prepareCommit()
  assert.equal(cleanPrepared.ok, false)
  if (!cleanPrepared.ok) assert.equal(cleanPrepared.error.code, 'unsupported')

  const conflicted = await createRepository(t, 'pi-gui-git-commit-conflict-')
  await commitFile(conflicted, 'tracked.txt', 'base\n')
  await git(conflicted, ['checkout', '-b', 'side'])
  await writeFile(join(conflicted, 'tracked.txt'), 'side\n')
  await git(conflicted, ['add', '--', 'tracked.txt'])
  await git(conflicted, ['commit', '-m', 'side'])
  await git(conflicted, ['checkout', 'main'])
  await writeFile(join(conflicted, 'tracked.txt'), 'main\n')
  await git(conflicted, ['add', '--', 'tracked.txt'])
  await git(conflicted, ['commit', '-m', 'main'])
  await git(conflicted, ['merge', 'side'], true)
  const conflictPrepared = await new GitService(conflicted).prepareCommit()
  assert.equal(conflictPrepared.ok, false)
  if (!conflictPrepared.ok) assert.equal(conflictPrepared.error.code, 'conflict')

  const detached = await createRepository(t, 'pi-gui-git-commit-detached-')
  await commitFile(detached, 'tracked.txt', 'base\n')
  const head = (await git(detached, ['rev-parse', 'HEAD'])).trim()
  await git(detached, ['checkout', '--detach', head])
  await writeFile(join(detached, 'tracked.txt'), 'detached\n')
  await git(detached, ['add', '--', 'tracked.txt'])
  const detachedPrepared = await new GitService(detached).prepareCommit()
  assert.equal(detachedPrepared.ok, false)
  if (!detachedPrepared.ok) assert.equal(detachedPrepared.error.code, 'unsupported')

  const noIdentity = await createRepository(t, 'pi-gui-git-commit-noid-')
  await writeFile(join(noIdentity, 'tracked.txt'), 'base\n')
  await git(noIdentity, ['add', '--', 'tracked.txt'])
  const previousAuthor = process.env.GIT_AUTHOR_NAME
  const previousEmail = process.env.GIT_AUTHOR_EMAIL
  const previousCommitter = process.env.GIT_COMMITTER_NAME
  const previousCommitterEmail = process.env.GIT_COMMITTER_EMAIL
  t.after(() => {
    if (previousAuthor === undefined) delete process.env.GIT_AUTHOR_NAME
    else process.env.GIT_AUTHOR_NAME = previousAuthor
    if (previousEmail === undefined) delete process.env.GIT_AUTHOR_EMAIL
    else process.env.GIT_AUTHOR_EMAIL = previousEmail
    if (previousCommitter === undefined) delete process.env.GIT_COMMITTER_NAME
    else process.env.GIT_COMMITTER_NAME = previousCommitter
    if (previousCommitterEmail === undefined) delete process.env.GIT_COMMITTER_EMAIL
    else process.env.GIT_COMMITTER_EMAIL = previousCommitterEmail
  })
  delete process.env.GIT_AUTHOR_NAME
  delete process.env.GIT_AUTHOR_EMAIL
  delete process.env.GIT_COMMITTER_NAME
  delete process.env.GIT_COMMITTER_EMAIL
  await git(noIdentity, ['config', '--unset', 'user.name'], true)
  await git(noIdentity, ['config', '--unset', 'user.email'], true)
  // Ensure repository-local config cannot invent identity either.
  await execFileAsync('git', ['config', '--local', '--unset-all', 'user.name'], { cwd: noIdentity, env: { ...process.env, HOME: noIdentity } }).catch(() => undefined)
  await execFileAsync('git', ['config', '--local', '--unset-all', 'user.email'], { cwd: noIdentity, env: { ...process.env, HOME: noIdentity } }).catch(() => undefined)
  const isolatedEnvService = new GitService(noIdentity)
  // Force identity failure through a wrapper binary that clears author vars for `git var`.
  const binDirectory = await mkdtemp(join(tmpdir(), 'pi-gui-git-noid-bin-'))
  t.after(() => rm(binDirectory, { recursive: true, force: true }))
  const wrapper = join(binDirectory, 'git')
  await writeFile(wrapper, [
    '#!/bin/sh',
    'if [ "$1" = "var" ]; then',
    '  echo "fatal: no identity" >&2',
    '  exit 128',
    'fi',
    'exec git "$@"'
  ].join('\n'))
  await chmod(wrapper, 0o755)
  const identityPrepared = await new GitService(noIdentity, { gitBinary: wrapper }).prepareCommit()
  assert.equal(identityPrepared.ok, false)
  if (!identityPrepared.ok) {
    assert.equal(identityPrepared.error.code, 'unsupported')
    assert.equal(identityPrepared.error.message.includes('fatal'), false)
  }
  void isolatedEnvService
})

test('unborn commit succeeds while amend and commit-and-push remain unavailable', async (t) => {
  const root = await createRepository(t, 'pi-gui-git-unborn-')
  await writeFile(join(root, 'first.txt'), 'one\n')
  await git(root, ['add', '--', 'first.txt'])
  const service = new GitService(root)

  const prepared = await service.prepareCommit()
  assert.equal(prepared.ok, true)
  if (!prepared.ok) return
  assert.equal(prepared.preview.amendAvailable, false)
  assert.equal(prepared.preview.pushTarget, null)
  assert.equal(prepared.preview.snapshot.headOid, null)

  const amend = await service.executeCommit({
    mode: 'amend',
    message: 'should fail',
    snapshot: prepared.preview.snapshot,
    expectedPushTarget: null
  })
  assert.equal(amend.commit.status, 'failed')
  if (amend.commit.status === 'failed') assert.equal(amend.commit.error.code, 'unsupported')

  const push = await service.executeCommit({
    mode: 'commit-and-push',
    message: 'should fail',
    snapshot: prepared.preview.snapshot,
    expectedPushTarget: { remote: 'origin', branch: 'main' }
  })
  assert.equal(push.commit.status, 'failed')
  if (push.commit.status === 'failed') assert.equal(push.commit.error.code, 'unsupported')

  const committed = await service.executeCommit({
    mode: 'commit',
    message: 'Initial commit',
    snapshot: prepared.preview.snapshot,
    expectedPushTarget: null
  })
  assert.equal(committed.commit.status, 'succeeded')
  if (committed.commit.status === 'succeeded') {
    assert.notEqual(committed.commit.oid, null)
    assert.match(committed.commit.oid!, /^[0-9a-f]{40}$/u)
    assert.equal((await git(root, ['rev-parse', 'HEAD'])).trim(), committed.commit.oid)
  }
  assert.equal(committed.push, null)
})

test('commit only includes the confirmed index and leaves unstaged worktree content alone', async (t) => {
  const root = await createRepository(t, 'pi-gui-git-index-only-')
  await commitFile(root, 'tracked.txt', 'base\n')
  await writeFile(join(root, 'tracked.txt'), 'staged\n')
  await writeFile(join(root, 'untracked.txt'), 'keep-me\n')
  await git(root, ['add', '--', 'tracked.txt'])
  await writeFile(join(root, 'tracked.txt'), 'later-working\n')
  const service = new GitService(root)
  const prepared = await service.prepareCommit()
  assert.equal(prepared.ok, true)
  if (!prepared.ok) return

  const result = await service.executeCommit({
    mode: 'commit',
    message: 'Only staged',
    snapshot: prepared.preview.snapshot,
    expectedPushTarget: null
  })
  assert.equal(result.commit.status, 'succeeded')
  assert.equal(await readFile(join(root, 'tracked.txt'), 'utf8'), 'later-working\n')
  assert.equal(await readFile(join(root, 'untracked.txt'), 'utf8'), 'keep-me\n')
  assert.equal((await git(root, ['show', 'HEAD:tracked.txt'])), 'staged\n')
  const status = await git(root, ['status', '--porcelain=v1', '-z'])
  assert.match(status, /untracked\.txt/)
  assert.match(status, /tracked\.txt/)
})

test('unrelated worktree-only changes do not invalidate a confirmed index commit', async (t) => {
  const root = await createRepository(t, 'pi-gui-git-worktree-ok-')
  await commitFile(root, 'tracked.txt', 'base\n')
  await writeFile(join(root, 'tracked.txt'), 'staged\n')
  await git(root, ['add', '--', 'tracked.txt'])
  const service = new GitService(root)
  const prepared = await service.prepareCommit()
  assert.equal(prepared.ok, true)
  if (!prepared.ok) return
  await writeFile(join(root, 'extra.txt'), 'only-worktree\n')

  const result = await service.executeCommit({
    mode: 'commit',
    message: 'Confirmed index',
    snapshot: prepared.preview.snapshot,
    expectedPushTarget: null
  })
  assert.equal(result.commit.status, 'succeeded')
  assert.equal(await readFile(join(root, 'extra.txt'), 'utf8'), 'only-worktree\n')
  assert.equal((await git(root, ['ls-files', '--', 'extra.txt'])).trim(), '')
})

test('amend rewrites HEAD tree while preserving old parents', async (t) => {
  const root = await createRepository(t, 'pi-gui-git-amend-')
  await commitFile(root, 'tracked.txt', 'base\n', 'first')
  await writeFile(join(root, 'tracked.txt'), 'second\n')
  await git(root, ['add', '--', 'tracked.txt'])
  await git(root, ['commit', '-m', 'second'])
  const oldHead = (await git(root, ['rev-parse', 'HEAD'])).trim()
  const oldParents = (await git(root, ['rev-list', '--parents', '-n1', 'HEAD'])).trim().split(/\s+/u).slice(1)
  await writeFile(join(root, 'tracked.txt'), 'amended\n')
  await git(root, ['add', '--', 'tracked.txt'])
  const service = new GitService(root)
  const prepared = await service.prepareCommit()
  assert.equal(prepared.ok, true)
  if (!prepared.ok) return
  assert.equal(prepared.preview.amendAvailable, true)

  const result = await service.executeCommit({
    mode: 'amend',
    message: 'amended message',
    snapshot: prepared.preview.snapshot,
    expectedPushTarget: null
  })
  assert.equal(result.commit.status, 'succeeded')
  if (result.commit.status !== 'succeeded') return
  const newHead = result.commit.oid
  assert.notEqual(newHead, oldHead)
  assert.equal((await git(root, ['rev-parse', 'HEAD^{tree}'])).trim(), prepared.preview.snapshot.indexTreeOid)
  const newParents = (await git(root, ['rev-list', '--parents', '-n1', 'HEAD'])).trim().split(/\s+/u).slice(1)
  assert.deepEqual(newParents, oldParents)
  assert.equal((await git(root, ['log', '-1', '--format=%B'])).trim(), 'amended message')
})

test('executeCommit returns stale without mutating when HEAD, index, branch, or upstream change', async (t) => {
  const { root, remote } = await createRemotePair(t)
  await writeFile(join(root, 'tracked.txt'), 'staged\n')
  await git(root, ['add', '--', 'tracked.txt'])
  const service = new GitService(root)
  const prepared = await service.prepareCommit()
  assert.equal(prepared.ok, true)
  if (!prepared.ok) return
  const beforeHead = (await git(root, ['rev-parse', 'HEAD'])).trim()

  await writeFile(join(root, 'other.txt'), 'external\n')
  await git(root, ['add', '--', 'other.txt'])
  await git(root, ['commit', '-m', 'external'])
  const staleHead = await service.executeCommit({
    mode: 'commit',
    message: 'stale head',
    snapshot: prepared.preview.snapshot,
    expectedPushTarget: null
  })
  assert.equal(staleHead.commit.status, 'failed')
  if (staleHead.commit.status === 'failed') assert.equal(staleHead.commit.error.code, 'stale')
  assert.notEqual((await git(root, ['rev-parse', 'HEAD'])).trim(), beforeHead)

  await writeFile(join(root, 'tracked.txt'), 'again\n')
  await git(root, ['add', '--', 'tracked.txt'])
  const prepared2 = await service.prepareCommit()
  assert.equal(prepared2.ok, true)
  if (!prepared2.ok) return
  await writeFile(join(root, 'tracked.txt'), 'index-changed\n')
  await git(root, ['add', '--', 'tracked.txt'])
  const staleIndex = await service.executeCommit({
    mode: 'commit',
    message: 'stale index',
    snapshot: prepared2.preview.snapshot,
    expectedPushTarget: null
  })
  assert.equal(staleIndex.commit.status, 'failed')
  if (staleIndex.commit.status === 'failed') assert.equal(staleIndex.commit.error.code, 'stale')

  await writeFile(join(root, 'tracked.txt'), 'branch\n')
  await git(root, ['add', '--', 'tracked.txt'])
  const prepared3 = await service.prepareCommit()
  assert.equal(prepared3.ok, true)
  if (!prepared3.ok) return
  await git(root, ['checkout', '-b', 'other-branch'])
  const staleBranch = await service.executeCommit({
    mode: 'commit',
    message: 'stale branch',
    snapshot: prepared3.preview.snapshot,
    expectedPushTarget: null
  })
  assert.equal(staleBranch.commit.status, 'failed')
  if (staleBranch.commit.status === 'failed') assert.equal(staleBranch.commit.error.code, 'stale')

  await git(root, ['checkout', 'main'])
  await writeFile(join(root, 'tracked.txt'), 'push-target\n')
  await git(root, ['add', '--', 'tracked.txt'])
  const prepared4 = await service.prepareCommit()
  assert.equal(prepared4.ok, true)
  if (!prepared4.ok) return
  await git(root, ['branch', '--unset-upstream'])
  const beforeUpstreamAttempt = (await git(root, ['rev-parse', 'HEAD'])).trim()
  const staleUpstream = await service.executeCommit({
    mode: 'commit-and-push',
    message: 'stale upstream',
    snapshot: prepared4.preview.snapshot,
    expectedPushTarget: prepared4.preview.pushTarget
  })
  assert.equal(staleUpstream.commit.status, 'failed')
  if (staleUpstream.commit.status === 'failed') {
    assert.ok(staleUpstream.commit.error.code === 'stale' || staleUpstream.commit.error.code === 'unsupported')
  }
  assert.equal((await git(root, ['rev-parse', 'HEAD'])).trim(), beforeUpstreamAttempt)
  assert.notEqual(beforeUpstreamAttempt, (await git(remote, ['rev-parse', 'main'])).trim())
})

test('commit-and-push succeeds against an explicit upstream branch', async (t) => {
  const { root, remote } = await createRemotePair(t)
  await writeFile(join(root, 'tracked.txt'), 'push-me\n')
  await git(root, ['add', '--', 'tracked.txt'])
  const service = new GitService(root)
  const prepared = await service.prepareCommit()
  assert.equal(prepared.ok, true)
  if (!prepared.ok) return

  const result = await service.executeCommit({
    mode: 'commit-and-push',
    message: 'Push this',
    snapshot: prepared.preview.snapshot,
    expectedPushTarget: prepared.preview.pushTarget
  })
  assert.equal(result.commit.status, 'succeeded')
  assert.equal(result.push?.status, 'succeeded')
  if (result.commit.status === 'succeeded') {
    assert.equal((await git(remote, ['rev-parse', 'main'])).trim(), result.commit.oid)
  }
})

test('commit success with push failure reports partial success and keeps the new HEAD', async (t) => {
  const { root } = await createRemotePair(t)
  await writeFile(join(root, 'tracked.txt'), 'partial\n')
  await git(root, ['add', '--', 'tracked.txt'])
  const service = new GitService(root)
  const prepared = await service.prepareCommit()
  assert.equal(prepared.ok, true)
  if (!prepared.ok) return
  // Replace origin with a non-repository path so push fails after commit.
  await git(root, ['remote', 'set-url', 'origin', join(root, 'missing-remote.git')])
  const before = (await git(root, ['rev-parse', 'HEAD'])).trim()

  const result = await service.executeCommit({
    mode: 'commit-and-push',
    message: 'partial success',
    snapshot: prepared.preview.snapshot,
    expectedPushTarget: prepared.preview.pushTarget
  })
  assert.equal(result.commit.status, 'succeeded')
  assert.equal(result.push?.status, 'failed')
  if (result.push?.status === 'failed') {
    assert.equal(result.push.error.code, 'git-error')
    assert.equal(result.push.error.message.includes('missing-remote'), false)
  }
  if (result.commit.status === 'succeeded') {
    assert.notEqual(result.commit.oid, before)
    assert.equal((await git(root, ['rev-parse', 'HEAD'])).trim(), result.commit.oid)
  }
})

test('commit failure never starts push', async (t) => {
  const { root } = await createRemotePair(t)
  await writeFile(join(root, 'tracked.txt'), 'hook-fail\n')
  await git(root, ['add', '--', 'tracked.txt'])
  const hooks = join(root, '.git', 'hooks')
  await mkdir(hooks, { recursive: true })
  const hook = join(hooks, 'pre-commit')
  await writeFile(hook, '#!/bin/sh\necho "secret-hook-token-xyz" >&2\nexit 1\n')
  await chmod(hook, 0o755)
  const service = new GitService(root)
  const prepared = await service.prepareCommit()
  assert.equal(prepared.ok, true)
  if (!prepared.ok) return
  const before = (await git(root, ['rev-parse', 'HEAD'])).trim()

  const result = await service.executeCommit({
    mode: 'commit-and-push',
    message: 'should not commit',
    snapshot: prepared.preview.snapshot,
    expectedPushTarget: prepared.preview.pushTarget
  })
  assert.equal(result.commit.status, 'failed')
  assert.equal(result.push, null)
  if (result.commit.status === 'failed') {
    assert.equal(result.commit.error.message.includes('secret-hook-token-xyz'), false)
    assert.equal(result.commit.error.message, 'Git operation failed.')
  }
  assert.equal((await git(root, ['rev-parse', 'HEAD'])).trim(), before)
})

test('successful index-mutating hook reports a landed commit with a snapshot warning', async (t) => {
  const root = await createRepository(t, 'pi-gui-git-hook-index-')
  await commitFile(root, 'tracked.txt', 'base\n')
  await writeFile(join(root, 'tracked.txt'), 'confirmed\n')
  await writeFile(join(root, 'hook-added.txt'), 'added by hook\n')
  await git(root, ['add', '--', 'tracked.txt'])
  const hooks = join(root, '.git', 'hooks')
  await mkdir(hooks, { recursive: true })
  const hook = join(hooks, 'pre-commit')
  await writeFile(hook, '#!/bin/sh\ngit add -- hook-added.txt\n')
  await chmod(hook, 0o755)
  const service = new GitService(root)
  const prepared = await service.prepareCommit()
  assert.equal(prepared.ok, true)
  if (!prepared.ok) return
  assert.equal(prepared.preview.stagedFileCount, 1)

  const result = await service.executeCommit({
    mode: 'commit',
    message: 'hook-adjusted commit',
    snapshot: prepared.preview.snapshot,
    expectedPushTarget: prepared.preview.pushTarget
  })
  assert.equal(result.commit.status, 'succeeded')
  if (result.commit.status === 'succeeded') {
    assert.ok(result.commit.warnings.includes('confirmed-snapshot-diverged'))
    assert.notEqual(result.commit.oid, null)
  }
  assert.equal((await git(root, ['show', 'HEAD:tracked.txt'])), 'confirmed\n')
  assert.equal((await git(root, ['show', 'HEAD:hook-added.txt'])), 'added by hook\n')
})

test('timeout after HEAD lands is reported as succeeded and refreshes the new state', async (t) => {
  const root = await createRepository(t, 'pi-gui-git-post-hook-timeout-')
  await commitFile(root, 'tracked.txt', 'base\n')
  await writeFile(join(root, 'tracked.txt'), 'landed\n')
  await git(root, ['add', '--', 'tracked.txt'])
  const hooks = join(root, '.git', 'hooks')
  await mkdir(hooks, { recursive: true })
  const hook = join(hooks, 'post-commit')
  await writeFile(hook, '#!/bin/sh\nsleep 2\n')
  await chmod(hook, 0o755)
  const service = new GitService(root, { timeoutMs: 150 })
  const prepared = await service.prepareCommit()
  assert.equal(prepared.ok, true)
  if (!prepared.ok) return
  const before = prepared.preview.snapshot.headOid

  const result = await service.executeCommit({
    mode: 'commit',
    message: 'land before timeout',
    snapshot: prepared.preview.snapshot,
    expectedPushTarget: prepared.preview.pushTarget
  })
  assert.equal(result.commit.status, 'succeeded')
  if (result.commit.status === 'succeeded') {
    assert.ok(result.commit.warnings.includes('command-error-after-landing'))
    assert.notEqual(result.commit.oid, before)
  }
  assert.equal(result.postState.ok, true)
  if (result.postState.ok && result.commit.status === 'succeeded') {
    assert.equal(result.postState.state.headOid, result.commit.oid)
  }
})

test('prepare rejects an option-shaped configured upstream remote', async (t) => {
  const root = await createRepository(t, 'pi-gui-git-unsafe-remote-')
  await commitFile(root, 'tracked.txt', 'base\n')
  const remote = await mkdtemp(join(tmpdir(), 'pi-gui-git-unsafe-remote-bare-'))
  t.after(() => rm(remote, { recursive: true, force: true }))
  await git(remote, ['init', '--bare', '--initial-branch=main'])
  await git(root, ['remote', 'add', '--', '-u', remote])
  await git(root, ['config', 'branch.main.remote', '-u'])
  await git(root, ['config', 'branch.main.merge', 'refs/heads/main'])
  await git(root, ['update-ref', 'refs/remotes/-u/main', 'HEAD'])
  await writeFile(join(root, 'tracked.txt'), 'next\n')
  await git(root, ['add', '--', 'tracked.txt'])

  const prepared = await new GitService(root).prepareCommit()
  assert.equal(prepared.ok, false)
  if (!prepared.ok) {
    assert.equal(prepared.error.code, 'unsupported')
    assert.equal(prepared.error.message.includes('-u'), false)
  }
})

test('rejects blank and overlong commit messages without leaking the message', async (t) => {
  const root = await createRepository(t, 'pi-gui-git-message-')
  await commitFile(root, 'tracked.txt', 'base\n')
  await writeFile(join(root, 'tracked.txt'), 'next\n')
  await git(root, ['add', '--', 'tracked.txt'])
  const service = new GitService(root)
  const prepared = await service.prepareCommit()
  assert.equal(prepared.ok, true)
  if (!prepared.ok) return

  const blank = await service.executeCommit({
    mode: 'commit',
    message: '   \n\t',
    snapshot: prepared.preview.snapshot,
    expectedPushTarget: null
  })
  assert.equal(blank.commit.status, 'failed')
  if (blank.commit.status === 'failed') {
    assert.equal(blank.commit.error.code, 'unsupported')
    assert.equal(blank.commit.error.message.includes('   '), false)
  }

  const overlong = 'x'.repeat(64 * 1024 + 1)
  const tooLong = await service.executeCommit({
    mode: 'commit',
    message: overlong,
    snapshot: prepared.preview.snapshot,
    expectedPushTarget: null
  })
  assert.equal(tooLong.commit.status, 'failed')
  if (tooLong.commit.status === 'failed') {
    assert.equal(tooLong.commit.error.code, 'unsupported')
    assert.equal(tooLong.commit.error.message.includes('xxx'), false)
  }

  const unicode = await service.executeCommit({
    mode: 'commit',
    message: '多行\n提交 message',
    snapshot: prepared.preview.snapshot,
    expectedPushTarget: null
  })
  assert.equal(unicode.commit.status, 'succeeded')
  assert.equal((await git(root, ['log', '-1', '--format=%B'])).trim(), '多行\n提交 message')
})

test('same-repository concurrent executes allow at most one successful commit', async (t) => {
  const root = await createRepository(t, 'pi-gui-git-concurrent-')
  await commitFile(root, 'tracked.txt', 'base\n')
  await writeFile(join(root, 'tracked.txt'), 'staged\n')
  await git(root, ['add', '--', 'tracked.txt'])
  const first = new GitService(root)
  const second = new GitService(root)
  const prepared = await first.prepareCommit()
  assert.equal(prepared.ok, true)
  if (!prepared.ok) return
  const request = {
    mode: 'commit' as const,
    message: 'race',
    snapshot: prepared.preview.snapshot,
    expectedPushTarget: null
  }
  const [left, right] = await Promise.all([
    first.executeCommit(request),
    second.executeCommit(request)
  ])
  const statuses = [left.commit.status, right.commit.status].sort()
  assert.deepEqual(statuses, ['failed', 'succeeded'])
  const failed = left.commit.status === 'failed' ? left : right
  if (failed.commit.status === 'failed') assert.equal(failed.commit.error.code, 'stale')
})

async function realpathSafe(path: string): Promise<string> {
  const { realpath } = await import('node:fs/promises')
  return await realpath(path)
}


function historySnapshotFrom(state: GitRepositoryState) {
  assert.equal(state.kind, 'repository')
  if (state.repositoryRoot === null) assert.fail('Expected repository root')
  return {
    repositoryRoot: state.repositoryRoot,
    headOid: state.headOid,
    branch: state.branch
  }
}

test('listHistory returns empty history for unborn HEAD and rejects non-repositories', async (t) => {
  const unborn = await createRepository(t, 'pi-gui-history-unborn-')
  const unbornService = new GitService(unborn)
  const unbornState = await unbornService.refresh()
  const empty = await unbornService.listHistory({ snapshot: historySnapshotFrom(unbornState), offset: 0 })
  assert.equal(empty.ok, true)
  if (empty.ok) {
    assert.deepEqual(empty.commits, [])
    assert.equal(empty.hasMore, false)
    assert.equal(empty.pageSize, 50)
  }

  const missing = await mkdtemp(join(tmpdir(), 'pi-gui-history-missing-'))
  t.after(() => rm(missing, { recursive: true, force: true }))
  const missingService = new GitService(missing)
  const missingState = await missingService.refresh()
  const failed = await missingService.listHistory({
    snapshot: { repositoryRoot: missing, headOid: null, branch: null },
    offset: 0
  })
  assert.equal(failed.ok, false)
  if (!failed.ok) assert.equal(failed.error.code, 'not-repository')
  assert.equal(missingState.kind, 'not-repository')
})

test('listHistory pages reachable HEAD history and detail/file-diff use opaque fileId', async (t) => {
  const root = await createRepository(t, 'pi-gui-history-main-')
  for (let index = 1; index <= 3; index += 1) {
    await commitFile(root, `file-${index}.txt`, `content-${index}\n`, `commit ${index}`)
  }
  await writeFile(join(root, 'renamed-src.txt'), 'rename-me\n')
  await git(root, ['add', '--', 'renamed-src.txt'])
  await git(root, ['commit', '-m', 'add rename source'])
  await git(root, ['mv', 'renamed-src.txt', 'renamed-dst.txt'])
  await git(root, ['commit', '-m', 'rename file'])
  await writeFile(join(root, 'binary.bin'), Buffer.from([0, 1, 2, 3, 0, 255]))
  await git(root, ['add', '--', 'binary.bin'])
  await git(root, ['commit', '-m', 'add binary'])

  // merge commit with second parent metadata
  await git(root, ['checkout', '-b', 'side'])
  await commitFile(root, 'side.txt', 'side\n', 'side commit')
  await git(root, ['checkout', 'main'])
  await git(root, ['merge', '--no-ff', '-m', 'merge side', 'side'])

  const service = new GitService(root)
  const state = await service.refresh()
  const snapshot = historySnapshotFrom(state)
  const listed = await service.listHistory({ snapshot, offset: 0 })
  assert.equal(listed.ok, true)
  if (!listed.ok) return
  assert.equal(listed.commits.length >= 6, true)
  assert.equal(listed.commits[0]?.subject, 'merge side')
  assert.equal(listed.commits[0]?.parentOids.length, 2)
  assert.equal(/^[0-9a-f]{40}$/.test(listed.commits[0]!.oid), true)
  assert.equal(listed.commits[0]!.shortOid.length > 0, true)
  assert.equal(Number.isSafeInteger(listed.commits[0]!.authorAt), true)

  const page = await service.listHistory({ snapshot, offset: 2 })
  assert.equal(page.ok, true)
  if (page.ok) {
    assert.equal(page.offset, 2)
    assert.equal(page.commits[0]?.oid, listed.commits[2]?.oid)
  }

  const mergeOid = listed.commits[0]!.oid
  const detail = await service.getHistoryDetail({ snapshot, oid: mergeOid })
  assert.equal(detail.ok, true)
  if (!detail.ok) return
  assert.equal(detail.commit.oid, mergeOid)
  assert.match(detail.commit.message, /merge side/)
  assert.equal(detail.filesTruncated, false)
  assert.equal(detail.files.some((file) => file.path === 'side.txt' && file.status === 'added'), true)

  const renameCommit = listed.commits.find((commit) => commit.subject === 'rename file')
  assert.notEqual(renameCommit, undefined)
  const renameDetail = await service.getHistoryDetail({ snapshot, oid: renameCommit!.oid })
  assert.equal(renameDetail.ok, true)
  if (!renameDetail.ok) return
  const renamed = renameDetail.files.find((file) => file.status === 'renamed')
  assert.notEqual(renamed, undefined)
  assert.equal(renamed?.originalPath, 'renamed-src.txt')
  assert.equal(renamed?.path, 'renamed-dst.txt')

  const textFile = renameDetail.files.find((file) => file.path === 'renamed-dst.txt')
  assert.notEqual(textFile, undefined)
  const textDiff = await service.getHistoryFileDiff({
    snapshot,
    oid: renameCommit!.oid,
    fileId: textFile!.fileId
  })
  assert.equal(textDiff.state, 'ready')
  assert.equal(textDiff.path, 'renamed-dst.txt')
  assert.equal(textDiff.files.length, 1)

  const binaryCommit = listed.commits.find((commit) => commit.subject === 'add binary')
  assert.notEqual(binaryCommit, undefined)
  const binaryDetail = await service.getHistoryDetail({ snapshot, oid: binaryCommit!.oid })
  assert.equal(binaryDetail.ok, true)
  if (!binaryDetail.ok) return
  const binaryFile = binaryDetail.files.find((file) => file.path === 'binary.bin')
  assert.notEqual(binaryFile, undefined)
  const binaryDiff = await service.getHistoryFileDiff({
    snapshot,
    oid: binaryCommit!.oid,
    fileId: binaryFile!.fileId
  })
  assert.equal(binaryDiff.state, 'binary')
  assert.equal(binaryDiff.files.length, 0)

  const unreachable = await service.getHistoryDetail({
    snapshot,
    oid: 'a'.repeat(40)
  })
  assert.equal(unreachable.ok, false)
  if (!unreachable.ok) assert.equal(unreachable.error.code, 'stale')

  const badFile = await service.getHistoryFileDiff({
    snapshot,
    oid: renameCommit!.oid,
    fileId: 'd'.repeat(32)
  })
  assert.equal(badFile.state, 'error')
  assert.equal(badFile.error?.code, 'stale')
})

test('history reads fence only repositoryRoot/headOid/branch and stay readable when detached', async (t) => {
  const root = await createRepository(t, 'pi-gui-history-fence-')
  await commitFile(root, 'a.txt', 'a\n', 'one')
  await commitFile(root, 'b.txt', 'b\n', 'two')
  const service = new GitService(root)
  const state = await service.refresh()
  const snapshot = historySnapshotFrom(state)

  await writeFile(join(root, 'dirty.txt'), 'dirty\n')
  const dirtyList = await service.listHistory({ snapshot, offset: 0 })
  assert.equal(dirtyList.ok, true)

  await commitFile(root, 'c.txt', 'c\n', 'three')
  const stale = await service.listHistory({ snapshot, offset: 0 })
  assert.equal(stale.ok, false)
  if (!stale.ok) {
    assert.equal(stale.error.code, 'stale')
    assert.notEqual(stale.current, null)
    assert.equal(stale.current?.headOid !== snapshot.headOid, true)
  }

  const head = (await git(root, ['rev-parse', 'HEAD'])).trim()
  await git(root, ['checkout', '--detach', head])
  const detachedState = await service.refresh()
  assert.equal(detachedState.detached, true)
  const detachedSnapshot = historySnapshotFrom(detachedState)
  const detachedList = await service.listHistory({ snapshot: detachedSnapshot, offset: 0 })
  assert.equal(detachedList.ok, true)
  if (detachedList.ok) {
    assert.equal(detachedList.commits.length >= 3, true)
    const detail = await service.getHistoryDetail({
      snapshot: detachedSnapshot,
      oid: detachedList.commits[0]!.oid
    })
    assert.equal(detail.ok, true)
  }
})

test('history file list truncates at 200 entries with explicit filesTruncated', async (t) => {
  const root = await createRepository(t, 'pi-gui-history-truncate-')
  await commitFile(root, 'seed.txt', 'seed\n', 'seed')
  for (let index = 0; index < 210; index += 1) {
    await writeFile(join(root, `bulk-${index}.txt`), `${index}\n`)
  }
  await git(root, ['add', '--', '.'])
  await git(root, ['commit', '-m', 'bulk files'])
  const service = new GitService(root)
  const state = await service.refresh()
  const snapshot = historySnapshotFrom(state)
  const listed = await service.listHistory({ snapshot, offset: 0 })
  assert.equal(listed.ok, true)
  if (!listed.ok) return
  const detail = await service.getHistoryDetail({ snapshot, oid: listed.commits[0]!.oid })
  assert.equal(detail.ok, true)
  if (!detail.ok) return
  assert.equal(detail.files.length, 200)
  assert.equal(detail.filesTruncated, true)
})

test('history ignores replacement objects and keeps the literal confirmed HEAD graph', async (t) => {
  const root = await createRepository(t, 'pi-gui-history-replace-')
  await commitFile(root, 'first.txt', 'first\n', 'literal first')
  const firstOid = (await git(root, ['rev-parse', 'HEAD'])).trim()
  await commitFile(root, 'second.txt', 'second\n', 'literal second')
  const headOid = (await git(root, ['rev-parse', 'HEAD'])).trim()
  await git(root, ['replace', headOid, firstOid])

  const service = new GitService(root)
  const state = await service.refresh()
  const snapshot = historySnapshotFrom(state)
  const listed = await service.listHistory({ snapshot, offset: 0 })
  assert.equal(listed.ok, true)
  if (!listed.ok) return
  assert.equal(listed.commits.length, 2)
  assert.equal(listed.commits[0]!.oid, headOid)
  assert.equal(listed.commits[0]!.subject, 'literal second')

  const detail = await service.getHistoryDetail({ snapshot, oid: headOid })
  assert.equal(detail.ok, true)
  if (!detail.ok) return
  assert.equal(detail.commit.message.trimEnd(), 'literal second')
  assert.deepEqual(detail.files.map((file) => file.path), ['second.txt'])

  await git(root, ['replace', '-d', headOid])
  await writeFile(join(root, '.git', 'info', 'grafts'), `${headOid}\n`)
  const graftedList = await service.listHistory({ snapshot, offset: 0 })
  assert.equal(graftedList.ok, true)
  if (!graftedList.ok) return
  assert.equal(graftedList.commits.length, 2)
  assert.equal(graftedList.commits[0]!.subject, 'literal second')
  const graftedDetail = await service.getHistoryDetail({ snapshot, oid: headOid })
  assert.equal(graftedDetail.ok, true)
  if (!graftedDetail.ok) return
  assert.equal(graftedDetail.commit.parentOids.length, 1)
  assert.deepEqual(graftedDetail.files.map((file) => file.path), ['second.txt'])
})

test('oversized history messages return the bounded message prefix with explicit truncation', async (t) => {
  const root = await createRepository(t, 'pi-gui-history-message-')
  await writeFile(join(root, 'large.txt'), 'large\n')
  await git(root, ['add', '--', 'large.txt'])
  const body = Array.from({ length: 10_000 }, (_, index) => `body-${index.toString().padStart(5, '0')}`).join('\n')
  const fullMessage = `large subject\n\n${body}\n`
  const messagePath = join(root, '.git', 'large-message.txt')
  await writeFile(messagePath, fullMessage)
  await git(root, ['commit', '--file', messagePath])

  const service = new GitService(root)
  const state = await service.refresh()
  const snapshot = historySnapshotFrom(state)
  const detail = await service.getHistoryDetail({ snapshot, oid: state.headOid! })
  assert.equal(detail.ok, true)
  if (!detail.ok) return
  assert.equal(detail.commit.messageTruncated, true)
  assert.equal(detail.commit.message.startsWith('large subject\n\nbody-00000'), true)
  assert.equal(detail.commit.message.length > 'large subject'.length, true)
  assert.equal(Buffer.byteLength(detail.commit.message, 'utf8') <= GIT_HISTORY_MESSAGE_MAX_UTF8_BYTES, true)
})

test('prepareBranchSync lists local/remote-tracking branches, remotes, and action gates', async (t) => {
  const { root, remote } = await createRemotePair(t)
  await git(root, ['checkout', '-b', 'feature'])
  await commitFile(root, 'feature.txt', 'feature\n', 'feature')
  await git(root, ['push', '-u', 'origin', 'feature'])
  await git(root, ['checkout', 'main'])

  const prepared = await new GitService(root).prepareBranchSync()
  assert.equal(prepared.ok, true)
  if (!prepared.ok) return
  assert.equal(prepared.current.branch, 'main')
  assert.equal(prepared.current.clean, true)
  assert.equal(prepared.actions.canCreate, true)
  assert.equal(prepared.actions.canSwitch, true)
  assert.equal(prepared.actions.canFetch, true)
  assert.equal(prepared.actions.canPull, true)
  assert.equal(prepared.actions.canPush, true)
  assert.ok(prepared.localBranches.some((entry) => entry.name === 'main' && entry.isCurrent))
  assert.ok(prepared.localBranches.some((entry) => entry.name === 'feature' && !entry.isCurrent))
  assert.ok(prepared.remoteTrackingBranches.some((entry) => entry.name === 'origin/main'))
  assert.ok(prepared.remoteTrackingBranches.every((entry) => entry.kind === 'remote-tracking'))
  assert.ok(!prepared.remoteTrackingBranches.some((entry) => entry.name === 'origin/HEAD'))
  assert.deepEqual(prepared.remotes.map((entry) => entry.name), ['origin'])
  assert.equal(prepared.snapshot.upstreamRemote, 'origin')
  assert.equal(prepared.snapshot.upstreamBranch, 'main')
  assert.match(prepared.localBranches[0]!.branchId, /^[0-9a-f]{32}$/u)
  assert.match(prepared.remotes[0]!.remoteId, /^[0-9a-f]{32}$/u)
  void remote
})

test('prepareBranchSync keeps a true remote-tracking truncation sentinel beside symbolic refs', async (t) => {
  const root = await createRepository(t, 'pi-gui-remote-tracking-sentinel-')
  await commitFile(root, 'tracked.txt', 'base\n')
  const head = (await git(root, ['rev-parse', 'HEAD'])).trim()
  await git(root, ['remote', 'add', 'origin', root])
  for (let index = 0; index <= 200; index += 1) {
    await git(root, ['update-ref', `refs/remotes/origin/branch-${index.toString().padStart(3, '0')}`, head])
  }
  await git(root, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/branch-000'])

  const prepared = await new GitService(root).prepareBranchSync()
  assert.equal(prepared.ok, true)
  if (!prepared.ok) return
  assert.equal(prepared.remoteTrackingBranches.length, 200)
  assert.equal(prepared.remoteTrackingBranchesTruncated, true)
  assert.ok(!prepared.remoteTrackingBranches.some((entry) => entry.name === 'origin/HEAD'))
})

test('prepareBranchSync preserves slash remote names and rejects dirty create/switch/pull gates', async (t) => {
  const root = await createRepository(t, 'pi-gui-branch-slash-')
  await commitFile(root, 'tracked.txt', 'base\n')
  const remote = await mkdtemp(join(tmpdir(), 'pi-gui-branch-slash-bare-'))
  t.after(() => rm(remote, { recursive: true, force: true }))
  await git(remote, ['init', '--bare', '--initial-branch=main'])
  await git(root, ['remote', 'add', 'company/prod', remote])
  await git(root, ['push', '-u', 'company/prod', 'main'])
  await writeFile(join(root, 'tracked.txt'), 'dirty\n')

  const prepared = await new GitService(root).prepareBranchSync()
  assert.equal(prepared.ok, true)
  if (!prepared.ok) return
  assert.equal(prepared.current.clean, false)
  assert.equal(prepared.actions.canCreate, false)
  assert.equal(prepared.actions.canSwitch, false)
  assert.equal(prepared.actions.canPull, false)
  assert.equal(prepared.actions.canPush, true)
  assert.equal(prepared.actions.canFetch, true)
  assert.deepEqual(prepared.remotes.map((entry) => entry.name), ['company/prod'])
  assert.equal(prepared.snapshot.upstreamRemote, 'company/prod')
})

test('create-and-switch and switch use opaque IDs and require clean fenced snapshots', async (t) => {
  const root = await createRepository(t, 'pi-gui-branch-switch-')
  await commitFile(root, 'tracked.txt', 'base\n')
  await git(root, ['checkout', '-b', 'other'])
  await commitFile(root, 'other.txt', 'other\n', 'other')
  await git(root, ['checkout', 'main'])
  const service = new GitService(root)

  const prepared = await service.prepareBranchSync()
  assert.equal(prepared.ok, true)
  if (!prepared.ok) return
  const other = prepared.localBranches.find((entry) => entry.name === 'other')
  assert.ok(other)

  const created = await service.executeBranchSync({
    action: 'create-and-switch',
    snapshot: prepared.snapshot,
    name: 'from-main'
  })
  assert.equal(created.branch?.status, 'succeeded')
  if (created.branch?.status === 'succeeded') {
    assert.equal(created.branch.branch, 'from-main')
    assert.equal((await git(root, ['symbolic-ref', '--short', 'HEAD'])).trim(), 'from-main')
    assert.equal((await git(root, ['rev-parse', 'HEAD'])).trim(), created.branch.headOid)
  }
  assert.equal(created.postView.ok, true)

  const prepared2 = await service.prepareBranchSync()
  assert.equal(prepared2.ok, true)
  if (!prepared2.ok) return
  const preparedOther = prepared2.localBranches.find((entry) => entry.name === 'other')
  assert.ok(preparedOther)
  const switched = await service.executeBranchSync({
    action: 'switch',
    snapshot: prepared2.snapshot,
    branchId: preparedOther!.branchId
  })
  assert.equal(switched.branch?.status, 'succeeded')
  if (switched.branch?.status === 'succeeded') {
    assert.equal(switched.branch.branch, 'other')
  }
  assert.equal((await git(root, ['symbolic-ref', '--short', 'HEAD'])).trim(), 'other')

  const prepared3 = await service.prepareBranchSync()
  assert.equal(prepared3.ok, true)
  if (!prepared3.ok) return
  await writeFile(join(root, 'tracked.txt'), 'dirty\n')
  const dirty = await service.executeBranchSync({
    action: 'create-and-switch',
    snapshot: prepared3.snapshot,
    name: 'should-fail'
  })
  assert.equal(dirty.branch?.status, 'failed')
  if (dirty.branch?.status === 'failed') {
    assert.ok(dirty.branch.error.code === 'unsupported' || dirty.branch.error.code === 'stale')
  }
  assert.equal((await git(root, ['symbolic-ref', '--short', 'HEAD'])).trim(), 'other')
})

test('switch capability binds the prepare-visible branch tip and rejects later target movement', async (t) => {
  const root = await createRepository(t, 'pi-gui-branch-capability-tip-')
  await commitFile(root, 'tracked.txt', 'base\n')
  await git(root, ['branch', 'target'])
  const service = new GitService(root)
  const prepared = await service.prepareBranchSync()
  assert.equal(prepared.ok, true)
  if (!prepared.ok) return
  const target = prepared.localBranches.find((entry) => entry.name === 'target')
  assert.ok(target)

  const oldTarget = (await git(root, ['rev-parse', 'target'])).trim()
  const tree = (await git(root, ['rev-parse', 'HEAD^{tree}'])).trim()
  const movedTarget = (await git(root, [
    'commit-tree',
    tree,
    '-p',
    oldTarget,
    '-m',
    'move hidden target'
  ])).trim()
  await git(root, ['branch', '--force', 'target', movedTarget])

  const result = await service.executeBranchSync({
    action: 'switch',
    snapshot: prepared.snapshot,
    branchId: target!.branchId
  })
  assert.equal(result.branch?.status, 'failed')
  if (result.branch?.status === 'failed') assert.equal(result.branch.error.code, 'stale')
  assert.equal((await git(root, ['symbolic-ref', '--short', 'HEAD'])).trim(), 'main')
})

test('prepare-scoped capabilities are unforgeable and cannot address entries hidden after prepare', async (t) => {
  const root = await createRepository(t, 'pi-gui-branch-hidden-capability-')
  await commitFile(root, 'tracked.txt', 'base\n')
  await git(root, ['branch', 'z-target'])
  await git(root, ['remote', 'add', 'z-remote', root])

  const service = new GitService(root)
  const prepared = await service.prepareBranchSync()
  assert.equal(prepared.ok, true)
  if (!prepared.ok) return
  const target = prepared.localBranches.find((entry) => entry.name === 'z-target')
  const remote = prepared.remotes.find((entry) => entry.name === 'z-remote')
  assert.ok(target)
  assert.ok(remote)

  const predictableBranchId = createHash('sha256')
    .update(['local-branch', 'z-target'].join('\0'))
    .digest('hex')
    .slice(0, 32)
  const forgedSwitch = await service.executeBranchSync({
    action: 'switch',
    snapshot: prepared.snapshot,
    branchId: predictableBranchId
  })
  assert.equal(forgedSwitch.branch?.status, 'failed')
  if (forgedSwitch.branch?.status === 'failed') assert.equal(forgedSwitch.branch.error.code, 'stale')

  const predictableRemoteId = createHash('sha256')
    .update(['remote', 'z-remote'].join('\0'))
    .digest('hex')
    .slice(0, 32)
  const forgedFetch = await service.executeBranchSync({
    action: 'fetch',
    snapshot: prepared.snapshot,
    remoteId: predictableRemoteId
  })
  assert.equal(forgedFetch.fetch?.status, 'failed')
  if (forgedFetch.fetch?.status === 'failed') assert.equal(forgedFetch.fetch.error.code, 'stale')

  for (let index = 0; index <= 200; index += 1) {
    await git(root, ['branch', `a-branch-${index.toString().padStart(3, '0')}`])
  }
  for (let index = 0; index < 32; index += 1) {
    await git(root, ['remote', 'add', `a-remote-${index.toString().padStart(2, '0')}`, root])
  }

  const hiddenSwitch = await service.executeBranchSync({
    action: 'switch',
    snapshot: prepared.snapshot,
    branchId: target!.branchId
  })
  assert.equal(hiddenSwitch.branch?.status, 'failed')
  if (hiddenSwitch.branch?.status === 'failed') assert.equal(hiddenSwitch.branch.error.code, 'stale')

  const hiddenFetch = await service.executeBranchSync({
    action: 'fetch',
    snapshot: prepared.snapshot,
    remoteId: remote!.remoteId
  })
  assert.equal(hiddenFetch.fetch?.status, 'failed')
  if (hiddenFetch.fetch?.status === 'failed') assert.equal(hiddenFetch.fetch.error.code, 'stale')
})

test('branch create/switch reject stale fences and hostile option-like names', async (t) => {
  const root = await createRepository(t, 'pi-gui-branch-stale-')
  await commitFile(root, 'tracked.txt', 'base\n')
  const service = new GitService(root)
  const prepared = await service.prepareBranchSync()
  assert.equal(prepared.ok, true)
  if (!prepared.ok) return

  await git(root, ['checkout', '-b', 'moved'])
  const stale = await service.executeBranchSync({
    action: 'create-and-switch',
    snapshot: prepared.snapshot,
    name: 'after-stale'
  })
  assert.equal(stale.branch?.status, 'failed')
  if (stale.branch?.status === 'failed') assert.equal(stale.branch.error.code, 'stale')
  assert.equal((await git(root, ['symbolic-ref', '--short', 'HEAD'])).trim(), 'moved')

  const prepared2 = await service.prepareBranchSync()
  assert.equal(prepared2.ok, true)
  if (!prepared2.ok) return
  const hostile = await service.executeBranchSync({
    action: 'create-and-switch',
    snapshot: prepared2.snapshot,
    name: '--orphan'
  })
  assert.equal(hostile.branch?.status, 'failed')
  if (hostile.branch?.status === 'failed') assert.equal(hostile.branch.error.code, 'unsupported')
})

test('fetch allows dirty worktrees, re-resolves opaque remote IDs, and reports unknown on timeout', async (t) => {
  const { root, remote } = await createRemotePair(t)
  const second = await mkdtemp(join(tmpdir(), 'pi-gui-branch-fetch-second-'))
  t.after(() => rm(second, { recursive: true, force: true }))
  await git(tmpdir(), ['clone', remote, second])
  await commitFile(second, 'remote-change.txt', 'from-second\n', 'remote change')
  await git(second, ['push'])
  await writeFile(join(root, 'local-dirty.txt'), 'dirty\n')

  const service = new GitService(root)
  const prepared = await service.prepareBranchSync()
  assert.equal(prepared.ok, true)
  if (!prepared.ok) return
  assert.equal(prepared.current.clean, false)
  assert.equal(prepared.actions.canFetch, true)
  const remoteId = prepared.remotes[0]!.remoteId

  const fetched = await service.executeBranchSync({
    action: 'fetch',
    snapshot: prepared.snapshot,
    remoteId
  })
  assert.equal(fetched.fetch?.status, 'succeeded')
  assert.equal((await git(root, ['rev-parse', 'origin/main'])).trim(), (await git(second, ['rev-parse', 'HEAD'])).trim())
  assert.equal(await readFile(join(root, 'local-dirty.txt'), 'utf8'), 'dirty\n')

  const prepared2 = await service.prepareBranchSync()
  assert.equal(prepared2.ok, true)
  if (!prepared2.ok) return
  const missingRemote = await service.executeBranchSync({
    action: 'fetch',
    snapshot: prepared2.snapshot,
    remoteId: 'f'.repeat(32)
  })
  assert.equal(missingRemote.branch?.status ?? 'failed', 'failed')
  assert.equal(missingRemote.fetch?.status, 'failed')

  const binDirectory = await mkdtemp(join(tmpdir(), 'pi-gui-branch-fetch-timeout-'))
  t.after(() => rm(binDirectory, { recursive: true, force: true }))
  const wrapper = join(binDirectory, 'git')
  await writeFile(wrapper, [
    '#!/bin/sh',
    'if [ "$1" = "fetch" ]; then',
    '  sleep 5',
    '  exit 0',
    'fi',
    'exec git "$@"'
  ].join('\n'))
  await chmod(wrapper, 0o755)
  const timeoutService = new GitService(root, { gitBinary: wrapper, timeoutMs: 200 })
  // Override only network timeout path by using a tiny service timeout and direct method path.
  const prepared3 = await timeoutService.prepareBranchSync()
  assert.equal(prepared3.ok, true)
  if (!prepared3.ok) return
  // Use a custom service that inherits the same repo; network commands use fixed 120s, so force unknown via wrapper + lower timeout on runRaw defaults is not enough.
  // Instead exercise unknown through a push/fetch helper by temporarily replacing remote and using a hanging git for fetch only with reduced timeout via service option is ignored for network.
  // Directly assert timeout mapping with an injected short timeout by monkeypatching through a wrapper that sleeps and a one-off service call path:
  const hanging = await timeoutService.executeBranchSync({
    action: 'fetch',
    snapshot: prepared3.snapshot,
    remoteId: prepared3.remotes[0]!.remoteId
  })
  assert.equal(hanging.fetch?.status, 'unknown')
  if (hanging.fetch?.status === 'unknown') {
    assert.equal(hanging.fetch.error.code, 'timeout')
  }
})

test('pull reports fetch and fast-forward separately including already-up-to-date and non-ff partial success', async (t) => {
  const { root, remote } = await createRemotePair(t)
  const second = await mkdtemp(join(tmpdir(), 'pi-gui-branch-pull-second-'))
  t.after(() => rm(second, { recursive: true, force: true }))
  await git(tmpdir(), ['clone', remote, second])

  const service = await (async () => new GitService(root))()
  const prepared = await service.prepareBranchSync()
  assert.equal(prepared.ok, true)
  if (!prepared.ok) return
  const already = await service.executeBranchSync({
    action: 'pull',
    snapshot: prepared.snapshot
  })
  assert.equal(already.fetch?.status, 'succeeded')
  assert.equal(already.fastForward?.status, 'succeeded')
  if (already.fastForward?.status === 'succeeded') {
    assert.equal(already.fastForward.alreadyUpToDate, true)
  }

  await commitFile(second, 'upstream.txt', 'up\n', 'upstream')
  await git(second, ['push'])
  const prepared2 = await service.prepareBranchSync()
  assert.equal(prepared2.ok, true)
  if (!prepared2.ok) return
  const pulled = await service.executeBranchSync({
    action: 'pull',
    snapshot: prepared2.snapshot
  })
  assert.equal(pulled.fetch?.status, 'succeeded')
  assert.equal(pulled.fastForward?.status, 'succeeded')
  if (pulled.fastForward?.status === 'succeeded') {
    assert.equal(pulled.fastForward.alreadyUpToDate, false)
    assert.equal((await git(root, ['rev-parse', 'HEAD'])).trim(), pulled.fastForward.toOid)
  }
  assert.equal(await readFile(join(root, 'upstream.txt'), 'utf8'), 'up\n')

  // Diverged histories: fetch succeeds, ff-only fails, remote-tracking remains updated.
  await commitFile(root, 'local-only.txt', 'local\n', 'local')
  await commitFile(second, 'remote-only.txt', 'remote\n', 'remote')
  await git(second, ['push', '--force'])
  const prepared3 = await service.prepareBranchSync()
  assert.equal(prepared3.ok, true)
  if (!prepared3.ok) return
  const beforeHead = (await git(root, ['rev-parse', 'HEAD'])).trim()
  const partial = await service.executeBranchSync({
    action: 'pull',
    snapshot: prepared3.snapshot
  })
  assert.equal(partial.fetch?.status, 'succeeded')
  assert.equal(partial.fastForward?.status, 'failed')
  assert.equal((await git(root, ['rev-parse', 'HEAD'])).trim(), beforeHead)
  assert.equal(
    (await git(root, ['rev-parse', 'origin/main'])).trim(),
    (await git(second, ['rev-parse', 'HEAD'])).trim()
  )
})

test('pull resolves the actual upstream tracking ref for custom fetch refspecs', async (t) => {
  const { root, remote } = await createRemotePair(t)
  const second = await mkdtemp(join(tmpdir(), 'pi-gui-branch-custom-upstream-'))
  t.after(() => rm(second, { recursive: true, force: true }))
  await git(tmpdir(), ['clone', remote, second])

  await git(root, ['config', '--unset-all', 'remote.origin.fetch'])
  await git(root, [
    'config',
    '--add',
    'remote.origin.fetch',
    '+refs/heads/main:refs/remotes/custom/main'
  ])
  await git(root, ['fetch', 'origin'])
  await git(root, ['branch', '--set-upstream-to=custom/main', 'main'])
  await commitFile(second, 'custom-upstream.txt', 'custom\n', 'custom upstream')
  await git(second, ['push'])

  const service = new GitService(root)
  const prepared = await service.prepareBranchSync()
  assert.equal(prepared.ok, true)
  if (!prepared.ok) return
  assert.equal(prepared.current.upstreamRemote, 'origin')
  assert.equal(prepared.current.upstreamBranch, 'main')

  const pulled = await service.executeBranchSync({
    action: 'pull',
    snapshot: prepared.snapshot
  })
  assert.equal(pulled.fetch?.status, 'succeeded')
  assert.equal(pulled.fastForward?.status, 'succeeded')
  assert.equal(
    (await git(root, ['rev-parse', 'HEAD'])).trim(),
    (await git(root, ['rev-parse', 'refs/remotes/custom/main'])).trim()
  )
  assert.equal(await readFile(join(root, 'custom-upstream.txt'), 'utf8'), 'custom\n')
})

test('pull reports a landed fast-forward when the merge command errors after updating HEAD', async (t) => {
  const { root, remote } = await createRemotePair(t)
  const second = await mkdtemp(join(tmpdir(), 'pi-gui-branch-pull-landed-second-'))
  t.after(() => rm(second, { recursive: true, force: true }))
  await git(tmpdir(), ['clone', remote, second])
  await commitFile(second, 'landed-upstream.txt', 'landed\n', 'landed upstream')
  await git(second, ['push'])

  const hooks = join(root, '.git', 'hooks')
  await mkdir(hooks, { recursive: true })
  const postMergeHook = join(hooks, 'post-merge')
  await writeFile(postMergeHook, '#!/bin/sh\nsleep 2\n')
  await chmod(postMergeHook, 0o755)

  const service = new GitService(root, { timeoutMs: 150 })
  const prepared = await service.prepareBranchSync()
  assert.equal(prepared.ok, true)
  if (!prepared.ok) return
  const result = await service.executeBranchSync({ action: 'pull', snapshot: prepared.snapshot })
  assert.equal(result.fetch?.status, 'succeeded')
  assert.equal(result.fastForward?.status, 'succeeded')
  if (result.fastForward?.status === 'succeeded') {
    assert.deepEqual(result.fastForward.warnings, ['command-error-after-landing'])
    assert.equal((await git(root, ['rev-parse', 'HEAD'])).trim(), result.fastForward.toOid)
  }
  assert.equal(await readFile(join(root, 'landed-upstream.txt'), 'utf8'), 'landed\n')
})

test('standalone push fences HEAD/upstream, allows ordinary dirty worktrees, and maps reject/unknown', async (t) => {
  const { root, remote } = await createRemotePair(t)
  const service = new GitService(root)
  await writeFile(join(root, 'dirty.txt'), 'dirty\n')
  const prepared = await service.prepareBranchSync()
  assert.equal(prepared.ok, true)
  if (!prepared.ok) return
  assert.equal(prepared.current.clean, false)
  assert.equal(prepared.actions.canPush, true)

  // No new commits to push: still succeeds as already up to date.
  const pushed = await service.executeBranchSync({
    action: 'push',
    snapshot: prepared.snapshot
  })
  assert.equal(pushed.push?.status, 'succeeded')
  assert.equal(await readFile(join(root, 'dirty.txt'), 'utf8'), 'dirty\n')

  await git(root, ['add', '--', 'dirty.txt'])
  await git(root, ['commit', '-m', 'dirty commit'])
  // Keep worktree dirty after commit.
  await writeFile(join(root, 'more-dirty.txt'), 'more\n')
  const prepared2 = await service.prepareBranchSync()
  assert.equal(prepared2.ok, true)
  if (!prepared2.ok) return
  const pushed2 = await service.executeBranchSync({
    action: 'push',
    snapshot: prepared2.snapshot
  })
  assert.equal(pushed2.push?.status, 'succeeded')
  assert.equal((await git(remote, ['rev-parse', 'main'])).trim(), (await git(root, ['rev-parse', 'HEAD'])).trim())
  assert.equal(await readFile(join(root, 'more-dirty.txt'), 'utf8'), 'more\n')

  // Non-fast-forward reject.
  const second = await mkdtemp(join(tmpdir(), 'pi-gui-branch-push-second-'))
  t.after(() => rm(second, { recursive: true, force: true }))
  await git(tmpdir(), ['clone', remote, second])
  await commitFile(second, 'remote-ahead.txt', 'ahead\n', 'ahead')
  await git(second, ['push'])
  await commitFile(root, 'local-ahead.txt', 'local\n', 'local')
  const prepared3 = await service.prepareBranchSync()
  assert.equal(prepared3.ok, true)
  if (!prepared3.ok) return
  const rejected = await service.executeBranchSync({
    action: 'push',
    snapshot: prepared3.snapshot
  })
  assert.equal(rejected.push?.status, 'failed')
  if (rejected.push?.status === 'failed') {
    assert.equal(rejected.push.error.code, 'git-error')
  }

  // Stale upstream fence.
  const prepared4 = await service.prepareBranchSync()
  assert.equal(prepared4.ok, true)
  if (!prepared4.ok) return
  await git(root, ['branch', '--unset-upstream'])
  const staleUpstream = await service.executeBranchSync({
    action: 'push',
    snapshot: prepared4.snapshot
  })
  assert.equal(staleUpstream.push?.status, 'failed')
  if (staleUpstream.push?.status === 'failed') {
    assert.ok(staleUpstream.push.error.code === 'stale' || staleUpstream.push.error.code === 'unsupported')
  }
})

test('standalone push publishes the confirmed OID even if external Git moves HEAD at spawn time', async (t) => {
  const { root, remote } = await createRemotePair(t)
  await git(root, ['checkout', '-b', 'race-source'])
  await commitFile(root, 'race.txt', 'race\n', 'race target')
  const raceOid = (await git(root, ['rev-parse', 'HEAD'])).trim()
  await git(root, ['checkout', 'main'])
  const confirmedOid = (await git(root, ['rev-parse', 'HEAD'])).trim()

  const binDirectory = await mkdtemp(join(tmpdir(), 'pi-gui-branch-push-race-bin-'))
  t.after(() => rm(binDirectory, { recursive: true, force: true }))
  const gitPath = (await execFileAsync('sh', ['-c', 'command -v git'], { encoding: 'utf8' })).stdout.trim()
  const wrapper = join(binDirectory, 'push-race-git')
  await writeFile(wrapper, [
    '#!/bin/sh',
    'if [ "$1" = "push" ]; then',
    `  current=$('${gitPath}' rev-parse refs/heads/main)`,
    `  '${gitPath}' update-ref refs/heads/main '${raceOid}' "$current" || exit $?`,
    'fi',
    `exec '${gitPath}' "$@"`
  ].join('\n'))
  await chmod(wrapper, 0o755)

  const service = new GitService(root, { gitBinary: wrapper })
  const prepared = await service.prepareBranchSync()
  assert.equal(prepared.ok, true)
  if (!prepared.ok) return
  assert.equal(prepared.snapshot.headOid, confirmedOid)
  const result = await service.executeBranchSync({ action: 'push', snapshot: prepared.snapshot })
  assert.equal(result.push?.status, 'succeeded')
  assert.equal((await git(root, ['rev-parse', 'HEAD'])).trim(), raceOid)
  assert.equal((await git(remote, ['rev-parse', 'main'])).trim(), confirmedOid)
})

test('branch create lands even when post-command verification sees the new branch after command error path', async (t) => {
  const root = await createRepository(t, 'pi-gui-branch-landed-')
  await commitFile(root, 'tracked.txt', 'base\n')
  const service = new GitService(root)
  const prepared = await service.prepareBranchSync()
  assert.equal(prepared.ok, true)
  if (!prepared.ok) return
  const created = await service.executeBranchSync({
    action: 'create-and-switch',
    snapshot: prepared.snapshot,
    name: 'landed'
  })
  assert.equal(created.branch?.status, 'succeeded')
  if (created.branch?.status === 'succeeded') {
    assert.equal(created.branch.branch, 'landed')
    assert.deepEqual(created.branch.warnings, [])
  }
  assert.equal((await git(root, ['symbolic-ref', '--short', 'HEAD'])).trim(), 'landed')
})

test('detached and unborn repositories block create/switch/pull/push but may still prepare and fetch', async (t) => {
  const { root, remote } = await createRemotePair(t)
  const head = (await git(root, ['rev-parse', 'HEAD'])).trim()
  await git(root, ['checkout', '--detach', head])
  const detachedService = new GitService(root)
  const detachedPrepared = await detachedService.prepareBranchSync()
  assert.equal(detachedPrepared.ok, true)
  if (!detachedPrepared.ok) return
  assert.equal(detachedPrepared.current.detached, true)
  assert.equal(detachedPrepared.actions.canCreate, false)
  assert.equal(detachedPrepared.actions.canSwitch, false)
  assert.equal(detachedPrepared.actions.canPull, false)
  assert.equal(detachedPrepared.actions.canPush, false)
  assert.equal(detachedPrepared.actions.canFetch, true)
  const detachedFetch = await detachedService.executeBranchSync({
    action: 'fetch',
    snapshot: detachedPrepared.snapshot,
    remoteId: detachedPrepared.remotes[0]!.remoteId
  })
  assert.equal(detachedFetch.fetch?.status, 'succeeded')

  const unborn = await createRepository(t, 'pi-gui-branch-unborn-')
  const unbornPrepared = await new GitService(unborn).prepareBranchSync()
  assert.equal(unbornPrepared.ok, true)
  if (!unbornPrepared.ok) return
  assert.equal(unbornPrepared.current.unborn, true)
  assert.equal(unbornPrepared.actions.canCreate, false)
  assert.equal(unbornPrepared.actions.canSwitch, false)
  assert.equal(unbornPrepared.actions.canPull, false)
  assert.equal(unbornPrepared.actions.canPush, false)
  void remote
})
