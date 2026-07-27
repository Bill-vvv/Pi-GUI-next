import type {
  KernelState,
  KernelStatePatch,
  KernelToolEntry,
  KernelToolEntryPatchMetadata
} from '../../../shared/kernel-contract'

export function applyStatePatches(
  state: KernelState,
  patches: KernelStatePatch[]
): KernelState {
  let runtime = state.runtime
  let session = state.session
  let entries = state.conversation.entries
  let activeRunStartIndex = state.conversation.activeRunStartIndex
  let conversationChanged = false
  let entriesCopied = false

  for (const patch of patches) {
    if (
      patch.projectKey !== state.activeProjectKey ||
      patch.sessionKey !== state.activeSessionKey
    ) continue
    if (patch.runtime !== undefined) runtime = patch.runtime
    if (patch.session !== undefined) session = patch.session
    if (patch.conversation === undefined) continue
    if (patch.conversation.entries !== undefined) {
      if (!entriesCopied) {
        entries = entries.slice()
        entriesCopied = true
      }
      conversationChanged = true
      for (const change of patch.conversation.entries) {
        if (change.type === 'insert') {
          if (change.index === entries.length) entries.push(change.entry)
          else if (entries[change.index]?.id !== change.entry.id) {
            throw new Error(`Conversation insert index ${change.index} is out of sequence.`)
          }
          continue
        }

        const current = entries[change.index]
        if (current === undefined) {
          throw new Error(`Conversation patch index ${change.index} does not exist.`)
        }
        if (change.type === 'append-message-text') {
          if (current.kind !== 'message') {
            throw new Error('Conversation message patch kind mismatch.')
          }
          const text = appendProjectedText(current.text, change.from, change.text)
          if (text === null) continue
          entries[change.index] = {
            ...current,
            text,
            streaming: change.streaming,
            stopReason: change.stopReason,
            error: change.error
          }
          continue
        }
        if (change.type === 'append-thinking-text') {
          if (current.kind !== 'thinking') {
            throw new Error('Conversation thinking patch kind mismatch.')
          }
          const text = appendProjectedText(current.text, change.from, change.text)
          if (text === null) continue
          entries[change.index] = { ...current, text, streaming: change.streaming }
          continue
        }
        if (current.kind !== 'tool') {
          throw new Error('Conversation tool patch kind mismatch.')
        }
        if (current.toolCallId !== change.toolCallId) {
          throw new Error('Conversation tool patch identity mismatch.')
        }
        if (change.type === 'replace-tool-metadata') {
          const currentMetadata = toolEntryPatchMetadata(current)
          if (sameProjectedValue(currentMetadata, change.metadata)) continue
          if (
            current.output.length !== change.expectedOutputLength ||
            !sameProjectedValue(currentMetadata, change.expected)
          ) continue
          entries[change.index] = {
            ...current,
            ...change.metadata,
            ...(change.metadata.todos === undefined
              ? {}
              : { todos: change.metadata.todos.map((todo) => ({ ...todo })) }),
            ...(change.metadata.attachments === undefined
              ? {}
              : {
                  attachments: change.metadata.attachments.map((attachment) => ({
                    ...attachment
                  }))
                })
          }
          continue
        }
        const output = appendProjectedText(current.output, change.from, change.output)
        if (output === null) continue
        entries[change.index] = {
          ...current,
          output,
          status: change.status,
          details: change.details,
          truncated: change.truncated,
          durationMs: change.durationMs,
          subagent: change.subagent
        }
      }
    }
    if ('activeRunStartIndex' in patch.conversation) {
      activeRunStartIndex = patch.conversation.activeRunStartIndex ?? null
      conversationChanged = true
    }
  }

  return {
    ...state,
    runtime,
    session,
    conversation: conversationChanged
      ? { entries, activeRunStartIndex }
      : state.conversation
  }
}

function toolEntryPatchMetadata(entry: KernelToolEntry): KernelToolEntryPatchMetadata {
  return {
    status: entry.status,
    details: entry.details,
    truncated: entry.truncated,
    durationMs: entry.durationMs,
    subagent: entry.subagent,
    todos: entry.todos,
    attachments: entry.attachments
  }
}

function sameProjectedValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (
    left === null || right === null ||
    typeof left !== 'object' || typeof right !== 'object' ||
    Array.isArray(left) !== Array.isArray(right)
  ) return false
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length &&
      left.every((value, index) => sameProjectedValue(value, right[index]))
  }
  const leftRecord = left as Record<string, unknown>
  const rightRecord = right as Record<string, unknown>
  const leftKeys = Object.keys(leftRecord)
  if (leftKeys.length !== Object.keys(rightRecord).length) return false
  return leftKeys.every((key) =>
    Object.hasOwn(rightRecord, key) && sameProjectedValue(leftRecord[key], rightRecord[key])
  )
}

export function appendProjectedText(
  current: string,
  from: number,
  addition: string
): string | null {
  if (current.length === from) return addition.length === 0 ? null : `${current}${addition}`
  const targetLength = from + addition.length
  if (
    current.length >= targetLength &&
    current.slice(from, targetLength) === addition
  ) return null
  throw new Error(
    `Conversation text patch expected ${from} characters; received ${current.length}.`
  )
}
