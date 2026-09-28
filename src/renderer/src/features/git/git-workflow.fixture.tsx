import { act, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import {
  GIT_HISTORY_PAGE_SIZE,
  type GitRepositoryState, type GitFileChange, type GitHistoryListRequest,
  type GitHistoryCommitSummary, type GitBranchSyncPrepareResult, type GitCommitPreview,
  type GitBranchSyncExecutionRequest
} from '../../../../shared/git-contract'
import { GitChangesPanel } from './GitChangesPanel'
import { useGitRepository } from './use-git-repository'
import { useGitChanges } from './use-git-changes'
import { useGitHistory } from './use-git-history'
import { useGitBranches } from './use-git-branches'

type Pending = { method: string; projectKey: string; payload: unknown; resolve: (result: unknown) => void }
const file: GitFileChange = {
  id: 'file', path: 'tracked.txt', originalPath: null, state: 'mixed',
  indexChange: 'modified', worktreeChange: 'modified', conflicted: false, fingerprint: 'file'
}
function repository(projectKey: string, revision = '1'): GitRepositoryState {
  return {
    kind: 'repository', projectRoot: projectKey, repositoryRoot: `/${projectKey}`, headOid: 'a'.repeat(40),
    branch: 'main', detached: false, upstream: 'origin/main', ahead: 0, behind: 0,
    indexTreeOid: 'b'.repeat(40), indexFingerprint: 'index', worktreeFingerprint: 'worktree',
    statusRevision: revision, files: [file], truncated: false, refreshedAt: 1, lastError: null
  }
}
function commit(index: number): GitHistoryCommitSummary {
  return {
    oid: index.toString(16).padStart(40, '0'), shortOid: String(index), subject: `commit ${index}`,
    authorName: 'A', authorEmail: '', authorAt: 1, committerName: 'A', committerEmail: '',
    committerAt: 1, parentOids: []
  }
}
function prepared(state: GitRepositoryState): Extract<GitBranchSyncPrepareResult, { ok: true }> {
  return {
    ok: true,
    snapshot: {
      repositoryRoot: state.repositoryRoot!, headOid: state.headOid, branch: state.branch,
      indexTreeOid: state.indexTreeOid, indexFingerprint: state.indexFingerprint,
      worktreeFingerprint: state.worktreeFingerprint, statusRevision: state.statusRevision,
      upstreamRemote: 'origin', upstreamBranch: 'main'
    },
    current: {
      branch: state.branch, headOid: state.headOid, detached: false, unborn: false,
      upstream: state.upstream, upstreamRemote: 'origin', upstreamBranch: 'main',
      ahead: 0, behind: 0, clean: true, conflicted: false, truncated: false
    },
    localBranches: [{ branchId: 'main', kind: 'local', name: 'main', headOid: state.headOid, isCurrent: true }],
    localBranchesTruncated: false, remoteTrackingBranches: [], remoteTrackingBranchesTruncated: false,
    remotes: [{ remoteId: 'origin-id', name: 'origin' }], remotesTruncated: false,
    actions: { canCreate: true, canSwitch: true, canFetch: true, canPull: true, canPush: true }
  }
}

export async function runGitWorkflowChecks(): Promise<string[]> {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const pending: Pending[] = []
  const calls: string[] = []
  const methods = ['refresh', 'getDiff', 'listHistory', 'getHistoryDetail', 'getHistoryFileDiff',
    'prepareBranchSync', 'executeBranchSync', 'prepareCommit', 'executeCommit', 'stageFile', 'unstageFile',
    'authorizeAncestorRepository']
  window.piGit = Object.fromEntries(methods.map((method) => [method, (projectKey: string, payload: unknown) => {
    calls.push(method)
    return new Promise((resolve) => pending.push({ method, projectKey, payload, resolve }))
  }])) as unknown as Window['piGit']
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const results: string[] = []
  function check(value: unknown, message: string): asserts value {
    if (!value) throw new Error(message)
  }
  const take = (method: string, projectKey = 'A'): Pending => {
    const index = pending.findIndex((call) => call.method === method && call.projectKey === projectKey)
    check(index >= 0, `Missing ${method} for ${projectKey}`)
    return pending.splice(index, 1)[0]!
  }
  const run = async (action: () => void): Promise<void> => { await act(async () => { action() }) }
  const settle = async (call: Pending, result: unknown): Promise<void> => {
    await run(() => call.resolve({ projectKey: call.projectKey, result }))
  }
  const page = (call: Pending, commits: GitHistoryCommitSummary[], hasMore = false) => ({
    ok: true, snapshot: (call.payload as GitHistoryListRequest).snapshot,
    offset: (call.payload as GitHistoryListRequest).offset, pageSize: GIT_HISTORY_PAGE_SIZE, commits, hasMore
  })
  const refresh = async (state: GitRepositoryState): Promise<void> => {
    await run(() => { void api.repo.refreshState(api.repo.generationRef.current, false) })
    await settle(take('refresh', state.projectRoot), { ok: true, state })
  }
  function Probe({ projectKey }: { projectKey: string }) {
    const repo = useGitRepository(projectKey)
    const changes = useGitChanges(repo, repo.state)
    const history = useGitHistory(repo, repo.state, false)
    const branches = useGitBranches(repo)
    api = { repo, changes, history, branches }
    return null
  }
  let api!: {
    repo: ReturnType<typeof useGitRepository>; changes: ReturnType<typeof useGitChanges>;
    history: ReturnType<typeof useGitHistory>; branches: ReturnType<typeof useGitBranches>
  }
  const mount = async (projectKey: string, strict = false): Promise<void> => {
    await run(() => root.render(strict
      ? <StrictMode><Probe key={projectKey} projectKey={projectKey} /></StrictMode>
      : <Probe key={projectKey} projectKey={projectKey} />))
  }
  let state = repository('A')
  try {
    await mount('A', true)
    const obsoleteRefresh = take('refresh')
    await settle(take('refresh'), { ok: true, state })
    await settle(obsoleteRefresh, { ok: true, state: repository('A', 'obsolete') })
    check(api.repo.state?.statusRevision === '1', 'Strict Mode replay accepted an obsolete refresh')
    results.push('Strict Mode and late initial refresh preserve current identity')

    await run(() => api.history.activateHistory(false))
    const first = take('listHistory')
    await settle(first, page(first, Array.from({ length: GIT_HISTORY_PAGE_SIZE }, (_, i) => commit(i)), true))
    await run(() => api.history.loadMoreHistory())
    const more = take('listHistory')
    check((more.payload as GitHistoryListRequest).offset === GIT_HISTORY_PAGE_SIZE, 'Pagination offset was lost')
    await settle(more, page(more, [commit(GIT_HISTORY_PAGE_SIZE - 1), commit(GIT_HISTORY_PAGE_SIZE)]))
    check(api.history.historyDraft.commits.length === GIT_HISTORY_PAGE_SIZE + 1, 'Pagination did not deduplicate OIDs')
    results.push('History pagination retains ordering and deduplicates overlap')

    await run(() => { void api.history.selectHistoryCommit(commit(0).oid) })
    const detail = take('getHistoryDetail')
    state = { ...state, headOid: 'c'.repeat(40), statusRevision: '2' }
    await refresh(state)
    await settle(detail, { ok: true, snapshot: (detail.payload as GitHistoryListRequest).snapshot,
      commit: { ...commit(0), message: 'late', messageTruncated: false }, files: [], filesTruncated: false })
    check(api.history.historyDraft.selectedOid === null && api.history.historyDraft.detail === null,
      'Old detail survived a HEAD change')
    results.push('Repository replacement invalidates pending history detail')

    await run(() => { api.changes.toggleFile(state, file, 'working'); api.changes.toggleFile(state, file, 'working') })
    const diff = take('getDiff')
    check(!pending.some((call) => call.method === 'getDiff'), 'Duplicate diff requests were not coalesced')
    await settle(diff, {
      kind: 'working', path: file.path, state: 'ready', revision: state.statusRevision, headOid: state.headOid,
      indexTreeOid: state.indexTreeOid, worktreeFingerprint: state.worktreeFingerprint,
      files: [], byteCount: 0, fileCount: 0, hunkCount: 0, lineCount: 0, error: null
    })
    await run(() => api.changes.clearExpandedDiffs())
    await run(() => api.changes.toggleFile(state, file, 'working'))
    check(!pending.some((call) => call.method === 'getDiff'), 'Valid diff cache was lost')
    await refresh({ ...state, statusRevision: '3' })
    check(api.changes.expandedDiffs.size === 0, 'Refresh left a stale expanded diff')
    state = api.repo.state!
    results.push('Diff single-flight, cache reuse and refresh invalidation remain intact')

    await run(() => { void api.changes.mutateFile(state, file, 'stage'); void api.changes.mutateFile(state, file, 'stage') })
    const mutation = take('stageFile')
    check(!pending.some((call) => call.method === 'stageFile'), 'Duplicate staging escaped the mutation gate')
    await mount('B')
    await settle(take('refresh', 'B'), { ok: true, state: repository('B') })
    await settle(mutation, { ok: true, action: 'stage', path: file.path, state })
    check(api.repo.state?.projectRoot === 'B' && api.changes.pendingMutations.size === 0,
      'A late mutation contaminated the new Project')
    check(!pending.some((call) => call.method === 'refresh' && call.projectKey === 'A'), 'Late mutation refreshed the old Project')
    results.push('Duplicate writes and late mutations are fenced across Project changes')

    await mount('A')
    await settle(take('refresh'), { ok: true, state })
    await run(() => { void api.changes.prepareCommit(state) })
    const preview: GitCommitPreview = {
      snapshot: { repositoryRoot: '/A', branch: 'main', headOid: state.headOid, indexTreeOid: state.indexTreeOid!, indexFingerprint: state.indexFingerprint },
      stagedFileCount: 1, pushTarget: { remote: 'origin', branch: 'main' }, amendAvailable: true, suggestedMessage: 'change'
    }
    await settle(take('prepareCommit'), { ok: true, preview })
    // A refresh can start while the commit dialog is idle and finish after commit.
    await run(() => { void api.repo.refreshState(api.repo.generationRef.current, false) })
    const preCommitRefresh = take('refresh')
    await run(() => { void api.changes.submitCommit('commit-and-push', 'change') })
    const committedState = { ...state, headOid: 'd'.repeat(40), statusRevision: 'committed' }
    await settle(take('executeCommit'), {
      mode: 'commit-and-push', commit: { status: 'succeeded', oid: 'd'.repeat(40), warnings: [] },
      push: { status: 'failed', remote: 'origin', branch: 'main', error: { code: 'git-error', message: 'offline', stderrCharacters: 0 } },
      postState: { ok: true, state: committedState }
    })
    check(api.changes.commitDialog?.result?.commit.status === 'succeeded' && api.changes.commitDialog.result.push.status === 'failed',
      'Partial commit success was lost')
    await run(() => { void api.changes.submitCommit('commit-and-push', 'change') })
    check(!pending.some((call) => call.method === 'executeCommit'), 'Landed commit could be submitted twice')
    results.push('Commit success survives push failure and blocks duplicate submission')

    await settle(preCommitRefresh, { ok: true, state })
    check(api.repo.state === committedState && !api.repo.refreshing,
      'An older refresh overwrote the committed repository state')
    state = committedState
    results.push('Publishing a committed snapshot supersedes older refreshes')

    await run(() => api.branches.activateBranches(false))
    await settle(take('prepareBranchSync'), prepared(state))
    // Refresh does not block idle branch actions. Its post-refresh prepare may
    // replace the list snapshot after the user has already opened a confirmation.
    await run(() => { void api.repo.refreshState(api.repo.generationRef.current, false) })
    const branchRefresh = take('refresh')
    await run(() => api.branches.openBranchDialog('fetch'))
    const refreshedBranchState = { ...state, statusRevision: 'after-confirmation' }
    await settle(branchRefresh, { ok: true, state: refreshedBranchState })
    await run(() => api.branches.activateBranches(true))
    await settle(take('prepareBranchSync'), prepared(refreshedBranchState))
    await run(() => { void api.branches.submitBranchSync({ action: 'fetch', remoteId: 'origin-id' }) })
    const branch = take('executeBranchSync')
    check((branch.payload as GitBranchSyncExecutionRequest).snapshot.statusRevision === state.statusRevision,
      'Branch submission silently replaced the snapshot the user confirmed')
    results.push('Branch confirmation retains its own snapshot through list refresh')
    await mount('B')
    await settle(take('refresh', 'B'), { ok: true, state: repository('B') })
    await settle(branch, { action: 'fetch', branch: null, fetch: { status: 'succeeded', remote: 'origin' }, fastForward: null, push: null, postView: prepared(state) })
    check(api.branches.branchDialog === null && api.branches.branchesDraft.listStatus === 'loading',
      'Late branch response reopened a dialog in another Project')
    results.push('Branch execution remains bound to its original confirmation owner')

    for (const staleFailure of [false, true]) {
      const key = staleFailure ? 'C-error' : 'C-state'
      await mount(key)
      const trustedState = repository(key)
      const trustState: GitRepositoryState = { ...trustedState, kind: 'trust-required' }
      await settle(take('refresh', key), { ok: true, state: trustState })
      let pendingRefresh!: Promise<string | null>
      await run(() => { pendingRefresh = api.repo.refreshState(api.repo.generationRef.current, false) })
      const preAuthorizationRefresh = take('refresh', key)
      await run(() => { void api.repo.authorizeAncestorRepository(trustState) })
      await settle(take('authorizeAncestorRepository', key), { ok: true, state: trustedState })
      await settle(preAuthorizationRefresh, staleFailure
        ? { ok: false, error: { code: 'git-error', message: 'obsolete failure', stderrCharacters: 0 } }
        : { ok: true, state: trustState })
      check(await pendingRefresh === null, 'Superseded refresh reported an obsolete error')
      check(api.repo.state === trustedState && !api.repo.refreshing,
        'An older refresh reverted successful repository authorization')
      const newer: GitRepositoryState = { ...trustedState, statusRevision: 'newer' }
      await refresh(newer)
      check(api.repo.state === newer && !api.repo.refreshing, 'A new refresh was incorrectly suppressed')
    }
    results.push('Authorization supersedes stale reads and errors while allowing new refreshes')

    await run(() => root.render(<GitChangesPanel projectKey="A" />))
    await settle(take('refresh'), { ok: true, state })
    const historyTab = container.querySelectorAll<HTMLButtonElement>('[role=tab]')[1]!
    await run(() => historyTab.click())
    const oldList = take('listHistory')
    await run(() => root.render(<GitChangesPanel projectKey="B" />))
    await settle(take('refresh', 'B'), { ok: true, state: repository('B') })
    await settle(oldList, page(oldList, [commit(999)]))
    check(container.querySelector('[role=tab][aria-selected=true]')?.textContent === 'Changes', 'Project change retained the old tab')
    check(!container.textContent?.includes('commit 999'), 'Old history appeared in the new Project')
    check(calls.filter((method) => method === 'executeCommit').length === 1, 'UI integration replayed a write')
    results.push('Mounted Git panel resets subviews and rejects previous Project content')
    return results
  } finally {
    await run(() => root.unmount())
    container.remove()
  }
}
