import type {
  KernelCompactionReason,
  KernelEvent,
  KernelSessionStatistics
} from '../../shared/kernel-contract.ts'
import type { PiRpcEvent } from '../pi-rpc/pi-rpc-data.ts'
import { errorMessage } from '../utils/errors.ts'
import type { RuntimeSessionState } from './runtime-session-state.ts'
import {
  toKernelSession,
  toKernelSessionStatistics,
  toKernelSessionUsage
} from './session-projection.ts'
import {
  assertSessionStatisticsIdentity,
  compactionReason,
  createCompactionLifecycle,
  isCompactionResult,
  isOptionalCompactionResult,
  stringValue
} from './workbench-kernel-helpers.ts'
import type {
  CompactionLifecycle,
  ProjectNavigationState,
  RuntimeContext
} from './workbench-kernel-types.ts'

/** What the compaction lifecycle needs from the Kernel. */
export type ContextCompactionHost = {
  isManaged(context: RuntimeContext): boolean
  projectNavigationState(projectPath: string): ProjectNavigationState
  publishContextState(
    context: RuntimeContext,
    navigationBefore: ProjectNavigationState | null,
    publication: 'patch' | 'snapshot'
  ): void
  emitKernelEvent(event: KernelEvent): void
  /** Store refreshed lifetime statistics for one Session of a project. */
  recordSessionStatistics(projectPath: string, sessionKey: string, statistics: KernelSessionStatistics | null): void
}

/**
 * The per-Context compaction lifecycle: start, completion projection, retry and terminal
 * settlement (moved unchanged from WorkbenchKernel, D-098).
 */
export class ContextCompaction {
  private readonly host: ContextCompactionHost

  constructor(host: ContextCompactionHost) {
    this.host = host
  }

  started(context: RuntimeContext, event: PiRpcEvent): void {
    const reason = compactionReason(event.reason)
    const projectKey = context.projectPath
    const sessionKey = context.state.activeSessionKey
    const sessionId = context.state.session.id
    if (reason === null || sessionKey === null || sessionId === null) return

    const existingLifecycle = context.compactionLifecycle
    if (existingLifecycle !== null && !existingLifecycle.settled) {
      const currentReason = context.state.session.compaction?.reason ?? null
      if (currentReason === reason) return
      if (currentReason !== null) {
        this.reject(
          context,
          existingLifecycle,
          { projectKey, sessionKey, sessionId, reason: currentReason },
          'failed',
          false,
          'Runtime emitted a conflicting compaction start before the previous lifecycle settled.'
        )
      } else {
        existingLifecycle.settled = true
        existingLifecycle.reject(new Error(
          'Runtime emitted a compaction start while an invalid lifecycle was still pending.'
        ))
      }
      return
    }
    context.compactionRevision += 1
    context.compactionLifecycle = createCompactionLifecycle(context.compactionRevision)
    const navigationBefore = this.host.projectNavigationState(projectKey)
    const nextState: RuntimeSessionState = {
      ...context.state,
      session: { ...context.state.session, compaction: { reason } }
    }
    context.state = nextState
    // Inactive start: lifecycle only unless navigation truly changes.
    // Active start: always publishes (active branch of publishContextNavigationChange).
    this.host.publishContextState(context, navigationBefore, 'snapshot')
    this.host.emitKernelEvent({
      type: 'kernel.compaction-started',
      projectKey,
      sessionKey,
      reason
    })
  }

  ended(context: RuntimeContext, event: PiRpcEvent): void {
    const compaction = context.state.session.compaction
    const sessionKey = context.state.activeSessionKey
    const sessionId = context.state.session.id
    const lifecycle = context.compactionLifecycle
    if (
      compaction === null ||
      sessionKey === null ||
      sessionId === null ||
      lifecycle === null ||
      lifecycle.settled
    ) return
    const identity = {
      projectKey: context.projectPath,
      sessionKey,
      sessionId,
      reason: compaction.reason
    }
    if (
      compactionReason(event.reason) !== compaction.reason ||
      typeof event.willRetry !== 'boolean' ||
      typeof event.aborted !== 'boolean' ||
      !isOptionalCompactionResult(event.result)
    ) {
      this.reject(
        context,
        lifecycle,
        identity,
        'failed',
        false,
        'Runtime emitted an invalid compaction lifecycle.'
      )
      return
    }
    if (isCompactionResult(event.result)) {
      void this.complete(context, lifecycle, identity, event.willRetry)
      return
    }
    if (event.willRetry) {
      this.host.emitKernelEvent({
        type: 'kernel.compaction-ended',
        projectKey: identity.projectKey,
        sessionKey,
        reason: identity.reason,
        outcome: 'retrying',
        willRetry: true
      })
      return
    }

    const outcome = event.aborted ? 'cancelled' : 'failed'
    this.reject(
      context,
      lifecycle,
      identity,
      outcome,
      false,
      outcome === 'cancelled' ? 'Compaction was cancelled.' : 'Compaction failed.'
    )
  }

