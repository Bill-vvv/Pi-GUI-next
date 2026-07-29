import assert from 'node:assert/strict'
import test from 'node:test'

import { GIT_REPOSITORY_RELATIVE_PATH_MAX_UTF8_BYTES } from '../../shared/git-contract.ts'
import { isGitCommand, isGitDiffRequest, isGitFileMutationRequest } from './git-command-validation.ts'

const HASH = 'a'.repeat(64)
const OID = 'b'.repeat(40)
const PROJECT = '/tmp/pi-gui-project'
const REPOSITORY = '/tmp/pi-gui-repository'

const diffRequest = {
  kind: 'working' as const,
  path: 'src/file.ts',
  expectedRepositoryRoot: REPOSITORY,
  expectedHeadOid: OID,
  expectedIndexTreeOid: HASH,
  expectedStatusRevision: HASH
}

const mutationRequest = {
  action: 'stage' as const,
  path: 'src/file.ts',
  expectedRepositoryRoot: REPOSITORY,
  expectedHeadOid: OID,
  expectedIndexTreeOid: HASH,
  expectedIndexFingerprint: HASH,
  expectedFileFingerprint: HASH,
  expectedWorktreeFingerprint: HASH,
  expectedStatusRevision: HASH
}

test('accepts only the exact Git command union shapes', () => {
  assert.equal(isGitCommand({ type: 'git.refresh', projectKey: PROJECT }), true)
  assert.equal(isGitCommand({ type: 'git.refresh' }), false)
  assert.equal(isGitCommand({ type: 'git.refresh', projectKey: PROJECT, cwd: '/tmp/other' }), false)
  assert.equal(isGitCommand({
    type: 'git.authorize-ancestor-repository',
    projectKey: PROJECT,
    repositoryRoot: REPOSITORY,
    expectedStatusRevision: HASH
  }), true)
  assert.equal(isGitCommand({
    type: 'git.authorize-ancestor-repository',
    projectKey: PROJECT,
    repositoryRoot: REPOSITORY,
    expectedStatusRevision: HASH,
    persist: true
  }), false)
  assert.equal(isGitCommand({ type: 'git.get-diff', projectKey: PROJECT, request: diffRequest }), true)
  assert.equal(isGitCommand({ type: 'git.mutate-file', projectKey: PROJECT, request: mutationRequest }), true)
  assert.equal(isGitCommand({ type: 'git.raw', projectKey: PROJECT, args: ['status'] }), false)
})

test('rejects unsafe and noncanonical Project and authorization roots', () => {
  for (const projectKey of ['', '   ', 'relative', '/tmp/../etc', '/tmp/project/', '/tmp/control\npath']) {
    assert.equal(isGitCommand({ type: 'git.refresh', projectKey }), false, projectKey)
  }
  for (const repositoryRoot of ['', 'relative', '/tmp/repository/', '/tmp/repository\0other']) {
    assert.equal(isGitCommand({
      type: 'git.authorize-ancestor-repository',
      projectKey: PROJECT,
      repositoryRoot,
      expectedStatusRevision: HASH
    }), false, repositoryRoot)
  }
  assert.equal(isGitCommand({
    type: 'git.authorize-ancestor-repository',
    projectKey: PROJECT,
    repositoryRoot: REPOSITORY,
    expectedStatusRevision: 'stale'
  }), false)
})

test('validates exact bounded diff and file mutation requests', () => {
  assert.equal(isGitDiffRequest(diffRequest), true)
  assert.equal(isGitFileMutationRequest(mutationRequest), true)
  assert.equal(isGitDiffRequest({ ...diffRequest, extra: true }), false)
  const { expectedStatusRevision: _missingDiff, ...missingDiff } = diffRequest
  assert.equal(isGitDiffRequest(missingDiff), false)
  assert.equal(isGitFileMutationRequest({ ...mutationRequest, args: ['--all'] }), false)
  const { expectedFileFingerprint: _missingMutation, ...missingMutation } = mutationRequest
  assert.equal(isGitFileMutationRequest(missingMutation), false)

  for (const path of ['', '   ', '/etc/passwd', '../outside', 'src/../outside', './file', 'dir//file', 'bad\nfile']) {
    assert.equal(isGitDiffRequest({ ...diffRequest, path }), false, path)
    assert.equal(isGitFileMutationRequest({ ...mutationRequest, path }), false, path)
  }
  const overlong = '界'.repeat(Math.floor(GIT_REPOSITORY_RELATIVE_PATH_MAX_UTF8_BYTES / 3) + 1)
  assert.equal(isGitDiffRequest({ ...diffRequest, path: overlong }), false)
  assert.equal(isGitFileMutationRequest({ ...mutationRequest, path: overlong }), false)

  assert.equal(isGitDiffRequest({ ...diffRequest, expectedRepositoryRoot: '/tmp/repository/' }), false)
  assert.equal(isGitDiffRequest({ ...diffRequest, expectedHeadOid: 'HEAD' }), false)
  assert.equal(isGitFileMutationRequest({ ...mutationRequest, action: 'commit' }), false)
  assert.equal(isGitFileMutationRequest({ ...mutationRequest, expectedIndexFingerprint: 'x'.repeat(64) }), false)
})

test('accepts only exact lowercase SHA-1 or SHA-256 Git object identity widths', () => {
  for (const length of [40, 64]) {
    const oid = 'b'.repeat(length)
    assert.equal(isGitDiffRequest({ ...diffRequest, expectedHeadOid: oid }), true, String(length))
    assert.equal(isGitDiffRequest({ ...diffRequest, expectedIndexTreeOid: oid }), true, String(length))
  }
  for (const length of [39, 41, 63, 65]) {
    const oid = 'b'.repeat(length)
    assert.equal(isGitDiffRequest({ ...diffRequest, expectedHeadOid: oid }), false, String(length))
    assert.equal(isGitDiffRequest({ ...diffRequest, expectedIndexTreeOid: oid }), false, String(length))
  }
  assert.equal(isGitDiffRequest({ ...diffRequest, expectedHeadOid: 'B'.repeat(40) }), false)
})
