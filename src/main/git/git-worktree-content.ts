import {
  spawn
} from 'node:child_process'
import {
  constants as fsConstants
} from 'node:fs'
import {
  lstat,
  open,
  type FileHandle
} from 'node:fs/promises'
import {
  resolve
} from 'node:path'
import {
  GitRunError,
  assertNotAborted,
  boundedGitMessage,
  errorDto,
  isFileNotFoundError,
  toErrorDto
} from './git-admission.ts'
import {
  parseIndexEntries,
  validateRepositoryPath
} from './git-parsing.ts'
import {
  CONTENT_HASH_WORKERS,
  type ExactWorktreeContent,
  type FileIdentity,
  type HashChild,
  type StatusRecord
} from './git-service-types.ts'
import {
  assertPathIdentityUnchanged,
  assertSafeNoFollowPlatform,
  endHashInput,
  isNoFollowRaceError,
  killHashChild,
  mapWithConcurrency,
  readStableSymbolicLink,
  sameFileIdentity,
  serializeFileIdentity,
  toFileIdentity,
  worktreeFileKind,
  writeHashChunk
} from './git-worktree-io.ts'
import type { GitServiceCore } from './git-service-core.ts'

/** Exact worktree content reads, content hashing and rename coalescing for GitService (moved unchanged, D-098). */
export class GitWorktreeContent {
  private readonly core: GitServiceCore

  constructor(core: GitServiceCore) {
    this.core = core
  }

  async readAutomaticWorktreeIdentity(
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
    if (before.size > BigInt(this.core.options.maxAutomaticFingerprintBytes)) {
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

  async readExactWorktreeContent(
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
    await this.core.testHooks.beforeNoFollowOpen?.(absolutePath)
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

  async readIndexOid(repositoryRoot: string, path: string, signal?: AbortSignal): Promise<string | null> {
    const output = await this.core.runRaw(repositoryRoot, ['ls-files', '--stage', '-z', '--', path], {
      signal,
      maxOutputBytes: 64 * 1024
    })
    if (output.length === 0) return null
    const records = output.split('\0').filter((record) => record.length > 0)
    if (records.length !== 1) return null
    const match = /^\d+ ((?:[0-9a-f]{40}|[0-9a-f]{64})) 0\t/s.exec(records[0]!)
    return match?.[1] ?? null
  }

  async coalesceExactWorktreeRenames(
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
        this.core.options.maxAutomaticFingerprintBytes
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
    let inputFailed = false
    const observeInput = <T>(operation: Promise<T>): Promise<T> => operation.catch((error) => {
      inputFailed = true
      throw error
    })
    const stop = (error: GitRunError): void => {
      if (failure !== null) return
      failure = error
      for (const child of children) killHashChild(child.process)
    }
    const onAbort = (): void => stop(new GitRunError(errorDto('aborted', 'Git hashing was aborted.')))
    signal?.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => {
      stop(new GitRunError(errorDto('timeout', 'Git hashing timed out.')))
    }, this.core.options.timeoutMs)
    try {
      for (const args of argsList) {
        const childProcess = spawn(this.core.options.gitBinary, args, {
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
          inputError: null,
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
        childProcess.stdin.once('error', (error) => { child.inputError = error })
        childProcess.stdout.on('data', (chunk: Buffer) => countOutput(child.stdout, chunk))
        childProcess.stderr.on('data', (chunk: Buffer) => countOutput(child.stderr, chunk))
        child.result = new Promise((resolveResult) => {
          let spawnError: Error | null = null
          childProcess.once('error', (error) => {
            spawnError = error
          })
          childProcess.once('close', (code) => {
            if (failure === null && (spawnError !== null || code !== 0 || child.inputError !== null)) {
              const stderr = Buffer.concat(child.stderr).toString('utf8')
              stop(new GitRunError(errorDto(
                'git-error',
                boundedGitMessage(spawnError ?? (stderr ? new Error(stderr) : child.inputError ?? new Error(`Git hashing exited ${code ?? 'without a status'}.`))),
                stderr.length
              )))
            }
            resolveResult({ code, error: spawnError })
          })
        })
      }

      await produceInput(async (chunk) => {
        if (failure !== null) throw failure
        await observeInput(Promise.all(children.map((child) => writeHashChunk(child.process, chunk))))
        if (failure !== null) throw failure
      })
      if (failure !== null) throw failure
      await observeInput(Promise.all(children.map((child) => endHashInput(child.process))))
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
      if (inputFailed) {
        // Any rejected stdin write/end may precede stderr/close, including stream
        // destruction errors. Classify by the IO owner rather than one OS error code.
        // The existing timeout still bounds a child that never exits.
        for (const child of children) child.process.stdin.destroy()
        await Promise.all(children.map((child) => child.result))
      }
      if (failure === null) stop(error instanceof GitRunError ? error : new GitRunError(toErrorDto(error)))
      await Promise.all(children.map((child) => child.result))
      throw failure
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  }
}
