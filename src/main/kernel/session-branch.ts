import type { KernelForkCandidate } from '../../shared/kernel-contract.ts'
import type { PiRpcSessionEntry } from '../pi-rpc/pi-rpc-client.ts'

export function forkCandidatesOnActivePath(
  entries: PiRpcSessionEntry[],
  leafId: string | null
): KernelForkCandidate[] {
  return sessionEntriesOnActivePath(entries, leafId).flatMap((entry) => {
    const content = entry.message?.role === 'user' ? entry.message.content : undefined
    return entry.type === 'message' && content !== undefined && !content.hasImage
      ? [{ entryId: entry.id, text: content.text, timestamp: entry.timestamp }]
      : []
  })
}

export function sessionEntriesOnActivePath(
  entries: readonly PiRpcSessionEntry[],
  leafId: string | null
): PiRpcSessionEntry[] {
  const entriesById = new Map<string, PiRpcSessionEntry>()
  for (const entry of entries) {
    if (entriesById.has(entry.id)) {
      throw new Error(`Runtime returned duplicate session entry ID: ${entry.id}`)
    }
    entriesById.set(entry.id, entry)
  }
  if (leafId === null) return []

  const activePath: PiRpcSessionEntry[] = []
  const visited = new Set<string>()
  let currentId: string | null = leafId
  while (currentId !== null) {
    if (visited.has(currentId)) {
      throw new Error(`Runtime returned a cyclic session entry path at: ${currentId}`)
    }
    visited.add(currentId)
    const entry = entriesById.get(currentId)
    if (entry === undefined) {
      throw new Error(`Runtime active session path references a missing entry: ${currentId}`)
    }
    activePath.push(entry)
    currentId = entry.parentId
  }
  activePath.reverse()
  return activePath
}
