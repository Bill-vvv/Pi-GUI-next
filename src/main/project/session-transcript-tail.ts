import { open, type FileHandle } from 'node:fs/promises'
import { TextDecoder } from 'node:util'

import type { SessionPointer } from './session-pointer.ts'
import type { SessionTranscriptEntry } from './session-transcript.ts'

const MAX_SESSION_HEADER_BYTES = 16 * 1024
const DEFAULT_READ_CHUNK_BYTES = 64 * 1024

export type SessionTranscriptMessageRecord = {
  entryId: string
  message: Record<string, unknown>
}

export type SessionTranscriptMessagePhase = {
  capturedEof: number
  messages: SessionTranscriptMessageRecord[]
}

export type SessionTranscriptReadRange = {
  position: number
  bytesRead: number
  source: 'header' | 'reverse'
}

export type ReadSessionMessagesTailFirstOptions = {
  signal?: AbortSignal
  onTail: (phase: SessionTranscriptMessagePhase) => void | Promise<void>
  chunkSizeBytes?: number
  onRead?: (range: SessionTranscriptReadRange) => void
}

/**
 * Reads a captured Session JSONL generation once from the physical tail toward the header.
 * The early tail and final result retain the canonical transcript entry ID for stable projection.
 */
export async function readSessionMessagesTailFirst(
  pointer: SessionPointer,
  options: ReadSessionMessagesTailFirstOptions
): Promise<SessionTranscriptMessagePhase> {
  const chunkSizeBytes = options.chunkSizeBytes ?? DEFAULT_READ_CHUNK_BYTES
  if (!Number.isSafeInteger(chunkSizeBytes) || chunkSizeBytes <= 0) {
    throw new Error('Session transcript read chunk size must be a positive safe integer.')
  }

  throwIfAborted(options.signal)
  const file = await open(pointer.sessionFile, 'r')
  try {
    throwIfAborted(options.signal)
    const stat = await file.stat()
    if (!Number.isSafeInteger(stat.size) || stat.size < 0) {
      throw new Error('Invalid Pi session transcript size.')
    }
    const capturedEof = stat.size
    const headerPrefix = await readAndValidateHeader(
      file,
      capturedEof,
      pointer.sessionId,
      chunkSizeBytes,
      options
    )

    const entriesReverse: SessionTranscriptEntry[] = []
    const entriesById = new Map<string, SessionTranscriptEntry>()
    const activeReverse: SessionTranscriptEntry[] = []
    const activeIds = new Set<string>()
    let nextActiveParentId: string | null | undefined
    let activeUserBoundaryCount = 0
    let tailPublished = false
    let firstPhysicalFrame = true
    let pendingParts: Buffer[] = []
    let pendingPartsBytes = 0

    const activeMessages = (entries: SessionTranscriptEntry[]): SessionTranscriptMessageRecord[] =>
      entries
        .filter(isMessageEntry)
        .map((entry) => ({ entryId: entry.id, message: entry.message }))

    const publishTail = async (entries: SessionTranscriptEntry[]): Promise<void> => {
      if (tailPublished) return
      tailPublished = true
      throwIfAborted(options.signal)
      await options.onTail({ capturedEof, messages: activeMessages(entries) })
      throwIfAborted(options.signal)
    }

    const appendActiveEntry = async (entry: SessionTranscriptEntry): Promise<void> => {
      activeReverse.push(entry)
      activeIds.add(entry.id)
      if (isUserMessageEntry(entry)) activeUserBoundaryCount += 1
      if (!tailPublished && activeUserBoundaryCount === 2) {
        await publishTail([...activeReverse].reverse())
      }
    }

    const advanceActiveBranch = async (): Promise<void> => {
      while (nextActiveParentId !== null && nextActiveParentId !== undefined) {
        const parent = entriesById.get(nextActiveParentId)
        if (parent === undefined) return
        if (activeIds.has(parent.id)) {
          throw new Error('Pi session transcript contains a parent cycle.')
        }
        await appendActiveEntry(parent)
        nextActiveParentId = parent.parentId
      }
    }

    const processRecord = async (raw: Buffer, byteOffset: number): Promise<void> => {
      throwIfAborted(options.signal)
      const value = parseJsonRecord(raw, 'entry', byteOffset)
      if (
        !isObject(value) ||
        typeof value.id !== 'string' ||
        value.id.length === 0 ||
        (typeof value.parentId !== 'string' && value.parentId !== null)
      ) {
        throw new Error(`Invalid Pi session transcript entry at byte offset ${byteOffset}.`)
      }
      if (entriesById.has(value.id)) {
        throw new Error('Duplicate Pi session transcript entry ID.')
      }

      const entry: SessionTranscriptEntry = {
        ...value,
        id: value.id,
        parentId: value.parentId
      }
      entriesReverse.push(entry)
      entriesById.set(entry.id, entry)

      if (entriesReverse.length === 1) {
        await appendActiveEntry(entry)
        nextActiveParentId = entry.parentId
      }
      await advanceActiveBranch()
      throwIfAborted(options.signal)
    }

    const takePendingRecord = (prefix: Buffer): Buffer => {
      const parts = [prefix]
      for (let index = pendingParts.length - 1; index >= 0; index -= 1) {
        parts.push(pendingParts[index]!)
      }
      const raw = Buffer.concat(parts, prefix.length + pendingPartsBytes)
      pendingParts = []
      pendingPartsBytes = 0
      return raw
    }

    const scanChunk = async (chunk: Buffer, position: number): Promise<void> => {
      let segmentEnd = chunk.length
      for (let index = chunk.length - 1; index >= 0; index -= 1) {
        if (chunk[index] !== 0x0a) continue
        const part = Buffer.from(chunk.subarray(index + 1, segmentEnd))
        const raw = takePendingRecord(part)
        if (!(firstPhysicalFrame && raw.length === 0)) {
          await processRecord(raw, position + index + 1)
        }
        firstPhysicalFrame = false
        segmentEnd = index
      }
      if (segmentEnd > 0) {
        const part = Buffer.from(chunk.subarray(0, segmentEnd))
        pendingParts.push(part)
        pendingPartsBytes += part.length
      }
    }

    let position = capturedEof
    while (position > headerPrefix.bytes.length) {
      throwIfAborted(options.signal)
      const length = Math.min(chunkSizeBytes, position - headerPrefix.bytes.length)
      const start = position - length
      const chunk = await readExact(file, start, length, 'reverse', options)
      await scanChunk(chunk, start)
      position = start
    }

    const cachedBody = headerPrefix.bytes.subarray(headerPrefix.headerEnd)
    if (cachedBody.length > 0) {
      await scanChunk(cachedBody, headerPrefix.headerEnd)
    }
    if (capturedEof > headerPrefix.headerEnd) {
      await processRecord(takePendingRecord(Buffer.alloc(0)), headerPrefix.headerEnd)
    }

    if (!tailPublished) {
      await publishTail([...activeReverse].reverse())
    }

    const entries = [...entriesReverse].reverse()
    validateParentGraph(entries, entriesById, options.signal)
    throwIfAborted(options.signal)
    return { capturedEof, messages: activeMessages([...activeReverse].reverse()) }
  } finally {
    await file.close()
  }
}

