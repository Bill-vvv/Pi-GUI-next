import {
  isAbsolute,
  relative,
  resolve,
  sep
} from 'node:path'
import {
  GIT_HISTORY_MESSAGE_MAX_UTF8_BYTES,
  GIT_REPOSITORY_RELATIVE_PATH_MAX_UTF8_BYTES
} from '../../shared/git-contract.ts'
import type {
  GitChangeKind,
  GitDiffFile,
  GitDiffHunk,
  GitDiffKind,
  GitDiffLine,
  GitDiffRequest,
  GitDiffResult,
  GitErrorDto,
  GitFileChange,
  GitHistoryCommitSummary,
  GitHistoryFileChange,
  GitHistoryFileDiffRequest,
  GitHistoryFileDiffResult,
  GitHistoryFileEntry,
  GitHistorySnapshot,
  GitRepositoryState
} from '../../shared/git-contract.ts'
import {
  GitRunError,
  digest,
  errorDto
} from './git-admission.ts'
import type {
  HistoryNameStatusRecord,
  IndexEntry,
  StatusRecord
} from './git-service-types.ts'

/* Parsers and projections of Git command output (moved unchanged from git-service.ts, D-098). */

export function parseIndexEntries(text: string): Map<string, IndexEntry> {
  const entries = new Map<string, IndexEntry>()
  for (const record of text.split('\0')) {
    if (record.length === 0) continue
    const match = /^(\d+) ((?:[0-9a-f]{40}|[0-9a-f]{64})) ([0-3])\t(.*)$/s.exec(record)
    if (match === null) throw new GitRunError(errorDto('git-error', 'Git returned an invalid index entry.'))
    if (match[3] === '0') entries.set(match[4]!, { mode: match[1]!, oid: match[2]! })
  }
  return entries
}

export function parseStatus(text: string): StatusRecord[] {
  const records = text.split('\0')
  const result: StatusRecord[] = []
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    if (record.length === 0) continue
    if (record.startsWith('? ')) {
      result.push({ path: record.slice(2), originalPath: null, indexCode: '.', worktreeCode: '?', conflicted: false, untracked: true })
      continue
    }
    if (record.startsWith('! ')) continue
    const ordinary = /^1 (..) \S+ \S+ \S+ \S+ \S+ \S+ (.*)$/s.exec(record)
    if (ordinary !== null) {
      result.push(statusRecord(ordinary[2]!, null, ordinary[1]!))
      continue
    }
    const renamed = /^2 (..) \S+ \S+ \S+ \S+ \S+ \S+ \S+ (.*)$/s.exec(record)
    if (renamed !== null) {
      const originalPath = records[index + 1]
      if (originalPath === undefined) throw new GitRunError(errorDto('git-error', 'Git returned an incomplete rename status record.'))
      index += 1
      result.push(statusRecord(renamed[2]!, originalPath, renamed[1]!))
      continue
    }
    const unmerged = /^u (..) \S+ \S+ \S+ \S+ \S+ \S+ \S+ \S+ (.*)$/s.exec(record)
    if (unmerged !== null) {
      result.push({ ...statusRecord(unmerged[2]!, null, unmerged[1]!), conflicted: true })
      continue
    }
    throw new GitRunError(errorDto('git-error', 'Git returned an unsupported status record.'))
  }
  return result
}

export function statusRecord(path: string, originalPath: string | null, xy: string): StatusRecord {
  const indexCode = xy[0] ?? '.'
  const worktreeCode = xy[1] ?? '.'
  return {
    path,
    originalPath,
    indexCode,
    worktreeCode,
    conflicted: indexCode === 'U' || worktreeCode === 'U' || xy === 'AA' || xy === 'DD',
    untracked: false
  }
}

export function mapStatusCode(code: string): GitChangeKind {
  switch (code) {
    case '.': return 'unmodified'
    case 'A': return 'added'
    case 'M': return 'modified'
    case 'D': return 'deleted'
    case 'R': return 'renamed'
    // Git copy detection is intentionally projected as an added file until the product needs copy identity.
    case 'C': return 'added'
    case 'T': return 'type-changed'
    case 'U': return 'unmerged'
    case '?': return 'untracked'
    case '!': return 'ignored'
    default: return 'unknown'
  }
}

