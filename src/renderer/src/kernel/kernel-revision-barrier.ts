import {
  isKernelMutationAck,
  isKernelSnapshot,
  type KernelEvent,
  type KernelMutationAck,
  type KernelSnapshot,
  type KernelState,
  type KernelStatePatch
} from '../../../shared/kernel-contract.ts'

export const DEFAULT_REVISION_WAIT_TIMEOUT_MS = 2_000
export const DEFAULT_RESYNC_TIMEOUT_MS = 2_000
export const DEFAULT_MAX_PENDING_PATCHES = 256

export type RevisionFrameHandle = number | object

export type KernelRevisionBarrierOptions = {
  applyState: (state: KernelState, meta: { revision: number; initializing: boolean }) => void
  applyPatches: (
    state: KernelState,
    patches: Array<{ revision: number; patch: KernelStatePatch }>
  ) => KernelState
  fetchSnapshot: () => Promise<unknown>
  scheduleFrame: (callback: () => void) => RevisionFrameHandle
  cancelFrame: (handle: RevisionFrameHandle) => void
  waitTimeoutMs?: number
  resyncTimeoutMs?: number
  maxPendingPatches?: number
  onRecoveryError?: (error: unknown) => void
}

type PendingPatch = {
  revision: number
  patch: KernelStatePatch
}

type RevisionWaiter = {
  revision: number
  resolve: () => void
  reject: (error: unknown) => void
}

/**
 * Renderer-side monotonic revision barrier.
 *
 * - Full-state events apply immediately and advance appliedRevision.
 * - Patches advance appliedRevision only after the scheduled frame applies them.
 * - Mutation acks settle only once appliedRevision >= ack.revision.
 * - A single targeted snapshot resync recovers from gaps, queue overflow, or wait timeouts.
 * - Once initialized, recovery snapshots never regress or reapply an equal revision.
 */
export class KernelRevisionBarrier {
  private readonly options: KernelRevisionBarrierOptions
  private appliedRevision = -1
  private currentState: KernelState | null = null
  private pendingPatches: PendingPatch[] = []
  private frameHandle: RevisionFrameHandle | null = null
  private readonly waiters = new Set<RevisionWaiter>()
  private resyncPromise: Promise<void> | null = null
  private resyncGeneration = 0
  private disposed = false

  constructor(options: KernelRevisionBarrierOptions) {
    this.options = options
  }

  getAppliedRevision(): number {
    return this.appliedRevision
  }

  getState(): KernelState | null {
    return this.currentState
  }

  handleEvent(event: KernelEvent): void {
    if (this.disposed) return
    if (event.type === 'kernel.state-batch') {
      for (const stateEvent of event.events) this.handleEvent(stateEvent)
      return
    }
    if (event.type === 'kernel.state-changed') {
      this.commitState(event.state, event.revision, this.currentState === null)
      return
    }
    if (event.type === 'kernel.state-patched') {
      this.queuePatch(event.patch, event.revision)
    }
  }

  /**
   * Apply an initial or recovery snapshot. Events that already advanced past the
   * snapshot revision win the startup race and keep their applied state. After the
   * barrier is initialized, equal or older snapshots are ignored (no force path).
   */
  handleSnapshot(value: unknown): void {
    if (this.disposed) return
    const snapshot = parseKernelSnapshot(value)
    if (this.currentState !== null && snapshot.revision <= this.appliedRevision) {
      return
    }
    const pending = this.pendingPatches.filter((entry) => entry.revision > snapshot.revision)
    this.cancelFrame()
    this.pendingPatches = []
    this.commitState(snapshot.state, snapshot.revision, this.currentState === null)
    if (pending.length > 0) {
      for (const entry of pending) this.queuePatch(entry.patch, entry.revision)
    }
  }

  async waitForAck(value: unknown): Promise<KernelMutationAck> {
    const ack = parseKernelMutationAck(value)
    await this.waitForRevision(ack.revision)
    return ack
  }

