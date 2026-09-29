import { resolve } from 'node:path'
import type {
  GitCommitExecutionRequest,
  GitCommitExecutionResult,
  GitCommitPreview,
  GitCommitPreviewResult,
  GitCommitSnapshot,
  GitCommitWarning,
  GitPushTarget,
  GitRepositoryState
} from '../../shared/git-contract.ts'
import { isGitRefName } from './git-command-validation.ts'
import {
  GitRunError,
  assertCommitAdmission,
  assertNotAborted,
  assertPushTargetFence,
  errorDto,
  failedCommitExecution,
  snapshotFromState,
  stderrLength,
  toErrorDto,
  toPublicErrorDto,
  trustRequiredError,
  trustRequiredErrorPublic,
  validateCommitMessage
} from './git-admission.ts'
import { suggestCommitMessage, trimNullable, validateRepositoryPath } from './git-parsing.ts'
import { type CommitInspection, GIT_BRANCH_SYNC_READ_ENV, GIT_NETWORK_ENV } from './git-service-types.ts'
import type { GitServiceCore } from './git-service-core.ts'

/** Commit preview, commit execution and push-target reads for GitService (moved unchanged, D-098). */
export class GitCommits {
  private readonly core: GitServiceCore

  constructor(core: GitServiceCore) {
    this.core = core
  }

  async prepareCommit(signal?: AbortSignal): Promise<GitCommitPreviewResult> {
    let discovered: GitRepositoryState
    try {
      discovered = await this.core.refresh(signal)
    } catch (error) {
      return { ok: false, error: toPublicErrorDto(error), state: null }
    }
    if (discovered.kind !== 'repository' || discovered.repositoryRoot === null) {
      return {
        ok: false,
        error: discovered.kind === 'trust-required'
          ? trustRequiredErrorPublic()
          : errorDto('not-repository', 'Project is not a Git repository.'),
        state: discovered
      }
    }
    return this.core.resolveQueue(discovered.repositoryRoot).run(async () => {
      let latest: GitRepositoryState | null = null
      try {
        latest = await this.core.refresh(signal)
        const preview = await this.buildCommitPreview(latest, signal)
        return { ok: true, preview }
      } catch (error) {
        const dto = toErrorDto(error)
        const settled = dto.code === 'aborted' || dto.code === 'timeout'
          ? latest
          : await this.core.safeRefresh()
        return {
          ok: false,
          error: toPublicErrorDto(error),
          state: settled ?? latest
        }
      }
    })
  }

  async executeCommit(
    request: GitCommitExecutionRequest,
    signal?: AbortSignal,
    assertCurrentBoundary?: () => Promise<void>
  ): Promise<GitCommitExecutionResult> {
    const mode = request.mode
    let discovered: GitRepositoryState
    try {
      discovered = await this.core.refresh(signal)
    } catch (error) {
      const publicError = toPublicErrorDto(error)
      return failedCommitExecution(mode, publicError, { ok: false, error: publicError })
    }
    if (discovered.kind !== 'repository' || discovered.repositoryRoot === null) {
      const error = discovered.kind === 'trust-required'
        ? trustRequiredErrorPublic()
        : errorDto('not-repository', 'Project is not a Git repository.')
      return failedCommitExecution(mode, error, { ok: true, state: discovered })
    }
    return this.core.resolveQueue(discovered.repositoryRoot).run(async () => {
      let latest: GitRepositoryState | null = null
      let confirmed: GitCommitSnapshot
      let message: string
      let pushTarget: GitPushTarget | null
      try {
        latest = await this.core.refresh(signal)
        assertCommitAdmission(latest, request)
        message = validateCommitMessage(request.message)
        pushTarget = await this.readPushTarget(latest.repositoryRoot!, latest.branch!, signal)
        assertPushTargetFence(mode, request.expectedPushTarget, pushTarget)
        await this.assertCommitIdentity(latest.repositoryRoot!, signal)
        const stagedPaths = await this.readStagedPaths(latest.repositoryRoot!, signal)
        if (stagedPaths.length === 0) {
          throw new GitRunError(errorDto('unsupported', 'There are no staged changes to commit.'))
        }
        if (assertCurrentBoundary !== undefined) {
          await assertCurrentBoundary()
          latest = await this.core.refresh(signal)
          assertCommitAdmission(latest, request)
          await assertCurrentBoundary()
        }
        assertNotAborted(signal)
        confirmed = snapshotFromState(latest)
      } catch (error) {
        return failedCommitExecution(mode, toPublicErrorDto(error), await this.core.refreshSafe())
      }

      let commandError: unknown = null
      try {
        await this.runCommit(confirmed.repositoryRoot, mode === 'amend', message, signal)
      } catch (error) {
        commandError = error
      }

      let inspection: CommitInspection | null = null
      let inspectionUnavailable = false
      try {
        inspection = await this.inspectCommitAttempt(confirmed.repositoryRoot, mode, confirmed)
      } catch {
        inspectionUnavailable = true
      }
      if (commandError !== null && (inspection === null || !inspection.parentMatched)) {
        return failedCommitExecution(mode, toPublicErrorDto(commandError), await this.core.refreshSafe())
      }

      const warnings: GitCommitWarning[] = []
      if (commandError !== null) warnings.push('command-error-after-landing')
      if (inspectionUnavailable || inspection === null) {
        warnings.push('verification-unavailable')
      } else if (!inspection.snapshotMatched) {
        warnings.push('confirmed-snapshot-diverged')
      }
      const commitStep = {
        status: 'succeeded' as const,
        oid: inspection?.oid ?? null,
        warnings
      }
      if (mode !== 'commit-and-push') {
        return {
          mode,
          commit: commitStep,
          push: null,
          postState: await this.core.refreshSafe()
        }
      }

      const activeTarget = pushTarget!
      try {
        assertNotAborted(signal)
        const afterCommit = await this.core.refresh(signal)
        if (
          afterCommit.kind !== 'repository' ||
          afterCommit.repositoryRoot !== confirmed.repositoryRoot ||
          afterCommit.branch !== confirmed.branch
        ) {
          throw new GitRunError(errorDto('stale', 'Repository identity changed after the commit and before push.'))
        }
        const liveTarget = await this.readPushTarget(afterCommit.repositoryRoot!, afterCommit.branch!, signal)
        assertPushTargetFence(mode, request.expectedPushTarget, liveTarget)
        assertNotAborted(signal)
        await this.runPush(afterCommit.repositoryRoot!, liveTarget!, signal)
        return {
          mode,
          commit: commitStep,
          push: { status: 'succeeded', remote: liveTarget!.remote, branch: liveTarget!.branch },
          postState: await this.core.refreshSafe()
        }
      } catch (error) {
        return {
          mode,
          commit: commitStep,
          push: {
            status: 'failed',
            remote: activeTarget.remote,
            branch: activeTarget.branch,
            error: toPublicErrorDto(error)
          },
          postState: await this.core.refreshSafe()
        }
      }
    })
  }

