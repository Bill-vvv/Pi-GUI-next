import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import {
  GIT_HISTORY_MAX_CHANGED_FILES,
  GIT_HISTORY_MESSAGE_MAX_UTF8_BYTES,
  GIT_HISTORY_PAGE_SIZE,
  GIT_REPOSITORY_RELATIVE_PATH_MAX_UTF8_BYTES
} from '../../shared/git-contract.ts'
import type {
  GitDiffHunk,
  GitHistoryCommitDetail,
  GitHistoryDetailRequest,
  GitHistoryDetailResult,
  GitHistoryFileDiffRequest,
  GitHistoryFileDiffResult,
  GitHistoryFileEntry,
  GitHistoryListRequest,
  GitHistoryListResult,
  GitHistorySnapshot,
  GitRepositoryState
} from '../../shared/git-contract.ts'
import {
  GitRunError,
  admitHistoryState,
  assertNotAborted,
  boundedGitMessage,
  digest,
  errorDto,
  historyDetailFailure,
  historyListFailure,
  historySnapshotFromState,
  toErrorDto,
  toPublicErrorDto
} from './git-admission.ts'
import {
  boundHistoryMessage,
  emptyHistoryFileDiff,
  historyStatusToDiffChange,
  parseHistoryNameStatusRecords,
  parseHistorySummaries,
  parseSingleFilePatch,
  validateRepositoryPath
} from './git-parsing.ts'
import {
  GIT_HISTORY_READ_ENV,
  GIT_HISTORY_STREAM_STDERR_MAX_BYTES,
  type HistoryNameStatusRecord
} from './git-service-types.ts'
import type { GitServiceCore } from './git-service-core.ts'

/** Commit history listing, commit detail and historical file diffs for GitService (moved unchanged, D-098). */
export class GitHistory {
  private readonly core: GitServiceCore

  constructor(core: GitServiceCore) {
    this.core = core
  }

  async listHistory(request: GitHistoryListRequest, signal?: AbortSignal): Promise<GitHistoryListResult> {
    let state: GitRepositoryState | null = null
    try {
      state = await this.core.refresh(signal)
      const admission = admitHistoryState(state, request.snapshot)
      if (admission.kind === 'failure') return admission.result
      if (admission.state.headOid === null) {
        return {
          ok: true,
          snapshot: request.snapshot,
          commits: [],
          offset: request.offset,
          pageSize: GIT_HISTORY_PAGE_SIZE,
          hasMore: false
        }
      }

      const logText = await this.core.runRaw(
        admission.state.repositoryRoot,
        [
          '-c', 'core.quotepath=false',
          'log',
          `--max-count=${GIT_HISTORY_PAGE_SIZE + 1}`,
          `--skip=${request.offset}`,
          '--format=%H%x00%h%x00%s%x00%an%x00%ae%x00%at%x00%cn%x00%ce%x00%ct%x00%P',
          admission.state.headOid,
          '--'
        ],
        { signal, maxOutputBytes: 2 * 1024 * 1024, env: GIT_HISTORY_READ_ENV }
      )
      const parsed = parseHistorySummaries(logText)
      const hasMore = parsed.length > GIT_HISTORY_PAGE_SIZE
      const commits = parsed.slice(0, GIT_HISTORY_PAGE_SIZE)

      assertNotAborted(signal)
      const settled = await this.core.refresh(signal)
      const settledAdmission = admitHistoryState(settled, request.snapshot)
      if (settledAdmission.kind === 'failure') return settledAdmission.result

      return {
        ok: true,
        snapshot: request.snapshot,
        commits,
        offset: request.offset,
        pageSize: GIT_HISTORY_PAGE_SIZE,
        hasMore
      }
    } catch (error) {
      return historyListFailure(toPublicErrorDto(error), request.snapshot, await this.currentHistorySnapshot(state, signal))
    }
  }

