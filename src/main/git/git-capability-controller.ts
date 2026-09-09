import { isAbsolute, relative, sep } from 'node:path'

import type {
  GitBranchSyncExecutionRequest,
  GitBranchSyncExecutionResponse,
  GitBranchSyncExecutionResult,
  GitBranchSyncPrepareResponse,
  GitBranchSyncPrepareResult,
  GitCommand,
  GitCommandResponse,
  GitCommitExecutionRequest,
  GitCommitExecutionResponse,
  GitCommitExecutionResult,
  GitCommitPreviewResponse,
  GitCommitPreviewResult,
  GitDiffRequest,
  GitDiffResponse,
  GitDiffResult,
  GitErrorCode,
  GitErrorDto,
  GitFileMutationRequest,
  GitHistoryDetailRequest,
  GitHistoryDetailResponse,
  GitHistoryDetailResult,
  GitHistoryFileDiffRequest,
  GitHistoryFileDiffResponse,
  GitHistoryFileDiffResult,
  GitHistoryListRequest,
  GitHistoryListResponse,
  GitHistoryListResult,
  GitMutationResponse,
  GitMutationResult,
  GitRefreshResponse,
  GitRefreshResult,
  GitRepositoryState
} from '../../shared/git-contract.ts'
import { isCanonicalAbsolutePath, isGitCommand } from './git-command-validation.ts'
import { GitService, type GitServiceOptions } from './git-service.ts'

export type GitCapabilityService = Pick<
  GitService,
  | 'refreshSafe'
  | 'getDiff'
  | 'mutateFile'
  | 'prepareCommit'
  | 'executeCommit'
  | 'listHistory'
  | 'getHistoryDetail'
  | 'getHistoryFileDiff'
  | 'prepareBranchSync'
  | 'executeBranchSync'
>
export type GitCapabilityServiceFactory = (
  canonicalProjectPath: string,
  options?: Pick<GitServiceOptions, 'authorizedRepositoryRoot'>
) => GitCapabilityService
export type ResolveActiveRegisteredProject = (projectKey: string) => Promise<string>

type ServiceEntry = {
  service: GitCapabilityService
  authorizedRepositoryRoot: string | null
}

type TrustChallenge = {
  repositoryRoot: string
  statusRevision: string
}

class ProjectSerialQueue {
  private tail: Promise<void> = Promise.resolve()
  private pending = 0

  run<T>(operation: () => Promise<T>): Promise<T> {
    this.pending += 1
    const result = this.tail.then(operation, operation)
    this.tail = result.then(() => undefined, () => undefined)
    return result.finally(() => {
      this.pending -= 1
    })
  }

  get idle(): boolean {
    return this.pending === 0
  }
}

export class GitCapabilityController {
  private readonly services = new Map<string, ServiceEntry>()
  private readonly trustChallenges = new Map<string, TrustChallenge>()
  private readonly projectQueues = new Map<string, ProjectSerialQueue>()
  private readonly resolveActiveRegisteredProject: ResolveActiveRegisteredProject
  private readonly createService: GitCapabilityServiceFactory

  constructor(
    resolveActiveRegisteredProject: ResolveActiveRegisteredProject,
    createService: GitCapabilityServiceFactory = (projectPath, options) =>
      new GitService(projectPath, options)
  ) {
    this.resolveActiveRegisteredProject = resolveActiveRegisteredProject
    this.createService = createService
  }

