import type {
  KernelConversationEntry,
  KernelForkCandidate,
  KernelMessageEntry
} from '../../shared/kernel-contract.ts'
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

export function resolveVisiblePromptCandidate(
  entries: readonly KernelConversationEntry[],
  candidates: readonly KernelForkCandidate[],
  messageId: string
): KernelForkCandidate | null {
  const visiblePrompts = entries.filter((entry): entry is KernelMessageEntry =>
    entry.kind === 'message' &&
    entry.role === 'user' &&
    !entry.streaming &&
    !(entry.attachments ?? []).some(({ type }) => type === 'image')
  )
  const targetPromptIndex = visiblePrompts.findIndex(({ id }) => id === messageId)
  if (targetPromptIndex < 0) return null

  const earliestMatches: number[] = []
  let candidateIndex = 0
  for (const prompt of visiblePrompts) {
    while (candidateIndex < candidates.length && candidates[candidateIndex]!.text !== prompt.text) {
      candidateIndex += 1
    }
    if (candidateIndex >= candidates.length) return null
    earliestMatches.push(candidateIndex)
    candidateIndex += 1
  }

  const latestMatches = new Array<number>(visiblePrompts.length)
  candidateIndex = candidates.length - 1
  for (let promptIndex = visiblePrompts.length - 1; promptIndex >= 0; promptIndex -= 1) {
    const prompt = visiblePrompts[promptIndex]!
    while (candidateIndex >= 0 && candidates[candidateIndex]!.text !== prompt.text) {
      candidateIndex -= 1
    }
    if (candidateIndex < 0) return null
    latestMatches[promptIndex] = candidateIndex
    candidateIndex -= 1
  }

  const targetCandidateIndex = earliestMatches[targetPromptIndex]
  if (targetCandidateIndex !== latestMatches[targetPromptIndex]) return null
  return candidates[targetCandidateIndex] ?? null
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
