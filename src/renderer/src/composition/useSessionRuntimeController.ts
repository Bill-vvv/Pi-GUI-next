import { useEffect, useRef, useState } from 'react'

import type { KernelState } from '../../../shared/kernel-contract'
import {
  SessionRuntimeController,
  type SessionRuntimeControllerDependencies,
  type SessionRuntimeSnapshot
} from './session-runtime-controller'

type SessionRuntimeControllerOptions = Omit<
  SessionRuntimeControllerDependencies,
  'onSnapshot'
>

export type SessionRuntimeControllerApi = SessionRuntimeSnapshot & {
  getSessionViewTarget: () => SessionRuntimeSnapshot['sessionViewTarget']
  reconcileKernelState: (state: KernelState, initializing?: boolean) => void
  previewSession: (sessionKey: string) => Promise<void>
  clearSessionView: () => void
  startSession: () => Promise<void>
  waitForSessionStart: () => Promise<void>
  ensureInitialRuntime: () => Promise<void>
  ensureSessionRuntime: (
    sessionKey: string,
    mode?: 'immediate' | 'settled'
  ) => Promise<void>
  waitForRuntimeEnsureIdle: () => Promise<void>
}

export function useSessionRuntimeController(
  options: SessionRuntimeControllerOptions
): SessionRuntimeControllerApi {
  const optionsRef = useRef(options)
  optionsRef.current = options
  const [snapshot, setSnapshot] = useState<SessionRuntimeSnapshot>({
    sessionViewTarget: null,
    sessionPreview: null,
    previewPendingKey: null
  })
  const controllerRef = useRef<SessionRuntimeController | null>(null)
  const createController = (): SessionRuntimeController =>
    new SessionRuntimeController({
      settleMs: options.settleMs,
      getKernelState: () => optionsRef.current.getKernelState(),
      startSession: () => optionsRef.current.startSession(),
      activateSession: (sessionKey) => optionsRef.current.activateSession(sessionKey),
      previewSession: (sessionKey) => optionsRef.current.previewSession(sessionKey),
      beginActionPresentation: () => optionsRef.current.beginActionPresentation(),
      isActionPresentationCurrent: (revision) =>
        optionsRef.current.isActionPresentationCurrent(revision),
      onSnapshot: setSnapshot,
      onError: (error) => optionsRef.current.onError(error),
      onCompletedAction: (action, succeeded) =>
        optionsRef.current.onCompletedAction(action, succeeded),
      onClearArchivedPreview: () => optionsRef.current.onClearArchivedPreview(),
      setTimer: options.setTimer,
      clearTimer: options.clearTimer
    })
  if (controllerRef.current === null) controllerRef.current = createController()

  useEffect(() => {
    let controller = controllerRef.current
    if (controller === null) {
      controller = createController()
      controllerRef.current = controller
    }
    return () => {
      controller.dispose()
      if (controllerRef.current === controller) controllerRef.current = null
    }
  }, [])

  const getController = (): SessionRuntimeController => {
    const controller = controllerRef.current
    if (controller === null) throw new Error('Session Runtime controller is unavailable.')
    return controller
  }

  return {
    ...snapshot,
    getSessionViewTarget: () => getController().getSnapshot().sessionViewTarget,
    reconcileKernelState: (state, initializing) =>
      getController().reconcileKernelState(state, initializing),
    previewSession: (sessionKey) => getController().preview(sessionKey),
    clearSessionView: () => getController().clear(),
    startSession: () => getController().start(),
    waitForSessionStart: () => getController().waitForStart(),
    ensureInitialRuntime: () => getController().ensureInitialRuntime(),
    ensureSessionRuntime: (sessionKey, mode) => getController().activate(sessionKey, mode),
    waitForRuntimeEnsureIdle: () => getController().waitForIdle()
  }
}