export function diffChangeForStatus(
  kind: GitDiffKind,
  statusFile: GitFileChange | undefined,
  hasRenameHeader: boolean
): GitDiffFile['change'] | null {
  if (statusFile === undefined) return null
  const change = kind === 'working' ? statusFile.worktreeChange : statusFile.indexChange
  switch (change) {
    case 'added': return 'added'
    case 'deleted': return 'deleted'
    case 'renamed': return 'renamed'
    case 'type-changed': return 'type-changed'
    case 'modified': return hasRenameHeader ? 'renamed' : 'modified'
    default: return null
  }
}

export function parseSingleFilePatch(
  kind: GitDiffKind,
  path: string,
  patch: string,
  maxHunks: number,
  maxLines: number
): { hunks: GitDiffHunk[]; hasRenameHeader: boolean; hasModeOnlyChange: boolean } {
  const lines = patch.split('\n')
  const fileHeaders = lines.filter((line) => line.startsWith('diff --git ')).length
  if (fileHeaders !== 1 || !lines[0]?.startsWith('diff --git ')) {
    throw new GitRunError(errorDto('unsupported', 'Git diff must contain exactly one expected file.'))
  }
  let hasRenameHeader = false
  let hasModeHeader = false
  let totalParsedLines = 0
  const hunks: GitDiffHunk[] = []
  let index = 1
  while (index < lines.length) {
    const line = lines[index]!
    if (line.startsWith('@@ ')) break
    if (line.startsWith('diff --git ')) throw new GitRunError(errorDto('unsupported', 'Git diff contains more than one file.'))
    if (line.startsWith('rename from ') || line.startsWith('rename to ')) hasRenameHeader = true
    if (line.startsWith('old mode ') || line.startsWith('new mode ')) hasModeHeader = true
    index += 1
  }
  while (index < lines.length) {
    if (index === lines.length - 1 && lines[index] === '') break
    const header = lines[index]!
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(header)
    if (match === null) throw new GitRunError(errorDto('unsupported', 'Git diff contains an invalid hunk header.'))
    const oldStart = Number(match[1])
    const oldLines = match[2] === undefined ? 1 : Number(match[2])
    const newStart = Number(match[3])
    const newLines = match[4] === undefined ? 1 : Number(match[4])
    for (const value of [oldStart, oldLines, newStart, newLines]) {
      if (!Number.isSafeInteger(value) || value < 0) throw new GitRunError(errorDto('unsupported', 'Git diff contains an invalid hunk range.'))
    }
    const normalizedHeader = `@@ -${oldStart},${oldLines} +${newStart},${newLines} @@${match[5] ?? ''}`
    index += 1
    let oldLine = oldStart
    let newLine = newStart
    let consumedOld = 0
    let consumedNew = 0
    const changes: GitDiffLine[] = []
    if (hunks.length >= maxHunks) throw new GitRunError(errorDto('output-limit', 'Diff exceeds the configured hunk budget.'))
    while (index < lines.length) {
      const line = lines[index]!
      if (line.startsWith('@@ ')) break
      if (index === lines.length - 1 && line === '') {
        index += 1
        break
      }
      const prefix = line[0]
      if (prefix === '+') {
        changes.push({ kind: 'add', oldLine: null, newLine, content: line.slice(1) })
        newLine += 1
        consumedNew += 1
      } else if (prefix === '-') {
        changes.push({ kind: 'remove', oldLine, newLine: null, content: line.slice(1) })
        oldLine += 1
        consumedOld += 1
      } else if (prefix === ' ') {
        changes.push({ kind: 'context', oldLine, newLine, content: line.slice(1) })
        oldLine += 1
        newLine += 1
        consumedOld += 1
        consumedNew += 1
      } else if (prefix === '\\') {
        changes.push({ kind: 'meta', oldLine: null, newLine: null, content: line.slice(1).trim() })
      } else {
        throw new GitRunError(errorDto('unsupported', 'Git diff contains an invalid hunk line.'))
      }
      index += 1
      totalParsedLines += 1
      if (totalParsedLines > maxLines) {
        throw new GitRunError(errorDto('output-limit', 'Diff exceeds the configured line budget.'))
      }
    }
    if (consumedOld !== oldLines || consumedNew !== newLines) {
      throw new GitRunError(errorDto('unsupported', 'Git diff hunk counts do not match its content.'))
    }
    hunks.push({
      id: digest(`${kind}\0${path}\0${normalizedHeader}\0${hunks.length}`).slice(0, 24),
      header: normalizedHeader,
      oldStart,
      oldLines,
      newStart,
      newLines,
      lines: changes
    })
  }
  return { hunks, hasRenameHeader, hasModeOnlyChange: hasModeHeader }
}