  async dispatch(
    commandValue: Extract<GitCommand, { type: 'git.refresh' | 'git.authorize-ancestor-repository' }>,
    signal?: AbortSignal
  ): Promise<GitRefreshResponse>
  async dispatch(commandValue: Extract<GitCommand, { type: 'git.get-diff' }>, signal?: AbortSignal): Promise<GitDiffResponse>
  async dispatch(commandValue: Extract<GitCommand, { type: 'git.mutate-file' }>, signal?: AbortSignal): Promise<GitMutationResponse>
  async dispatch(commandValue: Extract<GitCommand, { type: 'git.prepare-commit' }>, signal?: AbortSignal): Promise<GitCommitPreviewResponse>
  async dispatch(commandValue: Extract<GitCommand, { type: 'git.execute-commit' }>, signal?: AbortSignal): Promise<GitCommitExecutionResponse>
  async dispatch(commandValue: Extract<GitCommand, { type: 'git.list-history' }>, signal?: AbortSignal): Promise<GitHistoryListResponse>
  async dispatch(commandValue: Extract<GitCommand, { type: 'git.get-history-detail' }>, signal?: AbortSignal): Promise<GitHistoryDetailResponse>
  async dispatch(commandValue: Extract<GitCommand, { type: 'git.get-history-file-diff' }>, signal?: AbortSignal): Promise<GitHistoryFileDiffResponse>
  async dispatch(commandValue: Extract<GitCommand, { type: 'git.prepare-branch-sync' }>, signal?: AbortSignal): Promise<GitBranchSyncPrepareResponse>
  async dispatch(commandValue: Extract<GitCommand, { type: 'git.execute-branch-sync' }>, signal?: AbortSignal): Promise<GitBranchSyncExecutionResponse>
  async dispatch(commandValue: unknown, signal?: AbortSignal): Promise<GitCommandResponse>
  async dispatch(commandValue: unknown, signal?: AbortSignal): Promise<GitCommandResponse> {
    if (!isGitCommand(commandValue)) throw new Error('Invalid Git command.')
    const command: GitCommand = commandValue
    let canonicalProjectPath: string
    try {
      canonicalProjectPath = await this.resolveActiveRegisteredProject(command.projectKey)
      if (!isCanonicalAbsolutePath(canonicalProjectPath)) throw new Error('noncanonical')
    } catch {
      return this.projectFailure(command, fixedError('git-error', 'Active Project is unavailable for Git.'))
    }

    return await this.runProjectOperation(canonicalProjectPath, async () => {
      try {
        switch (command.type) {
          case 'git.refresh':
            return await this.refresh(command.projectKey, canonicalProjectPath)
          case 'git.authorize-ancestor-repository':
            return await this.authorizeAncestorRepository(
              command.projectKey,
              canonicalProjectPath,
              command.repositoryRoot,
              command.expectedStatusRevision
            )
          case 'git.get-diff':
            return await this.getDiff(command.projectKey, canonicalProjectPath, command.request)
          case 'git.mutate-file':
            return await this.mutateFile(command.projectKey, canonicalProjectPath, command.request)
          case 'git.prepare-commit':
            return await this.prepareCommit(command.projectKey, canonicalProjectPath)
          case 'git.execute-commit':
            return await this.executeCommit(command.projectKey, canonicalProjectPath, command.request)
          case 'git.list-history':
            return await this.listHistory(command.projectKey, canonicalProjectPath, command.request, signal)
          case 'git.get-history-detail':
            return await this.getHistoryDetail(command.projectKey, canonicalProjectPath, command.request, signal)
          case 'git.get-history-file-diff':
            return await this.getHistoryFileDiff(command.projectKey, canonicalProjectPath, command.request, signal)
          case 'git.prepare-branch-sync':
            return await this.prepareBranchSync(command.projectKey, canonicalProjectPath, signal)
          case 'git.execute-branch-sync':
            return await this.executeBranchSync(command.projectKey, canonicalProjectPath, command.request)
        }
      } catch {
        this.services.delete(canonicalProjectPath)
        this.trustChallenges.delete(canonicalProjectPath)
        return this.projectFailure(command, fixedError('git-error', 'Git controller operation failed.'))
      }
    })
  }

  private async runProjectOperation<T>(canonicalProjectPath: string, operation: () => Promise<T>): Promise<T> {
    let queue = this.projectQueues.get(canonicalProjectPath)
    if (queue === undefined) {
      queue = new ProjectSerialQueue()
      this.projectQueues.set(canonicalProjectPath, queue)
    }
    try {
      return await queue.run(operation)
    } finally {
      if (queue.idle && this.projectQueues.get(canonicalProjectPath) === queue) {
        this.projectQueues.delete(canonicalProjectPath)
      }
    }
  }

  private async refresh(projectKey: string, canonicalProjectPath: string): Promise<GitRefreshResponse> {
    const result = await this.refreshEntry(canonicalProjectPath)
    return { projectKey, result }
  }