  private async buildCommitPreview(
    state: GitRepositoryState,
    signal?: AbortSignal
  ): Promise<GitCommitPreview> {
    if (state.kind !== 'repository' || state.repositoryRoot === null) {
      throw new GitRunError(
        state.kind === 'trust-required'
          ? trustRequiredError()
          : errorDto('not-repository', 'Project is not a Git repository.')
      )
    }
    if (state.detached || state.branch === null) {
      throw new GitRunError(errorDto('unsupported', 'Commit requires a named branch; detached HEAD is unsupported.'))
    }
    if (state.indexTreeOid === null || state.files.some((file) => file.conflicted)) {
      throw new GitRunError(errorDto('conflict', 'Git repository has unresolved conflicts.'))
    }
    if (state.truncated) {
      throw new GitRunError(errorDto('unsupported', 'Git status is truncated; commit is blocked until status is complete.'))
    }
    await this.assertCommitIdentity(state.repositoryRoot, signal)
    const stagedPaths = await this.readStagedPaths(state.repositoryRoot, signal)
    if (stagedPaths.length === 0) {
      throw new GitRunError(errorDto('unsupported', 'There are no staged changes to commit.'))
    }
    const pushTarget = await this.readPushTarget(state.repositoryRoot, state.branch, signal)
    return {
      snapshot: snapshotFromState(state),
      stagedFileCount: stagedPaths.length,
      pushTarget,
      amendAvailable: state.headOid !== null,
      suggestedMessage: suggestCommitMessage(stagedPaths)
    }
  }

  private async readStagedPaths(repositoryRoot: string, signal?: AbortSignal): Promise<string[]> {
    const text = await this.core.runRaw(repositoryRoot, ['diff', '--cached', '--name-only', '-z'], {
      signal,
      maxOutputBytes: this.core.options.maxStatusBytes
    })
    const paths: string[] = []
    for (const record of text.split('\0')) {
      if (record.length === 0) continue
      paths.push(validateRepositoryPath(record, repositoryRoot))
    }
    return paths
  }

  async readPushTarget(
    repositoryRoot: string,
    branch: string,
    signal?: AbortSignal
  ): Promise<GitPushTarget | null> {
    const text = await this.core.runRaw(
      repositoryRoot,
      ['for-each-ref', '--format=%(upstream:remotename)%00%(upstream:remoteref)', `refs/heads/${branch}`],
      { signal, maxOutputBytes: 64 * 1024 }
    )
    const trimmed = text.replace(/\n+$/u, '')
    if (trimmed.length === 0) return null
    const parts = trimmed.split('\0')
    if (parts.length < 2) return null
    const remote = parts[0]!.trim()
    const remoteref = parts[1]!.trim()
    if (remote.length === 0 || remoteref.length === 0) return null
    if (!isGitRefName(remote)) {
      throw new GitRunError(errorDto('unsupported', 'Upstream remote name is unsafe for push.'))
    }
    if (!remoteref.startsWith('refs/heads/')) {
      throw new GitRunError(errorDto('unsupported', 'Upstream is not a branch ref and cannot be used for push.'))
    }
    const upstreamBranch = remoteref.slice('refs/heads/'.length)
    if (!isGitRefName(upstreamBranch)) {
      throw new GitRunError(errorDto('unsupported', 'Upstream branch ref is invalid.'))
    }
    return { remote, branch: upstreamBranch }
  }