export function validatedPathspecsForStatusFile(
  path: string,
  statusFile: GitFileChange | undefined,
  repositoryRoot: string
): string[] {
  if (
    statusFile?.originalPath !== null &&
    statusFile?.originalPath !== undefined &&
    (statusFile.indexChange === 'renamed' || statusFile.worktreeChange === 'renamed')
  ) {
    return [
      validateRepositoryPath(statusFile.originalPath, repositoryRoot),
      validateRepositoryPath(path, repositoryRoot)
    ]
  }
  return [validateRepositoryPath(path, repositoryRoot)]
}

export function validateRepositoryPath(path: string, repositoryRoot: string | null): string {
  if (repositoryRoot === null) throw new GitRunError(errorDto('not-repository', 'Project is not a Git repository.'))
  if (path.length === 0 || path.includes('\0') || isAbsolute(path)) {
    throw new GitRunError(errorDto('invalid-path', 'Git path must be a non-empty repository-relative path.'))
  }
  if (Buffer.byteLength(path, 'utf8') > GIT_REPOSITORY_RELATIVE_PATH_MAX_UTF8_BYTES) {
    throw new GitRunError(errorDto(
      'invalid-path',
      `Git path exceeds the ${GIT_REPOSITORY_RELATIVE_PATH_MAX_UTF8_BYTES}-byte repository-relative limit.`
    ))
  }
  const segments = path.split('/')
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new GitRunError(errorDto('invalid-path', 'Git path contains an invalid traversal segment.'))
  }
  const absolute = resolve(repositoryRoot, path)
  const relativePath = relative(repositoryRoot, absolute)
  if (relativePath.startsWith(`..${sep}`) || relativePath === '..' || isAbsolute(relativePath)) {
    throw new GitRunError(errorDto('invalid-path', 'Git path resolves outside the repository.'))
  }
  return path
}

export function emptyHistoryFileDiff(
  request: GitHistoryFileDiffRequest,
  state: GitHistoryFileDiffResult['state'],
  current: GitHistorySnapshot | null,
  error: GitErrorDto | null
): GitHistoryFileDiffResult {
  return {
    oid: request.oid,
    fileId: request.fileId,
    path: null,
    originalPath: null,
    status: null,
    state,
    snapshot: null,
    current,
    files: [],
    byteCount: 0,
    hunkCount: 0,
    lineCount: 0,
    error
  }
}

export function parseHistorySummaries(text: string): GitHistoryCommitSummary[] {
  if (text.length === 0) return []
  const lines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n')
  const commits: GitHistoryCommitSummary[] = []
  for (const line of lines) {
    if (line.length === 0) continue
    const parts = line.split('\0')
    if (parts.length !== 10) {
      throw new GitRunError(errorDto('git-error', 'Git returned an invalid history log record.'))
    }
    const [
      oid,
      shortOid,
      subject,
      authorName,
      authorEmail,
      authorAtText,
      committerName,
      committerEmail,
      committerAtText,
      parentsText
    ] = parts as [string, string, string, string, string, string, string, string, string, string]
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(oid) || shortOid.length === 0) {
      throw new GitRunError(errorDto('git-error', 'Git returned an invalid history commit identity.'))
    }
    const authorAt = Number(authorAtText)
    const committerAt = Number(committerAtText)
    const authorAtMs = authorAt * 1000
    const committerAtMs = committerAt * 1000
    if (
      !Number.isSafeInteger(authorAt) ||
      !Number.isSafeInteger(committerAt) ||
      authorAt < 0 ||
      committerAt < 0 ||
      !Number.isSafeInteger(authorAtMs) ||
      !Number.isSafeInteger(committerAtMs)
    ) {
      throw new GitRunError(errorDto('git-error', 'Git returned an invalid history commit timestamp.'))
    }
    const parentOids = parentsText.length === 0
      ? []
      : parentsText.split(' ').filter((parent) => parent.length > 0)
    for (const parent of parentOids) {
      if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(parent)) {
        throw new GitRunError(errorDto('git-error', 'Git returned an invalid history parent identity.'))
      }
    }
    commits.push({
      oid,
      shortOid,
      subject,
      authorName,
      authorEmail,
      authorAt: authorAtMs,
      committerName,
      committerEmail,
      committerAt: committerAtMs,
      parentOids
    })
  }
  return commits
}