  private async authorizeAncestorRepository(
    projectKey: string,
    canonicalProjectPath: string,
    repositoryRoot: string,
    expectedStatusRevision: string
  ): Promise<GitRefreshResponse> {
    const challenge = this.trustChallenges.get(canonicalProjectPath)
    if (
      challenge === undefined ||
      challenge.repositoryRoot !== repositoryRoot ||
      challenge.statusRevision !== expectedStatusRevision
    ) {
      return {
        projectKey,
        result: {
          ok: false,
          error: fixedError('stale', 'Git ancestor authorization is stale or does not match the current Project.')
        }
      }
    }

    const unauthorizedService = this.createService(canonicalProjectPath)
    const fresh = await unauthorizedService.refreshSafe()
    if (
      !fresh.ok ||
      !isExactTrustChallenge(fresh.state, canonicalProjectPath, repositoryRoot, expectedStatusRevision)
    ) {
      this.trustChallenges.delete(canonicalProjectPath)
      return {
        projectKey,
        result: {
          ok: false,
          error: fixedError('stale', 'Git ancestor authorization is stale or does not match the current Project.')
        }
      }
    }

    const authorizedService = this.createService(canonicalProjectPath, {
      authorizedRepositoryRoot: repositoryRoot
    })
    const authorized = await authorizedService.refreshSafe()
    if (
      !authorized.ok ||
      !isValidStateIdentity(authorized.state, canonicalProjectPath, repositoryRoot) ||
      authorized.state.kind !== 'repository' ||
      authorized.state.repositoryRoot !== repositoryRoot
    ) {
      this.services.delete(canonicalProjectPath)
      return {
        projectKey,
        result: authorized.ok
          ? { ok: false, error: fixedError('stale', 'Git repository identity changed during authorization.') }
          : authorized
      }
    }

    this.services.set(canonicalProjectPath, {
      service: authorizedService,
      authorizedRepositoryRoot: repositoryRoot
    })
    this.trustChallenges.delete(canonicalProjectPath)
    return { projectKey, result: authorized }
  }

  private async getDiff(
    projectKey: string,
    canonicalProjectPath: string,
    request: GitDiffRequest
  ): Promise<GitDiffResponse> {
    const preflight = await this.refreshEntry(canonicalProjectPath)
    if (!preflight.ok) {
      return { projectKey, result: diffFailure(request, preflight.error) }
    }
    if (preflight.state.kind !== 'repository') {
      const error = preflight.state.kind === 'trust-required'
        ? trustRequiredError()
        : fixedError('not-repository', 'Project is not a Git repository.')
      return { projectKey, result: diffFailure(request, error, preflight.state) }
    }

    const entry = this.services.get(canonicalProjectPath)
    if (entry === undefined) {
      return {
        projectKey,
        result: diffFailure(request, fixedError('git-error', 'Git repository service is unavailable.'), preflight.state)
      }
    }
    const result = await entry.service.getDiff(request)
    if (result.state === 'trust-required' || result.error?.code === 'trust-required') {
      await this.refreshEntry(canonicalProjectPath)
    }
    return { projectKey, result }
  }

  private async mutateFile(
    projectKey: string,
    canonicalProjectPath: string,
    request: GitFileMutationRequest
  ): Promise<GitMutationResponse> {
    const preflight = await this.refreshEntry(canonicalProjectPath)
    if (!preflight.ok) {
      return { projectKey, result: mutationFailure(request, preflight.error) }
    }
    if (preflight.state.kind !== 'repository') {
      const error = preflight.state.kind === 'trust-required'
        ? trustRequiredError()
        : fixedError('not-repository', 'Project is not a Git repository.')
      return { projectKey, result: mutationFailure(request, error, preflight.state) }
    }

    const entry = this.services.get(canonicalProjectPath)
    if (entry === undefined) {
      return {
        projectKey,
        result: mutationFailure(request, fixedError('git-error', 'Git repository service is unavailable.'), preflight.state)
      }
    }
    const result = await entry.service.mutateFile(request)
    if (!result.ok && result.error.code === 'trust-required') {
      await this.refreshEntry(canonicalProjectPath)
    }
    return { projectKey, result }
  }

