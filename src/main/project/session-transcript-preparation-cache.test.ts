import assert from 'node:assert/strict'
import test from 'node:test'

import type { SessionPointer } from './session-pointer.ts'
import { SessionTranscriptPreparationCache } from './session-transcript-preparation-cache.ts'
import type {
  SessionTranscriptGeneration,
  SessionTranscriptMessagePhase
} from './session-transcript-tail.ts'

const GENERATION_ONE: SessionTranscriptGeneration = {
  device: 1,
  inode: 1,
  size: 100,
  modifiedAtMs: 1,
  changedAtMs: 1
}

const GENERATION_TWO: SessionTranscriptGeneration = {
  ...GENERATION_ONE,
  size: 200,
  modifiedAtMs: 2,
  changedAtMs: 2
}

test('shares one in-flight transcript read until every consumer releases it', async () => {
  const completion = deferred<SessionTranscriptMessagePhase>()
  let reads = 0
  let signal: AbortSignal | undefined
  const cache = new SessionTranscriptPreparationCache(
    async (_pointer, options) => {
      reads += 1
      signal = options.signal
      return completion.promise
    },
    async () => GENERATION_ONE
  )
  const pointer = sessionPointer('shared')

  const first = await cache.acquire(pointer)
  const second = await cache.acquire(pointer)
  assert.equal(reads, 1)

  first.release()
  assert.equal(signal?.aborted, false)

  const phase = transcriptPhase(GENERATION_ONE, 'shared')
  completion.resolve(phase)
  assert.equal(await first.completion, phase)
  assert.equal(await second.completion, phase)
  second.release()
})

test('aborts an unfinished read after its final consumer releases and allows retry', async () => {
  let reads = 0
  const cache = new SessionTranscriptPreparationCache(
    async (_pointer, options) => {
      reads += 1
      if (reads > 1) return transcriptPhase(GENERATION_ONE, 'retry')
      return await new Promise<SessionTranscriptMessagePhase>((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => {
          const error = new Error('aborted')
          error.name = 'AbortError'
          reject(error)
        }, { once: true })
      })
    },
    async () => GENERATION_ONE
  )
  const pointer = sessionPointer('abort')

  const abandoned = await cache.acquire(pointer)
  abandoned.release()
  await assert.rejects(abandoned.completion, (error: Error) => error.name === 'AbortError')

  const retry = await cache.acquire(pointer)
  assert.equal((await retry.completion).messages[0]?.entryId, 'retry')
  assert.equal(reads, 2)
  retry.release()
})

test('reuses matching ready generations and evicts the least-recently-used entry', async () => {
  const generations = new Map<string, SessionTranscriptGeneration>()
  const reads = new Map<string, number>()
  const cache = new SessionTranscriptPreparationCache(
    async (pointer, options) => {
      const id = pointer.sessionId
      reads.set(id, (reads.get(id) ?? 0) + 1)
      const phase = transcriptPhase(generations.get(id) ?? GENERATION_ONE, id)
      await options.onTail(phase)
      return phase
    },
    async (pointer) => generations.get(pointer.sessionId) ?? GENERATION_ONE,
    2
  )
  const firstPointer = sessionPointer('first')
  const secondPointer = sessionPointer('second')
  const thirdPointer = sessionPointer('third')

  await complete(cache, firstPointer)
  await complete(cache, secondPointer)
  await complete(cache, firstPointer)
  await complete(cache, thirdPointer)
  await complete(cache, secondPointer)

  assert.deepEqual(Object.fromEntries(reads), {
    first: 1,
    second: 2,
    third: 1
  })

  generations.set(secondPointer.sessionId, GENERATION_TWO)
  await complete(cache, secondPointer)
  assert.equal(reads.get('second'), 3)
})

async function complete(
  cache: SessionTranscriptPreparationCache,
  pointer: SessionPointer
): Promise<void> {
  const handle = await cache.acquire(pointer)
  await handle.completion
  handle.release()
}

function sessionPointer(id: string): SessionPointer {
  return {
    projectPath: '/tmp/project',
    sessionFile: `/tmp/${id}.jsonl`,
    sessionId: id,
    sessionName: null
  }
}

function transcriptPhase(
  generation: SessionTranscriptGeneration,
  entryId: string
): SessionTranscriptMessagePhase {
  return {
    generation: { ...generation },
    capturedEof: generation.size,
    messages: [{ entryId, message: { role: 'user', content: entryId } }]
  }
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}
