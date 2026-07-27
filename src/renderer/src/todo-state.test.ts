import assert from 'node:assert/strict'
import test from 'node:test'

import type {
  KernelConversationEntry,
  KernelTodoItem,
  KernelToolEntry
} from '../../shared/kernel-contract'
import { currentTurnTodos, isTodoWriteToolEntry } from './todo-state.ts'

const todos: KernelTodoItem[] = [
  { id: 'one', content: 'Inspect', status: 'completed', priority: 'high' },
  { id: 'two', content: 'Implement', status: 'in_progress', priority: null }
]

test('selects the latest valid todowrite list in the current user turn', () => {
  const entries: KernelConversationEntry[] = [
    user('old-user', 1),
    todoTool('old-todo', [{ ...todos[0]!, status: 'completed' }], 'success'),
    user('current-user', 2),
    todoTool('failed-update', [{ ...todos[1]!, status: 'pending' }], 'error'),
    todoTool('current-todo', todos, 'running')
  ]

  assert.equal(isTodoWriteToolEntry(entries.at(-1)!), true)
  assert.deepEqual(currentTurnTodos(entries), todos)
})

test('a new user turn hides the previous completed Todo panel', () => {
  assert.equal(currentTurnTodos([
    user('first-user', 1),
    todoTool('first-todo', todos, 'success'),
    user('next-user', 2)
  ]), null)
})

test('an empty todowrite list clears the panel for the current turn', () => {
  assert.equal(currentTurnTodos([
    user('current-user', 1),
    todoTool('current-todo', todos, 'success'),
    todoTool('clear-todo', [], 'success')
  ]), null)
})

test('namespaced todowrite tools use the same exact suffix match', () => {
  const entry = todoTool('namespaced', todos, 'success', 'functions.todowrite')
  assert.equal(isTodoWriteToolEntry(entry), true)
  assert.deepEqual(currentTurnTodos([user('user', 1), entry]), todos)
})

function user(id: string, timestamp: number): KernelConversationEntry {
  return {
    id,
    kind: 'message',
    role: 'user',
    phase: null,
    text: id,
    timestamp,
    streaming: false,
    stopReason: null,
    error: null
  }
}

function todoTool(
  id: string,
  projectedTodos: KernelTodoItem[],
  status: KernelToolEntry['status'],
  name = 'todowrite'
): KernelToolEntry {
  return {
    id,
    kind: 'tool',
    toolCallId: id,
    name,
    status,
    args: '',
    output: '',
    details: '',
    truncated: false,
    timestamp: 1,
    durationMs: null,
    subagent: null,
    todos: projectedTodos
  }
}
