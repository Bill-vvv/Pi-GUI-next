import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, readlink, rename, rm, stat, symlink, truncate, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import { GitService } from './git-service.ts'
import { GIT_REPOSITORY_RELATIVE_PATH_MAX_UTF8_BYTES } from '../../shared/git-contract.ts'
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
  setTimeout(() => controller.abort(), 50)
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
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await stat(marker)
      break
    } catch (error) {
      if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')) throw error
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
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
