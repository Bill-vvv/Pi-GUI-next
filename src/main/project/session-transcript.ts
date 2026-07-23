import { readFile } from 'node:fs/promises'

import type { SessionPointer } from './session-pointer.ts'

type SessionEntry = {
  type?: unknown
  id: string
  parentId: string | null
  message?: unknown
}

export async function readSessionMessages(pointer: SessionPointer): Promise<unknown[]> {
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

  const entries: SessionEntry[] = []
  const entriesById = new Map<string, SessionEntry>()
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
    const entry: SessionEntry = {
      type: value.type,
      id: value.id,
      parentId: value.parentId,
      message: value.message
    }
    entries.push(entry)
    entriesById.set(entry.id, entry)
  }

  validateParentGraph(entries, entriesById)
  if (entries.length === 0) return []

  const branch: SessionEntry[] = []
  let entry: SessionEntry | undefined = entries.at(-1)
  while (entry !== undefined) {
    branch.push(entry)
    entry = entry.parentId === null ? undefined : entriesById.get(entry.parentId)
  }
  branch.reverse()

  return branch
    .filter((candidate) => candidate.type === 'message' && isObject(candidate.message))
    .map((candidate) => candidate.message)
}

function parseLine(line: string, lineNumber: number): unknown {
  try {
    return JSON.parse(line) as unknown
  } catch {
    throw new Error(`Invalid Pi session transcript JSON at line ${lineNumber}.`)
  }
}

function validateParentGraph(entries: SessionEntry[], entriesById: Map<string, SessionEntry>): void {
  for (const entry of entries) {
    if (entry.parentId !== null && !entriesById.has(entry.parentId)) {
      throw new Error('Pi session transcript entry references a missing parent.')
    }
  }

  const visited = new Set<string>()
  for (const entry of entries) {
    if (visited.has(entry.id)) continue
    const path = new Set<string>()
    let current: SessionEntry | undefined = entry
    while (current !== undefined && !visited.has(current.id)) {
      if (path.has(current.id)) throw new Error('Pi session transcript contains a parent cycle.')
      path.add(current.id)
      current = current.parentId === null ? undefined : entriesById.get(current.parentId)
    }
    for (const id of path) visited.add(id)
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