  async readUpstreamTrackingRef(
    repositoryRoot: string,
    branch: string,
    signal?: AbortSignal
  ): Promise<string> {
    const text = await this.core.runRaw(
      repositoryRoot,
      ['for-each-ref', '--format=%(upstream)', `refs/heads/${branch}`],
      { signal, maxOutputBytes: 64 * 1024, env: { ...GIT_BRANCH_SYNC_READ_ENV } }
    )
    const upstreamRef = trimNullable(text)
    if (
      upstreamRef === null ||
      !upstreamRef.startsWith('refs/remotes/') ||
      !isGitRefName(upstreamRef)
    ) {
      throw new GitRunError(errorDto(
        'unsupported',
        'Configured upstream does not resolve to a safe remote-tracking ref.'
      ))
    }
    return upstreamRef
  }

  private async assertCommitIdentity(repositoryRoot: string, signal?: AbortSignal): Promise<void> {
    try {
      const author = trimNullable(await this.core.runRaw(repositoryRoot, ['var', 'GIT_AUTHOR_IDENT'], {
        signal,
        maxOutputBytes: 16 * 1024
      }))
      const committer = trimNullable(await this.core.runRaw(repositoryRoot, ['var', 'GIT_COMMITTER_IDENT'], {
        signal,
        maxOutputBytes: 16 * 1024
      }))
      if (author === null || committer === null) {
        throw new GitRunError(errorDto('unsupported', 'Git author or committer identity is unavailable.'))
      }
    } catch (error) {
      if (error instanceof GitRunError && error.dto.code === 'unsupported') throw error
      throw new GitRunError(errorDto(
        'unsupported',
        'Git author or committer identity is unavailable.',
        stderrLength(error)
      ))
    }
  }

  private async runCommit(
    repositoryRoot: string,
    amend: boolean,
    message: string,
    signal?: AbortSignal
  ): Promise<void> {
    const args = amend
      ? ['commit', '--amend', '--file=-', '--cleanup=verbatim']
      : ['commit', '--file=-', '--cleanup=verbatim']
    await this.core.runRaw(repositoryRoot, args, {
      signal,
      maxOutputBytes: 1024 * 1024,
      stdin: message.endsWith('\n') ? message : `${message}\n`
    })
  }

  private async runPush(
    repositoryRoot: string,
    target: GitPushTarget,
    signal?: AbortSignal
  ): Promise<void> {
    await this.core.runRaw(
      repositoryRoot,
      ['push', '--porcelain', '--', target.remote, `HEAD:refs/heads/${target.branch}`],
      {
        signal,
        maxOutputBytes: 1024 * 1024,
        env: { ...GIT_NETWORK_ENV }
      }
    )
  }

  private async inspectCommitAttempt(
    repositoryRoot: string,
    mode: GitCommitExecutionRequest['mode'],
    confirmed: GitCommitSnapshot
  ): Promise<CommitInspection | null> {
    const newOid = trimNullable(await this.core.runRaw(repositoryRoot, ['rev-parse', 'HEAD'], {
      maxOutputBytes: 64 * 1024
    }))
    if (newOid === null || newOid === confirmed.headOid) return null
    const treeOid = trimNullable(await this.core.runRaw(repositoryRoot, ['rev-parse', 'HEAD^{tree}'], {
      maxOutputBytes: 64 * 1024
    }))
    const parentsText = await this.core.runRaw(repositoryRoot, ['rev-list', '--parents', '-n1', 'HEAD'], {
      maxOutputBytes: 64 * 1024
    })
    const tokens = parentsText.trim().split(/\s+/u).filter((token) => token.length > 0)
    const parents = tokens[0] === newOid ? tokens.slice(1) : []
    let parentMatched = false
    if (mode === 'amend' && confirmed.headOid !== null) {
      const oldParentsText = await this.core.runRaw(
        repositoryRoot,
        ['rev-list', '--parents', '-n1', confirmed.headOid],
        { maxOutputBytes: 64 * 1024 }
      )
      const oldTokens = oldParentsText.trim().split(/\s+/u).filter((token) => token.length > 0)
      const oldParents = oldTokens.slice(1)
      parentMatched = parents.length === oldParents.length &&
        parents.every((parent, index) => parent === oldParents[index])
    } else if (confirmed.headOid === null) {
      parentMatched = parents.length === 0
    } else {
      parentMatched = parents.length === 1 && parents[0] === confirmed.headOid
    }
    return {
      oid: newOid,
      parentMatched,
      snapshotMatched: parentMatched && treeOid === confirmed.indexTreeOid
    }
  }
}
