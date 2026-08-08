import type {
  KernelConversationPage,
  KernelConversationState,
  KernelState
} from '../../../shared/kernel-contract.ts'

/** Keep locally loaded immutable history when a newer authoritative tail still overlaps it. */
export function preserveEarlierConversationWindow(
  current: KernelState,
  next: KernelState
): KernelState {
  if (
    current.activeProjectKey !== next.activeProjectKey ||
    current.activeSessionKey !== next.activeSessionKey ||
    current.session.id !== next.session.id ||
    current.conversation.startIndex >= next.conversation.startIndex
  ) {
    return next
  }

  const overlapStart = next.conversation.startIndex - current.conversation.startIndex
  if (overlapStart >= current.conversation.entries.length) return next
  const overlapLength = Math.min(
    current.conversation.entries.length - overlapStart,
    next.conversation.entries.length
  )
  if (overlapLength <= 0) return next
  for (let index = 0; index < overlapLength; index += 1) {
    if (
      current.conversation.entries[overlapStart + index]?.id !==
      next.conversation.entries[index]?.id
    ) {
      return next
    }
  }

  return {
    ...next,
    conversation: {
      ...next.conversation,
      startIndex: current.conversation.startIndex,
      entries: [
        ...current.conversation.entries.slice(0, overlapStart),
        ...next.conversation.entries
      ]
    }
  }
}

/** Merge one authoritative page without changing the Kernel revision. */
export function mergeEarlierConversationPage(
  state: KernelState,
  page: KernelConversationPage
): KernelState {
  validatePage(page)
  if (
    page.projectKey !== state.activeProjectKey ||
    page.sessionKey !== state.activeSessionKey ||
    page.sessionId !== state.session.id
  ) {
    throw new Error('Conversation page identity is stale.')
  }

  const conversation = state.conversation
  const existingIds = new Set<string>()
  for (const entry of conversation.entries) {
    if (existingIds.has(entry.id)) {
      throw new Error(`Conversation entry ID ${JSON.stringify(entry.id)} is duplicated.`)
    }
    existingIds.add(entry.id)
  }

  if (page.beforeIndex === conversation.startIndex) {
    const boundaryEntry = conversation.entries[0]
    if (boundaryEntry === undefined || boundaryEntry.id !== page.beforeEntryId) {
      throw new Error('Conversation page boundary identity does not match the current window.')
    }
    for (const entry of page.entries) {
      if (existingIds.has(entry.id)) {
        throw new Error(`Conversation page entry ID ${JSON.stringify(entry.id)} is duplicated.`)
      }
    }
    return {
      ...state,
      conversation: {
        ...conversation,
        startIndex: page.startIndex,
        entries: [...page.entries, ...conversation.entries]
      }
    }
  }

  if (pageIsAlreadyCovered(conversation, page)) return state
  throw new Error('Conversation page result is stale for the current window.')
}

function validatePage(page: KernelConversationPage): void {
  if (
    !Number.isSafeInteger(page.beforeIndex) ||
    !Number.isSafeInteger(page.startIndex) ||
    page.startIndex < 0 ||
    page.beforeIndex <= page.startIndex ||
    page.entries.length === 0 ||
    page.startIndex + page.entries.length !== page.beforeIndex
  ) {
    throw new Error('Conversation page range is invalid.')
  }
  if (
    page.projectKey.length === 0 ||
    page.sessionKey.length === 0 ||
    page.sessionId.length === 0 ||
    page.beforeEntryId.length === 0
  ) {
    throw new Error('Conversation page identity is invalid.')
  }
  const ids = new Set<string>()
  for (const entry of page.entries) {
    if (entry.id.length === 0 || ids.has(entry.id)) {
      throw new Error(`Conversation page entry ID ${JSON.stringify(entry.id)} is duplicated.`)
    }
    ids.add(entry.id)
  }
}

function pageIsAlreadyCovered(
  conversation: KernelConversationState,
  page: KernelConversationPage
): boolean {
  if (
    conversation.startIndex > page.startIndex ||
    conversation.startIndex + conversation.entries.length < page.beforeIndex
  ) return false

  const localStart = page.startIndex - conversation.startIndex
  for (let index = 0; index < page.entries.length; index += 1) {
    if (conversation.entries[localStart + index]?.id !== page.entries[index]!.id) return false
  }
  const boundaryLocalIndex = page.beforeIndex - conversation.startIndex
  return conversation.entries[boundaryLocalIndex]?.id === page.beforeEntryId
}