  private async prepareCommit(
    projectKey: string,
    canonicalProjectPath: string
  ): Promise<GitCommitPreviewResponse> {
    const preflight = await this.refreshEntry(canonicalProjectPath)
    if (!preflight.ok) {
      return { projectKey, result: { ok: false, error: preflight.error, state: null } }
    }
    if (preflight.state.kind !== 'repository') {
      const error = preflight.state.kind === 'trust-required'
        ? trustRequiredError()
        : fixedError('not-repository', 'Project is not a Git repository.')
      return { projectKey, result: { ok: false, error, state: preflight.state } }
    }

    const entry = this.services.get(canonicalProjectPath)
    if (entry === undefined) {
      return {
        projectKey,
        result: {
          ok: false,
          error: fixedError('git-error', 'Git repository service is unavailable.'),
          state: preflight.state
        }
      }
    }
    const result = await entry.service.prepareCommit()
    if (!result.ok && result.error.code === 'trust-required') {
      await this.refreshEntry(canonicalProjectPath)
    }
    return { projectKey, result }
  }

  private async listHistory(
    projectKey: string,
    canonicalProjectPath: string,
    request: GitHistoryListRequest,
    signal?: AbortSignal
  ): Promise<GitHistoryListResponse> {
    const preflight = await this.refreshEntry(canonicalProjectPath, signal)
    if (!preflight.ok) {
      return { projectKey, result: { ok: false, error: preflight.error, snapshot: request.snapshot, current: null } }
    }
    if (preflight.state.kind !== 'repository') {
      const error = preflight.state.kind === 'trust-required'
        ? trustRequiredError()
        : fixedError('not-repository', 'Project is not a Git repository.')
      return { projectKey, result: { ok: false, error, snapshot: request.snapshot, current: null } }
    }

    const entry = this.services.get(canonicalProjectPath)
    if (entry === undefined) {
      return {
        projectKey,
        result: {
          ok: false,
          error: fixedError('git-error', 'Git repository service is unavailable.'),
          snapshot: request.snapshot,
          current: null
        }
      }
    }
    const result = await entry.service.listHistory(request, signal)
    if (!result.ok && result.error.code === 'trust-required') {
      await this.refreshEntry(canonicalProjectPath, signal)
    }
    return { projectKey, result }
  }

  private async getHistoryDetail(
    projectKey: string,
    canonicalProjectPath: string,
    request: GitHistoryDetailRequest,
    signal?: AbortSignal
  ): Promise<GitHistoryDetailResponse> {
    const preflight = await this.refreshEntry(canonicalProjectPath, signal)
    if (!preflight.ok) {
      return { projectKey, result: { ok: false, error: preflight.error, snapshot: request.snapshot, current: null } }
    }
    if (preflight.state.kind !== 'repository') {
      const error = preflight.state.kind === 'trust-required'
        ? trustRequiredError()
        : fixedError('not-repository', 'Project is not a Git repository.')
      return { projectKey, result: { ok: false, error, snapshot: request.snapshot, current: null } }
    }

    const entry = this.services.get(canonicalProjectPath)
    if (entry === undefined) {
      return {
        projectKey,
        result: {
          ok: false,
          error: fixedError('git-error', 'Git repository service is unavailable.'),
          snapshot: request.snapshot,
          current: null
        }
      }
    }
    const result = await entry.service.getHistoryDetail(request, signal)
    if (!result.ok && result.error.code === 'trust-required') {
      await this.refreshEntry(canonicalProjectPath, signal)
    }
    return { projectKey, result }
  }

  private async getHistoryFileDiff(
    projectKey: string,
    canonicalProjectPath: string,
    request: GitHistoryFileDiffRequest,
    signal?: AbortSignal
  ): Promise<GitHistoryFileDiffResponse> {
    const preflight = await this.refreshEntry(canonicalProjectPath, signal)
    if (!preflight.ok) {
      return {
        projectKey,
        result: historyDiffFailure(request, preflight.error)
      }
    }
    if (preflight.state.kind !== 'repository') {
      const error = preflight.state.kind === 'trust-required'
        ? trustRequiredError()
        : fixedError('not-repository', 'Project is not a Git repository.')
      return { projectKey, result: historyDiffFailure(request, error) }
    }

    const entry = this.services.get(canonicalProjectPath)
    if (entry === undefined) {
      return {
        projectKey,
        result: historyDiffFailure(request, fixedError('git-error', 'Git repository service is unavailable.'))
      }
    }
    const result = await entry.service.getHistoryFileDiff(request, signal)
    if (result.state === 'trust-required' || result.error?.code === 'trust-required') {
      await this.refreshEntry(canonicalProjectPath, signal)
    }
    return { projectKey, result }
  }

