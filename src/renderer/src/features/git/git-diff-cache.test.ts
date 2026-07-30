import assert from 'node:assert/strict'
import test from 'node:test'

import type {
  GitDiffResult,
  GitFileChange,
  GitRepositoryState
} from '../../../../shared/git-contract.ts'
import {
  GIT_DIFF_MAX_EXPANDED_FILES,
  GitDiffLruCache,
  GitDiffRequestPool,
  GitMutationGate,
  gitDiffCacheKey,
  isCacheableGitDiffResult,
  setBoundedGitDiffEntry
} from './git-diff-cache.ts'

const file: GitFileChange = {
  id: 'file-id',
  path: 'src/file.ts',
  originalPath: null,
  state: 'unstaged',
  indexChange: 'unmodified',
  worktreeChange: 'modified',
  conflicted: false,
  fingerprint: 'file-fingerprint'
}

const state: GitRepositoryState = {
  kind: 'repository',
  projectRoot: '/project',
  repositoryRoot: '/project',
  headOid: 'head',
  branch: 'main',
  detached: false,
  upstream: null,
  ahead: 0,
  behind: 0,
  indexTreeOid: 'index-tree',
  indexFingerprint: 'index-fingerprint',
  worktreeFingerprint: 'worktree-fingerprint',
  statusRevision: 'status-revision',
  files: [file],
  truncated: false,
  refreshedAt: 1,
  lastError: null
}

function result(path = file.path, byteCount = 64, lineCount = 1): GitDiffResult {
  return {
    kind: 'working',
    path,
    state: 'ready',
    revision: `revision:${path}`,
    headOid: state.headOid,
    indexTreeOid: state.indexTreeOid,
    worktreeFingerprint: state.worktreeFingerprint,
    files: [],
    byteCount,
    fileCount: 1,
    hunkCount: 1,
    lineCount,
    error: null
  }
}

test('cache keys bind every repository and file snapshot identity used by diff reads', () => {
  const baseline = gitDiffCacheKey('project-a', state, file, 'working')
  const variants = [
    gitDiffCacheKey('project-b', state, file, 'working'),
    gitDiffCacheKey('project-a', { ...state, repositoryRoot: '/other' }, file, 'working'),
    gitDiffCacheKey('project-a', { ...state, statusRevision: 'next-status' }, file, 'working'),
    gitDiffCacheKey('project-a', { ...state, headOid: 'next-head' }, file, 'working'),
    gitDiffCacheKey('project-a', { ...state, indexTreeOid: 'next-index' }, file, 'working'),
    gitDiffCacheKey('project-a', { ...state, worktreeFingerprint: 'next-worktree' }, file, 'working'),
    gitDiffCacheKey('project-a', state, { ...file, id: 'next-file' }, 'working'),
    gitDiffCacheKey('project-a', state, { ...file, fingerprint: 'next-fingerprint' }, 'working'),
    gitDiffCacheKey('project-a', state, file, 'staged')
  ]
  assert.equal(new Set([baseline, ...variants]).size, variants.length + 1)
})

test('mutation gate synchronously rejects duplicate admission until release', () => {
  const gate = new GitMutationGate()
  assert.equal(gate.tryAcquire('project\u0000stage\u0000file'), true)
  assert.equal(gate.tryAcquire('project\u0000stage\u0000file'), false)
  assert.equal(gate.tryAcquire('other-project\u0000stage\u0000file'), true)
  gate.release('project\u0000stage\u0000file')
  assert.equal(gate.tryAcquire('project\u0000stage\u0000file'), true)
})

test('request pool deduplicates the same key and removes settled or rejected work', async () => {
  const pool = new GitDiffRequestPool<string>()
  let loads = 0
  let resolve!: (value: string) => void
  const first = pool.getOrCreate('same', () => {
    loads += 1
    return new Promise<string>((done) => { resolve = done })
  })
  const duplicate = pool.getOrCreate('same', async () => {
    loads += 1
    return 'duplicate'
  })
  assert.equal(first, duplicate)
  assert.equal(pool.has('same'), true)
  await Promise.resolve()
  resolve('ready')
  assert.equal(await first, 'ready')
  await Promise.resolve()
  assert.equal(pool.has('same'), false)
  assert.equal(loads, 1)

  await assert.rejects(pool.getOrCreate('failure', async () => {
    throw new Error('expected')
  }), /expected/)
  assert.equal(pool.has('failure'), false)
  assert.equal(await pool.getOrCreate('failure', async () => 'retry'), 'retry')
})

test('expanded diff map keeps only the newest bounded file entries', () => {
  let expanded: ReadonlyMap<string, number> = new Map()
  for (let index = 0; index < GIT_DIFF_MAX_EXPANDED_FILES; index += 1) {
    expanded = setBoundedGitDiffEntry(expanded, `file-${index}`, index)
  }
  expanded = setBoundedGitDiffEntry(expanded, 'file-0', 100)
  expanded = setBoundedGitDiffEntry(expanded, 'newest', 101)

  assert.equal(expanded.size, GIT_DIFF_MAX_EXPANDED_FILES)
  assert.equal(expanded.has('file-1'), false)
  assert.equal(expanded.get('file-0'), 100)
  assert.equal(expanded.get('newest'), 101)
  assert.throws(() => setBoundedGitDiffEntry(expanded, 'invalid', 0, 0), /positive safe integer/)
})

test('LRU cache is entry-bounded and reads promote the retained entry', () => {
  const cache = new GitDiffLruCache(2, 32_000)
  cache.set('a', result('a'))
  cache.set('b', result('b'))
  assert.equal(cache.get('a')?.path, 'a')
  cache.set('c', result('c'))

  assert.equal(cache.size, 2)
  assert.equal(cache.get('b'), null)
  assert.equal(cache.get('a')?.path, 'a')
  assert.equal(cache.get('c')?.path, 'c')
})

test('LRU cache enforces weighted memory budget and skips entries larger than the whole budget', () => {
  const cache = new GitDiffLruCache(8, 3_000)
  cache.set('a', result('a'))
  cache.set('b', result('b'))
  cache.set('too-large', result('large', 8_000, 100))

  assert.equal(cache.size, 2)
  assert.equal(cache.get('too-large'), null)
  assert.ok(cache.weight <= 3_000)
  cache.clear()
  assert.equal(cache.size, 0)
  assert.equal(cache.weight, 0)
})

test('only stable display results are cacheable', () => {
  assert.equal(isCacheableGitDiffResult(result()), true)
  assert.equal(isCacheableGitDiffResult({ ...result(), state: 'binary' }), true)
  assert.equal(isCacheableGitDiffResult({ ...result(), state: 'oversized' }), true)
  assert.equal(isCacheableGitDiffResult({ ...result(), state: 'unsupported' }), true)
  assert.equal(isCacheableGitDiffResult({
    ...result(),
    state: 'error',
    error: { code: 'stale', message: 'stale', stderrCharacters: 0 }
  }), false)
})
