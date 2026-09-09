import { isAbsolute, normalize } from 'node:path'

import {
  GIT_BRANCH_ID_MAX_UTF8_BYTES,
  GIT_BRANCH_NAME_MAX_UTF8_BYTES,
  GIT_COMMIT_MESSAGE_MAX_UTF8_BYTES,
  GIT_HISTORY_FILE_ID_MAX_UTF8_BYTES,
  GIT_HISTORY_MAX_OFFSET,
  GIT_REF_NAME_MAX_UTF8_BYTES,
  GIT_REMOTE_ID_MAX_UTF8_BYTES,
  GIT_REPOSITORY_RELATIVE_PATH_MAX_UTF8_BYTES,
  type GitBranchSyncExecutionRequest,
  type GitBranchSyncSnapshot,
  type GitCommand,
  type GitCommitExecutionRequest,
  type GitCommitSnapshot,
  type GitDiffRequest,
  type GitFileMutationRequest,
  type GitHistoryDetailRequest,
  type GitHistoryFileDiffRequest,
  type GitHistoryListRequest,
  type GitHistorySnapshot,
  type GitPushTarget
} from '../../shared/git-contract.ts'

const MAX_ABSOLUTE_PATH_UTF8_BYTES = 4_096
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u
const SHA256 = /^[0-9a-f]{64}$/u
const GIT_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u
const INVALID_GIT_NAME_CHARACTERS = /[\s~^:?*\[\\]/u

export function isGitCommand(value: unknown): value is GitCommand {
  if (!isRecord(value) || typeof value.type !== 'string') return false
  if (value.type === 'git.refresh') {
    return hasExactKeys(value, ['type', 'projectKey']) && isCanonicalAbsolutePath(value.projectKey)
  }
  if (value.type === 'git.authorize-ancestor-repository') {
    return hasExactKeys(value, ['type', 'projectKey', 'repositoryRoot', 'expectedStatusRevision']) &&
      isCanonicalAbsolutePath(value.projectKey) &&
      isCanonicalAbsolutePath(value.repositoryRoot) &&
      matches(SHA256, value.expectedStatusRevision)
  }
  if (value.type === 'git.get-diff') {
    return hasExactKeys(value, ['type', 'projectKey', 'request']) &&
      isCanonicalAbsolutePath(value.projectKey) &&
      isGitDiffRequest(value.request)
  }
  if (value.type === 'git.mutate-file') {
    return hasExactKeys(value, ['type', 'projectKey', 'request']) &&
      isCanonicalAbsolutePath(value.projectKey) &&
      isGitFileMutationRequest(value.request)
  }
  if (value.type === 'git.prepare-commit') {
    return hasExactKeys(value, ['type', 'projectKey']) && isCanonicalAbsolutePath(value.projectKey)
  }
  if (value.type === 'git.execute-commit') {
    return hasExactKeys(value, ['type', 'projectKey', 'request']) &&
      isCanonicalAbsolutePath(value.projectKey) &&
      isGitCommitExecutionRequest(value.request)
  }
  if (value.type === 'git.list-history') {
    return hasExactKeys(value, ['type', 'projectKey', 'request']) &&
      isCanonicalAbsolutePath(value.projectKey) &&
      isGitHistoryListRequest(value.request)
  }
  if (value.type === 'git.get-history-detail') {
    return hasExactKeys(value, ['type', 'projectKey', 'request']) &&
      isCanonicalAbsolutePath(value.projectKey) &&
      isGitHistoryDetailRequest(value.request)
  }
  if (value.type === 'git.get-history-file-diff') {
    return hasExactKeys(value, ['type', 'projectKey', 'request']) &&
      isCanonicalAbsolutePath(value.projectKey) &&
      isGitHistoryFileDiffRequest(value.request)
  }
  if (value.type === 'git.prepare-branch-sync') {
    return hasExactKeys(value, ['type', 'projectKey']) && isCanonicalAbsolutePath(value.projectKey)
  }
  if (value.type === 'git.execute-branch-sync') {
    return hasExactKeys(value, ['type', 'projectKey', 'request']) &&
      isCanonicalAbsolutePath(value.projectKey) &&
      isGitBranchSyncExecutionRequest(value.request)
  }
  return false
}

export function isGitDiffRequest(value: unknown): value is GitDiffRequest {
  return isRecord(value) &&
    hasExactKeys(value, [
      'kind',
      'path',
      'expectedRepositoryRoot',
      'expectedHeadOid',
      'expectedIndexTreeOid',
      'expectedStatusRevision'
    ]) &&
    (value.kind === 'working' || value.kind === 'staged') &&
    isRepositoryRelativePath(value.path) &&
    isCanonicalAbsolutePath(value.expectedRepositoryRoot) &&
    isNullableGitOid(value.expectedHeadOid) &&
    isNullableGitOid(value.expectedIndexTreeOid) &&
    matches(SHA256, value.expectedStatusRevision)
}

export function isGitFileMutationRequest(value: unknown): value is GitFileMutationRequest {
  return isRecord(value) &&
    hasExactKeys(value, [
      'action',
      'path',
      'expectedRepositoryRoot',
      'expectedHeadOid',
      'expectedIndexTreeOid',
      'expectedIndexFingerprint',
      'expectedFileFingerprint',
      'expectedWorktreeFingerprint',
      'expectedStatusRevision'
    ]) &&
    (value.action === 'stage' || value.action === 'unstage') &&
    isRepositoryRelativePath(value.path) &&
    isCanonicalAbsolutePath(value.expectedRepositoryRoot) &&
    isNullableGitOid(value.expectedHeadOid) &&
    isNullableGitOid(value.expectedIndexTreeOid) &&
    matches(SHA256, value.expectedIndexFingerprint) &&
    matches(SHA256, value.expectedFileFingerprint) &&
    matches(SHA256, value.expectedWorktreeFingerprint) &&
    matches(SHA256, value.expectedStatusRevision)
}

export function isGitCommitExecutionRequest(value: unknown): value is GitCommitExecutionRequest {
  return isRecord(value) &&
    hasExactKeys(value, ['mode', 'message', 'snapshot', 'expectedPushTarget']) &&
    (value.mode === 'commit' || value.mode === 'commit-and-push' || value.mode === 'amend') &&
    isCommitMessage(value.message) &&
    isGitCommitSnapshot(value.snapshot) &&
    isNullablePushTarget(value.expectedPushTarget) &&
    (value.mode !== 'commit-and-push' || value.expectedPushTarget !== null)
}

export function isGitCommitSnapshot(value: unknown): value is GitCommitSnapshot {
  return isRecord(value) &&
    hasExactKeys(value, ['repositoryRoot', 'headOid', 'branch', 'indexTreeOid', 'indexFingerprint']) &&
    isCanonicalAbsolutePath(value.repositoryRoot) &&
    isNullableGitOid(value.headOid) &&
    isGitRefName(value.branch) &&
    matches(GIT_OID, value.indexTreeOid) &&
    matches(SHA256, value.indexFingerprint)
}

export function isGitPushTarget(value: unknown): value is GitPushTarget {
  return isRecord(value) &&
    hasExactKeys(value, ['remote', 'branch']) &&
    isGitRefName(value.remote) &&
    isGitRefName(value.branch)
}

export function isGitHistorySnapshot(value: unknown): value is GitHistorySnapshot {
  return isRecord(value) &&
    hasExactKeys(value, ['repositoryRoot', 'headOid', 'branch']) &&
    isCanonicalAbsolutePath(value.repositoryRoot) &&
    isNullableGitOid(value.headOid) &&
    isNullableHistoryBranch(value.branch)
}

export function isGitHistoryListRequest(value: unknown): value is GitHistoryListRequest {
  return isRecord(value) &&
    hasExactKeys(value, ['snapshot', 'offset']) &&
    isGitHistorySnapshot(value.snapshot) &&
    isHistoryOffset(value.offset)
}

export function isGitHistoryDetailRequest(value: unknown): value is GitHistoryDetailRequest {
  return isRecord(value) &&
    hasExactKeys(value, ['snapshot', 'oid']) &&
    isGitHistorySnapshot(value.snapshot) &&
    matches(GIT_OID, value.oid)
}

export function isGitHistoryFileDiffRequest(value: unknown): value is GitHistoryFileDiffRequest {
  return isRecord(value) &&
    hasExactKeys(value, ['snapshot', 'oid', 'fileId']) &&
    isGitHistorySnapshot(value.snapshot) &&
    matches(GIT_OID, value.oid) &&
    isHistoryFileId(value.fileId)
}

export function isGitBranchSyncSnapshot(value: unknown): value is GitBranchSyncSnapshot {
  return isRecord(value) &&
    hasExactKeys(value, [
      'repositoryRoot',
      'headOid',
      'branch',
      'indexTreeOid',
      'indexFingerprint',
      'worktreeFingerprint',
      'statusRevision',
      'upstreamRemote',
      'upstreamBranch'
    ]) &&
    isCanonicalAbsolutePath(value.repositoryRoot) &&
    isNullableGitOid(value.headOid) &&
    isNullableHistoryBranch(value.branch) &&
    isNullableGitOid(value.indexTreeOid) &&
    matches(SHA256, value.indexFingerprint) &&
    matches(SHA256, value.worktreeFingerprint) &&
    matches(SHA256, value.statusRevision) &&
    isNullableGitRefName(value.upstreamRemote) &&
    isNullableGitRefName(value.upstreamBranch)
}

export function isGitBranchSyncExecutionRequest(value: unknown): value is GitBranchSyncExecutionRequest {
  if (!isRecord(value) || typeof value.action !== 'string' || !isGitBranchSyncSnapshot(value.snapshot)) {
    return false
  }
  if (value.action === 'create-and-switch') {
    return hasExactKeys(value, ['action', 'snapshot', 'name']) && isBranchNameInput(value.name)
  }
  if (value.action === 'switch') {
    return hasExactKeys(value, ['action', 'snapshot', 'branchId']) && isOpaqueBranchId(value.branchId)
  }
  if (value.action === 'fetch') {
    return hasExactKeys(value, ['action', 'snapshot', 'remoteId']) && isOpaqueRemoteId(value.remoteId)
  }
  if (value.action === 'pull' || value.action === 'push') {
    return hasExactKeys(value, ['action', 'snapshot'])
  }
  return false
}

export function isCanonicalAbsolutePath(value: unknown): value is string {
  return typeof value === 'string' &&
    value.trim().length > 0 &&
    !CONTROL_CHARACTERS.test(value) &&
    Buffer.byteLength(value, 'utf8') <= MAX_ABSOLUTE_PATH_UTF8_BYTES &&
    isAbsolute(value) &&
    normalize(value) === value &&
    (value === '/' || !value.endsWith('/'))
}

export function isRepositoryRelativePath(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    CONTROL_CHARACTERS.test(value) ||
    Buffer.byteLength(value, 'utf8') > GIT_REPOSITORY_RELATIVE_PATH_MAX_UTF8_BYTES ||
    isAbsolute(value)
  ) return false
  const segments = value.split('/')
  return segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
}

