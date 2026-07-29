import type {
  KernelEvent,
  KernelStateEvent
} from '../../shared/kernel-contract.ts'

export const DEFAULT_STATE_BATCH_WINDOW_MS = 8
export const MAX_STATE_BATCH_EVENTS = 64

type TimerHandle = unknown

type KernelEventForwarderOptions = {
  send: (event: KernelEvent) => void
  batchWindowMs?: number
  maxBatchEvents?: number
  schedule?: (callback: () => void, delayMs: number) => TimerHandle
  cancel?: (handle: TimerHandle) => void
}

export type KernelEventForwarder = {
  forward: (event: KernelEvent) => void
  flush: () => void
  dispose: () => void
}

export function createKernelEventForwarder(
  options: KernelEventForwarderOptions
): KernelEventForwarder {
  const batchWindowMs = options.batchWindowMs ?? DEFAULT_STATE_BATCH_WINDOW_MS
  const maxBatchEvents = options.maxBatchEvents ?? MAX_STATE_BATCH_EVENTS
  const schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs))
  const cancel = options.cancel ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  if (!Number.isFinite(batchWindowMs) || batchWindowMs < 0) {
    throw new Error('Kernel state batch window must be a finite non-negative duration.')
  }
  if (!Number.isSafeInteger(maxBatchEvents) || maxBatchEvents < 2) {
    throw new Error('Kernel state batch limit must be an integer of at least two events.')
  }

  let pending: KernelStateEvent[] = []
  let timer: TimerHandle | null = null
  let disposed = false

  const clearTimer = (): void => {
    if (timer === null) return
    cancel(timer)
    timer = null
  }

  const safeSend = (event: KernelEvent): void => {
    try {
      options.send(event)
    } catch {
      // A Renderer can disappear between the lifecycle check and webContents.send().
      // Revision-gap recovery covers a dropped delivery after the next subscription.
    }
  }

  const flush = (): void => {
    clearTimer()
    if (disposed || pending.length === 0) {
      pending = []
      return
    }
    const events = pending
    pending = []
    safeSend(events.length === 1
      ? events[0]
      : { type: 'kernel.state-batch', events })
  }

  const scheduleFlush = (): void => {
    if (timer !== null) return
    timer = schedule(() => {
      timer = null
      flush()
    }, batchWindowMs)
  }

  const forward = (event: KernelEvent): void => {
    if (disposed) return
    if (isKernelStateEvent(event)) {
      // A full snapshot at revision N already contains every pending state mutation
      // through N, so older pending snapshots and patches are redundant.
      if (event.type === 'kernel.state-changed') pending = []
      pending.push(event)
      if (pending.length >= maxBatchEvents) flush()
      else scheduleFlush()
      return
    }

    // Domain events are ordering barriers relative to state revisions.
    flush()
    safeSend(event)
  }

  return {
    forward,
    flush,
    dispose: () => {
      if (disposed) return
      disposed = true
      clearTimer()
      pending = []
    }
  }
}

function isKernelStateEvent(event: KernelEvent): event is KernelStateEvent {
  return event.type === 'kernel.state-changed' || event.type === 'kernel.state-patched'
}