  waitForRevision(revision: number): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('Kernel revision barrier is disposed.'))
    if (!Number.isInteger(revision) || revision < 0) {
      return Promise.reject(new Error('Kernel mutation ack revision is invalid.'))
    }
    if (this.appliedRevision >= revision) return Promise.resolve()

    return new Promise<void>((resolve, reject) => {
      let settled = false
      let timeoutHandle: ReturnType<typeof setTimeout> | null = null
      const finish = (error?: unknown): void => {
        if (settled) return
        settled = true
        if (timeoutHandle !== null) clearTimeout(timeoutHandle)
        this.waiters.delete(waiter)
        if (error === undefined) resolve()
        else reject(error)
      }
      const waiter: RevisionWaiter = {
        revision,
        resolve: () => finish(),
        reject: (error) => finish(error)
      }
      this.waiters.add(waiter)

      const timeoutMs = this.options.waitTimeoutMs ?? DEFAULT_REVISION_WAIT_TIMEOUT_MS
      timeoutHandle = setTimeout(() => {
        timeoutHandle = null
        if (settled || this.disposed) return
        void this.resync()
          .then(() => {
            if (this.appliedRevision >= revision) finish()
            else {
              finish(new Error(
                `Timed out waiting for Kernel revision ${revision}; applied ${this.appliedRevision}.`
              ))
            }
          })
          .catch((error: unknown) => finish(error))
      }, timeoutMs)
    })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.resyncGeneration += 1
    this.cancelFrame()
    this.pendingPatches = []
    const error = new Error('Kernel revision barrier is disposed.')
    for (const waiter of this.waiters) waiter.reject(error)
    this.waiters.clear()
  }

  private queuePatch(patch: KernelStatePatch, revision: number): void {
    if (!Number.isInteger(revision) || revision < 0) {
      throw new Error('Kernel state patch revision is invalid.')
    }
    if (this.currentState === null) {
      this.storePendingPatch(revision, patch)
      return
    }
    if (revision <= this.appliedRevision) return

    const expectedNext = this.nextExpectedRevision()
    if (revision > expectedNext) {
      this.startResync()
      return
    }

    this.storePendingPatch(revision, patch)
    if (this.pendingPatches.length === 0) return
    this.scheduleFlush()
  }

  private storePendingPatch(revision: number, patch: KernelStatePatch): void {
    if (this.pendingPatches.some((entry) => entry.revision === revision)) return
    this.pendingPatches.push({ revision, patch })
    this.pendingPatches.sort((left, right) => left.revision - right.revision)
    const maxPending = this.options.maxPendingPatches ?? DEFAULT_MAX_PENDING_PATCHES
    if (this.pendingPatches.length <= maxPending) return
    // Diff queue is unusable once capped; drop it and recover from one snapshot.
    this.cancelFrame()
    this.pendingPatches = []
    this.startResync()
  }

  private nextExpectedRevision(): number {
    if (this.pendingPatches.length === 0) return this.appliedRevision + 1
    return this.pendingPatches[this.pendingPatches.length - 1]!.revision + 1
  }

  private scheduleFlush(): void {
    if (this.frameHandle !== null || this.pendingPatches.length === 0) return
    this.frameHandle = this.options.scheduleFrame(() => {
      this.frameHandle = null
      this.flushPatches()
    })
  }

  private flushPatches(): void {
    if (this.disposed || this.currentState === null || this.pendingPatches.length === 0) return
    const batch = this.pendingPatches
    this.pendingPatches = []
    // Require contiguous revisions from applied+1; a hole triggers one resync.
    const contiguous: PendingPatch[] = []
    let expected = this.appliedRevision + 1
    for (const entry of batch) {
      if (entry.revision < expected) continue
      if (entry.revision > expected) {
        this.pendingPatches = batch.filter((candidate) => candidate.revision >= expected)
        this.startResync()
        return
      }
      contiguous.push(entry)
      expected += 1
    }
    if (contiguous.length === 0) return
    const nextState = this.options.applyPatches(this.currentState, contiguous)
    this.currentState = nextState
    this.appliedRevision = contiguous[contiguous.length - 1]!.revision
    this.options.applyState(nextState, { revision: this.appliedRevision, initializing: false })
    this.resolveWaiters()
  }

  private commitState(state: KernelState, revision: number, initializing: boolean): void {
    if (!Number.isInteger(revision) || revision < 0) {
      throw new Error('Kernel state revision is invalid.')
    }
    if (this.currentState !== null && revision < this.appliedRevision) return
    this.cancelFrame()
    this.pendingPatches = this.pendingPatches.filter((entry) => entry.revision > revision)
    this.currentState = state
    this.appliedRevision = revision
    this.options.applyState(state, { revision, initializing })
    this.resolveWaiters()
    if (this.pendingPatches.length > 0) this.scheduleFlush()
  }

  private resolveWaiters(): void {
    for (const waiter of [...this.waiters]) {
      if (this.appliedRevision < waiter.revision) continue
      this.waiters.delete(waiter)
      waiter.resolve()
    }
  }

  private startResync(): void {
    void this.resync().catch(() => undefined)
  }

  private async resync(): Promise<void> {
    if (this.disposed) return
    if (this.resyncPromise !== null) {
      await this.resyncPromise
      return
    }
    const generation = this.resyncGeneration + 1
    this.resyncGeneration = generation
    const timeoutMs = this.options.resyncTimeoutMs ?? DEFAULT_RESYNC_TIMEOUT_MS
    const run = (async () => {
      let timeoutHandle: ReturnType<typeof setTimeout> | null = null
      try {
        const snapshot = await new Promise<unknown>((resolve, reject) => {
          timeoutHandle = setTimeout(() => {
            timeoutHandle = null
            reject(new Error(`Kernel snapshot resync timed out after ${timeoutMs}ms.`))
          }, timeoutMs)
          void this.options.fetchSnapshot().then(
            (value) => {
              if (timeoutHandle === null) return
              clearTimeout(timeoutHandle)
              timeoutHandle = null
              resolve(value)
            },
            (error: unknown) => {
              if (timeoutHandle === null) return
              clearTimeout(timeoutHandle)
              timeoutHandle = null
              reject(error)
            }
          )
        })
        if (this.disposed || this.resyncGeneration !== generation) return
        this.handleSnapshot(snapshot)
      } catch (error) {
        if (!this.disposed && this.resyncGeneration === generation) {
          this.reportRecoveryError(error)
        }
        throw error
      } finally {
        if (timeoutHandle !== null) clearTimeout(timeoutHandle)
      }
    })()
    this.resyncPromise = run.then(
      () => undefined,
      () => undefined
    )
    try {
      await run
    } finally {
      if (this.resyncGeneration === generation) this.resyncPromise = null
    }
  }

  private reportRecoveryError(error: unknown): void {
    const onRecoveryError = this.options.onRecoveryError
    if (onRecoveryError === undefined) return
    try {
      onRecoveryError(error)
    } catch {
      // Callback faults must not break recovery bookkeeping.
    }
  }

  private cancelFrame(): void {
    if (this.frameHandle === null) return
    this.options.cancelFrame(this.frameHandle)
    this.frameHandle = null
  }
}

export function parseKernelMutationAck(value: unknown): KernelMutationAck {
  if (!isKernelMutationAck(value)) {
    throw new Error('Kernel mutation ack is invalid or from a stale preload bridge.')
  }
  return value
}

export function parseKernelSnapshot(value: unknown): KernelSnapshot {
  if (!isKernelSnapshot(value)) {
    throw new Error('Kernel snapshot is invalid or from a stale preload bridge.')
  }
  return value
}