  async getHistoryDetail(
    request: GitHistoryDetailRequest,
    signal?: AbortSignal
  ): Promise<GitHistoryDetailResult> {
    let state: GitRepositoryState | null = null
    try {
      state = await this.core.refresh(signal)
      const admission = admitHistoryState(state, request.snapshot)
      if (admission.kind === 'failure') return admission.result
      if (admission.state.headOid === null) {
        return historyDetailFailure(
          errorDto('stale', 'Requested commit is not reachable from the confirmed HEAD.'),
          request.snapshot,
          historySnapshotFromState(admission.state)
        )
      }

      await this.assertHistoryOidReachable(
        admission.state.repositoryRoot,
        request.oid,
        admission.state.headOid,
        signal
      )
      const summaryText = await this.core.runRaw(
        admission.state.repositoryRoot,
        [
          '-c', 'core.quotepath=false',
          'log',
          '-n', '1',
          '--format=%H%x00%h%x00%s%x00%an%x00%ae%x00%at%x00%cn%x00%ce%x00%ct%x00%P',
          request.oid,
          '--'
        ],
        { signal, maxOutputBytes: 256 * 1024, env: GIT_HISTORY_READ_ENV }
      )
      const summaries = parseHistorySummaries(summaryText)
      if (summaries.length !== 1 || summaries[0]!.oid !== request.oid) {
        throw new GitRunError(errorDto('git-error', 'Git returned an invalid history detail identity.'))
      }
      const { message, messageTruncated } = await this.readHistoryMessage(
        admission.state.repositoryRoot,
        request.oid,
        signal
      )
      const changedFiles = await this.readHistoryChangedFiles(
        admission.state.repositoryRoot,
        request.oid,
        summaries[0]!.parentOids,
        signal
      )
      const filesTruncated = changedFiles.truncated
      const files = changedFiles.files
      const commit: GitHistoryCommitDetail = {
        ...summaries[0]!,
        message,
        messageTruncated
      }

      assertNotAborted(signal)
      const settled = await this.core.refresh(signal)
      const settledAdmission = admitHistoryState(settled, request.snapshot)
      if (settledAdmission.kind === 'failure') return settledAdmission.result

      return {
        ok: true,
        snapshot: request.snapshot,
        commit,
        files,
        filesTruncated
      }
    } catch (error) {
      return historyDetailFailure(toPublicErrorDto(error), request.snapshot, await this.currentHistorySnapshot(state, signal))
    }
  }

  async getHistoryFileDiff(
    request: GitHistoryFileDiffRequest,
    signal?: AbortSignal
  ): Promise<GitHistoryFileDiffResult> {
    let state: GitRepositoryState | null = null
    try {
      state = await this.core.refresh(signal)
      const admission = admitHistoryState(state, request.snapshot)
      if (admission.kind === 'failure') {
        return emptyHistoryFileDiff(
          request,
          admission.result.error.code === 'trust-required'
            ? 'trust-required'
            : admission.result.error.code === 'not-repository'
              ? 'not-repository'
              : 'error',
          admission.result.current,
          admission.result.error
        )
      }
      if (admission.state.headOid === null) {
        return emptyHistoryFileDiff(
          request,
          'error',
          historySnapshotFromState(admission.state),
          errorDto('stale', 'Requested commit is not reachable from the confirmed HEAD.')
        )
      }

      await this.assertHistoryOidReachable(
        admission.state.repositoryRoot,
        request.oid,
        admission.state.headOid,
        signal
      )
      const summaryText = await this.core.runRaw(
        admission.state.repositoryRoot,
        [
          '-c', 'core.quotepath=false',
          'log',
          '-n', '1',
          '--format=%H%x00%h%x00%s%x00%an%x00%ae%x00%at%x00%cn%x00%ce%x00%ct%x00%P',
          request.oid,
          '--'
        ],
        { signal, maxOutputBytes: 256 * 1024, env: GIT_HISTORY_READ_ENV }
      )
      const summaries = parseHistorySummaries(summaryText)
      if (summaries.length !== 1 || summaries[0]!.oid !== request.oid) {
        throw new GitRunError(errorDto('git-error', 'Git returned an invalid history detail identity.'))
      }
      const files = (await this.readHistoryChangedFiles(
        admission.state.repositoryRoot,
        request.oid,
        summaries[0]!.parentOids,
        signal
      )).files
      const file = files.find((entry) => entry.fileId === request.fileId)
      if (file === undefined) {
        return emptyHistoryFileDiff(
          request,
          'error',
          historySnapshotFromState(admission.state),
          errorDto('stale', 'Requested history file identity is missing from the bounded commit file list.')
        )
      }

      const path = validateRepositoryPath(file.path, admission.state.repositoryRoot)
      const pathspecs = file.originalPath === null
        ? [path]
        : [
            validateRepositoryPath(file.originalPath, admission.state.repositoryRoot),
            path
          ]
      const patch = await this.readHistoryFilePatch(
        admission.state.repositoryRoot,
        request.oid,
        summaries[0]!.parentOids,
        pathspecs,
        signal
      )
      const result = this.parseHistoryFileDiff(request, file, patch)

      assertNotAborted(signal)
      const settled = await this.core.refresh(signal)
      const settledAdmission = admitHistoryState(settled, request.snapshot)
      if (settledAdmission.kind === 'failure') {
        return emptyHistoryFileDiff(
          request,
          settledAdmission.result.error.code === 'trust-required'
            ? 'trust-required'
            : settledAdmission.result.error.code === 'not-repository'
              ? 'not-repository'
              : 'error',
          settledAdmission.result.current,
          settledAdmission.result.error
        )
      }
      return result
    } catch (error) {
      const dto = toPublicErrorDto(error)
      const resultState = dto.code === 'output-limit'
        ? 'oversized'
        : dto.code === 'unsupported'
          ? 'unsupported'
          : dto.code === 'trust-required'
            ? 'trust-required'
            : dto.code === 'not-repository'
              ? 'not-repository'
              : 'error'
      return emptyHistoryFileDiff(
        request,
        resultState,
        await this.currentHistorySnapshot(state, signal),
        dto
      )
    }
  }

