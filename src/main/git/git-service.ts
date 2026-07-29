import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { lstat, open, readlink, realpath, type FileHandle } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

import { simpleGit } from 'simple-git'

import { GIT_REPOSITORY_RELATIVE_PATH_MAX_UTF8_BYTES } from '../../shared/git-contract.ts'
import type {
  GitChangeKind,
  GitDiffFile,
  GitDiffHunk,
  GitDiffKind,
  GitDiffLine,
  GitDiffRequest,
  GitDiffResult,
  GitErrorCode,
  GitErrorDto,
  GitFileChange,
  GitFileMutationRequest,
  GitMutationResult,
  GitRefreshResult,
  GitRepositoryState
} from '../../shared/git-contract.ts'

const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_MAX_STATUS_BYTES = 2 * 1024 * 1024
const DEFAULT_MAX_STATUS_FILES = 2_000
const DEFAULT_MAX_DIFF_BYTES = 1024 * 1024
const DEFAULT_MAX_DIFF_FILES = 25
const DEFAULT_MAX_DIFF_HUNKS = 200
const DEFAULT_MAX_DIFF_LINES = 5_000
const DEFAULT_MAX_AUTOMATIC_FINGERPRINT_BYTES = 1024 * 1024
const CONTENT_HASH_WORKERS = 4
const MAX_ERROR_MESSAGE_CHARACTERS = 512
const MAX_ERROR_STDERR_CHARACTERS = 2 * 1024 * 1024

export type GitServiceOptions = {
  gitBinary?: string
  timeoutMs?: number
  maxStatusBytes?: number
  maxStatusFiles?: number
  maxDiffBytes?: number
  maxDiffFiles?: number
  maxDiffHunks?: number
  maxDiffLines?: number
  /** Maximum regular-file bytes read per file during automatic refresh and exact-rename coalescing. */
  maxAutomaticFingerprintBytes?: number
  /** Exact canonical repository root authorized by Main when the Project is inside an ancestor repository. */
  authorizedRepositoryRoot?: string
}

/** @internal Deterministic filesystem-race injection used only by the focused Main tests. */
type GitServiceTestHooks = {
  beforeNoFollowOpen?: (absolutePath: string) => Promise<void>
}

type ResolvedOptions = Required<Omit<GitServiceOptions, 'authorizedRepositoryRoot'>> & Pick<GitServiceOptions, 'authorizedRepositoryRoot'>

type StatusRecord = {
  path: string
  originalPath: string | null
  indexCode: string
  worktreeCode: string
  conflicted: boolean
  untracked: boolean
}

type RunOptions = {
  signal?: AbortSignal
  maxOutputBytes: number
  timeoutMs?: number
}

type FileIdentity = {
  dev: string
  ino: string
  mode: string
  size: string
  mtime: string
  ctime: string
}

type MutationContentFence = {
  rawOid: string | null
}

type ExactWorktreeContent = {
  kind: 'regular' | 'symlink'
  mode: string
  rawOid: string
  filteredOid: string
}

type HashChild = {
  process: ChildProcessWithoutNullStreams
  stdout: Buffer[]
  stderr: Buffer[]
  outputBytes: number
  result: Promise<{ code: number | null; error: Error | null }>
}

type IndexEntry = {
  mode: string
  oid: string
}

class GitRunError extends Error {
  readonly dto: GitErrorDto

  constructor(dto: GitErrorDto) {
    super(dto.message)
    this.name = 'GitRunError'
    this.dto = dto
  }
}

class SerialQueue {
  private tail: Promise<void> = Promise.resolve()

  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation)
    this.tail = result.then(() => undefined, () => undefined)
    return result
  }
}

const repositoryQueues = new Map<string, SerialQueue>()

export class GitService {
  private readonly projectRoot: string
  private readonly options: ResolvedOptions
  private readonly testHooks: GitServiceTestHooks

  constructor(projectRoot: string, options: GitServiceOptions = {}, testHooks: GitServiceTestHooks = {}) {
    if (!isAbsolute(projectRoot)) throw new Error('Git project root must be absolute.')
    if (options.authorizedRepositoryRoot !== undefined && !isAbsolute(options.authorizedRepositoryRoot)) {
      throw new Error('Authorized Git repository root must be absolute.')
    }
    this.projectRoot = projectRoot
    this.options = {
      gitBinary: options.gitBinary ?? 'git',
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxStatusBytes: options.maxStatusBytes ?? DEFAULT_MAX_STATUS_BYTES,
      maxStatusFiles: options.maxStatusFiles ?? DEFAULT_MAX_STATUS_FILES,
      maxDiffBytes: options.maxDiffBytes ?? DEFAULT_MAX_DIFF_BYTES,
      maxDiffFiles: options.maxDiffFiles ?? DEFAULT_MAX_DIFF_FILES,
      maxDiffHunks: options.maxDiffHunks ?? DEFAULT_MAX_DIFF_HUNKS,
      maxDiffLines: options.maxDiffLines ?? DEFAULT_MAX_DIFF_LINES,
      maxAutomaticFingerprintBytes: options.maxAutomaticFingerprintBytes ?? DEFAULT_MAX_AUTOMATIC_FINGERPRINT_BYTES,
      authorizedRepositoryRoot: options.authorizedRepositoryRoot
    }
    this.testHooks = testHooks
    assertPositiveOptions(this.options)
  }

  async refreshSafe(signal?: AbortSignal): Promise<GitRefreshResult> {
    try {
      return { ok: true, state: await this.refresh(signal) }
    } catch (error) {
      return { ok: false, error: toPublicErrorDto(error) }
    }
  }

