import { useEffect, useRef, useState } from 'react'

import type { KernelForkCandidate, KernelState } from '../../../../shared/kernel-contract'
import type { SessionViewTarget } from '../../session-view-target'
import { workbenchOp, type WorkbenchCompletedAction } from '../../workbench-actions'
import { unknownErrorMessage } from '../../unknown-error-message'
import type { SessionOperationRunner } from './use-session-archive'

type ForkDialog = {
  projectKey: string
  sessionKey: string
  sessionId: string | null
  candidates: KernelForkCandidate[]
  loading: boolean
  submitting: boolean
  error: string | null
  preferredUserText: string | null
}

type Options = {
  getKernelState: () => KernelState | null
  getSessionViewTarget: () => SessionViewTarget | null
  ensureSessionRuntime: (sessionKey: string, mode: 'immediate') => Promise<void>
  runMutation: SessionOperationRunner['mutation']
  onOpenError: (error: unknown | null) => void
  onCompletedAction: (action: WorkbenchCompletedAction | null) => void
  onForked: (draft: string) => void
}

/** Owns the complete dialog request lifecycle; App still owns mutation acknowledgement. */
export function useSessionFork(options: Options) {
  const [dialog, setDialog] = useState<ForkDialog | null>(null)
  const dialogRef = useRef<ForkDialog | null>(null)
  const requestRevision = useRef(0)
  const active = useRef(true)

  function publish(next: ForkDialog | null): void {
    dialogRef.current = next
    setDialog(next)
  }

  function closeForkDialog(): void {
    requestRevision.current += 1
    publish(null)
  }

  function ownsCurrentSession(owner: ForkDialog): boolean {
    const state = options.getKernelState()
    return state !== null && state.activeProjectKey === owner.projectKey &&
      state.activeSessionKey === owner.sessionKey && state.session.id === owner.sessionId &&
      options.getSessionViewTarget() === null
  }

  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
      requestRevision.current += 1
      dialogRef.current = null
    }
  }, [])

  useEffect(() => {
    const current = dialogRef.current
    // A successful fork itself changes the canonical Session before its ack settles.
    if (current !== null && !current.submitting && !ownsCurrentSession(current)) closeForkDialog()
  })

  async function loadForkCandidates(): Promise<void> {
    const owner = dialogRef.current
    if (owner === null || owner.submitting) return
    if (!ownsCurrentSession(owner)) {
      closeForkDialog()
      return
    }
    const revision = ++requestRevision.current
    publish({ ...owner, loading: true, error: null })
    try {
      const candidates = await window.piGui.listForkCandidates()
      if (!active.current || requestRevision.current !== revision || !ownsCurrentSession(owner)) return
      publish({ ...owner, candidates, loading: false, error: null })
    } catch (error) {
      if (!active.current || requestRevision.current !== revision || !ownsCurrentSession(owner)) return
      publish({ ...owner, candidates: [], loading: false, error: unknownErrorMessage(error) })
    }
  }

  async function openForkDialog(preferredUserText?: string): Promise<void> {
    if (dialogRef.current?.submitting) return
    const revision = ++requestRevision.current
    const viewTarget = options.getSessionViewTarget()
    const initial = options.getKernelState()
    const projectKey = viewTarget?.projectKey ?? initial?.activeProjectKey
    const sessionKey = viewTarget?.kind === 'session' ? viewTarget.sessionKey : initial?.activeSessionKey
    try {
      if (viewTarget?.kind === 'session') {
        await options.ensureSessionRuntime(viewTarget.sessionKey, 'immediate')
      }
      if (!active.current || requestRevision.current !== revision) return
      const state = options.getKernelState()
      if (state === null || state.activeProjectKey === null || state.activeSessionKey === null ||
        state.activeProjectKey !== projectKey || state.activeSessionKey !== sessionKey ||
        state.runtime.status !== 'ready' || !state.session.settled || options.getSessionViewTarget() !== null) {
        throw new Error('当前对话暂时不能分叉。')
      }
      options.onOpenError(null)
      publish({
        projectKey: state.activeProjectKey, sessionKey: state.activeSessionKey, sessionId: state.session.id,
        candidates: [], loading: false, submitting: false, error: null,
        preferredUserText: preferredUserText?.trim() ? preferredUserText : null
      })
      await loadForkCandidates()
    } catch (error) {
      if (!active.current || requestRevision.current !== revision) return
      options.onOpenError(error)
      throw error
    }
  }

  async function forkSession(entryId: string): Promise<void> {
    const owner = dialogRef.current
    if (owner === null || owner.loading || owner.submitting ||
      !owner.candidates.some((candidate) => candidate.entryId === entryId)) return
    if (!ownsCurrentSession(owner)) {
      closeForkDialog()
      throw new Error('分叉目标在操作前发生了变化。')
    }
    const revision = requestRevision.current
    const action = workbenchOp('fork-session')
    options.onCompletedAction(null)
    publish({ ...owner, submitting: true, error: null })
    try {
      const result = await options.runMutation(action, () => window.piGui.forkSession(entryId))
      if (!active.current || requestRevision.current !== revision || options.getKernelState() === null) return
      if (!result.cancelled) {
        // Only the acknowledged result may update the Composer in the new Session.
        options.onForked(result.draft)
        options.onCompletedAction({ action, succeeded: true })
      }
      closeForkDialog()
    } catch (error) {
      if (!active.current || requestRevision.current !== revision) return
      publish({ ...owner, submitting: false, error: unknownErrorMessage(error) })
      options.onCompletedAction({ action, succeeded: false })
      throw error
    }
  }

  return {
    forkDialogOpen: dialog !== null,
    forkCandidates: dialog?.candidates ?? [],
    forkCandidatesLoading: dialog?.loading ?? false,
    forkSubmitting: dialog?.submitting ?? false,
    forkError: dialog?.error ?? null,
    forkPreferredUserText: dialog?.preferredUserText ?? null,
    openForkDialog, closeForkDialog, loadForkCandidates, forkSession
  }
}
