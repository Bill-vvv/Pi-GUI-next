import type { KernelState } from '../../shared/kernel-contract.ts'
import { type SessionPointer } from '../project/session-pointer.ts'
import type { RuntimeHost } from '../runtime/runtime-host.ts'
import type { SessionNameGenerator } from '../runtime/session-name-generator.ts'
import { type RuntimeContext, type ProjectNavigationState } from './workbench-kernel-types.ts'
import {
  selectSessionNameModel,
  normalizeGeneratedSessionName,
  firstUserMessage,
  lastAssistantMessage
} from './workbench-kernel-helpers.ts'

/** What automatic Session naming needs from the Kernel. */
export type SessionNamingHost = {
  isManaged(context: RuntimeContext): boolean
  managedContexts(): Iterable<RuntimeContext>
  generator(): SessionNameGenerator | undefined
  sessionNamingSettings(): KernelState['sessionNaming']
  /** Persisted pointers of a project, or the active in-memory list. */
  pointersForProject(projectPath: string): SessionPointer[]
  persistSession(pointer: SessionPointer): Promise<void>
  /** Store a renamed pointer in the project registry and, when active, the navigation list. */
  storeRenamedPointer(projectPath: string, renamed: SessionPointer, fallback: SessionPointer[]): void
  projectNavigationState(projectPath: string): ProjectNavigationState
  publishContextState(
    context: RuntimeContext,
    navigationBefore: ProjectNavigationState | null,
    publication: 'patch' | 'snapshot'
  ): void
}

/**
 * Best-effort purpose-based naming of unnamed Sessions through a cheap model
 * (moved unchanged from WorkbenchKernel, D-098).
 */
export class SessionNaming {
  private readonly host: SessionNamingHost

  constructor(host: SessionNamingHost) {
    this.host = host
  }

  begin(context: RuntimeContext): void {
    const pending = context.pendingSessionName
    if (!this.host.isManaged(context) || pending === null || context.sessionNameOperation !== null) return
    const state = context.state
    if (this.host.generator() === undefined) {
      context.pendingSessionName = null
      return
    }
    if (
      state.runtime.status !== 'ready' &&
      state.runtime.status !== 'running'
    ) return
    if (state.session.name !== null) {
      context.pendingSessionName = null
      return
    }

    const model = selectSessionNameModel(
      this.host.sessionNamingSettings(),
      state.availableModels,
      state.session.model?.provider ?? null
    )
    const executable = context.runtime.getState().executable
    if (model === null || executable === null) {
      context.pendingSessionName = null
      return
    }

    const controller = new AbortController()
    const operation = { runtime: context.runtime, controller }
    context.sessionNameOperation = operation

    void this.host.generator()!({
      executable,
      cwd: context.projectPath,
      provider: model.provider,
      modelId: model.id,
      userMessage: pending.userMessage,
      assistantMessage: lastAssistantMessage(state.conversation.entries),
      signal: controller.signal
    }).then(async (generated) => {
      const name = normalizeGeneratedSessionName(generated)
      if (
        name === null ||
        controller.signal.aborted ||
        context.sessionNameOperation !== operation ||
        context.pendingSessionName !== pending ||
        !this.host.isManaged(context) ||
        (
          context.state.runtime.status !== 'ready' &&
          context.state.runtime.status !== 'running'
        ) ||
        context.state.session.name !== null
      ) return

      await context.runtime.send({ type: 'set_session_name', name })
      if (
        controller.signal.aborted ||
        context.sessionNameOperation !== operation ||
        context.pendingSessionName !== pending ||
        !this.host.isManaged(context)
      ) return

      const pointersForProject = this.host.pointersForProject(context.projectPath)
      const pointer = pointersForProject.find(({ sessionFile }) => sessionFile === pending.sessionFile)
      if (pointer === undefined || controller.signal.aborted) return

      const renamed = { ...pointer, sessionName: name }
      await this.host.persistSession(renamed)
      if (
        controller.signal.aborted ||
        context.sessionNameOperation !== operation ||
        !this.host.isManaged(context)
      ) return

      const navigationBefore = this.host.projectNavigationState(context.projectPath)
      this.host.storeRenamedPointer(context.projectPath, renamed, pointersForProject)
      context.state = {
        ...context.state,
        session: { ...context.state.session, name }
      }
      // Emit only after the name is persisted so navigation and durable index stay aligned.
      this.host.publishContextState(context, navigationBefore, 'snapshot')
    }).catch(() => {
      // Automatic naming remains best-effort metadata enrichment.
    }).finally(() => {
      if (context.sessionNameOperation === operation) context.sessionNameOperation = null
      if (context.pendingSessionName === pending) context.pendingSessionName = null
    })
  }

  queue(
    context: RuntimeContext,
    pointer: SessionPointer,
    userMessage: string | null
  ): void {
    const pending = pointer.sessionName === null && userMessage !== null
      ? {
          runtime: context.runtime,
          sessionFile: pointer.sessionFile,
          sessionId: pointer.sessionId,
          userMessage
        }
      : null
    context.pendingSessionName = pending
  }

  cancel(runtime?: RuntimeHost): void {
    for (const context of this.host.managedContexts()) {
      if (runtime !== undefined && context.runtime !== runtime) continue
      if (context.pendingSessionName !== null) context.pendingSessionName = null
      if (context.sessionNameOperation !== null) {
        const operation = context.sessionNameOperation
        context.sessionNameOperation = null
        operation.controller.abort()
      }
    }
  }

  ensureQueued(context: RuntimeContext): void {
    const state = context.state
    if (state.session.name !== null) return
    if (context.pendingSessionName !== null) return
    if (context.provisionalSession?.runtime === context.runtime) return
    const sessionFile = state.activeSessionKey
    if (sessionFile === null) return
    const pointers = this.host.pointersForProject(context.projectPath)
    const pointer = pointers.find((candidate) => candidate.sessionFile === sessionFile)
    if (pointer === undefined || pointer.sessionName !== null) return
    this.queue(context, pointer, firstUserMessage(state.conversation.entries))
  }
}
