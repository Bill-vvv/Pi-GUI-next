import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import type { GitBranchSyncExecutionRequest, GitBranchSyncSnapshot } from '../../../../shared/git-contract'
import { isCurrentGitResponse } from './git-changes-model'
import {
  buildGitBranchSyncDialogPreview, buildGitBranchSyncExecutionRequest,
  gitBranchSyncExecutionMatchesPreview, gitBranchSyncInvocationFailure,
  gitBranchSyncSnapshotMatchesState, mapGitBranchSyncExecutionResult, mapGitBranchSyncPrepareResult
} from './git-branches-adapter'
import {
  createEmptyGitBranchesDraft, gitBranchesSelectLocalBranch,
  type GitBranchesDraftViewModel, type GitBranchSyncAction,
  type GitBranchSyncConfirmPayload, type GitBranchSyncDialogState
} from './git-branches-model'
import {
  RENDERER_GIT_INVOCATION_ERROR, type GitRepositoryReader, type GitRepositoryController
} from './use-git-repository'

// Confirmation owns the exact snapshot shown to the user; list refreshes own a separate snapshot.
type ConfirmedBranchDialog = GitBranchSyncDialogState & { snapshot: GitBranchSyncSnapshot }

export function useGitBranches({ projectKey, generationRef, stateRef, refreshState, setNotice }:
  GitRepositoryReader & Pick<GitRepositoryController, 'setNotice'>
) {
  const branchPrepareTokenRef = useRef(0)
  const branchExecuteTokenRef = useRef(0)
  const branchSnapshotRef = useRef<GitBranchSyncSnapshot | null>(null)
  const [branchesDraft, setBranchesDraft] = useState<GitBranchesDraftViewModel>(() => createEmptyGitBranchesDraft())
  const [branchPreparing, setBranchPreparing] = useState(false)
  const [branchDialog, setBranchDialog] = useState<ConfirmedBranchDialog | null>(null)

  useLayoutEffect(() => () => {
    branchPrepareTokenRef.current += 1
    branchExecuteTokenRef.current += 1
    branchSnapshotRef.current = null
  }, [])

  const loadBranches = useCallback(async (): Promise<void> => {
    const requestGeneration = generationRef.current
    const requestProjectKey = projectKey
    const requestToken = ++branchPrepareTokenRef.current
    setBranchPreparing(true)
    if (branchSnapshotRef.current === null) {
      setBranchesDraft(createEmptyGitBranchesDraft())
    }
    try {
      const response = await window.piGit.prepareBranchSync(requestProjectKey)
      if (
        requestToken !== branchPrepareTokenRef.current ||
        requestProjectKey !== projectKey ||
        requestGeneration !== generationRef.current
      ) return
      if (!isCurrentGitResponse(
        projectKey,
        generationRef.current,
        requestProjectKey,
        requestGeneration,
        response.projectKey
      )) {
        branchSnapshotRef.current = null
        setBranchesDraft({
          ...createEmptyGitBranchesDraft(),
          listStatus: 'error',
          listError: RENDERER_GIT_INVOCATION_ERROR
        })
        return
      }
      const mapped = mapGitBranchSyncPrepareResult(response.result)
      branchSnapshotRef.current = mapped.snapshot
      setBranchesDraft(mapped.view)
    } catch {
      if (
        requestToken !== branchPrepareTokenRef.current ||
        requestGeneration !== generationRef.current
      ) return
      branchSnapshotRef.current = null
      setBranchesDraft({
        ...createEmptyGitBranchesDraft(),
        listStatus: 'error',
        listError: RENDERER_GIT_INVOCATION_ERROR
      })
    } finally {
      if (
        requestToken === branchPrepareTokenRef.current &&
        requestGeneration === generationRef.current
      ) setBranchPreparing(false)
    }
  }, [projectKey])

  const activateBranches = useCallback((force: boolean): void => {
    if (
      !force &&
      gitBranchSyncSnapshotMatchesState(branchSnapshotRef.current, stateRef.current)
    ) return
    void loadBranches()
  }, [loadBranches])

  const openBranchDialog = (action: GitBranchSyncAction): void => {
    if (
      branchesDraft.listStatus !== 'ready' ||
      branchSnapshotRef.current === null ||
      !branchesDraft.actions[action].enabled ||
      branchDialog !== null
    ) return
    if (!gitBranchSyncSnapshotMatchesState(branchSnapshotRef.current, stateRef.current)) {
      setNotice({ projectKey, tone: 'info', text: 'Git 状态已变化，正在重新准备分支操作。' })
      activateBranches(true)
      return
    }
    setBranchDialog({
      snapshot: branchSnapshotRef.current,
      preview: buildGitBranchSyncDialogPreview(action, branchesDraft),
      busy: false,
      result: null
    })
  }

  const closeBranchDialog = (): void => {
    if (branchDialog?.busy === true) return
    branchExecuteTokenRef.current += 1
    setBranchDialog(null)
    if (!gitBranchSyncSnapshotMatchesState(branchSnapshotRef.current, stateRef.current)) {
      activateBranches(true)
    }
  }

  const submitBranchSync = async (payload: GitBranchSyncConfirmPayload): Promise<void> => {
    const dialog = branchDialog
    if (dialog === null || dialog.busy || dialog.result !== null) return
    const snapshot = dialog.snapshot
    const request: GitBranchSyncExecutionRequest = buildGitBranchSyncExecutionRequest(payload, snapshot)
    const expectedAction = request.action
    const requestGeneration = generationRef.current
    const requestProjectKey = projectKey
    const requestToken = ++branchExecuteTokenRef.current
    setBranchDialog((current) => current === null ? null : { ...current, busy: true })
    setNotice(null)
    try {
      const response = await window.piGit.executeBranchSync(requestProjectKey, request)
      if (
        requestToken !== branchExecuteTokenRef.current ||
        requestProjectKey !== projectKey ||
        requestGeneration !== generationRef.current
      ) return
      if (
        !isCurrentGitResponse(
          projectKey,
          generationRef.current,
          requestProjectKey,
          requestGeneration,
          response.projectKey
        ) ||
        response.result.action !== expectedAction ||
        !gitBranchSyncExecutionMatchesPreview(response.result, dialog.preview, payload, snapshot)
      ) {
        setBranchDialog((current) => current === null
          ? null
          : { ...current, busy: false, result: gitBranchSyncInvocationFailure(dialog.preview.action) })
        return
      }

      const mappedPostView = mapGitBranchSyncPrepareResult(response.result.postView)
      branchSnapshotRef.current = mappedPostView.snapshot
      setBranchesDraft(mappedPostView.view)
      const refreshError = await refreshState(requestGeneration, false)
      if (
        requestToken !== branchExecuteTokenRef.current ||
        requestGeneration !== generationRef.current
      ) return
      const result = mapGitBranchSyncExecutionResult(response.result, refreshError)
      setBranchDialog((current) => current === null
        ? null
        : { ...current, busy: false, result })
    } catch {
      if (
        requestToken !== branchExecuteTokenRef.current ||
        requestGeneration !== generationRef.current
      ) return
      setBranchDialog((current) => current === null
        ? null
        : {
            ...current,
            busy: false,
            result: gitBranchSyncInvocationFailure(dialog.preview.action)
          })
    }
  }

  const selectLocalBranch = (branchId: string): void => {
    setBranchesDraft((current) => gitBranchesSelectLocalBranch(current, branchId))
  }

  return {
    branchesDraft, branchPreparing, branchDialog, activateBranches, selectLocalBranch,
    openBranchDialog, closeBranchDialog, submitBranchSync
  }
}