  private async currentHistorySnapshot(
    state: GitRepositoryState | null,
    signal?: AbortSignal
  ): Promise<GitHistorySnapshot | null> {
    if (state !== null && state.kind === 'repository' && state.repositoryRoot !== null) {
      return historySnapshotFromState(state)
    }
    const refreshed = signal === undefined ? await this.core.safeRefresh() : await this.safeRefreshWithSignal(signal)
    if (refreshed === null || refreshed.kind !== 'repository' || refreshed.repositoryRoot === null) return null
    return historySnapshotFromState(refreshed)
  }

  private async assertHistoryOidReachable(
    repositoryRoot: string,
    oid: string,
    confirmedHeadOid: string,
    signal?: AbortSignal
  ): Promise<void> {
    try {
      await this.core.runRaw(repositoryRoot, ['merge-base', '--is-ancestor', oid, confirmedHeadOid], {
        signal,
        maxOutputBytes: 1024,
        env: GIT_HISTORY_READ_ENV
      })
    } catch (error) {
      if (error instanceof GitRunError && error.dto.code === 'git-error') {
        throw new GitRunError(errorDto('stale', 'Requested commit is not reachable from the confirmed HEAD.'))
      }
      throw error
    }
  }

  private async readHistoryMessage(
    repositoryRoot: string,
    oid: string,
    signal?: AbortSignal
  ): Promise<{ message: string; messageTruncated: boolean }> {
    const prefix = await this.runRawPrefix(
      repositoryRoot,
      ['log', '-n', '1', '--format=%B', oid, '--'],
      GIT_HISTORY_MESSAGE_MAX_UTF8_BYTES,
      signal
    )
    const bounded = boundHistoryMessage(prefix.text)
    return {
      message: bounded.message,
      messageTruncated: prefix.truncated || bounded.messageTruncated
    }
  }

  private async readHistoryChangedFiles(
    repositoryRoot: string,
    oid: string,
    parentOids: string[],
    signal?: AbortSignal
  ): Promise<{ files: GitHistoryFileEntry[]; truncated: boolean }> {
    const args = parentOids.length === 0
      ? [
          '-c', 'core.quotepath=false',
          'diff-tree',
          '--no-commit-id',
          '--root',
          '-r',
          '--find-renames',
          '-z',
          '--name-status',
          oid,
          '--'
        ]
      : [
          '-c', 'core.quotepath=false',
          'diff',
          '--find-renames',
          '-z',
          '--name-status',
          parentOids[0]!,
          oid,
          '--'
        ]
    const result = await this.runHistoryNameStatusRecords(repositoryRoot, args, signal)
    return {
      files: parseHistoryNameStatusRecords(result.records, oid, repositoryRoot),
      truncated: result.truncated
    }
  }