  private async prepareBranchSync(
    projectKey: string,
    canonicalProjectPath: string,
    signal?: AbortSignal
  ): Promise<GitBranchSyncPrepareResponse> {
    const preflight = await this.refreshEntry(canonicalProjectPath, signal)
    if (!preflight.ok) {
      return { projectKey, result: { ok: false, error: preflight.error, state: null } }
    }
    if (preflight.state.kind !== 'repository') {
      const error = preflight.state.kind === 'trust-required'
        ? trustRequiredError()
        : fixedError('not-repository', 'Project is not a Git repository.')
      return { projectKey, result: { ok: false, error, state: preflight.state } }
    }

    const entry = this.services.get(canonicalProjectPath)
    if (entry === undefined) {
      return {
        projectKey,
        result: {
          ok: false,
          error: fixedError('git-error', 'Git repository service is unavailable.'),
          state: preflight.state
        }
      }
    }
    const result = await entry.service.prepareBranchSync(signal)
    if (!result.ok && result.error.code === 'trust-required') {
      await this.refreshEntry(canonicalProjectPath, signal)
    }
    return { projectKey, result }
  }

  private async executeBranchSync(
    projectKey: string,
    canonicalProjectPath: string,
    request: GitBranchSyncExecutionRequest
  ): Promise<GitBranchSyncExecutionResponse> {
    const preflight = await this.refreshEntry(canonicalProjectPath)
    if (!preflight.ok) {
      return {
        projectKey,
        result: failedBranchSync(request.action, preflight.error, {
          ok: false,
          error: preflight.error,
          state: null
        })
      }
    }
    if (preflight.state.kind !== 'repository') {
      const error = preflight.state.kind === 'trust-required'
        ? trustRequiredError()
        : fixedError('not-repository', 'Project is not a Git repository.')
      return {
        projectKey,
        result: failedBranchSync(request.action, error, {
          ok: false,
          error,
          state: preflight.state
        })
      }
    }

    const entry = this.services.get(canonicalProjectPath)
    if (entry === undefined) {
      return {
        projectKey,
        result: failedBranchSync(
          request.action,
          fixedError('git-error', 'Git repository service is unavailable.'),
          {
            ok: false,
            error: fixedError('git-error', 'Git repository service is unavailable.'),
            state: preflight.state
          }
        )
      }
    }
    const result = await entry.service.executeBranchSync(request)
    if (branchSyncNeedsTrustRefresh(result)) {
      await this.refreshEntry(canonicalProjectPath)
    }
    return { projectKey, result }
  }

  private async executeCommit(
    projectKey: string,
    canonicalProjectPath: string,
    request: GitCommitExecutionRequest
  ): Promise<GitCommitExecutionResponse> {
    const preflight = await this.refreshEntry(canonicalProjectPath)
    if (!preflight.ok) {
      return {
        projectKey,
        result: failedExecution(request.mode, preflight.error, preflight)
      }
    }
    if (preflight.state.kind !== 'repository') {
      const error = preflight.state.kind === 'trust-required'
        ? trustRequiredError()
        : fixedError('not-repository', 'Project is not a Git repository.')
      return {
        projectKey,
        result: failedExecution(request.mode, error, { ok: true, state: preflight.state })
      }
    }

    const entry = this.services.get(canonicalProjectPath)
    if (entry === undefined) {
      return {
        projectKey,
        result: failedExecution(
          request.mode,
          fixedError('git-error', 'Git repository service is unavailable.'),
          { ok: true, state: preflight.state }
        )
      }
    }
    const result = await entry.service.executeCommit(request)
    if (
      result.commit.status === 'failed' && result.commit.error.code === 'trust-required' ||
      result.push?.status === 'failed' && result.push.error.code === 'trust-required'
    ) {
      await this.refreshEntry(canonicalProjectPath)
    }
    return { projectKey, result }
  }

