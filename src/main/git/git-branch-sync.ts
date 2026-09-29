import { createHmac } from 'node:crypto'
import { GIT_BRANCH_LIST_MAX, GIT_REMOTE_LIST_MAX, GIT_REMOTE_TRACKING_LIST_MAX } from '../../shared/git-contract.ts'
import type {
  GitBranchMutationWarning,
  GitBranchSyncActions,
  GitBranchSyncCurrent,
  GitBranchSyncExecutionRequest,
  GitBranchSyncExecutionResult,
  GitBranchSyncPrepareResult,
  GitBranchSyncSnapshot,
  GitFastForwardStep,
  GitRepositoryState
} from '../../shared/git-contract.ts'
import { isGitRefName } from './git-command-validation.ts'
import {
  GitRunError,
  assertBranchMutationAdmission,
  assertCleanNamedBranchState,
  assertPushBranchAdmission,
  assertRepositoryRootFence,
  assertUpstreamFence,
  errorDto,
  failedBranchSyncExecution,
  stderrLength,
  toErrorDto,
  toPublicErrorDto,
  trustRequiredErrorPublic
} from './git-admission.ts'
import { splitNonEmptyLines, trimNullable } from './git-parsing.ts'
import { GIT_BRANCH_SYNC_READ_ENV, GIT_REMOTE_TRACKING_SCAN_MAX } from './git-service-types.ts'
import type { GitServiceCore } from './git-service-core.ts'

/** Branch listing, switching, fetch, pull and push of the branch sync flow for GitService (moved unchanged, D-098). */
export class GitBranchSync {
  private readonly core: GitServiceCore

  constructor(core: GitServiceCore) {
    this.core = core
  }

