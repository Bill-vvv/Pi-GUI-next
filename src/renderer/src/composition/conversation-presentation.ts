import type {
  KernelConversationPreviewState,
  KernelConversationState
} from '../../../shared/kernel-contract.ts'

export function timelineConversation(
  conversation: KernelConversationState
): KernelConversationPreviewState {
  const activeRunStartIndex = conversation.activeRunStartIndex === null
    ? null
    : conversation.activeRunStartIndex - conversation.startIndex
  if (
    activeRunStartIndex !== null &&
    (!Number.isSafeInteger(activeRunStartIndex) ||
      activeRunStartIndex < 0 ||
      activeRunStartIndex > conversation.entries.length)
  ) {
    throw new Error('Conversation active run boundary is outside the loaded window.')
  }
  return {
    entries: conversation.entries,
    startIndex: conversation.startIndex,
    activeRunStartIndex
  }
}