  private async refreshEntry(
    canonicalProjectPath: string,
    signal?: AbortSignal
  ): Promise<GitRefreshResult> {
    let entry = this.services.get(canonicalProjectPath)
    if (entry === undefined) {
      entry = {
        service: this.createService(canonicalProjectPath),
        authorizedRepositoryRoot: null
      }
      this.services.set(canonicalProjectPath, entry)
    }

    let result = await entry.service.refreshSafe(signal)
    if (!result.ok) {
      this.services.delete(canonicalProjectPath)
      this.trustChallenges.delete(canonicalProjectPath)
      return result
    }
    if (!isValidStateIdentity(result.state, canonicalProjectPath, entry.authorizedRepositoryRoot)) {
      this.services.delete(canonicalProjectPath)
      this.trustChallenges.delete(canonicalProjectPath)
      return {
        ok: false,
        error: fixedError('git-error', 'Git service returned an invalid Project identity.')
      }
    }

    if (result.state.kind === 'trust-required' && entry.authorizedRepositoryRoot !== null) {
      const unauthorizedService = this.createService(canonicalProjectPath)
      result = await unauthorizedService.refreshSafe(signal)
      if (!result.ok || !isValidStateIdentity(result.state, canonicalProjectPath, null)) {
        this.services.delete(canonicalProjectPath)
        this.trustChallenges.delete(canonicalProjectPath)
        return result.ok
          ? { ok: false, error: fixedError('git-error', 'Git service returned an invalid Project identity.') }
          : result
      }
      entry = { service: unauthorizedService, authorizedRepositoryRoot: null }
      this.services.set(canonicalProjectPath, entry)
    }

    if (result.state.kind === 'trust-required' && result.state.repositoryRoot !== null) {
      this.trustChallenges.set(canonicalProjectPath, {
        repositoryRoot: result.state.repositoryRoot,
        statusRevision: result.state.statusRevision
      })
    } else {
      this.trustChallenges.delete(canonicalProjectPath)
      if (result.state.kind !== 'repository') this.services.delete(canonicalProjectPath)
    }
    return result
  }

  private projectFailure(command: GitCommand, error: GitErrorDto): GitCommandResponse {
    if (command.type === 'git.get-diff') {
      return { projectKey: command.projectKey, result: diffFailure(command.request, error) }
    }
    if (command.type === 'git.mutate-file') {
      return { projectKey: command.projectKey, result: mutationFailure(command.request, error) }
    }
    if (command.type === 'git.prepare-commit') {
      return { projectKey: command.projectKey, result: { ok: false, error, state: null } satisfies GitCommitPreviewResult }
    }
    if (command.type === 'git.execute-commit') {
      return {
        projectKey: command.projectKey,
        result: failedExecution(command.request.mode, error, { ok: false, error })
      }
    }
    if (command.type === 'git.list-history') {
      return {
        projectKey: command.projectKey,
        result: { ok: false, error, snapshot: command.request.snapshot, current: null } satisfies GitHistoryListResult
      }
    }
    if (command.type === 'git.get-history-detail') {
      return {
        projectKey: command.projectKey,
        result: { ok: false, error, snapshot: command.request.snapshot, current: null } satisfies GitHistoryDetailResult
      }
    }
    if (command.type === 'git.get-history-file-diff') {
      return {
        projectKey: command.projectKey,
        result: historyDiffFailure(command.request, error)
      }
    }
    if (command.type === 'git.prepare-branch-sync') {
      return {
        projectKey: command.projectKey,
        result: { ok: false, error, state: null } satisfies GitBranchSyncPrepareResult
      }
    }
    if (command.type === 'git.execute-branch-sync') {
      return {
        projectKey: command.projectKey,
        result: failedBranchSync(command.request.action, error, { ok: false, error, state: null })
      }
    }
    return { projectKey: command.projectKey, result: { ok: false, error } }
  }
}

function isExactTrustChallenge(
  state: GitRepositoryState,
  projectRoot: string,
  repositoryRoot: string,
  statusRevision: string
): boolean {
  return isValidStateIdentity(state, projectRoot, null) &&
    state.kind === 'trust-required' &&
    state.repositoryRoot === repositoryRoot &&
    state.statusRevision === statusRevision
}

function isValidStateIdentity(
  state: GitRepositoryState,
  canonicalProjectPath: string,
  authorizedRepositoryRoot: string | null
): boolean {
  if (state.projectRoot !== canonicalProjectPath) return false
  if (state.kind === 'not-repository') return state.repositoryRoot === null
  if (state.kind === 'trust-required') {
    return state.repositoryRoot !== null &&
      isCanonicalAncestor(state.repositoryRoot, canonicalProjectPath)
  }
  return state.repositoryRoot === canonicalProjectPath ||
    (authorizedRepositoryRoot !== null && state.repositoryRoot === authorizedRepositoryRoot)
}