export function isCommitMessage(value: unknown): value is string {
  return typeof value === 'string' &&
    !value.includes('\0') &&
    value.trim().length > 0 &&
    Buffer.byteLength(value, 'utf8') <= GIT_COMMIT_MESSAGE_MAX_UTF8_BYTES
}

export function isGitRefName(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value !== value.trim() ||
    CONTROL_CHARACTERS.test(value) ||
    INVALID_GIT_NAME_CHARACTERS.test(value) ||
    value === '.' ||
    value === '@' ||
    value.startsWith('-') ||
    value.startsWith('/') ||
    value.endsWith('/') ||
    value.endsWith('.') ||
    value.endsWith('.lock') ||
    value.includes('..') ||
    value.includes('//') ||
    value.includes('@{') ||
    Buffer.byteLength(value, 'utf8') > GIT_REF_NAME_MAX_UTF8_BYTES
  ) return false
  return value.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
}

function isNullablePushTarget(value: unknown): value is GitPushTarget | null {
  return value === null || isGitPushTarget(value)
}

function isNullableGitOid(value: unknown): value is string | null {
  return value === null || matches(GIT_OID, value)
}

function isNullableHistoryBranch(value: unknown): value is string | null {
  return value === null || isGitRefName(value)
}

function isHistoryOffset(value: unknown): value is number {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= GIT_HISTORY_MAX_OFFSET
}