  async prepareBranchSync(signal?: AbortSignal): Promise<GitBranchSyncPrepareResult> {
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
        return await this.buildBranchSyncView(latest, signal)
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

  async executeBranchSync(
    request: GitBranchSyncExecutionRequest
  ): Promise<GitBranchSyncExecutionResult> {
    const action = request.action
    let discovered: GitRepositoryState
    try {
      discovered = await this.core.refresh()
    } catch (error) {
      const publicError = toPublicErrorDto(error)
      return failedBranchSyncExecution(action, publicError, {
        ok: false,
        error: publicError,
        state: null
      })
    }
    if (discovered.kind !== 'repository' || discovered.repositoryRoot === null) {
      const error = discovered.kind === 'trust-required'
        ? trustRequiredErrorPublic()
        : errorDto('not-repository', 'Project is not a Git repository.')
      return failedBranchSyncExecution(action, error, {
        ok: false,
        error,
        state: discovered
      })
    }
    return this.core.resolveQueue(discovered.repositoryRoot).run(async () => {
      try {
        switch (request.action) {
          case 'create-and-switch':
            return await this.executeCreateAndSwitch(request)
          case 'switch':
            return await this.executeSwitchBranch(request)
          case 'fetch':
            return await this.executeFetchRemote(request)
          case 'pull':
            return await this.executePullUpstream(request)
          case 'push':
            return await this.executePushUpstream(request)
        }
      } catch (error) {
        return failedBranchSyncExecution(action, toPublicErrorDto(error), await this.safeBranchSyncView())
      }
    })
  }

  private async buildBranchSyncView(
    state: GitRepositoryState,
    signal?: AbortSignal
  ): Promise<GitBranchSyncPrepareResult> {
    if (state.kind !== 'repository' || state.repositoryRoot === null) {
      return {
        ok: false,
        error: state.kind === 'trust-required'
          ? trustRequiredErrorPublic()
          : errorDto('not-repository', 'Project is not a Git repository.'),
        state
      }
    }
    const repositoryRoot = state.repositoryRoot
    const [localBranchesRaw, remoteTrackingRaw, remotesRaw, pushTarget] = await Promise.all([
      this.listLocalBranches(repositoryRoot, signal),
      this.listRemoteTrackingBranches(repositoryRoot, signal),
      this.listConfiguredRemotes(repositoryRoot, signal),
      state.branch === null || state.headOid === null
        ? Promise.resolve(null)
        : this.core.readPushTarget(repositoryRoot, state.branch, signal)
    ])
    const localBranchesTruncated = localBranchesRaw.length > GIT_BRANCH_LIST_MAX
    const remoteTrackingBranchesTruncated = remoteTrackingRaw.truncated
    const remotesTruncated = remotesRaw.length > GIT_REMOTE_LIST_MAX
    const conflicted = state.files.some((file) => file.conflicted) || state.indexTreeOid === null
    const clean = state.files.length === 0 && !conflicted && !state.truncated
    const namedNonUnborn = state.branch !== null && state.headOid !== null && !state.detached
    const mutationReady = namedNonUnborn && clean && !conflicted && !state.truncated
    const hasUpstream = pushTarget !== null
    const snapshot: GitBranchSyncSnapshot = {
      repositoryRoot,
      headOid: state.headOid,
      branch: state.branch,
      indexTreeOid: state.indexTreeOid,
      indexFingerprint: state.indexFingerprint,
      worktreeFingerprint: state.worktreeFingerprint,
      statusRevision: state.statusRevision,
      upstreamRemote: pushTarget?.remote ?? null,
      upstreamBranch: pushTarget?.branch ?? null
    }
    const localBranches = localBranchesRaw.slice(0, GIT_BRANCH_LIST_MAX).map((entry) => ({
      branchId: this.branchCapabilityId('local', snapshot, entry.name, entry.headOid),
      kind: 'local' as const,
      name: entry.name,
      headOid: entry.headOid,
      isCurrent: state.branch !== null && entry.name === state.branch
    }))
    const remoteTrackingBranches = remoteTrackingRaw.entries.slice(0, GIT_REMOTE_TRACKING_LIST_MAX).map((entry) => ({
      branchId: this.branchCapabilityId('remote-tracking', snapshot, entry.name, entry.headOid),
      kind: 'remote-tracking' as const,
      name: entry.name,
      headOid: entry.headOid,
      isCurrent: false
    }))
    const remotes = remotesRaw.slice(0, GIT_REMOTE_LIST_MAX).map((name) => ({
      remoteId: this.branchCapabilityId('remote', snapshot, name, null),
      name
    }))
    const current: GitBranchSyncCurrent = {
      branch: state.branch,
      headOid: state.headOid,
      detached: state.detached,
      unborn: state.headOid === null,
      upstream: state.upstream,
      upstreamRemote: pushTarget?.remote ?? null,
      upstreamBranch: pushTarget?.branch ?? null,
      ahead: state.ahead,
      behind: state.behind,
      clean,
      conflicted,
      truncated: state.truncated
    }
    const actions: GitBranchSyncActions = {
      canCreate: mutationReady,
      canSwitch: mutationReady,
      canFetch: remotes.length > 0,
      canPull: mutationReady && hasUpstream,
      canPush: namedNonUnborn && hasUpstream && !conflicted && !state.truncated
    }
    return {
      ok: true,
      snapshot,
      current,
      localBranches,
      localBranchesTruncated,
      remoteTrackingBranches,
      remoteTrackingBranchesTruncated,
      remotes,
      remotesTruncated,
      actions
    }
  }

  private async safeBranchSyncView(): Promise<GitBranchSyncPrepareResult> {
    try {
      const state = await this.core.refresh()
      return await this.buildBranchSyncView(state)
    } catch (error) {
      return { ok: false, error: toPublicErrorDto(error), state: null }
    }
  }

  private async listLocalBranches(
    repositoryRoot: string,
    signal?: AbortSignal
  ): Promise<Array<{ name: string; headOid: string | null }>> {
    const text = await this.core.runRaw(
      repositoryRoot,
      [
        'for-each-ref',
        `--count=${GIT_BRANCH_LIST_MAX + 1}`,
        '--format=%(refname:short)%00%(objectname)',
        'refs/heads/'
      ],
      {
        signal,
        maxOutputBytes: 2 * 1024 * 1024,
        env: { ...GIT_BRANCH_SYNC_READ_ENV }
      }
    )
    const entries: Array<{ name: string; headOid: string | null }> = []
    for (const line of splitNonEmptyLines(text)) {
      const parts = line.split('\0')
      if (parts.length !== 2) {
        throw new GitRunError(errorDto('git-error', 'Git returned an invalid local branch record.'))
      }
      const name = parts[0]!
      const headOid = parts[1]!.trim()
      if (!isGitRefName(name)) {
        throw new GitRunError(errorDto('unsupported', 'Local branch name is unsafe.'))
      }
      if (headOid.length > 0 && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(headOid)) {
        throw new GitRunError(errorDto('git-error', 'Git returned an invalid local branch identity.'))
      }
      entries.push({ name, headOid: headOid.length === 0 ? null : headOid })
    }
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
    return entries
  }

  private async listRemoteTrackingBranches(
    repositoryRoot: string,
    signal?: AbortSignal
  ): Promise<{
    entries: Array<{ name: string; headOid: string | null }>
    truncated: boolean
  }> {
    // A bounded prefix works on Git 2.43 as well as newer hosts. One extra raw
    // record proves scan truncation even when symbolic refs consume the budget.
    const text = await this.core.runRaw(repositoryRoot, [
      'for-each-ref',
      `--count=${GIT_REMOTE_TRACKING_SCAN_MAX + 1}`,
      '--format=%(refname)%00%(refname:short)%00%(objectname)%00%(symref)',
      'refs/remotes/'
    ], { signal, maxOutputBytes: 4 * 1024 * 1024, env: { ...GIT_BRANCH_SYNC_READ_ENV } })
    const records = splitNonEmptyLines(text)
    const entries: Array<{ name: string; headOid: string | null }> = []
    for (const line of records.slice(0, GIT_REMOTE_TRACKING_SCAN_MAX)) {
      const parts = line.split('\0')
      if (parts.length !== 4) throw new GitRunError(errorDto('git-error', 'Git returned an invalid remote-tracking branch record.'))
      const [refname, name, headOid, symref] = parts as [string, string, string, string]
      if (!refname.startsWith('refs/remotes/') || !isGitRefName(refname)) {
        throw new GitRunError(errorDto('unsupported', 'Remote-tracking ref name is unsafe.'))
      }
      if (symref.length > 0) continue
      if (!isGitRefName(name)) throw new GitRunError(errorDto('unsupported', 'Remote-tracking branch name is unsafe.'))
      if (headOid.length > 0 && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(headOid)) {
        throw new GitRunError(errorDto('git-error', 'Git returned an invalid remote-tracking branch identity.'))
      }
      entries.push({ name, headOid: headOid.length === 0 ? null : headOid })
      if (entries.length > GIT_REMOTE_TRACKING_LIST_MAX) break
    }
    return {
      entries,
      truncated: entries.length > GIT_REMOTE_TRACKING_LIST_MAX || records.length > GIT_REMOTE_TRACKING_SCAN_MAX
    }
  }

  private async listConfiguredRemotes(
    repositoryRoot: string,
    signal?: AbortSignal
  ): Promise<string[]> {
    const text = await this.core.runRaw(repositoryRoot, ['remote'], {
      signal,
      maxOutputBytes: 64 * 1024,
      env: { ...GIT_BRANCH_SYNC_READ_ENV }
    })
    const names: string[] = []
    for (const line of splitNonEmptyLines(text)) {
      const name = line.trim()
      if (name.length === 0) continue
      if (!isGitRefName(name)) {
        throw new GitRunError(errorDto('unsupported', 'Configured remote name is unsafe.'))
      }
      names.push(name)
    }
    names.sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
    return names
  }

  private async executeCreateAndSwitch(
    request: Extract<GitBranchSyncExecutionRequest, { action: 'create-and-switch' }>
  ): Promise<GitBranchSyncExecutionResult> {
    let latest: GitRepositoryState
    try {
      latest = await this.core.refresh()
      assertBranchMutationAdmission(latest, request.snapshot)
      const name = await this.validateNewBranchName(latest.repositoryRoot!, request.name)
      const existing = await this.listLocalBranches(latest.repositoryRoot!)
      if (existing.some((entry) => entry.name === name)) {
        throw new GitRunError(errorDto('unsupported', 'A local branch with that name already exists.'))
      }
      let commandError: unknown = null
      try {
        await this.core.runRaw(
          latest.repositoryRoot!,
          ['switch', '--no-guess', '-c', name],
          { maxOutputBytes: 1024 * 1024 }
        )
      } catch (error) {
        commandError = error
      }
      const inspection = await this.inspectBranchLanding(latest.repositoryRoot!, name, latest.headOid!)
      if (commandError !== null && inspection === null) {
        return {
          action: 'create-and-switch',
          branch: { status: 'failed', error: toPublicErrorDto(commandError) },
          fetch: null,
          fastForward: null,
          push: null,
          postView: await this.safeBranchSyncView()
        }
      }
      const warnings: GitBranchMutationWarning[] = []
      if (commandError !== null) warnings.push('command-error-after-landing')
      if (inspection === null) warnings.push('verification-unavailable')
      return {
        action: 'create-and-switch',
        branch: {
          status: 'succeeded',
          branch: name,
          headOid: inspection?.headOid ?? latest.headOid!,
          warnings
        },
        fetch: null,
        fastForward: null,
        push: null,
        postView: await this.safeBranchSyncView()
      }
    } catch (error) {
      return failedBranchSyncExecution('create-and-switch', toPublicErrorDto(error), await this.safeBranchSyncView())
    }
  }

  private async executeSwitchBranch(
    request: Extract<GitBranchSyncExecutionRequest, { action: 'switch' }>
  ): Promise<GitBranchSyncExecutionResult> {
    try {
      const latest = await this.core.refresh()
      assertBranchMutationAdmission(latest, request.snapshot)
      const target = await this.resolveLocalBranchId(latest.repositoryRoot!, request.snapshot, request.branchId)
      if (latest.branch === target.name) {
        return {
          action: 'switch',
          branch: {
            status: 'succeeded',
            branch: target.name,
            headOid: target.headOid ?? latest.headOid!,
            warnings: []
          },
          fetch: null,
          fastForward: null,
          push: null,
          postView: await this.safeBranchSyncView()
        }
      }
      if (target.headOid === null) {
        throw new GitRunError(errorDto('unsupported', 'Target local branch has no commit identity.'))
      }
      let commandError: unknown = null
      try {
        await this.core.runRaw(
          latest.repositoryRoot!,
          ['switch', '--no-guess', '--', target.name],
          { maxOutputBytes: 1024 * 1024 }
        )
      } catch (error) {
        commandError = error
      }
      const inspection = await this.inspectBranchLanding(latest.repositoryRoot!, target.name, target.headOid)
      if (commandError !== null && inspection === null) {
        return {
          action: 'switch',
          branch: { status: 'failed', error: toPublicErrorDto(commandError) },
          fetch: null,
          fastForward: null,
          push: null,
          postView: await this.safeBranchSyncView()
        }
      }
      const warnings: GitBranchMutationWarning[] = []
      if (commandError !== null) warnings.push('command-error-after-landing')
      if (inspection === null) warnings.push('verification-unavailable')
      return {
        action: 'switch',
        branch: {
          status: 'succeeded',
          branch: target.name,
          headOid: inspection?.headOid ?? target.headOid,
          warnings
        },
        fetch: null,
        fastForward: null,
        push: null,
        postView: await this.safeBranchSyncView()
      }
    } catch (error) {
      return failedBranchSyncExecution('switch', toPublicErrorDto(error), await this.safeBranchSyncView())
    }
  }

  private async executeFetchRemote(
    request: Extract<GitBranchSyncExecutionRequest, { action: 'fetch' }>
  ): Promise<GitBranchSyncExecutionResult> {
    try {
      const latest = await this.core.refresh()
      assertRepositoryRootFence(latest, request.snapshot.repositoryRoot)
      const remote = await this.resolveRemoteId(latest.repositoryRoot!, request.snapshot, request.remoteId)
      const fetchStep = await this.core.runNetworkFetch(latest.repositoryRoot!, remote)
      return {
        action: 'fetch',
        branch: null,
        fetch: fetchStep,
        fastForward: null,
        push: null,
        postView: await this.safeBranchSyncView()
      }
    } catch (error) {
      return failedBranchSyncExecution('fetch', toPublicErrorDto(error), await this.safeBranchSyncView())
    }
  }

  private async executePullUpstream(
    request: Extract<GitBranchSyncExecutionRequest, { action: 'pull' }>
  ): Promise<GitBranchSyncExecutionResult> {
    try {
      const latest = await this.core.refresh()
      assertBranchMutationAdmission(latest, request.snapshot)
      assertUpstreamFence(latest, request.snapshot)
      const target = await this.core.readPushTarget(latest.repositoryRoot!, latest.branch!)
      if (target === null) {
        throw new GitRunError(errorDto('unsupported', 'Pull requires a configured upstream branch.'))
      }
      if (
        target.remote !== request.snapshot.upstreamRemote ||
        target.branch !== request.snapshot.upstreamBranch
      ) {
        throw new GitRunError(errorDto('stale', 'Upstream changed before pull.'))
      }
      const fromOid = latest.headOid!
      const fetchStep = await this.core.runNetworkFetch(latest.repositoryRoot!, target.remote)
      if (fetchStep.status !== 'succeeded') {
        return {
          action: 'pull',
          branch: null,
          fetch: fetchStep,
          fastForward: null,
          push: null,
          postView: await this.safeBranchSyncView()
        }
      }

      let fastForward: GitFastForwardStep
      try {
        const afterFetch = await this.core.refresh()
        assertCleanNamedBranchState(afterFetch)
        if (
          afterFetch.repositoryRoot !== request.snapshot.repositoryRoot ||
          afterFetch.branch !== request.snapshot.branch ||
          afterFetch.headOid !== request.snapshot.headOid ||
          afterFetch.indexTreeOid !== request.snapshot.indexTreeOid ||
          afterFetch.indexFingerprint !== request.snapshot.indexFingerprint ||
          afterFetch.worktreeFingerprint !== request.snapshot.worktreeFingerprint
        ) {
          throw new GitRunError(errorDto('stale', 'Repository identity changed during pull fetch.'))
        }
        const liveTarget = await this.core.readPushTarget(afterFetch.repositoryRoot!, afterFetch.branch!)
        if (
          liveTarget === null ||
          liveTarget.remote !== target.remote ||
          liveTarget.branch !== target.branch
        ) {
          throw new GitRunError(errorDto('stale', 'Upstream changed during pull.'))
        }
        const upstreamRef = await this.core.readUpstreamTrackingRef(
          afterFetch.repositoryRoot!,
          afterFetch.branch!
        )
        const upstreamOid = trimNullable(await this.core.runRaw(
          afterFetch.repositoryRoot!,
          ['rev-parse', '--verify', '--quiet', upstreamRef],
          {
            maxOutputBytes: 64 * 1024,
            env: { ...GIT_BRANCH_SYNC_READ_ENV }
          }
        ))
        if (upstreamOid === null) {
          throw new GitRunError(errorDto('unsupported', 'Upstream remote-tracking ref is missing after fetch.'))
        }
        if (upstreamOid === fromOid) {
          fastForward = {
            status: 'succeeded',
            branch: afterFetch.branch!,
            fromOid,
            toOid: fromOid,
            alreadyUpToDate: true,
            warnings: []
          }
        } else {
          let mergeError: unknown = null
          try {
            await this.core.runRaw(
              afterFetch.repositoryRoot!,
              ['merge', '--ff-only', upstreamOid],
              { maxOutputBytes: 1024 * 1024 }
            )
          } catch (error) {
            mergeError = error
          }
          if (mergeError !== null) {
            const landed = await this.inspectBranchLanding(
              afterFetch.repositoryRoot!,
              afterFetch.branch!,
              upstreamOid
            )
            if (landed === null) throw mergeError
            fastForward = {
              status: 'succeeded',
              branch: landed.branch,
              fromOid,
              toOid: landed.headOid,
              alreadyUpToDate: false,
              warnings: ['command-error-after-landing']
            }
          } else {
            const toOid = trimNullable(await this.core.runRaw(
              afterFetch.repositoryRoot!,
              ['rev-parse', 'HEAD'],
              { maxOutputBytes: 64 * 1024 }
            ))
            if (toOid !== upstreamOid) {
              throw new GitRunError(errorDto('git-error', 'Fast-forward did not land on the upstream commit.'))
            }
            fastForward = {
              status: 'succeeded',
              branch: afterFetch.branch!,
              fromOid,
              toOid: toOid!,
              alreadyUpToDate: false,
              warnings: []
            }
          }
        }
      } catch (error) {
        fastForward = {
          status: 'failed',
          branch: latest.branch!,
          error: toPublicErrorDto(error)
        }
      }
      return {
        action: 'pull',
        branch: null,
        fetch: fetchStep,
        fastForward,
        push: null,
        postView: await this.safeBranchSyncView()
      }
    } catch (error) {
      return failedBranchSyncExecution('pull', toPublicErrorDto(error), await this.safeBranchSyncView())
    }
  }

  private async executePushUpstream(
    request: Extract<GitBranchSyncExecutionRequest, { action: 'push' }>
  ): Promise<GitBranchSyncExecutionResult> {
    try {
      const latest = await this.core.refresh()
      assertPushBranchAdmission(latest, request.snapshot)
      const target = await this.core.readPushTarget(latest.repositoryRoot!, latest.branch!)
      if (target === null) {
        throw new GitRunError(errorDto('unsupported', 'Push requires a configured upstream branch.'))
      }
      if (
        target.remote !== request.snapshot.upstreamRemote ||
        target.branch !== request.snapshot.upstreamBranch
      ) {
        throw new GitRunError(errorDto('stale', 'Upstream changed before push.'))
      }
      const beforePush = await this.core.refresh()
      assertPushBranchAdmission(beforePush, request.snapshot)
      const confirmedTarget = await this.core.readPushTarget(beforePush.repositoryRoot!, beforePush.branch!)
      if (
        confirmedTarget === null ||
        confirmedTarget.remote !== target.remote ||
        confirmedTarget.branch !== target.branch
      ) {
        throw new GitRunError(errorDto('stale', 'Upstream changed immediately before push.'))
      }
      if (request.snapshot.headOid === null) {
        throw new GitRunError(errorDto('stale', 'Confirmed push commit is unavailable.'))
      }
      const pushStep = await this.core.runNetworkPush(
        beforePush.repositoryRoot!,
        confirmedTarget,
        request.snapshot.headOid
      )
      return {
        action: 'push',
        branch: null,
        fetch: null,
        fastForward: null,
        push: pushStep,
        postView: await this.safeBranchSyncView()
      }
    } catch (error) {
      return failedBranchSyncExecution('push', toPublicErrorDto(error), await this.safeBranchSyncView())
    }
  }

  private async validateNewBranchName(repositoryRoot: string, name: string): Promise<string> {
    if (!isGitRefName(name)) {
      throw new GitRunError(errorDto('unsupported', 'Branch name is invalid.'))
    }
    try {
      await this.core.runRaw(
        repositoryRoot,
        ['check-ref-format', '--branch', name],
        { maxOutputBytes: 16 * 1024 }
      )
    } catch (error) {
      throw new GitRunError(errorDto(
        'unsupported',
        'Branch name failed Git ref-format validation.',
        stderrLength(error)
      ))
    }
    return name
  }

  private async resolveLocalBranchId(
    repositoryRoot: string,
    snapshot: GitBranchSyncSnapshot,
    branchId: string
  ): Promise<{ name: string; headOid: string | null }> {
    const branches = (await this.listLocalBranches(repositoryRoot)).slice(0, GIT_BRANCH_LIST_MAX)
    const match = branches.find((entry) => (
      this.branchCapabilityId('local', snapshot, entry.name, entry.headOid) === branchId
    ))
    if (match === undefined) {
      throw new GitRunError(errorDto('stale', 'Local branch identity is no longer available.'))
    }
    return match
  }

  private async resolveRemoteId(
    repositoryRoot: string,
    snapshot: GitBranchSyncSnapshot,
    remoteId: string
  ): Promise<string> {
    const remotes = (await this.listConfiguredRemotes(repositoryRoot)).slice(0, GIT_REMOTE_LIST_MAX)
    const match = remotes.find((name) => (
      this.branchCapabilityId('remote', snapshot, name, null) === remoteId
    ))
    if (match === undefined) {
      throw new GitRunError(errorDto('stale', 'Remote identity is no longer available.'))
    }
    return match
  }

  private async inspectBranchLanding(
    repositoryRoot: string,
    expectedBranch: string,
    expectedHeadOid: string
  ): Promise<{ branch: string; headOid: string } | null> {
    try {
      const branch = trimNullable(await this.core.runRaw(
        repositoryRoot,
        ['symbolic-ref', '--quiet', '--short', 'HEAD'],
        { maxOutputBytes: 64 * 1024 }
      ))
      const headOid = trimNullable(await this.core.runRaw(
        repositoryRoot,
        ['rev-parse', '--verify', '--quiet', 'HEAD'],
        { maxOutputBytes: 64 * 1024 }
      ))
      if (branch !== expectedBranch || headOid !== expectedHeadOid) return null
      return { branch, headOid }
    } catch {
      return null
    }
  }

  private branchCapabilityId(
    kind: 'local' | 'remote-tracking' | 'remote',
    snapshot: GitBranchSyncSnapshot,
    name: string,
    headOid: string | null
  ): string {
    return createHmac('sha256', this.core.branchCapabilitySecret)
      .update([
        kind,
        snapshot.repositoryRoot,
        snapshot.statusRevision,
        snapshot.headOid ?? '',
        snapshot.branch ?? '',
        name,
        headOid ?? ''
      ].join('\0'))
      .digest('hex')
      .slice(0, 32)
  }
}