  private async runRawPrefix(
    cwd: string,
    args: string[],
    maxPrefixBytes: number,
    signal?: AbortSignal
  ): Promise<{ text: string; truncated: boolean }> {
    assertNotAborted(signal)
    const timeoutMs = this.core.options.timeoutMs
    return await new Promise((resolve, reject) => {
      let settled = false
      let timedOut = false
      let truncated = false
      let stdoutBytes = 0
      let retainedBytes = 0
      let stderrBytes = 0
      let streamFailure: GitRunError | null = null
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      const child = spawn(this.core.options.gitBinary, args, {
        cwd,
        detached: true,
        env: { ...process.env, LC_ALL: 'C', LANG: 'C', ...GIT_HISTORY_READ_ENV },
        stdio: ['ignore', 'pipe', 'pipe']
      })
      const stop = (): void => {
        if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return
        try {
          process.kill(-child.pid, 'SIGKILL')
        } catch (error) {
          if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH')) {
            streamFailure = new GitRunError(toErrorDto(error))
          }
        }
      }
      const onAbort = (): void => stop()
      const timer = setTimeout(() => {
        timedOut = true
        stop()
      }, timeoutMs)
      const finish = (error: Error | null, code: number | null): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        const stderrText = Buffer.concat(stderr).toString('utf8')
        if (streamFailure !== null) {
          reject(streamFailure)
          return
        }
        if (signal?.aborted) {
          reject(new GitRunError(errorDto('aborted', 'Git operation was aborted.', stderrBytes)))
          return
        }
        if (timedOut) {
          reject(new GitRunError(errorDto('timeout', 'Git operation timed out.', stderrBytes)))
          return
        }
        if (truncated) {
          resolve({ text: Buffer.concat(stdout).toString('utf8'), truncated: true })
          return
        }
        if (error !== null || code !== 0) {
          reject(new GitRunError(errorDto(
            'git-error',
            boundedGitMessage(error ?? new Error(stderrText || `Git exited ${code ?? 'without a status'}.`)),
            stderrBytes
          )))
          return
        }
        resolve({ text: Buffer.concat(stdout).toString('utf8'), truncated: false })
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      child.stdout.on('data', (chunk: Buffer) => {
        stdoutBytes += chunk.byteLength
        const retainedLimit = maxPrefixBytes + 4
        const remaining = retainedLimit - retainedBytes
        if (remaining > 0) {
          const retained = chunk.subarray(0, remaining)
          stdout.push(retained)
          retainedBytes += retained.byteLength
        }
        if (stdoutBytes > maxPrefixBytes && !truncated) {
          truncated = true
          stop()
        }
      })
      child.stderr.on('data', (chunk: Buffer) => {
        stderrBytes += chunk.byteLength
        if (stderrBytes <= GIT_HISTORY_STREAM_STDERR_MAX_BYTES) stderr.push(chunk)
        if (stderrBytes > GIT_HISTORY_STREAM_STDERR_MAX_BYTES && streamFailure === null) {
          streamFailure = new GitRunError(errorDto(
            'output-limit',
            'Git stderr exceeded the configured byte budget.',
            stderrBytes
          ))
          stop()
        }
      })
      child.once('error', (error) => finish(error, null))
      child.once('close', (code) => finish(null, code))
    })
  }

  private async runHistoryNameStatusRecords(
    cwd: string,
    args: string[],
    signal?: AbortSignal
  ): Promise<{ records: HistoryNameStatusRecord[]; truncated: boolean }> {
    assertNotAborted(signal)
    const timeoutMs = this.core.options.timeoutMs
    return await new Promise((resolve, reject) => {
      let settled = false
      let timedOut = false
      let truncated = false
      let stderrBytes = 0
      let streamFailure: GitRunError | null = null
      let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0)
      let current: string[] | null = null
      let remainingPaths = 0
      const records: HistoryNameStatusRecord[] = []
      const stderr: Buffer[] = []
      const child = spawn(this.core.options.gitBinary, args, {
        cwd,
        detached: true,
        env: { ...process.env, LC_ALL: 'C', LANG: 'C', ...GIT_HISTORY_READ_ENV },
        stdio: ['ignore', 'pipe', 'pipe']
      })
      const stop = (): void => {
        if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return
        try {
          process.kill(-child.pid, 'SIGKILL')
        } catch (error) {
          if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH')) {
            streamFailure = new GitRunError(toErrorDto(error))
          }
        }
      }
      const failStream = (error: GitRunError): void => {
        if (streamFailure === null) streamFailure = error
        stop()
      }
      const consumeToken = (tokenBytes: Buffer): void => {
        if (tokenBytes.byteLength > GIT_REPOSITORY_RELATIVE_PATH_MAX_UTF8_BYTES) {
          failStream(new GitRunError(errorDto(
            'output-limit',
            'Git history path exceeded the configured byte budget.'
          )))
          return
        }
        const token = tokenBytes.toString('utf8')
        if (current === null) {
          if (!/^[A-Z?][0-9]*$/.test(token)) {
            failStream(new GitRunError(errorDto('git-error', 'Git returned an invalid history file status.')))
            return
          }
          current = [token]
          remainingPaths = token[0] === 'R' || token[0] === 'C' ? 2 : 1
          return
        }
        if (token.length === 0) {
          failStream(new GitRunError(errorDto('git-error', 'Git returned an empty history file path.')))
          return
        }
        current.push(token)
        remainingPaths -= 1
        if (remainingPaths !== 0) return
        records.push(current as unknown as HistoryNameStatusRecord)
        current = null
        if (records.length > GIT_HISTORY_MAX_CHANGED_FILES) {
          truncated = true
          stop()
        }
      }
      const onAbort = (): void => stop()
      const timer = setTimeout(() => {
        timedOut = true
        stop()
      }, timeoutMs)
      const finish = (error: Error | null, code: number | null): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        const stderrText = Buffer.concat(stderr).toString('utf8')
        if (streamFailure !== null) {
          reject(streamFailure)
          return
        }
        if (signal?.aborted) {
          reject(new GitRunError(errorDto('aborted', 'Git operation was aborted.', stderrBytes)))
          return
        }
        if (timedOut) {
          reject(new GitRunError(errorDto('timeout', 'Git operation timed out.', stderrBytes)))
          return
        }
        if (truncated) {
          resolve({ records: records.slice(0, GIT_HISTORY_MAX_CHANGED_FILES), truncated: true })
          return
        }
        if (error !== null || code !== 0) {
          reject(new GitRunError(errorDto(
            'git-error',
            boundedGitMessage(error ?? new Error(stderrText || `Git exited ${code ?? 'without a status'}.`)),
            stderrBytes
          )))
          return
        }
        if (pending.byteLength !== 0 || current !== null) {
          reject(new GitRunError(errorDto('git-error', 'Git returned an incomplete history file record.')))
          return
        }
        resolve({ records, truncated: false })
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      child.stdout.on('data', (chunk: Buffer) => {
        if (truncated || streamFailure !== null) return
        pending = pending.byteLength === 0 ? chunk : Buffer.concat([pending, chunk])
        let separator = pending.indexOf(0)
        while (separator >= 0 && !truncated && streamFailure === null) {
          const token = pending.subarray(0, separator)
          pending = pending.subarray(separator + 1)
          consumeToken(token)
          separator = pending.indexOf(0)
        }
        if (
          pending.byteLength > GIT_REPOSITORY_RELATIVE_PATH_MAX_UTF8_BYTES &&
          streamFailure === null
        ) {
          failStream(new GitRunError(errorDto(
            'output-limit',
            'Git history token exceeded the configured byte budget.'
          )))
        }
      })
      child.stderr.on('data', (chunk: Buffer) => {
        stderrBytes += chunk.byteLength
        if (stderrBytes <= GIT_HISTORY_STREAM_STDERR_MAX_BYTES) stderr.push(chunk)
        if (stderrBytes > GIT_HISTORY_STREAM_STDERR_MAX_BYTES && streamFailure === null) {
          failStream(new GitRunError(errorDto(
            'output-limit',
            'Git stderr exceeded the configured byte budget.',
            stderrBytes
          )))
        }
      })
      child.once('error', (error) => finish(error, null))
      child.once('close', (code) => finish(null, code))
    })
  }

  private async readHistoryFilePatch(
    repositoryRoot: string,
    oid: string,
    parentOids: string[],
    pathspecs: string[],
    signal?: AbortSignal
  ): Promise<string> {
    const args = parentOids.length === 0
      ? [
          '-c', 'core.quotepath=false',
          'diff-tree',
          '--no-commit-id',
          '--root',
          '-p',
          '--binary',
          '--find-renames',
          '--full-index',
          oid,
          '--',
          ...pathspecs
        ]
      : [
          '-c', 'core.quotepath=false',
          'diff',
          '--no-ext-diff',
          '--binary',
          '--find-renames',
          '--full-index',
          parentOids[0]!,
          oid,
          '--',
          ...pathspecs
        ]
    return await this.core.runRaw(repositoryRoot, args, {
      signal,
      maxOutputBytes: this.core.options.maxDiffBytes,
      env: GIT_HISTORY_READ_ENV
    })
  }

  private parseHistoryFileDiff(
    request: GitHistoryFileDiffRequest,
    file: GitHistoryFileEntry,
    patch: string
  ): GitHistoryFileDiffResult {
    const byteCount = Buffer.byteLength(patch)
    const current = request.snapshot
    if (/(?:^|\n)(?:GIT binary patch|Binary files )/.test(patch)) {
      return {
        ...emptyHistoryFileDiff(request, 'binary', current, errorDto('unsupported', 'Binary diffs are not rendered.')),
        path: file.path,
        originalPath: file.originalPath,
        status: file.status,
        byteCount,
        snapshot: request.snapshot
      }
    }
    if (patch.length === 0) {
      return {
        oid: request.oid,
        fileId: request.fileId,
        path: file.path,
        originalPath: file.originalPath,
        status: file.status,
        state: 'ready',
        snapshot: request.snapshot,
        current: null,
        files: [{
          id: file.fileId,
          path: file.path,
          originalPath: file.originalPath,
          change: historyStatusToDiffChange(file.status),
          hunks: []
        }],
        byteCount: 0,
        hunkCount: 0,
        lineCount: 0,
        error: null
      }
    }
    let parsed: { hunks: GitDiffHunk[]; hasRenameHeader: boolean; hasModeOnlyChange: boolean }
    try {
      parsed = parseSingleFilePatch('staged', file.path, patch, this.core.options.maxDiffHunks, this.core.options.maxDiffLines)
    } catch (error) {
      const dto = toErrorDto(error)
      return {
        ...emptyHistoryFileDiff(
          request,
          dto.code === 'output-limit' ? 'oversized' : 'unsupported',
          current,
          dto
        ),
        path: file.path,
        originalPath: file.originalPath,
        status: file.status,
        byteCount,
        snapshot: request.snapshot
      }
    }
    const lineCount = parsed.hunks.reduce((total, hunk) => total + hunk.lines.length, 0)
    if (
      parsed.hunks.length > this.core.options.maxDiffHunks ||
      lineCount > this.core.options.maxDiffLines
    ) {
      return {
        ...emptyHistoryFileDiff(
          request,
          'oversized',
          current,
          errorDto('output-limit', 'Diff exceeds the configured structural budget.')
        ),
        path: file.path,
        originalPath: file.originalPath,
        status: file.status,
        byteCount,
        hunkCount: parsed.hunks.length,
        lineCount,
        snapshot: request.snapshot
      }
    }
    const change = historyStatusToDiffChange(file.status)
    const hunks = parsed.hunks.map((hunk) => ({
      ...hunk,
      id: digest([file.fileId, hunk.header, hunk.lines.map((line) => `${line.kind}:${line.content}`).join('\n')].join('\0')).slice(0, 24)
    }))
    return {
      oid: request.oid,
      fileId: request.fileId,
      path: file.path,
      originalPath: file.originalPath,
      status: file.status,
      state: 'ready',
      snapshot: request.snapshot,
      current: null,
      files: [{
        id: file.fileId,
        path: file.path,
        originalPath: file.originalPath,
        change,
        hunks
      }],
      byteCount,
      hunkCount: hunks.length,
      lineCount,
      error: null
    }
  }

  private async safeRefreshWithSignal(signal: AbortSignal): Promise<GitRepositoryState | null> {
    try {
      return await this.core.refresh(signal)
    } catch {
      return null
    }
  }
}
