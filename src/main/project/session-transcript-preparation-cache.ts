import type { SessionPointer } from './session-pointer.ts'
import {
  sessionTranscriptGenerationsEqual,
  type ReadSessionMessagesTailFirstOptions,
  type SessionTranscriptGeneration,
  type SessionTranscriptMessagePhase
} from './session-transcript-tail.ts'

export type SessionTranscriptPreparationHandle = {
  tail: Promise<SessionTranscriptMessagePhase>
  completion: Promise<SessionTranscriptMessagePhase>
  release: () => void
}

type Preparation = {
  key: string
  controller: AbortController
  consumers: number
  settled: boolean
  tail: Promise<SessionTranscriptMessagePhase>
  completion: Promise<SessionTranscriptMessagePhase>
}

type ReadyPreparation = {
  phase: SessionTranscriptMessagePhase
}

export class SessionTranscriptPreparationCache {
  private readonly inFlight = new Map<string, Preparation>()
  private readonly ready = new Map<string, ReadyPreparation>()
  private readonly read: (
    pointer: SessionPointer,
    options: ReadSessionMessagesTailFirstOptions
  ) => Promise<SessionTranscriptMessagePhase>
  private readonly readGeneration: (
    pointer: SessionPointer
  ) => Promise<SessionTranscriptGeneration>
  private readonly maxReady: number

  constructor(
    read: (
      pointer: SessionPointer,
      options: ReadSessionMessagesTailFirstOptions
    ) => Promise<SessionTranscriptMessagePhase>,
    readGeneration: (
      pointer: SessionPointer
    ) => Promise<SessionTranscriptGeneration>,
    maxReady = 5
  ) {
    if (!Number.isSafeInteger(maxReady) || maxReady <= 0) {
      throw new Error('Session transcript preparation cache size must be positive.')
    }
    this.read = read
    this.readGeneration = readGeneration
    this.maxReady = maxReady
  }

  async acquire(pointer: SessionPointer): Promise<SessionTranscriptPreparationHandle> {
    const key = preparationKey(pointer)
    const cached = this.ready.get(key)
    if (cached !== undefined) {
      const generation = await this.readGeneration(pointer)
      if (sessionTranscriptGenerationsEqual(generation, cached.phase.generation)) {
        this.ready.delete(key)
        this.ready.set(key, cached)
        return resolvedHandle(cached.phase)
      }
      this.ready.delete(key)
    }

    let preparation = this.inFlight.get(key)
    if (preparation === undefined) {
      preparation = this.start(pointer, key)
      this.inFlight.set(key, preparation)
    }
    preparation.consumers += 1
    let released = false
    return {
      tail: preparation.tail,
      completion: preparation.completion,
      release: () => {
        if (released) return
        released = true
        preparation!.consumers -= 1
        if (!preparation!.settled && preparation!.consumers === 0) {
          preparation!.controller.abort()
        }
      }
    }
  }

  clear(): void {
    for (const preparation of this.inFlight.values()) preparation.controller.abort()
    this.inFlight.clear()
    this.ready.clear()
  }

  private start(pointer: SessionPointer, key: string): Preparation {
    const controller = new AbortController()
    let resolveTail!: (phase: SessionTranscriptMessagePhase) => void
    let rejectTail!: (error: unknown) => void
    const tail = new Promise<SessionTranscriptMessagePhase>((resolve, reject) => {
      resolveTail = resolve
      rejectTail = reject
    })
    void tail.catch(() => undefined)
    const preparation: Preparation = {
      key,
      controller,
      consumers: 0,
      settled: false,
      tail,
      completion: Promise.resolve(null as unknown as SessionTranscriptMessagePhase)
    }
    preparation.completion = this.read(pointer, {
      signal: controller.signal,
      onTail: (phase) => resolveTail(phase)
    }).then(
      (phase) => {
        resolveTail(phase)
        preparation.settled = true
        if (this.inFlight.get(key) === preparation) this.inFlight.delete(key)
        this.ready.set(key, { phase })
        while (this.ready.size > this.maxReady) {
          const oldest = this.ready.keys().next().value as string | undefined
          if (oldest === undefined) break
          this.ready.delete(oldest)
        }
        return phase
      },
      (error: unknown) => {
        preparation.settled = true
        if (this.inFlight.get(key) === preparation) this.inFlight.delete(key)
        rejectTail(error)
        throw error
      }
    )
    void preparation.completion.catch(() => undefined)
    return preparation
  }
}

function preparationKey(pointer: SessionPointer): string {
  return `${pointer.projectPath}\0${pointer.sessionFile}\0${pointer.sessionId}`
}

function resolvedHandle(phase: SessionTranscriptMessagePhase): SessionTranscriptPreparationHandle {
  return {
    tail: Promise.resolve(phase),
    completion: Promise.resolve(phase),
    release: () => undefined
  }
}