  async refresh(signal?: AbortSignal): Promise<GitRepositoryState> {
    const projectRoot = await realpath(this.projectRoot)
    let repositoryRoot: string
    try {
      repositoryRoot = await realpath((await this.runRaw(
        projectRoot,
        ['rev-parse', '--show-toplevel'],
        { signal, maxOutputBytes: 16 * 1024 }
      )).trim())
    } catch (error) {
      if (isActualNotRepositoryError(error)) return notRepositoryState(projectRoot)
      throw error
    }

    if (repositoryRoot !== projectRoot) {
      const authorizedRoot = this.options.authorizedRepositoryRoot === undefined
        ? null
        : await realpath(this.options.authorizedRepositoryRoot)
      if (authorizedRoot !== repositoryRoot) return trustRequiredState(projectRoot, repositoryRoot)
    }

    const [headText, branchText, statusText, indexText] = await Promise.all([
      this.runRaw(repositoryRoot, ['rev-parse', '--verify', '--quiet', 'HEAD'], {
        signal,
        maxOutputBytes: 64 * 1024
      }),
      this.runRaw(repositoryRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD'], {
        signal,
        maxOutputBytes: 64 * 1024
      }),
      this.runRaw(repositoryRoot, ['status', '--porcelain=v2', '-z', '--untracked-files=all', '--find-renames'], {
        signal,
        maxOutputBytes: this.options.maxStatusBytes
      }),
      this.runRaw(repositoryRoot, ['ls-files', '--stage', '-z'], {
        signal,
        maxOutputBytes: this.options.maxStatusBytes
      })
    ])
    const headOid = trimNullable(headText)
    const branch = trimNullable(branchText)
    const records = parseStatus(statusText)
    const truncated = records.length > this.options.maxStatusFiles
    const visibleRecords = await this.coalesceExactWorktreeRenames(
      repositoryRoot,
      records.slice(0, this.options.maxStatusFiles),
      indexText,
      signal
    )
    const indexTreeOid = records.some((record) => record.conflicted)
      ? null
      : trimNullable(await this.runRaw(repositoryRoot, ['write-tree'], {
          signal,
          maxOutputBytes: 64 * 1024
        }))
    const upstream = headOid === null || branch === null
      ? null
      : trimNullable(await this.runRaw(
          repositoryRoot,
          ['for-each-ref', '--format=%(upstream:short)', `refs/heads/${branch}`],
          { signal, maxOutputBytes: 64 * 1024 }
        ))
    const [ahead, behind] = headOid !== null && upstream !== null
      ? await this.readAheadBehind(repositoryRoot, signal)
      : [0, 0]
    const files = await mapWithConcurrency(
      visibleRecords,
      CONTENT_HASH_WORKERS,
      (record) => this.mapStatusFile(repositoryRoot, record, signal)
    )
    const indexFingerprint = digest(indexText)
    const worktreeFingerprint = digest([
      statusText,
      truncated ? `truncated:${records.length}` : 'complete',
      ...files.map((file) => `${file.path}\0${file.fingerprint}`)
    ].join('\0'))
    const statusRevision = digest([
      repositoryRoot,
      headOid ?? 'unborn',
      indexTreeOid ?? 'unmerged-index',
      indexFingerprint,
      worktreeFingerprint
    ].join('\0'))

