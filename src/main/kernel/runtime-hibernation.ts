import { randomUUID } from 'node:crypto'

import {
  AUTO_HIBERNATE_GRACE_MS,
  HIBERNATE_HOST_COMMAND_GENERATION,
  type RuntimeContext
} from './workbench-kernel-types.ts'

/** What automatic hibernation needs from the Kernel; every other decision lives here. */
export type RuntimeHibernationHost = {
  now(): number
  managedContexts(): Iterable<RuntimeContext>
  isManaged(context: RuntimeContext): boolean
  isForeground(context: RuntimeContext): boolean
  foregroundSessionKey(): string | null
  hasPersistedPointer(projectPath: string, sessionKey: string): boolean
  /** Serializes with activate/reload/start (the Kernel launch gate). */
  withLaunchGate(operation: () => Promise<void>): Promise<void>
  stopContext(context: RuntimeContext): Promise<void>
  hasPendingCollaboration(context: RuntimeContext): boolean
}

export type HibernationSweepSummary = {
  attempted: number
  hibernatedCount: number
  skippedCount: number
  failedCount: number
}

/**
 * Automatic hibernation of idle background Runtimes and the shared busy gate used
 * by manual reclamation (moved unchanged from WorkbenchKernel, D-098).
 */
export class RuntimeHibernation {
  private readonly host: RuntimeHibernationHost
  private sweepInFlight: Promise<void> | null = null

  constructor(host: RuntimeHibernationHost) {
    this.host = host
  }

  /**
   * One non-overlapping automatic hibernation sweep.
   * Candidates must be persisted, background, ready, settled, non-provisional,
   * Kernel-unblocked, and older than the grace period. Keeps the most-recent
   * background ready Runtime warm. Uses generation-fenced prepare→commit→stop
   * only — never the user-directed manual hibernation path as authority.
   */
  async sweep(options?: { graceMs?: number; nowMs?: number }): Promise<HibernationSweepSummary> {
    if (this.sweepInFlight !== null) {
      await this.sweepInFlight
      return { attempted: 0, hibernatedCount: 0, skippedCount: 0, failedCount: 0 }
    }

    const summary = {
      attempted: 0,
      hibernatedCount: 0,
      skippedCount: 0,
      failedCount: 0
    }
    const run = this.runSweep(options, summary)
    this.sweepInFlight = run.then(
      () => undefined,
      () => undefined
    )
    try {
      await run
      return summary
    } finally {
      this.sweepInFlight = null
    }
  }

  /** Null when the context may be hibernated; otherwise the user-facing reason it may not. */
  blockReason(projectPath: string, sessionKey: string, context: RuntimeContext): string | null {
    if (context.projectPath !== projectPath) {
      return 'Cannot hibernate a session that is not owned by the requested project.'
    }
    if (!this.host.hasPersistedPointer(projectPath, sessionKey)) {
      return 'Cannot hibernate a session without a persisted pointer.'
    }
    if (this.host.isForeground(context) || this.host.foregroundSessionKey() === sessionKey) {
      return 'Cannot hibernate the active foreground session.'
    }
    if (
      context.provisionalSession !== null ||
      context.provisionalCommit !== null ||
      context.state.activeSessionKey === null
    ) {
      return 'Cannot hibernate a provisional session.'
    }
    if (this.host.hasPendingCollaboration(context)) {
      return 'Cannot hibernate a Session with pending agent deliveries.'
    }
    const runtimeStatus = context.state.runtime.status
    if (
      runtimeStatus === 'starting' ||
      runtimeStatus === 'running' ||
      runtimeStatus === 'stopping'
    ) {
      return `Cannot hibernate a session while runtime is ${runtimeStatus}.`
    }
    if (!context.state.session.settled) {
      return 'Cannot hibernate a session that is not settled.'
    }
    if (
      context.state.session.compaction !== null ||
      (context.compactionLifecycle !== null && !context.compactionLifecycle.settled)
    ) {
      return 'Hibernate is unavailable while compaction is in progress.'
    }
    if (context.launchCommitting) {
      return 'Cannot hibernate a session while launch is committing.'
    }
    if (context.deferredEvents !== null) {
      return 'Cannot hibernate a session while a deferred identity commit is in progress.'
    }
    if (context.sessionNameOperation !== null || context.pendingSessionName !== null) {
      return 'Cannot hibernate a session while session naming is in progress.'
    }
    if (context.stopRequested) {
      return 'Cannot hibernate a session while stop is in progress.'
    }
    if (context.sessionUsageRefreshInFlight || context.sessionUsageRefreshRequested) {
      return 'Cannot hibernate a session while session usage refresh is in progress.'
    }
    if (
      context.askInteraction !== null ||
      (context.state.extensionDialog !== null && context.state.extensionDialog !== undefined)
    ) {
      return 'Cannot hibernate a session while waiting for a user reply.'
    }
    const session = context.state.session
    if (
      session.pendingMessageCount > 0 ||
      session.pendingSteeringMessages.length > 0 ||
      session.pendingFollowUpMessages.length > 0
    ) {
      return 'Cannot hibernate a session while messages are queued.'
    }
    return null
  }

