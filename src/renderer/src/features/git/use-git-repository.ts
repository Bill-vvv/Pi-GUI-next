import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import type { GitRepositoryState } from '../../../../shared/git-contract'
import { gitErrorText, isCurrentGitResponse, isDisplayedGitSnapshot } from './git-changes-model'

export const RENDERER_GIT_INVOCATION_ERROR = 'Renderer 无法调用 Git 服务。请检查文件路径后重试。'

type PanelNotice = {
  projectKey: string
  tone: 'info' | 'error'
  text: string
}

// One instance belongs to one keyed Project panel. Only this owner publishes repository state.
export function useGitRepository(projectKey: string) {
  const generationRef = useRef(0)
  const refreshTokenRef = useRef(0)
  const stateRef = useRef<GitRepositoryState | null>(null)
  const [state, setState] = useState<GitRepositoryState | null>(null)
  const [initialError, setInitialError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [authorizing, setAuthorizing] = useState(false)
  const [notice, setNotice] = useState<PanelNotice | null>(null)

  const replaceDisplayedState = useCallback((nextState: GitRepositoryState): void => {
    // Publishing a confirmed snapshot supersedes reads started before it,
    // including their loading/error completion, without replaying any write.
    refreshTokenRef.current += 1
    setRefreshing(false)
    stateRef.current = nextState
    setState(nextState)
    setInitialError(null)
  }, [])

  const refreshState = useCallback(async (
    requestGeneration: number,
    clearNotice: boolean
  ): Promise<string | null> => {
    const requestProjectKey = projectKey
    const requestToken = ++refreshTokenRef.current
    if (clearNotice) setNotice(null)
    setRefreshing(true)
    try {
      const response = await window.piGit.refresh(requestProjectKey)
      if (
        requestToken !== refreshTokenRef.current ||
        requestProjectKey !== projectKey ||
        requestGeneration !== generationRef.current
      ) return null
      if (!isCurrentGitResponse(
        projectKey,
        generationRef.current,
        requestProjectKey,
        requestGeneration,
        response.projectKey
      )) {
        if (stateRef.current === null) {
          setInitialError(RENDERER_GIT_INVOCATION_ERROR)
        }
        return RENDERER_GIT_INVOCATION_ERROR
      }
      if (!response.result.ok) {
        const text = gitErrorText(response.result.error)
        if (stateRef.current === null) {
          setInitialError(text)
        }
        return text
      }
      replaceDisplayedState(response.result.state)
      return null
    } catch {
      if (
        requestToken !== refreshTokenRef.current ||
        requestGeneration !== generationRef.current
      ) return null
      if (stateRef.current === null) {
        setInitialError(RENDERER_GIT_INVOCATION_ERROR)
      }
      return RENDERER_GIT_INVOCATION_ERROR
    } finally {
      if (
        requestToken === refreshTokenRef.current &&
        requestGeneration === generationRef.current
      ) setRefreshing(false)
    }
  }, [projectKey, replaceDisplayedState])

  useLayoutEffect(() => {
    const generation = ++generationRef.current
    void refreshState(generation, false)
    return () => {
      refreshTokenRef.current += 1
      stateRef.current = null
      if (generationRef.current === generation) generationRef.current += 1
    }
  }, [refreshState])

  const authorizeAncestorRepository = async (snapshot: GitRepositoryState): Promise<void> => {
    if (
      snapshot.kind !== 'trust-required' ||
      snapshot.repositoryRoot === null ||
      !isDisplayedGitSnapshot(stateRef.current, snapshot)
    ) return
    const requestGeneration = generationRef.current
    const requestProjectKey = projectKey
    setAuthorizing(true)
    setNotice(null)
    try {
      const response = await window.piGit.authorizeAncestorRepository(
        requestProjectKey,
        snapshot.repositoryRoot,
        snapshot.statusRevision
      )
      if (
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
        setNotice({ projectKey, tone: 'error', text: RENDERER_GIT_INVOCATION_ERROR })
        return
      }
      if (!response.result.ok) {
        const failure = gitErrorText(response.result.error)
        if (response.result.error.code !== 'stale') {
          setNotice({ projectKey, tone: 'error', text: failure })
          return
        }
        const refreshFailure = await refreshState(requestGeneration, false)
        if (requestGeneration === generationRef.current) {
          setNotice({
            projectKey,
            tone: refreshFailure === null ? 'info' : 'error',
            text: refreshFailure === null
              ? 'Repository 授权状态已变化。列表已刷新，请重新确认授权范围。'
              : `${failure} 刷新失败：${refreshFailure}`
          })
        }
        return
      }
      replaceDisplayedState(response.result.state)
    } catch {
      if (requestGeneration === generationRef.current) {
        setNotice({ projectKey, tone: 'error', text: RENDERER_GIT_INVOCATION_ERROR })
      }
    } finally {
      if (requestGeneration === generationRef.current) setAuthorizing(false)
    }
  }

  return {
    projectKey, generationRef, stateRef, state, initialError, refreshing, authorizing, notice,
    setNotice, refreshState, replaceDisplayedState, authorizeAncestorRepository
  }
}

export type GitRepositoryController = ReturnType<typeof useGitRepository>
// Read access to the authoritative identity; feature owners cannot replace these refs.
export type GitRepositoryReader = Pick<GitRepositoryController, 'projectKey' | 'refreshState'> & {
  generationRef: Readonly<GitRepositoryController['generationRef']>
  stateRef: Readonly<GitRepositoryController['stateRef']>
}
