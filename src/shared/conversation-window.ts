import type { KernelConversationEntry } from './kernel-contract.ts'

export const KERNEL_CONVERSATION_PAGE_TURN_COUNT = 60

/**
 * Returns the first entry index for the requested number of complete turns ending at `end`.
 * Commands are standalone turns; every other turn begins at its user message.
 */
export function conversationTurnWindowStartIndex(
  entries: readonly KernelConversationEntry[],
  end: number,
  turnCount: number
): number {
  if (!Number.isSafeInteger(end) || end < 0 || end > entries.length) {
    throw new Error('Conversation window end index is invalid.')
  }
  if (!Number.isSafeInteger(turnCount) || turnCount < 1) {
    throw new Error('Conversation window turn count is invalid.')
  }

  let start = end
  for (let remaining = turnCount; remaining > 0 && start > 0; remaining -= 1) {
    const lastEntry = entries[start - 1]!
    if (lastEntry.kind === 'command') {
      start -= 1
      continue
    }

    let index = start - 1
    while (index >= 0) {
      const entry = entries[index]!
      if (entry.kind === 'message' && entry.role === 'user') {
        start = index
        break
      }
      if (entry.kind === 'command') {
        start = index + 1
        break
      }
      index -= 1
    }
    if (index < 0) start = 0
  }
  return start
}