    return {
      kind: 'repository',
      projectRoot,
      repositoryRoot,
      headOid,
      branch,
      detached: headOid !== null && branch === null,
      upstream,
      ahead,
      behind,
      indexTreeOid,
      indexFingerprint,
      worktreeFingerprint,
      statusRevision,
      files,
      truncated,
      refreshedAt: Date.now(),
      lastError: null
    }
  }

  async getDiff(request: GitDiffRequest, signal?: AbortSignal): Promise<GitDiffResult> {
    let state: GitRepositoryState | null = null
    try {
      state = await this.refresh(signal)
      if (state.kind === 'not-repository' || state.repositoryRoot === null) {
        return emptyDiff(request, 'not-repository', state, errorDto('not-repository', 'Project is not a Git repository.'))
      }
      if (state.kind === 'trust-required') {
        return emptyDiff(request, 'trust-required', state, trustRequiredError())
      }
      const path = validateRepositoryPath(request.path, state.repositoryRoot)
      const statusFile = state.files.find((file) => file.path === path)
      if (statusFile === undefined) {
        return emptyDiffFromPath(
          request.kind,
          path,
          'error',
          state,
          errorDto('stale', 'Requested path is not present in the current bounded Git status projection.')
        )
      }
      const stale = staleError(request, state)
      if (stale !== null) return emptyDiff(request, 'error', state, stale)
      if (statusFile.conflicted) {
        return emptyDiffFromPath(request.kind, path, 'conflict', state, errorDto('conflict', 'Conflicted files require an explicit conflict workflow.'))
      }

      let result: GitDiffResult
      if (statusFile?.state === 'untracked') {
        result = request.kind === 'working'
          ? await this.readUntrackedDiff(path, state, signal)
          : {
              ...emptyDiffFromPath(request.kind, path, 'ready', state, null),
              revision: diffRevision(request.kind, state, path, ''),
              byteCount: 0
            }
      } else {
        const pathspecs = validatedPathspecsForStatusFile(path, statusFile, state.repositoryRoot)
        const baseArgs = request.kind === 'working'
          ? ['diff', '--no-ext-diff', '--binary', '--find-renames', '--full-index']
          : ['diff', '--cached', '--no-ext-diff', '--binary', '--find-renames', '--full-index', await this.diffBase(state, signal)]
        const patch = await this.runRaw(state.repositoryRoot, [...baseArgs, '--', ...pathspecs], {
          signal,
          maxOutputBytes: this.options.maxDiffBytes
        })
        result = patch.length === 0
          ? {
              ...emptyDiffFromPath(request.kind, path, 'ready', state, null),
              revision: diffRevision(request.kind, state, path, patch),
              byteCount: 0
            }
          : this.parseSingleFileDiff(request.kind, path, patch, state, statusFile)
      }

      assertNotAborted(signal)
      const settled = await this.refresh(signal)
      if (!sameRepositoryIdentity(state, settled)) {
        return emptyDiffFromPath(request.kind, path, 'error', settled, errorDto('stale', 'Repository identity changed while the diff was read.'))
      }
      return result
    } catch (error) {
      const dto = toErrorDto(error)
      const fallback = dto.code === 'aborted' || dto.code === 'timeout'
        ? state
        : await this.safeRefresh()
      const resultState = dto.code === 'output-limit'
        ? 'oversized'
        : dto.code === 'unsupported'
          ? 'unsupported'
          : dto.code === 'trust-required'
            ? 'trust-required'
            : dto.code === 'conflict'
              ? 'conflict'
              : 'error'
      return emptyDiff(request, resultState, fallback, toPublicErrorDto(error))
    }
  }

  async mutateFile(request: GitFileMutationRequest, signal?: AbortSignal): Promise<GitMutationResult> {
    let discovered: GitRepositoryState
    try {
      discovered = await this.refresh(signal)
    } catch (error) {
      return {
        ok: false,
        action: request.action,
        path: request.path,
        error: toPublicErrorDto(error),
        state: null
      }
    }
    if (discovered.kind !== 'repository' || discovered.repositoryRoot === null) {
      return {
        ok: false,
        action: request.action,
        path: request.path,
        error: discovered.kind === 'trust-required' ? trustRequiredError() : errorDto('not-repository', 'Project is not a Git repository.'),
        state: discovered
      }
    }
    try {
      const path = validateRepositoryPath(request.path, discovered.repositoryRoot)
      const stale = staleMutationError(request, discovered, path)
      if (stale !== null) throw new GitRunError(stale)
    } catch (error) {
      return {
        ok: false,
        action: request.action,
        path: request.path,
        error: toPublicErrorDto(error),
        state: discovered
      }
    }
    return this.resolveQueue(discovered.repositoryRoot).run(async () => {
      let latest: GitRepositoryState | null = null
      try {
        latest = await this.refresh(signal)
        if (latest.kind !== 'repository' || latest.repositoryRoot === null) {
          throw new GitRunError(latest.kind === 'trust-required' ? trustRequiredError() : errorDto('not-repository', 'Project is not a Git repository.'))
        }
        const path = validateRepositoryPath(request.path, latest.repositoryRoot)
        const stale = staleMutationError(request, latest, path)
        if (stale !== null) throw new GitRunError(stale)
        const statusFile = latest.files.find((file) => file.path === path)!
        const pathspecs = validatedPathspecsForStatusFile(path, statusFile, latest.repositoryRoot)
        const before = await this.assertImmediateMutationIdentity(request, latest.repositoryRoot, path, signal)
        assertNotAborted(signal)
        if (request.action === 'stage') {
          // A pure worktree rename still has the old path in the index, so both validated sides
          // must be updated atomically. A staged rename with later working edits only refreshes
          // the new path and preserves the rename already recorded in the index.
          const args = statusFile.worktreeChange === 'renamed'
            ? ['add', '-A', '--', ...pathspecs]
            : ['add', '--', path]
          await this.runRaw(latest.repositoryRoot, args, {
            signal,
            maxOutputBytes: 64 * 1024
          })
        } else if (latest.headOid === null) {
          await this.runRaw(latest.repositoryRoot, ['rm', '--cached', '--force', '--', ...pathspecs], {
            signal,
            maxOutputBytes: 64 * 1024
          })
        } else {
          await this.runRaw(latest.repositoryRoot, ['reset', '--quiet', 'HEAD', '--', ...pathspecs], {
            signal,
            maxOutputBytes: 64 * 1024
          })
        }
        const settled = await this.refresh(signal)
        await this.assertPostMutationIdentity(request, latest, settled, path, before, signal)
        return { ok: true, action: request.action, path, state: settled }
      } catch (error) {
        const dto = toErrorDto(error)
        const settled = dto.code === 'aborted' || dto.code === 'timeout'
          ? latest
          : await this.safeRefresh()
        return {
          ok: false,
          action: request.action,
          path: request.path,
          error: toPublicErrorDto(error),
          state: settled ?? latest
        }
      }
    })
  }

  private resolveQueue(repositoryRoot: string): SerialQueue {
    let queue = repositoryQueues.get(repositoryRoot)
    if (queue === undefined) {
      queue = new SerialQueue()
      repositoryQueues.set(repositoryRoot, queue)
    }
    return queue
  }

  private async assertImmediateMutationIdentity(
    request: GitFileMutationRequest,
    repositoryRoot: string,
    path: string,
    signal?: AbortSignal
  ): Promise<MutationContentFence> {
    const immediate = await this.refresh(signal)
    if (immediate.kind !== 'repository' || immediate.repositoryRoot !== repositoryRoot) {
      throw new GitRunError(errorDto('stale', 'Repository identity changed immediately before the Git mutation.'))
    }
    const validatedPath = validateRepositoryPath(path, immediate.repositoryRoot)
    const stale = staleMutationError(request, immediate, validatedPath)
    if (stale !== null) throw new GitRunError(errorDto('stale', 'Repository or file identity changed immediately before the Git mutation.'))
    return {
      rawOid: (await this.readExactWorktreeContent(repositoryRoot, path, false, signal))?.rawOid ?? null
    }
  }

  private async assertPostMutationIdentity(
    request: GitFileMutationRequest,
    beforeState: GitRepositoryState,
    settled: GitRepositoryState,
    path: string,
    before: MutationContentFence,
    signal?: AbortSignal
  ): Promise<void> {
    if (
      settled.kind !== 'repository' ||
      settled.repositoryRoot !== beforeState.repositoryRoot ||
      settled.headOid !== beforeState.headOid
    ) {
      throw new GitRunError(errorDto('stale', 'Repository identity diverged during the Git mutation.'))
    }
    const after = await this.readExactWorktreeContent(
      settled.repositoryRoot!,
      path,
      request.action === 'stage',
      signal
    )
    const rawOid = after?.rawOid ?? null
    if (rawOid !== before.rawOid) {
      throw new GitRunError(errorDto('stale', 'File content diverged during the Git mutation.'))
    }
    if (request.action === 'stage') {
      const expectedIndexOid = after?.filteredOid ?? null
      const actualIndexOid = await this.readIndexOid(settled.repositoryRoot!, path, signal)
      if (expectedIndexOid !== actualIndexOid) {
        throw new GitRunError(errorDto('stale', 'The staged content diverged from the confirmed working content.'))
      }
    }
    const [rootText, headText] = await Promise.all([
      this.runRaw(settled.repositoryRoot!, ['rev-parse', '--show-toplevel'], { signal, maxOutputBytes: 16 * 1024 }),
      this.runRaw(settled.repositoryRoot!, ['rev-parse', '--verify', '--quiet', 'HEAD'], { signal, maxOutputBytes: 64 * 1024 })
    ])
    if (await realpath(rootText.trim()) !== settled.repositoryRoot || trimNullable(headText) !== settled.headOid) {
      throw new GitRunError(errorDto('stale', 'Repository identity diverged after the Git mutation.'))
    }
  }

  private async safeRefresh(): Promise<GitRepositoryState | null> {
    try {
      return await this.refresh()
    } catch {
      return null
    }
  }

  private async mapStatusFile(repositoryRoot: string, record: StatusRecord, signal?: AbortSignal): Promise<GitFileChange> {
    const path = validateRepositoryPath(record.path, repositoryRoot)
    const originalPath = record.originalPath === null
      ? null
      : validateRepositoryPath(record.originalPath, repositoryRoot)
    const indexChange = record.untracked ? 'unmodified' : mapStatusCode(record.indexCode)
    const worktreeChange = record.untracked ? 'untracked' : mapStatusCode(record.worktreeCode)
    const contentIdentity = worktreeChange === 'deleted'
      ? 'missing'
      : await this.readAutomaticWorktreeIdentity(repositoryRoot, path, signal)
    const fingerprint = digest([
      path,
      originalPath ?? '',
      record.indexCode,
      record.worktreeCode,
      contentIdentity
    ].join('\0'))
    return {
      id: digest(`${originalPath ?? ''}\0${path}`).slice(0, 24),
      path,
      originalPath,
      state: record.conflicted
        ? 'conflicted'
        : record.untracked
          ? 'untracked'
          : record.indexCode !== '.' && record.worktreeCode !== '.'
            ? 'mixed'
            : record.indexCode !== '.'
              ? 'staged'
              : 'unstaged',
      indexChange,
      worktreeChange,
      conflicted: record.conflicted,
      fingerprint
    }
  }

  private async readAutomaticWorktreeIdentity(
    repositoryRoot: string,
    path: string,
    signal?: AbortSignal
  ): Promise<string> {
    assertSafeNoFollowPlatform()
    const absolutePath = resolve(repositoryRoot, path)
    let before
    try {
      before = await lstat(absolutePath, { bigint: true })
    } catch (error) {
      if (isFileNotFoundError(error)) return 'missing'
      throw error
    }
    const beforeIdentity = toFileIdentity(before)
    if (before.isSymbolicLink()) {
      const linkBytes = await readStableSymbolicLink(absolutePath, beforeIdentity)
      const oid = await this.hashBytesFromStdin(repositoryRoot, ['hash-object', '--no-filters', '--stdin'], linkBytes, signal)
      return `symlink\0${serializeFileIdentity(beforeIdentity)}\0${oid}`
    }
    if (!before.isFile()) {
      await assertPathIdentityUnchanged(absolutePath, beforeIdentity)
      return `unsupported:${worktreeFileKind(before)}\0${serializeFileIdentity(beforeIdentity)}`
    }
    if (before.size > BigInt(this.options.maxAutomaticFingerprintBytes)) {
      await assertPathIdentityUnchanged(absolutePath, beforeIdentity)
      return `regular:stat\0${serializeFileIdentity(beforeIdentity)}`
    }
    const exact = await this.readOpenedRegularFile(
      repositoryRoot,
      path,
      absolutePath,
      beforeIdentity,
      Number(before.size),
      false,
      signal
    )
    return `regular:exact\0${serializeFileIdentity(beforeIdentity)}\0${exact.rawOid}`
  }

  private async readExactWorktreeContent(
    repositoryRoot: string,
    path: string,
    includeFilteredOid: boolean,
    signal?: AbortSignal,
    maxBytes?: number
  ): Promise<ExactWorktreeContent | null> {
    assertSafeNoFollowPlatform()
    const absolutePath = resolve(repositoryRoot, path)
    let before
    try {
      before = await lstat(absolutePath, { bigint: true })
    } catch (error) {
      if (isFileNotFoundError(error)) return null
      throw error
    }
    const beforeIdentity = toFileIdentity(before)
    if (before.isSymbolicLink()) {
      const linkBytes = await readStableSymbolicLink(absolutePath, beforeIdentity)
      const rawOid = await this.hashBytesFromStdin(
        repositoryRoot,
        ['hash-object', '--no-filters', '--stdin'],
        linkBytes,
        signal
      )
      return { kind: 'symlink', mode: '120000', rawOid, filteredOid: rawOid }
    }
    if (!before.isFile()) {
      throw new GitRunError(errorDto('unsupported', `Git worktree entry type ${worktreeFileKind(before)} is not supported.`))
    }
    if (maxBytes !== undefined && before.size > BigInt(maxBytes)) {
      await assertPathIdentityUnchanged(absolutePath, beforeIdentity)
      return null
    }
    if (before.size > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new GitRunError(errorDto('output-limit', 'Git worktree file exceeds the safe exact-hash size limit.'))
    }
    return await this.readOpenedRegularFile(
      repositoryRoot,
      path,
      absolutePath,
      beforeIdentity,
      Number(before.size),
      includeFilteredOid,
      signal
    )
  }

  private async readOpenedRegularFile(
    repositoryRoot: string,
    path: string,
    absolutePath: string,
    expectedIdentity: FileIdentity,
    expectedSize: number,
    includeFilteredOid: boolean,
    signal?: AbortSignal
  ): Promise<ExactWorktreeContent> {
    await this.testHooks.beforeNoFollowOpen?.(absolutePath)
    let handle: FileHandle
    try {
      handle = await open(absolutePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
    } catch (error) {
      if (isNoFollowRaceError(error)) {
        throw new GitRunError(errorDto('stale', 'Git worktree file identity changed before its no-follow open.'))
      }
      throw error
    }
    try {
      const opened = await handle.stat({ bigint: true })
      if (!opened.isFile() || !sameFileIdentity(expectedIdentity, toFileIdentity(opened))) {
        throw new GitRunError(errorDto('stale', 'Git worktree file identity changed before it was opened.'))
      }
      const hashes = await this.hashOpenedRegularFile(
        repositoryRoot,
        path,
        handle,
        expectedSize,
        includeFilteredOid,
        signal
      )
      const after = await handle.stat({ bigint: true })
      if (!after.isFile() || !sameFileIdentity(expectedIdentity, toFileIdentity(after))) {
        throw new GitRunError(errorDto('stale', 'Git worktree file identity changed while it was hashed.'))
      }
      await assertPathIdentityUnchanged(absolutePath, expectedIdentity)
      return {
        kind: 'regular',
        mode: (Number(opened.mode) & 0o111) === 0 ? '100644' : '100755',
        rawOid: hashes.rawOid,
        filteredOid: hashes.filteredOid
      }
    } finally {
      await handle.close()
    }
  }

  private async readIndexOid(repositoryRoot: string, path: string, signal?: AbortSignal): Promise<string | null> {
    const output = await this.runRaw(repositoryRoot, ['ls-files', '--stage', '-z', '--', path], {
      signal,
      maxOutputBytes: 64 * 1024
    })
    if (output.length === 0) return null
    const records = output.split('\0').filter((record) => record.length > 0)
    if (records.length !== 1) return null
    const match = /^\d+ ((?:[0-9a-f]{40}|[0-9a-f]{64})) 0\t/s.exec(records[0]!)
    return match?.[1] ?? null
  }

  private async coalesceExactWorktreeRenames(
    repositoryRoot: string,
    records: StatusRecord[],
    indexText: string,
    signal?: AbortSignal
  ): Promise<StatusRecord[]> {
    const deletions = records.filter((record) =>
      !record.conflicted && !record.untracked && record.indexCode === '.' && record.worktreeCode === 'D'
    )
    const additions = records.filter((record) => record.untracked)
    if (deletions.length === 0 || additions.length === 0) return records

    const indexEntries = parseIndexEntries(indexText)
    const deletionsByIdentity = new Map<string, StatusRecord[]>()
    for (const record of deletions) {
      const path = validateRepositoryPath(record.path, repositoryRoot)
      const entry = indexEntries.get(path)
      if (entry === undefined) continue
      const identity = `${entry.mode}\0${entry.oid}`
      const candidates = deletionsByIdentity.get(identity) ?? []
      candidates.push(record)
      deletionsByIdentity.set(identity, candidates)
    }
    const additionsWithIdentity = await mapWithConcurrency(additions, CONTENT_HASH_WORKERS, async (record) => {
      const path = validateRepositoryPath(record.path, repositoryRoot)
      const exact = await this.readExactWorktreeContent(
        repositoryRoot,
        path,
        true,
        signal,
        this.options.maxAutomaticFingerprintBytes
      )
      return { record, identity: exact === null ? null : `${exact.mode}\0${exact.filteredOid}` }
    })
    const additionsByIdentity = new Map<string, StatusRecord[]>()
    for (const candidate of additionsWithIdentity) {
      if (candidate.identity === null) continue
      const matches = additionsByIdentity.get(candidate.identity) ?? []
      matches.push(candidate.record)
      additionsByIdentity.set(candidate.identity, matches)
    }

    const renamesByOldPath = new Map<string, StatusRecord>()
    const renamedNewPaths = new Set<string>()
    for (const [identity, oldCandidates] of deletionsByIdentity) {
      const newCandidates = additionsByIdentity.get(identity)
      if (oldCandidates.length !== 1 || newCandidates?.length !== 1) continue
      const oldRecord = oldCandidates[0]!
      const newRecord = newCandidates[0]!
      renamesByOldPath.set(oldRecord.path, {
        path: newRecord.path,
        originalPath: oldRecord.path,
        indexCode: '.',
        worktreeCode: 'R',
        conflicted: false,
        untracked: false
      })
      renamedNewPaths.add(newRecord.path)
    }
    if (renamesByOldPath.size === 0) return records

    const result: StatusRecord[] = []
    for (const record of records) {
      const rename = renamesByOldPath.get(record.path)
      if (rename !== undefined) result.push(rename)
      else if (!renamedNewPaths.has(record.path)) result.push(record)
    }
    return result
  }

  private async readAheadBehind(repositoryRoot: string, signal?: AbortSignal): Promise<[number, number]> {
    const output = await this.runRaw(
      repositoryRoot,
      ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'],
      { signal, maxOutputBytes: 64 * 1024 }
    )
    const match = /^(\d+)\s+(\d+)\s*$/.exec(output)
    if (match === null) throw new GitRunError(errorDto('git-error', 'Git returned an invalid ahead/behind count.'))
    return [Number(match[1]), Number(match[2])]
  }

  private async diffBase(state: GitRepositoryState, signal?: AbortSignal): Promise<string> {
    if (state.headOid !== null) return state.headOid
    const emptyTree = await this.runRaw(
      state.repositoryRoot!,
      ['hash-object', '-t', 'tree', '/dev/null'],
      { signal, maxOutputBytes: 1024 }
    )
    return emptyTree.trim()
  }

  private async readUntrackedDiff(
    path: string,
    state: GitRepositoryState,
    signal?: AbortSignal
  ): Promise<GitDiffResult> {
    const repositoryRoot = state.repositoryRoot!
    const absolutePath = resolve(repositoryRoot, path)
    assertNotAborted(signal)
    assertSafeNoFollowPlatform()
    const before = await lstat(absolutePath, { bigint: true })
    if (!before.isFile()) {
      return emptyDiffFromPath('working', path, 'unsupported', state, errorDto('unsupported', 'Only regular untracked files can be rendered.'))
    }
    let handle: FileHandle
    try {
      handle = await open(absolutePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
    } catch (error) {
      if (isNoFollowRaceError(error)) {
        throw new GitRunError(errorDto('stale', 'Untracked file identity changed before its no-follow open.'))
      }
      throw error
    }
    try {
      const opened = await handle.stat({ bigint: true })
      if (!opened.isFile() || !sameFileIdentity(toFileIdentity(before), toFileIdentity(opened))) {
        throw new GitRunError(errorDto('stale', 'Untracked file identity changed before it was read.'))
      }
      const bytes = await readBounded(handle, this.options.maxDiffBytes, signal)
      const after = await handle.stat({ bigint: true })
      if (!sameFileIdentity(toFileIdentity(opened), toFileIdentity(after))) {
        throw new GitRunError(errorDto('stale', 'Untracked file identity changed while it was read.'))
      }
      await assertPathIdentityUnchanged(absolutePath, toFileIdentity(opened))
      if (bytes === null) {
        return emptyDiffFromPath('working', path, 'oversized', state, errorDto('output-limit', 'Untracked file exceeds the configured diff byte budget.'))
      }
      if (bytes.includes(0)) {
        return emptyDiffFromPath('working', path, 'binary', state, errorDto('unsupported', 'Binary diffs are not rendered.'))
      }
      let text: string
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      } catch {
        return emptyDiffFromPath('working', path, 'binary', state, errorDto('unsupported', 'Non-UTF-8 diffs are not rendered.'))
      }
      return this.buildUntrackedTextDiff(path, text, state)
    } finally {
      await handle.close()
    }
  }

  private buildUntrackedTextDiff(path: string, text: string, state: GitRepositoryState): GitDiffResult {
    const hasFinalNewline = text.endsWith('\n')
    const contentLines = text.length === 0
      ? []
      : (hasFinalNewline ? text.slice(0, -1) : text).split('\n')
    if (contentLines.length + (text.length > 0 && !hasFinalNewline ? 1 : 0) > this.options.maxDiffLines) {
      return emptyDiffFromPath('working', path, 'oversized', state, errorDto('output-limit', 'Diff exceeds the configured line budget.'))
    }
    const lines: GitDiffLine[] = contentLines.map((content, index) => ({
      kind: 'add',
      oldLine: null,
      newLine: index + 1,
      content
    }))
    if (text.length > 0 && !hasFinalNewline) {
      lines.push({ kind: 'meta', oldLine: null, newLine: null, content: 'No newline at end of file' })
    }
    const hunkHeader = `@@ -0,0 +1,${contentLines.length} @@`
    const fileId = digest(`working\0\0${path}`).slice(0, 24)
    const hunks: GitDiffHunk[] = contentLines.length === 0
      ? []
      : [{
          id: digest(`${fileId}\0${hunkHeader}\0${lines.map((line) => `${line.kind}:${line.content}`).join('\n')}`).slice(0, 24),
          header: hunkHeader,
          oldStart: 0,
          oldLines: 0,
          newStart: 1,
          newLines: contentLines.length,
          lines
        }]
    const patch = [
      `diff --git /dev/null ${JSON.stringify(path)}`,
      'new file mode 100644',
      '--- /dev/null',
      `+++ ${JSON.stringify(path)}`,
      ...(hunks.length === 0
        ? []
        : [hunkHeader, ...contentLines.map((line) => `+${line}`), ...(hasFinalNewline ? [] : ['\\ No newline at end of file'])])
    ].join('\n')
    const byteCount = Buffer.byteLength(patch)
    const lineCount = lines.length
    if (
      byteCount > this.options.maxDiffBytes ||
      1 > this.options.maxDiffFiles ||
      hunks.length > this.options.maxDiffHunks ||
      lineCount > this.options.maxDiffLines
    ) {
      return {
        ...emptyDiffFromPath('working', path, 'oversized', state, errorDto('output-limit', 'Diff exceeds the configured structural budget.')),
        revision: diffRevision('working', state, path, patch),
        byteCount,
        fileCount: 1,
        hunkCount: hunks.length,
        lineCount
      }
    }
    const file: GitDiffFile = { id: fileId, path, originalPath: null, change: 'added', hunks }
    return {
      kind: 'working',
      path,
      state: 'ready',
      revision: diffRevision('working', state, path, patch),
      headOid: state.headOid,
      indexTreeOid: state.indexTreeOid,
      worktreeFingerprint: state.worktreeFingerprint,
      files: [file],
      byteCount,
      fileCount: 1,
      hunkCount: hunks.length,
      lineCount,
      error: null
    }
  }

  private parseSingleFileDiff(
    kind: GitDiffKind,
    path: string,
    patch: string,
    state: GitRepositoryState,
    statusFile: GitFileChange | undefined
  ): GitDiffResult {
    const byteCount = Buffer.byteLength(patch)
    if (/(?:^|\n)(?:GIT binary patch|Binary files )/.test(patch)) {
      return {
        ...emptyDiffFromPath(kind, path, 'binary', state, errorDto('unsupported', 'Binary diffs are not rendered.')),
        revision: diffRevision(kind, state, path, patch),
        byteCount,
        fileCount: 1
      }
    }
    let parsed: { hunks: GitDiffHunk[]; hasRenameHeader: boolean; hasModeOnlyChange: boolean }
    try {
      parsed = parseSingleFilePatch(kind, path, patch, this.options.maxDiffHunks, this.options.maxDiffLines)
    } catch (error) {
      const dto = toErrorDto(error)
      return {
        ...emptyDiffFromPath(kind, path, dto.code === 'output-limit' ? 'oversized' : 'unsupported', state, dto),
        revision: diffRevision(kind, state, path, patch),
        byteCount
      }
    }
    const change = diffChangeForStatus(kind, statusFile, parsed.hasRenameHeader)
    if (change === null || (parsed.hasModeOnlyChange && parsed.hunks.length === 0 && change !== 'renamed' && change !== 'added' && change !== 'deleted')) {
      return {
        ...emptyDiffFromPath(kind, path, 'unsupported', state, errorDto('unsupported', 'This diff shape is not supported.')),
        revision: diffRevision(kind, state, path, patch),
        byteCount,
        fileCount: 1
      }
    }
    const originalPath = change === 'renamed' ? statusFile?.originalPath ?? null : null
    if (change === 'renamed' && originalPath === null) {
      return {
        ...emptyDiffFromPath(kind, path, 'unsupported', state, errorDto('unsupported', 'Rename identity is unavailable.')),
        revision: diffRevision(kind, state, path, patch),
        byteCount,
        fileCount: 1
      }
    }
    const lineCount = parsed.hunks.reduce((total, hunk) => total + hunk.lines.length, 0)
    if (
      1 > this.options.maxDiffFiles ||
      parsed.hunks.length > this.options.maxDiffHunks ||
      lineCount > this.options.maxDiffLines
    ) {
      return {
        ...emptyDiffFromPath(kind, path, 'oversized', state, errorDto('output-limit', 'Diff exceeds the configured structural budget.')),
        revision: diffRevision(kind, state, path, patch),
        byteCount,
        fileCount: 1,
        hunkCount: parsed.hunks.length,
        lineCount
      }
    }
    const fileId = digest(`${kind}\0${originalPath ?? ''}\0${path}`).slice(0, 24)
    const hunks = parsed.hunks.map((hunk) => ({
      ...hunk,
      id: digest(`${fileId}\0${hunk.header}\0${hunk.lines.map((line) => `${line.kind}:${line.content}`).join('\n')}`).slice(0, 24)
    }))
    return {
      kind,
      path,
      state: 'ready',
      revision: diffRevision(kind, state, path, patch),
      headOid: state.headOid,
      indexTreeOid: state.indexTreeOid,
      worktreeFingerprint: state.worktreeFingerprint,
      files: [{ id: fileId, path, originalPath, change, hunks }],
      byteCount,
      fileCount: 1,
      hunkCount: hunks.length,
      lineCount,
      error: null
    }
  }

  private async hashOpenedRegularFile(
    repositoryRoot: string,
    path: string,
    handle: FileHandle,
    expectedSize: number,
    includeFilteredOid: boolean,
    signal?: AbortSignal
  ): Promise<{ rawOid: string; filteredOid: string }> {
    const outputs = await this.runHashChildren(
      repositoryRoot,
      includeFilteredOid
        ? [
            ['hash-object', '--no-filters', '--stdin'],
            ['hash-object', `--path=${path}`, '--stdin']
          ]
        : [['hash-object', '--no-filters', '--stdin']],
      async (writeChunk) => {
        const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(expectedSize, 1)))
        let offset = 0
        while (offset < expectedSize) {
          assertNotAborted(signal)
          const length = Math.min(buffer.length, expectedSize - offset)
          const { bytesRead } = await handle.read(buffer, 0, length, offset)
          if (bytesRead === 0) {
            throw new GitRunError(errorDto('stale', 'Git worktree file became shorter while it was hashed.'))
          }
          offset += bytesRead
          await writeChunk(buffer.subarray(0, bytesRead))
        }
      },
      signal
    )
    return { rawOid: outputs[0]!, filteredOid: outputs[1] ?? outputs[0]! }
  }

  private async hashBytesFromStdin(
    repositoryRoot: string,
    args: string[],
    bytes: Uint8Array,
    signal?: AbortSignal
  ): Promise<string> {
    const outputs = await this.runHashChildren(
      repositoryRoot,
      [args],
      async (writeChunk) => writeChunk(bytes),
      signal
    )
    return outputs[0]!
  }

  private async runHashChildren(
    cwd: string,
    argsList: string[][],
    produceInput: (writeChunk: (chunk: Uint8Array) => Promise<void>) => Promise<void>,
    signal?: AbortSignal
  ): Promise<string[]> {
    assertSafeNoFollowPlatform()
    assertNotAborted(signal)
    const children: HashChild[] = []
    let failure: GitRunError | null = null
    const stop = (error: GitRunError): void => {
      if (failure !== null) return
      failure = error
      for (const child of children) killHashChild(child.process)
    }
    const onAbort = (): void => stop(new GitRunError(errorDto('aborted', 'Git hashing was aborted.')))
    signal?.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => {
      stop(new GitRunError(errorDto('timeout', 'Git hashing timed out.')))
    }, this.options.timeoutMs)
    try {
      for (const args of argsList) {
        const childProcess = spawn(this.options.gitBinary, args, {
          cwd,
          detached: true,
          env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
          stdio: ['pipe', 'pipe', 'pipe']
        })
        const child: HashChild = {
          process: childProcess,
          stdout: [],
          stderr: [],
          outputBytes: 0,
          result: Promise.resolve({ code: null, error: null })
        }
        children.push(child)
        const countOutput = (target: Buffer[], chunk: Buffer): void => {
          child.outputBytes += chunk.byteLength
          if (child.outputBytes > 64 * 1024) {
            stop(new GitRunError(errorDto('output-limit', 'Git hash output exceeded the configured byte budget.')))
            return
          }
          target.push(chunk)
        }
        childProcess.stdout.on('data', (chunk: Buffer) => countOutput(child.stdout, chunk))
        childProcess.stderr.on('data', (chunk: Buffer) => countOutput(child.stderr, chunk))
        child.result = new Promise((resolveResult) => {
          let spawnError: Error | null = null
          childProcess.once('error', (error) => {
            spawnError = error
          })
          childProcess.once('close', (code) => {
            if (failure === null && (spawnError !== null || code !== 0)) {
              const stderr = Buffer.concat(child.stderr).toString('utf8')
              stop(new GitRunError(errorDto(
                'git-error',
                boundedGitMessage(spawnError ?? new Error(stderr || `Git hashing exited ${code ?? 'without a status'}.`)),
                stderr.length
              )))
            }
            resolveResult({ code, error: spawnError })
          })
        })
      }

      await produceInput(async (chunk) => {
        if (failure !== null) throw failure
        await Promise.all(children.map((child) => writeHashChunk(child.process, chunk)))
        if (failure !== null) throw failure
      })
      if (failure !== null) throw failure
      await Promise.all(children.map((child) => endHashInput(child.process)))
      await Promise.all(children.map((child) => child.result))
      if (failure !== null) throw failure
      return children.map((child) => {
        const oid = Buffer.concat(child.stdout).toString('utf8').trim()
        if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid)) {
          throw new GitRunError(errorDto('git-error', 'Git returned an invalid worktree object identity.'))
        }
        return oid
      })
    } catch (error) {
      if (failure === null) stop(error instanceof GitRunError ? error : new GitRunError(toErrorDto(error)))
      await Promise.all(children.map((child) => child.result))
      throw failure
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  }

  private async runRaw(cwd: string, args: string[], options: RunOptions): Promise<string> {
    assertNotAborted(options.signal)
    const controller = new AbortController()
    let exceededOutput = false
    let timedOut = false
    let outputBytes = 0
    const timeoutMs = options.timeoutMs ?? this.options.timeoutMs
    const onAbort = (): void => controller.abort()
    options.signal?.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)
    const git = simpleGit({
      baseDir: cwd,
      binary: this.options.gitBinary,
      maxConcurrentProcesses: 1,
      abort: controller.signal,
      timeout: { block: timeoutMs, stdOut: true, stdErr: true },
      trimmed: false
    })
    git.env('LC_ALL', 'C')
    git.env('LANG', 'C')
    git.outputHandler((_command, stdout, stderr) => {
      const count = (chunk: unknown): void => {
        outputBytes += Buffer.isBuffer(chunk) ? chunk.byteLength : Buffer.byteLength(String(chunk))
        if (outputBytes > options.maxOutputBytes && !controller.signal.aborted) {
          exceededOutput = true
          controller.abort()
        }
      }
      stdout.on('data', count)
      stderr.on('data', count)
    })
    try {
      return await git.raw(args)
    } catch (error) {
      if (exceededOutput) throw new GitRunError(errorDto('output-limit', 'Git output exceeded the configured byte budget.', stderrLength(error)))
      if (options.signal?.aborted) throw new GitRunError(errorDto('aborted', 'Git operation was aborted.', stderrLength(error)))
      if (timedOut || /timeout/i.test(errorMessage(error))) {
        throw new GitRunError(errorDto('timeout', 'Git operation timed out.', stderrLength(error)))
      }
      throw new GitRunError(errorDto('git-error', boundedGitMessage(error), stderrLength(error)))
    } finally {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
    }
  }
}

