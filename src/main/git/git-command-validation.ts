import { isAbsolute, normalize } from 'node:path'

import {
  GIT_REPOSITORY_RELATIVE_PATH_MAX_UTF8_BYTES,
  type GitCommand,
  type GitDiffRequest,
  type GitFileMutationRequest
} from '../../shared/git-contract.ts'

const MAX_ABSOLUTE_PATH_UTF8_BYTES = 4_096
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u
const SHA256 = /^[0-9a-f]{64}$/u
const GIT_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u

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

function isNullableGitOid(value: unknown): value is string | null {
  return value === null || matches(GIT_OID, value)
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