async function readAndValidateHeader(
  file: FileHandle,
  capturedEof: number,
  expectedSessionId: string,
  chunkSizeBytes: number,
  options: ReadSessionMessagesTailFirstOptions
): Promise<{ bytes: Buffer; headerEnd: number }> {
  const chunks: Buffer[] = []
  const readLimit = Math.min(capturedEof, MAX_SESSION_HEADER_BYTES + 1)
  let position = 0

  while (position < readLimit) {
    const length = Math.min(chunkSizeBytes, readLimit - position)
    const chunk = await readExact(file, position, length, 'header', options)
    chunks.push(chunk)
    const lineFeed = chunk.indexOf(0x0a)
    position += chunk.length
    if (lineFeed >= 0) {
      const bytes = Buffer.concat(chunks)
      const headerEnd = position - chunk.length + lineFeed + 1
      validateHeader(bytes.subarray(0, headerEnd - 1), expectedSessionId)
      return { bytes, headerEnd }
    }
  }

  if (capturedEof > MAX_SESSION_HEADER_BYTES) {
    throw new Error('Invalid Pi session transcript header.')
  }
  const bytes = Buffer.concat(chunks)
  validateHeader(bytes, expectedSessionId)
  return { bytes, headerEnd: capturedEof }
}

function validateHeader(raw: Buffer, expectedSessionId: string): void {
  const header = parseJsonRecord(raw, 'header', 0)
  if (!isObject(header) || header.type !== 'session' || typeof header.id !== 'string') {
    throw new Error('Invalid Pi session transcript header.')
  }
  if (header.id !== expectedSessionId) {
    throw new Error('Pi session transcript ID does not match the session pointer.')
  }
}

async function readExact(
  file: FileHandle,
  position: number,
  length: number,
  source: SessionTranscriptReadRange['source'],
  options: ReadSessionMessagesTailFirstOptions
): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(length)
  const { bytesRead } = await file.read(buffer, 0, length, position)
  options.onRead?.({ position, bytesRead, source })
  throwIfAborted(options.signal)
  if (bytesRead !== length) {
    throw new Error('Pi session transcript changed while it was being read.')
  }
  return buffer
}

function parseJsonRecord(raw: Buffer, kind: 'header' | 'entry', byteOffset: number): unknown {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(raw)
  } catch {
    throw new Error(`Invalid Pi session transcript UTF-8 ${kind} at byte offset ${byteOffset}.`)
  }
  try {
    return JSON.parse(text) as unknown
  } catch {
    if (kind === 'header') throw new Error('Invalid Pi session transcript header.')
    throw new Error(`Invalid Pi session transcript JSON entry at byte offset ${byteOffset}.`)
  }
}

function validateParentGraph(
  entries: SessionTranscriptEntry[],
  entriesById: Map<string, SessionTranscriptEntry>,
  signal: AbortSignal | undefined
): void {
  for (const entry of entries) {
    throwIfAborted(signal)
    if (entry.parentId !== null && !entriesById.has(entry.parentId)) {
      throw new Error('Pi session transcript entry references a missing parent.')
    }
  }

  const visited = new Set<string>()
  for (const entry of entries) {
    throwIfAborted(signal)
    if (visited.has(entry.id)) continue
    const path = new Set<string>()
    let current: SessionTranscriptEntry | undefined = entry
    while (current !== undefined && !visited.has(current.id)) {
      throwIfAborted(signal)
      if (path.has(current.id)) throw new Error('Pi session transcript contains a parent cycle.')
      path.add(current.id)
      current = current.parentId === null ? undefined : entriesById.get(current.parentId)
    }
    for (const id of path) visited.add(id)
  }
}

function isMessageEntry(
  entry: SessionTranscriptEntry
): entry is SessionTranscriptEntry & { message: Record<string, unknown> } {
  return entry.type === 'message' && isObject(entry.message)
}

function isUserMessageEntry(entry: SessionTranscriptEntry): boolean {
  return isMessageEntry(entry) && entry.message.role === 'user'
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return
  const error = new Error('Session transcript read was aborted.')
  error.name = 'AbortError'
  throw error
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