function isHistoryFileId(value: unknown): value is string {
  return typeof value === 'string' &&
    value.length > 0 &&
    !CONTROL_CHARACTERS.test(value) &&
    Buffer.byteLength(value, 'utf8') <= GIT_HISTORY_FILE_ID_MAX_UTF8_BYTES &&
    /^[0-9a-f]+$/u.test(value)
}

function isOpaqueBranchId(value: unknown): value is string {
  return typeof value === 'string' &&
    value.length > 0 &&
    !CONTROL_CHARACTERS.test(value) &&
    Buffer.byteLength(value, 'utf8') <= GIT_BRANCH_ID_MAX_UTF8_BYTES &&
    /^[0-9a-f]+$/u.test(value)
}

function isOpaqueRemoteId(value: unknown): value is string {
  return typeof value === 'string' &&
    value.length > 0 &&
    !CONTROL_CHARACTERS.test(value) &&
    Buffer.byteLength(value, 'utf8') <= GIT_REMOTE_ID_MAX_UTF8_BYTES &&
    /^[0-9a-f]+$/u.test(value)
}

function isBranchNameInput(value: unknown): value is string {
  return typeof value === 'string' &&
    value.length > 0 &&
    Buffer.byteLength(value, 'utf8') <= GIT_BRANCH_NAME_MAX_UTF8_BYTES &&
    isGitRefName(value)
}

function isNullableGitRefName(value: unknown): value is string | null {
  return value === null || isGitRefName(value)
}

function matches(pattern: RegExp, value: unknown): value is string {
  return typeof value === 'string' && pattern.test(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}