  private async complete(
    context: RuntimeContext,
    lifecycle: CompactionLifecycle,
    identity: {
      projectKey: string
      sessionKey: string
      sessionId: string
      reason: KernelCompactionReason
    },
    willRetry: boolean
  ): Promise<void> {
    try {
      const stateResult = await context.runtime.send({ type: 'get_state' })
      this.assertIdentity(context, lifecycle, identity)
      if (stateResult.type !== 'state') throw new Error('Runtime did not return session state.')
      const projectedSession = toKernelSession(
        stateResult.state,
        context.state.session.resumeAvailable,
        null,
        context.state.session.openAiFastMode
      )
      const sessionFile = stringValue(stateResult.state.sessionFile)
      if (projectedSession.id !== identity.sessionId || sessionFile !== identity.sessionKey) {
        throw new Error('Runtime returned compacted state for a different session.')
      }

      const messagesResult = await context.runtime.send({ type: 'get_messages' })
      this.assertIdentity(context, lifecycle, identity)
      if (messagesResult.type !== 'messages') {
        throw new Error('Runtime did not return conversation messages.')
      }

      const statisticsResult = await context.runtime.send({ type: 'get_session_stats' })
      this.assertIdentity(context, lifecycle, identity)
      if (statisticsResult.type !== 'session-statistics') {
        throw new Error('Runtime did not return session statistics.')
      }
      assertSessionStatisticsIdentity(
        statisticsResult.statistics,
        identity.sessionKey,
        identity.sessionId
      )
      const usage = toKernelSessionUsage(
        statisticsResult.statistics,
        stateResult.state.model?.contextWindow
      )
      const statistics = toKernelSessionStatistics(statisticsResult.statistics)
      // Compaction changes the model context, not the visible active-branch transcript.
      // Rebuilding from get_messages would discard pre-compaction history, so retain the
      // complete canonical Conversation already owned by this RuntimeContext.
      const entries = context.state.conversation.entries
      const nextContextState: RuntimeSessionState = {
        ...context.state,
        session: {
          ...toKernelSession(
            stateResult.state,
            context.state.session.resumeAvailable,
            usage,
            context.state.session.openAiFastMode
          ),
          compaction: null
        },
        conversation: {
          entries,
          startIndex: 0,
          activeRunStartIndex: stateResult.state.isStreaming === true ? entries.length : null
        }
      }
      this.assertIdentity(context, lifecycle, identity)

      const navigationBefore = this.host.projectNavigationState(identity.projectKey)
      this.host.recordSessionStatistics(identity.projectKey, identity.sessionKey, statistics)
      context.state = nextContextState
      // Terminal ownership and Promise settlement are committed before synchronous
      // listener callbacks so reentrancy receives a fresh lifecycle and listener
      // failures cannot strand the completed command.
      lifecycle.settled = true
      lifecycle.resolve()
      this.host.publishContextState(context, navigationBefore, 'snapshot')
      this.host.emitKernelEvent({
        type: 'kernel.compaction-ended',
        projectKey: identity.projectKey,
        sessionKey: identity.sessionKey,
        reason: identity.reason,
        outcome: 'completed',
        willRetry
      })
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(errorMessage(error))
      if (lifecycle.settled) return
      if (!this.host.isManaged(context) || context.compactionLifecycle !== lifecycle) {
        lifecycle.settled = true
        lifecycle.reject(failure)
        return
      }
      this.reject(
        context,
        lifecycle,
        identity,
        'failed',
        willRetry,
        failure.message
      )
    }
  }

  cancel(context: RuntimeContext): void {
    this.settle(
      context,
      'cancelled',
      'Compaction was cancelled because the runtime stopped.'
    )
  }

  fail(context: RuntimeContext, message: string): void {
    this.settle(
      context,
      'failed',
      message.length > 0 ? message : 'Runtime process terminated during compaction.'
    )
  }

  private settle(
    context: RuntimeContext,
    outcome: 'cancelled' | 'failed',
    message: string
  ): void {
    const lifecycle = context.compactionLifecycle
    const compaction = context.state.session.compaction
    const sessionKey = context.state.activeSessionKey
    const sessionId = context.state.session.id
    if (
      lifecycle === null ||
      lifecycle.settled ||
      compaction === null ||
      sessionKey === null ||
      sessionId === null
    ) return
    this.reject(
      context,
      lifecycle,
      {
        projectKey: context.projectPath,
        sessionKey,
        sessionId,
        reason: compaction.reason
      },
      outcome,
      false,
      message
    )
  }

  private reject(
    context: RuntimeContext,
    lifecycle: CompactionLifecycle,
    identity: {
      projectKey: string
      sessionKey: string
      sessionId: string
      reason: KernelCompactionReason
    },
    outcome: 'cancelled' | 'failed',
    willRetry: boolean,
    message: string
  ): void {
    if (lifecycle.settled) return
    const navigationBefore = this.host.projectNavigationState(identity.projectKey)
    const failedState = {
      ...context.state,
      session: { ...context.state.session, compaction: null }
    }
    context.state = failedState
    // Mark terminal and reject before synchronous publication callbacks can reenter;
    // listener failures must not strand the originating command.
    lifecycle.settled = true
    lifecycle.reject(new Error(message))
    this.host.publishContextState(context, navigationBefore, 'snapshot')
    this.host.emitKernelEvent({
      type: 'kernel.compaction-ended',
      projectKey: identity.projectKey,
      sessionKey: identity.sessionKey,
      reason: identity.reason,
      outcome,
      willRetry
    })
  }

  private assertIdentity(
    context: RuntimeContext,
    lifecycle: CompactionLifecycle,
    identity: { projectKey: string, sessionKey: string, sessionId: string }
  ): void {
    if (
      lifecycle.settled ||
      !this.host.isManaged(context) ||
      context.compactionLifecycle !== lifecycle ||
      context.projectPath !== identity.projectKey ||
      context.state.activeSessionKey !== identity.sessionKey ||
      context.state.session.id !== identity.sessionId
    ) {
      throw new Error('Compaction projection cancelled because the session changed.')
    }
  }
}