  private async runSweep(
    options: { graceMs?: number; nowMs?: number } | undefined,
    summary: HibernationSweepSummary
  ): Promise<void> {
    const graceMs =
      typeof options?.graceMs === 'number' &&
      Number.isFinite(options.graceMs) &&
      options.graceMs >= 0
        ? options.graceMs
        : AUTO_HIBERNATE_GRACE_MS
    const nowMs =
      typeof options?.nowMs === 'number' && Number.isFinite(options.nowMs)
        ? options.nowMs
        : this.host.now()

    const backgroundReady: RuntimeContext[] = []
    for (const context of this.host.managedContexts()) {
      if (this.host.isForeground(context)) continue
      if (context.state.runtime.status !== 'ready') continue
      backgroundReady.push(context)
    }

    if (backgroundReady.length <= 1) {
      // Keep the single warm background Runtime (or none).
      summary.skippedCount += backgroundReady.length
      return
    }

    // Keep the most-recent background ready Runtime warm.
    let warmContext = backgroundReady[0]!
    for (const context of backgroundReady) {
      if (context.lastWarmUseAt > warmContext.lastWarmUseAt) {
        warmContext = context
      }
    }

    const candidates = backgroundReady
      .filter((context) => context !== warmContext)
      .filter((context) => nowMs - context.lastWarmUseAt >= graceMs)
      .sort((left, right) => left.lastWarmUseAt - right.lastWarmUseAt)

    // Count the intentionally retained warm Runtime plus ready Runtimes that
    // have not yet aged past the grace period. Non-ready contexts are outside
    // the automatic-idle candidate set rather than misleading "skips".
    summary.skippedCount += backgroundReady.length - candidates.length

    for (const context of candidates) {
      const outcome = await this.tryHibernate(context)
      summary.attempted += 1
      if (outcome === 'hibernated') summary.hibernatedCount += 1
      else if (outcome === 'failed') summary.failedCount += 1
      else summary.skippedCount += 1
    }
  }

  private async tryHibernate(
    context: RuntimeContext
  ): Promise<'hibernated' | 'skipped' | 'failed'> {
    const host = this.host
    if (!host.isManaged(context)) return 'skipped'
    if (host.isForeground(context)) return 'skipped'

    const sessionKey = context.state.activeSessionKey
    if (sessionKey === null) return 'skipped'
    const sessionId = context.state.session.id
    if (typeof sessionId !== 'string' || sessionId.length === 0) return 'skipped'

    // Kernel busy gate remains a necessary outer condition.
    if (this.blockReason(context.projectPath, sessionKey, context) !== null) {
      return 'skipped'
    }

    // RuntimeContext generation protects Kernel identity across replacement. The host
    // command generation is process-local; the in-process bridge separately advances
    // owner/provider generations on every Pi session_start.
    const runtimeGeneration = context.runtimeGeneration
    const providerGeneration = HIBERNATE_HOST_COMMAND_GENERATION
    const attemptId = randomUUID()
    let token: string | null = null
    const release = async (): Promise<void> => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const result = await context.runtime.releaseHibernation({
          sessionId,
          generation: providerGeneration,
          attemptId,
          token: token!
        })
        if (result.ok) return
      }
      throw new Error('Runtime hibernation lease release failed.')
    }
    const stillEligible = (): boolean =>
      host.isManaged(context) &&
      !host.isForeground(context) &&
      context.runtimeGeneration === runtimeGeneration &&
      this.blockReason(context.projectPath, sessionKey, context) === null &&
      context.state.session.id === sessionId

    try {
      const prepared = await context.runtime.prepareHibernation({
        sessionId,
        generation: providerGeneration,
        attemptId
      })
      if (!prepared.ok || typeof prepared.token !== 'string') {
        return 'skipped'
      }
      token = prepared.token

      // Recheck exact Kernel context identity after provider prepare/drain.
      if (!stillEligible()) {
        await release()
        return 'skipped'
      }

      const committed = await context.runtime.commitHibernation({
        sessionId,
        generation: providerGeneration,
        attemptId,
        token
      })
      if (!committed.ok) {
        await release()
        return 'skipped'
      }

      // Serialize the final check + stop with activate/reload/start. Once this
      // gate is acquired, a foreground activation cannot attach to a Context
      // that stopContext is about to remove.
      let stopEntered = false
      try {
        await host.withLaunchGate(async () => {
          if (!stillEligible()) return
          stopEntered = true
          await host.stopContext(context)
        })
        if (!stopEntered) {
          await release()
          return 'skipped'
        }
        return 'hibernated'
      } catch {
        // A competing launch rejected the automatic stop, or stop itself failed.
        // If the process may remain owned, roll back the exact provider token.
        if (host.isManaged(context) && context.runtimeGeneration === runtimeGeneration) {
          try {
            await release()
          } catch {
            // Ownership retention is handled by stopContext; a later sweep retries.
          }
        }
        return stopEntered ? 'failed' : 'skipped'
      }
    } catch {
      if (token !== null && host.isManaged(context)) {
        try {
          await release()
        } catch {
          // Best-effort release.
        }
      }
      return 'skipped'
    }
  }
}
