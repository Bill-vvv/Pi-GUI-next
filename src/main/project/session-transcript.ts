import { readFile } from 'node:fs/promises'

import type { SessionPointer } from './session-pointer.ts'

export type SessionTranscriptEntry = Record<string, unknown> & {
  type?: unknown
  id: string
  parentId: string | null
  timestamp?: unknown
  message?: unknown
}

export async function readSessionTranscript(pointer: SessionPointer): Promise<SessionTranscriptEntry[]> {
  const text = await readFile(pointer.sessionFile, 'utf8')
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  if (lines.length === 0) throw new Error('Invalid Pi session transcript header.')

  const header = parseLine(lines[0], 1)
  if (!isObject(header) || header.type !== 'session' || typeof header.id !== 'string') {
    throw new Error('Invalid Pi session transcript header.')
  }
  if (header.id !== pointer.sessionId) {
    throw new Error('Pi session transcript ID does not match the session pointer.')
  }

  const entries: SessionTranscriptEntry[] = []
  const entriesById = new Map<string, SessionTranscriptEntry>()
  for (let index = 1; index < lines.length; index += 1) {
    const value = parseLine(lines[index], index + 1)
    if (
      !isObject(value) ||
      typeof value.id !== 'string' ||
      value.id.length === 0 ||
      (typeof value.parentId !== 'string' && value.parentId !== null)
    ) {
      throw new Error(`Invalid Pi session transcript entry at line ${index + 1}.`)
    }
    if (entriesById.has(value.id)) {
      throw new Error(`Duplicate Pi session transcript entry ID at line ${index + 1}.`)
    }
    const entry: SessionTranscriptEntry = {
      ...value,
      id: value.id,
      parentId: value.parentId
    }
    entries.push(entry)
    entriesById.set(entry.id, entry)
  }

  validateParentGraph(entries, entriesById)
  return entries
}

export async function readSessionActivityAt(pointer: SessionPointer): Promise<number | null> {
  let entries: SessionTranscriptEntry[]
  try {
    entries = await readSessionTranscript(pointer)
  } catch {
    return null
  }

  const branch = activeSessionBranch(entries)
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index]
    if (entry?.type === 'message') return sessionTimestamp(entry.timestamp)
  }
  return null
}

export async function readSessionMessages(pointer: SessionPointer): Promise<unknown[]> {
  const entries = await readSessionTranscript(pointer)
  if (entries.length === 0) return []

  return activeSessionBranch(entries)
    .filter((candidate) => candidate.type === 'message' && isObject(candidate.message))
    .map((candidate) => candidate.message)
}

function activeSessionBranch(entries: SessionTranscriptEntry[]): SessionTranscriptEntry[] {
  const entriesById = new Map(entries.map((entry) => [entry.id, entry]))
  const branch: SessionTranscriptEntry[] = []
  let entry: SessionTranscriptEntry | undefined = entries.at(-1)
  while (entry !== undefined) {
    branch.push(entry)
    entry = entry.parentId === null ? undefined : entriesById.get(entry.parentId)
  }
  branch.reverse()
  return branch
}

function parseLine(line: string, lineNumber: number): unknown {
  try {
    return JSON.parse(line) as unknown
  } catch {
    throw new Error(`Invalid Pi session transcript JSON at line ${lineNumber}.`)
  }
}

function validateParentGraph(
  entries: SessionTranscriptEntry[],
  entriesById: Map<string, SessionTranscriptEntry>
): void {
  for (const entry of entries) {
    if (entry.parentId !== null && !entriesById.has(entry.parentId)) {
      throw new Error('Pi session transcript entry references a missing parent.')
    }
  }

  const visited = new Set<string>()
  for (const entry of entries) {
    if (visited.has(entry.id)) continue
    const path = new Set<string>()
    let current: SessionTranscriptEntry | undefined = entry
    while (current !== undefined && !visited.has(current.id)) {
      if (path.has(current.id)) throw new Error('Pi session transcript contains a parent cycle.')
      path.add(current.id)
      current = current.parentId === null ? undefined : entriesById.get(current.parentId)
    }
    for (const id of path) visited.add(id)
  }
}

const PI_SESSION_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u

function sessionTimestamp(value: unknown): number | null {
  if (typeof value !== 'string' || !PI_SESSION_TIMESTAMP_PATTERN.test(value)) return null
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return null
  return new Date(timestamp).toISOString() === value ? timestamp : null
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