export function parseHistoryNameStatusRecords(
  records: readonly HistoryNameStatusRecord[],
  commitOid: string,
  repositoryRoot: string
): GitHistoryFileEntry[] {
  return records.map((record) => {
    const statusCode = record[0][0]!
    if (statusCode === 'R' || statusCode === 'C') {
      if (record.length !== 3) {
        throw new GitRunError(errorDto('git-error', 'Git returned an invalid rename/copy history file record.'))
      }
      const originalPath = validateRepositoryPath(record[1], repositoryRoot)
      const path = validateRepositoryPath(record[2], repositoryRoot)
      const status: GitHistoryFileChange = statusCode === 'R' ? 'renamed' : 'added'
      return {
        fileId: historyFileId(commitOid, status, originalPath, path),
        path,
        originalPath: statusCode === 'R' ? originalPath : null,
        status
      }
    }
    if (record.length !== 2) {
      throw new GitRunError(errorDto('git-error', 'Git returned an invalid history file record.'))
    }
    const path = validateRepositoryPath(record[1], repositoryRoot)
    const status = mapHistoryStatusCode(statusCode)
    return {
      fileId: historyFileId(commitOid, status, null, path),
      path,
      originalPath: null,
      status
    }
  })
}

export function mapHistoryStatusCode(code: string): GitHistoryFileChange {
  switch (code) {
    case 'A':
      return 'added'
    case 'M':
      return 'modified'
    case 'D':
      return 'deleted'
    case 'T':
      return 'type-changed'
    default:
      return 'unknown'
  }
}

export function historyFileId(
  commitOid: string,
  status: GitHistoryFileChange,
  originalPath: string | null,
  path: string
): string {
  return digest(['history', commitOid, status, originalPath ?? '', path].join('\0')).slice(0, 32)
}

export function historyStatusToDiffChange(
  status: GitHistoryFileChange
): Exclude<GitChangeKind, 'unmodified' | 'unmerged' | 'untracked' | 'ignored'> {
  return status
}

export function boundHistoryMessage(text: string): { message: string; messageTruncated: boolean } {
  const normalized = text.endsWith('\n') ? text.slice(0, -1) : text
  if (Buffer.byteLength(normalized, 'utf8') <= GIT_HISTORY_MESSAGE_MAX_UTF8_BYTES) {
    return { message: normalized, messageTruncated: false }
  }
  let end = normalized.length
  while (end > 0 && Buffer.byteLength(normalized.slice(0, end), 'utf8') > GIT_HISTORY_MESSAGE_MAX_UTF8_BYTES) {
    end -= 1
  }
  return { message: normalized.slice(0, end), messageTruncated: true }
}

export function emptyDiff(
  request: GitDiffRequest,
  stateValue: GitDiffResult['state'],
  state: GitRepositoryState | null,
  error: GitErrorDto | null
): GitDiffResult {
  return emptyDiffFromPath(request.kind, request.path, stateValue, state, error)
}

export function emptyDiffFromPath(
  kind: GitDiffKind,
  path: string,
  stateValue: GitDiffResult['state'],
  state: GitRepositoryState | null,
  error: GitErrorDto | null
): GitDiffResult {
  return {
    kind,
    path,
    state: stateValue,
    revision: null,
    headOid: state?.headOid ?? null,
    indexTreeOid: state?.indexTreeOid ?? null,
    worktreeFingerprint: state?.worktreeFingerprint ?? '',
    files: [],
    byteCount: 0,
    fileCount: 0,
    hunkCount: 0,
    lineCount: 0,
    error
  }
}

export function suggestCommitMessage(paths: string[]): string {
  const sorted = [...paths].sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
  if (sorted.length === 1) return `Update ${sorted[0]}`
  if (sorted.length <= 5) return `Update ${sorted.join(', ')}`
  return `Update ${sorted.length} files`
}

export function splitNonEmptyLines(text: string): string[] {
  if (text.length === 0) return []
  const normalized = text.endsWith('\n') ? text.slice(0, -1) : text
  if (normalized.length === 0) return []
  return normalized.split('\n').filter((line) => line.length > 0)
}

export function diffRevision(kind: GitDiffKind, state: GitRepositoryState, path: string, patch: string): string {
  return digest([kind, state.headOid ?? 'unborn', state.indexTreeOid ?? 'unmerged-index', state.worktreeFingerprint, path, patch].join('\0'))
}

export function trimNullable(value: string | null): string | null {
  if (value === null) return null
  const trimmed = value.trim()
  return trimmed.length === 0 ? null : trimmed
}