function parseIndexEntries(text: string): Map<string, IndexEntry> {
  const entries = new Map<string, IndexEntry>()
  for (const record of text.split('\0')) {
    if (record.length === 0) continue
    const match = /^(\d+) ((?:[0-9a-f]{40}|[0-9a-f]{64})) ([0-3])\t(.*)$/s.exec(record)
    if (match === null) throw new GitRunError(errorDto('git-error', 'Git returned an invalid index entry.'))
    if (match[3] === '0') entries.set(match[4]!, { mode: match[1]!, oid: match[2]! })
  }
  return entries
}

function parseStatus(text: string): StatusRecord[] {
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

function statusRecord(path: string, originalPath: string | null, xy: string): StatusRecord {
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

function mapStatusCode(code: string): GitChangeKind {
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

function diffChangeForStatus(
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

function parseSingleFilePatch(
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

function validatedPathspecsForStatusFile(
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

function validateRepositoryPath(path: string, repositoryRoot: string | null): string {
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

function staleError(request: GitDiffRequest, state: GitRepositoryState): GitErrorDto | null {
  if (
    state.repositoryRoot !== request.expectedRepositoryRoot ||
    state.headOid !== request.expectedHeadOid ||
    state.indexTreeOid !== request.expectedIndexTreeOid ||
    state.statusRevision !== request.expectedStatusRevision
  ) {
    return errorDto('stale', 'Repository state changed before the diff was read.')
  }
  return null
}

function staleMutationError(
  request: GitFileMutationRequest,
  state: GitRepositoryState,
  path: string
): GitErrorDto | null {
  const statusFile = state.files.find((file) => file.path === path)
  if (statusFile === undefined || statusFile.fingerprint !== request.expectedFileFingerprint) {
    return errorDto('stale', 'Requested file is missing or changed in the current bounded Git status projection.')
  }
  if (
    state.repositoryRoot !== request.expectedRepositoryRoot ||
    state.headOid !== request.expectedHeadOid ||
    state.indexTreeOid !== request.expectedIndexTreeOid ||
    state.indexFingerprint !== request.expectedIndexFingerprint ||
    state.worktreeFingerprint !== request.expectedWorktreeFingerprint ||
    state.statusRevision !== request.expectedStatusRevision
  ) {
    return errorDto('stale', 'Repository state changed before the Git mutation.')
  }
  return null
}

function sameRepositoryIdentity(before: GitRepositoryState, after: GitRepositoryState): boolean {
  return before.kind === 'repository' &&
    after.kind === 'repository' &&
    before.repositoryRoot === after.repositoryRoot &&
    before.headOid === after.headOid &&
    before.indexTreeOid === after.indexTreeOid &&
    before.indexFingerprint === after.indexFingerprint &&
    before.worktreeFingerprint === after.worktreeFingerprint &&
    before.statusRevision === after.statusRevision
}

function emptyDiff(
  request: GitDiffRequest,
  stateValue: GitDiffResult['state'],
  state: GitRepositoryState | null,
  error: GitErrorDto | null
): GitDiffResult {
  return emptyDiffFromPath(request.kind, request.path, stateValue, state, error)
}

function emptyDiffFromPath(
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

function notRepositoryState(projectRoot: string): GitRepositoryState {
  return {
    kind: 'not-repository',
    projectRoot,
    repositoryRoot: null,
    headOid: null,
    branch: null,
    detached: false,
    upstream: null,
    ahead: 0,
    behind: 0,
    indexTreeOid: null,
    indexFingerprint: digest('not-repository'),
    worktreeFingerprint: digest('not-repository'),
    statusRevision: digest(`not-repository\0${projectRoot}`),
    files: [],
    truncated: false,
    refreshedAt: Date.now(),
    lastError: null
  }
}

function trustRequiredState(projectRoot: string, repositoryRoot: string): GitRepositoryState {
  const error = trustRequiredError()
  return {
    kind: 'trust-required',
    projectRoot,
    repositoryRoot,
    headOid: null,
    branch: null,
    detached: false,
    upstream: null,
    ahead: 0,
    behind: 0,
    indexTreeOid: null,
    indexFingerprint: digest(`trust-required\0${projectRoot}\0${repositoryRoot}`),
    worktreeFingerprint: digest(`trust-required\0${projectRoot}\0${repositoryRoot}`),
    statusRevision: digest(`trust-required\0${projectRoot}\0${repositoryRoot}`),
    files: [],
    truncated: false,
    refreshedAt: Date.now(),
    lastError: error
  }
}

function trustRequiredError(): GitErrorDto {
  return errorDto('trust-required', 'The Project is inside a different repository root and requires exact Main authorization.')
}

function diffRevision(kind: GitDiffKind, state: GitRepositoryState, path: string, patch: string): string {
  return digest([kind, state.headOid ?? 'unborn', state.indexTreeOid ?? 'unmerged-index', state.worktreeFingerprint, path, patch].join('\0'))
}

function trimNullable(value: string | null): string | null {
  if (value === null) return null
  const trimmed = value.trim()
  return trimmed.length === 0 ? null : trimmed
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function errorDto(code: GitErrorCode, message: string, stderrCharacters = 0): GitErrorDto {
  return {
    code,
    message: Array.from(message).slice(0, MAX_ERROR_MESSAGE_CHARACTERS).join(''),
    stderrCharacters: Number.isFinite(stderrCharacters)
      ? Math.max(0, Math.min(MAX_ERROR_STDERR_CHARACTERS, Math.trunc(stderrCharacters)))
      : 0
  }
}

function toErrorDto(error: unknown): GitErrorDto {
  if (error instanceof GitRunError) return error.dto
  return errorDto('git-error', 'Git service failed.', stderrLength(error))
}

function toPublicErrorDto(error: unknown): GitErrorDto {
  const dto = toErrorDto(error)
  const message: Record<GitErrorCode, string> = {
    'not-repository': 'Project is not a Git repository.',
    'trust-required': 'Git repository authorization is required.',
    'invalid-path': 'Git path validation failed.',
    stale: 'Git repository state changed.',
    conflict: 'Git repository has unresolved conflicts.',
    aborted: 'Git operation was aborted.',
    timeout: 'Git operation timed out.',
    'output-limit': 'Git output exceeded the configured limit.',
    unsupported: 'Git operation is unsupported.',
    'git-error': 'Git operation failed.'
  }
  return errorDto(dto.code, message[dto.code], dto.stderrCharacters)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function boundedGitMessage(error: unknown): string {
  const message = errorMessage(error).replace(/[\r\n]+/g, ' ').trim()
  return message.length === 0 ? 'Git command failed.' : message
}

function stderrLength(error: unknown): number {
  if (typeof error !== 'object' || error === null) return 0
  if ('stderr' in error) {
    const stderr = error.stderr
    if (typeof stderr === 'string') return stderr.length
    if (stderr instanceof Uint8Array) return stderr.byteLength
  }
  return errorMessage(error).length
}

function isActualNotRepositoryError(error: unknown): boolean {
  return error instanceof GitRunError &&
    error.dto.code === 'git-error' &&
    /(?:^|\b)not a git repository(?:\b|$)/i.test(error.message)
}

function isFileNotFoundError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new GitRunError(errorDto('aborted', 'Git operation was aborted.'))
}

function assertPositiveOptions(options: ResolvedOptions): void {
  for (const [name, value] of Object.entries(options)) {
    if (name === 'gitBinary' || name === 'authorizedRepositoryRoot') {
      if (value !== undefined && (typeof value !== 'string' || value.length === 0)) throw new Error(`${name} must not be empty.`)
      continue
    }
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${name} must be a positive safe integer.`)
    }
  }
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(values.length)
  let nextIndex = 0
  let stopped = false
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (!stopped) {
      const index = nextIndex
      nextIndex += 1
      if (index >= values.length) return
      try {
        results[index] = await mapper(values[index]!)
      } catch (error) {
        stopped = true
        throw error
      }
    }
  })
  await Promise.all(workers)
  return results
}

async function readBounded(handle: FileHandle, maxBytes: number, signal?: AbortSignal): Promise<Uint8Array | null> {
  const buffer = Buffer.allocUnsafe(maxBytes + 1)
  let offset = 0
  while (offset < buffer.length) {
    assertNotAborted(signal)
    const length = Math.min(64 * 1024, buffer.length - offset)
    const { bytesRead } = await handle.read(buffer, offset, length, offset)
    if (bytesRead === 0) break
    offset += bytesRead
  }
  assertNotAborted(signal)
  return offset > maxBytes ? null : buffer.subarray(0, offset)
}

function toFileIdentity(stat: {
  dev: number | bigint
  ino: number | bigint
  mode: number | bigint
  size: number | bigint
  mtimeMs?: number | bigint
  ctimeMs?: number | bigint
  mtimeNs?: bigint
  ctimeNs?: bigint
}): FileIdentity {
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    mode: String(stat.mode),
    size: String(stat.size),
    mtime: stat.mtimeNs === undefined ? String(stat.mtimeMs) : String(stat.mtimeNs),
    ctime: stat.ctimeNs === undefined ? String(stat.ctimeMs) : String(stat.ctimeNs)
  }
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtime === right.mtime &&
    left.ctime === right.ctime
}

function serializeFileIdentity(identity: FileIdentity): string {
  return [identity.dev, identity.ino, identity.mode, identity.size, identity.mtime, identity.ctime].join(':')
}

function assertSafeNoFollowPlatform(): void {
  if (process.platform !== 'linux' || !Number.isSafeInteger(fsConstants.O_NOFOLLOW) || fsConstants.O_NOFOLLOW === 0) {
    throw new GitRunError(errorDto('unsupported', 'Safe no-follow Git worktree reads require Linux O_NOFOLLOW support.'))
  }
}

async function readStableSymbolicLink(absolutePath: string, expectedIdentity: FileIdentity): Promise<Buffer> {
  let bytes: Buffer
  try {
    bytes = await readlink(absolutePath, { encoding: 'buffer' })
  } catch (error) {
    if (isNoFollowRaceError(error) || isInvalidFileTypeError(error)) {
      throw new GitRunError(errorDto('stale', 'Git symbolic-link identity changed while its link text was read.'))
    }
    throw error
  }
  await assertPathIdentityUnchanged(absolutePath, expectedIdentity)
  return bytes
}

async function assertPathIdentityUnchanged(absolutePath: string, expectedIdentity: FileIdentity): Promise<void> {
  let after
  try {
    after = await lstat(absolutePath, { bigint: true })
  } catch (error) {
    if (isFileNotFoundError(error)) {
      throw new GitRunError(errorDto('stale', 'Git worktree path disappeared while it was read.'))
    }
    throw error
  }
  if (!sameFileIdentity(expectedIdentity, toFileIdentity(after))) {
    throw new GitRunError(errorDto('stale', 'Git worktree path identity changed while it was read.'))
  }
}

function worktreeFileKind(stat: {
  isBlockDevice(): boolean
  isCharacterDevice(): boolean
  isDirectory(): boolean
  isFIFO(): boolean
  isSocket(): boolean
}): string {
  if (stat.isDirectory()) return 'directory'
  if (stat.isFIFO()) return 'fifo'
  if (stat.isSocket()) return 'socket'
  if (stat.isBlockDevice()) return 'block-device'
  if (stat.isCharacterDevice()) return 'character-device'
  return 'unknown'
}

function isNoFollowRaceError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error &&
    (error.code === 'ELOOP' || error.code === 'ENOENT' || error.code === 'ENOTDIR')
}

function isInvalidFileTypeError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EINVAL'
}

async function writeHashChunk(child: ChildProcessWithoutNullStreams, chunk: Uint8Array): Promise<void> {
  await new Promise<void>((resolveWrite, rejectWrite) => {
    child.stdin.write(chunk, (error) => error === null || error === undefined ? resolveWrite() : rejectWrite(error))
  })
}

async function endHashInput(child: ChildProcessWithoutNullStreams): Promise<void> {
  await new Promise<void>((resolveEnd, rejectEnd) => {
    child.stdin.end((error?: Error | null) => error === null || error === undefined ? resolveEnd() : rejectEnd(error))
  })
}

function killHashChild(child: ChildProcessWithoutNullStreams): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch (error) {
    if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH')) throw error
  }
}