function isCanonicalAncestor(repositoryRoot: string, canonicalProjectPath: string): boolean {
  if (!isCanonicalAbsolutePath(repositoryRoot) || repositoryRoot === canonicalProjectPath) return false
  const pathFromRepository = relative(repositoryRoot, canonicalProjectPath)
  return pathFromRepository.length > 0 &&
    pathFromRepository !== '..' &&
    !pathFromRepository.startsWith(`..${sep}`) &&
    !isAbsolute(pathFromRepository)
}

function diffFailure(
  request: GitDiffRequest,
  error: GitErrorDto,
  state: GitRepositoryState | null = null
): GitDiffResult {
  return {
    kind: request.kind,
    path: request.path,
    state: error.code === 'trust-required'
      ? 'trust-required'
      : error.code === 'not-repository'
        ? 'not-repository'
        : error.code === 'output-limit'
          ? 'oversized'
          : error.code === 'unsupported'
            ? 'unsupported'
            : error.code === 'conflict'
              ? 'conflict'
              : 'error',
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

function mutationFailure(
  request: GitFileMutationRequest,
  error: GitErrorDto,
  state: GitRepositoryState | null = null
): GitMutationResult {
  return {
    ok: false,
    action: request.action,
    path: request.path,
    error,
    state
  }
}

function failedExecution(
  mode: GitCommitExecutionRequest['mode'],
  error: GitErrorDto,
  postState: GitRefreshResult
): GitCommitExecutionResult {
  return {
    mode,
    commit: { status: 'failed', error },
    push: null,
    postState
  }
}

function trustRequiredError(): GitErrorDto {
  return fixedError(
    'trust-required',
    'The Project is inside a different repository root and requires exact Main authorization.'
  )
}

function historyDiffFailure(
  request: GitHistoryFileDiffRequest,
  error: GitErrorDto
): GitHistoryFileDiffResult {
  return {
    oid: request.oid,
    fileId: request.fileId,
    path: null,
    originalPath: null,
    status: null,
    state: error.code === 'trust-required'
      ? 'trust-required'
      : error.code === 'not-repository'
        ? 'not-repository'
        : error.code === 'output-limit'
          ? 'oversized'
          : error.code === 'unsupported'
            ? 'unsupported'
            : 'error',
    snapshot: null,
    current: null,
    files: [],
    byteCount: 0,
    hunkCount: 0,
    lineCount: 0,
    error
  }
}

function fixedError(code: GitErrorCode, message: string): GitErrorDto {
  return { code, message, stderrCharacters: 0 }
}

function failedBranchSync(
  action: GitBranchSyncExecutionRequest['action'],
  error: GitErrorDto,
  postView: GitBranchSyncPrepareResult
): GitBranchSyncExecutionResult {
  if (action === 'create-and-switch' || action === 'switch') {
    return {
      action,
      branch: { status: 'failed', error },
      fetch: null,
      fastForward: null,
      push: null,
      postView
    }
  }
  if (action === 'fetch' || action === 'pull') {
    return {
      action,
      branch: null,
      fetch: { status: 'failed', remote: '', error },
      fastForward: null,
      push: null,
      postView
    }
  }
  return {
    action,
    branch: null,
    fetch: null,
    fastForward: null,
    push: { status: 'failed', remote: '', branch: '', error },
    postView
  }
}

function branchSyncNeedsTrustRefresh(result: GitBranchSyncExecutionResult): boolean {
  if (result.branch?.status === 'failed' && result.branch.error.code === 'trust-required') return true
  if (result.fetch?.status === 'failed' && result.fetch.error.code === 'trust-required') return true
  if (result.fetch?.status === 'unknown' && result.fetch.error.code === 'trust-required') return true
  if (result.fastForward?.status === 'failed' && result.fastForward.error.code === 'trust-required') return true
  if (result.push?.status === 'failed' && result.push.error.code === 'trust-required') return true
  if (result.push?.status === 'unknown' && result.push.error.code === 'trust-required') return true
  if (!result.postView.ok && result.postView.error.code === 'trust-required') return true
  return false
}
