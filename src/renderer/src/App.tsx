import { useEffect, useState } from 'react'

import type {
  KernelState,
  ProjectTrust,
  ThinkingLevel
} from '../../shared/kernel-contract'
import { ChatWorkbench } from './features/chat/ChatWorkbench'
import { ProjectStartup } from './features/project/ProjectStartup'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function App(): React.JSX.Element {
  const [kernelState, setKernelState] = useState<KernelState | null>(null)
  const [ipcError, setIpcError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [pendingAction, setPendingAction] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    let receivedEvent = false
    let unsubscribe = (): void => undefined

    try {
      unsubscribe = window.piGui.subscribe((event) => {
        if (!active) return
        receivedEvent = true
        setKernelState(event.state)
        setIpcError(null)
      })

      void window.piGui.getState().then(
        (state) => {
          if (!active || receivedEvent) return
          setKernelState(state)
          setIpcError(null)
        },
        (error: unknown) => {
          if (!active) return
          setIpcError(errorMessage(error))
        }
      )
    } catch (error: unknown) {
      setIpcError(errorMessage(error))
    }

    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  async function runAction(
    action: string,
    operation: () => Promise<KernelState>
  ): Promise<void> {
    if (pendingAction !== null) throw new Error('Another action is already running.')
    setPendingAction(action)
    setActionError(null)
    try {
      setKernelState(await operation())
    } catch (error) {
      setActionError(errorMessage(error))
      throw error
    } finally {
      setPendingAction(null)
    }
  }

  if (kernelState === null) {
    return (
      <main className="screen-loading">
        {ipcError ? `无法连接 Workbench Kernel：${ipcError}` : '正在连接 Pi Workbench…'}
      </main>
    )
  }

  const showStartup =
    kernelState.runtime.status === 'stopped' || kernelState.runtime.status === 'starting'

  if (showStartup) {
    return (
      <ProjectStartup
        state={kernelState}
        pendingAction={pendingAction}
        error={actionError ?? ipcError}
        onSelectProject={() => runAction('select-project', () => window.piGui.selectProject())}
        onSetTrust={(trust: ProjectTrust) =>
          runAction('set-trust', () => window.piGui.setProjectTrust(trust))
        }
        onStart={() => runAction('start-project', () => window.piGui.startProject())}
      />
    )
  }

  return (
    <ChatWorkbench
      state={kernelState}
      pendingAction={pendingAction}
      actionError={actionError ?? ipcError}
      onPrompt={(message) => runAction('prompt', () => window.piGui.prompt(message))}
      onAbort={() => runAction('abort', () => window.piGui.abort())}
      onSetThinkingLevel={(level: ThinkingLevel) =>
        runAction('set-thinking-level', () => window.piGui.setThinkingLevel(level))
      }
    />
  )
}
