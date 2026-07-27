import type {
  KernelConversationEntry,
  KernelTodoItem,
  KernelToolEntry
} from '../../shared/kernel-contract'

export function isTodoWriteToolEntry(
  entry: KernelConversationEntry
): entry is KernelToolEntry & { todos?: KernelTodoItem[] } {
  return entry.kind === 'tool' &&
    entry.name.trim().toLowerCase().split('.').at(-1) === 'todowrite'
}

export function currentTurnTodos(
  entries: readonly KernelConversationEntry[]
): KernelTodoItem[] | null {
  const turnStartIndex = entries.findLastIndex(
    (entry) => entry.kind === 'message' && entry.role === 'user'
  )
  if (turnStartIndex === -1) return null

  for (let index = entries.length - 1; index > turnStartIndex; index -= 1) {
    const entry = entries[index]
    if (entry === undefined || !isTodoWriteToolEntry(entry)) continue
    if (entry.status === 'error' || entry.todos === undefined) continue
    return entry.todos.length === 0 ? null : entry.todos
  }
  return null
}
