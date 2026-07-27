import { useId, useState } from 'react'

import type { KernelTodoItem, KernelTodoStatus } from '../../../../shared/kernel-contract'
import { Icon } from '../../components/Icon'

type TodoPanelProps = {
  todos: KernelTodoItem[]
}

export function TodoPanel({ todos }: TodoPanelProps): React.JSX.Element {
  const [expanded, setExpanded] = useState(true)
  const bodyId = useId()
  const completedCount = todos.filter(({ status }) => status === 'completed').length
  const current = todos.find(({ status }) => status === 'in_progress') ??
    todos.find(({ status }) => status === 'pending') ??
    null
  const status = todoPanelStatus(todos)

  return (
    <section
      className={`composer-todo-panel${expanded ? ' expanded' : ' collapsed'}`}
      aria-label="当前任务"
      data-state={status.tone}
      data-todo-count={todos.length}
    >
      <button
        className="composer-todo-header"
        type="button"
        aria-label={expanded ? '收起任务清单' : '展开任务清单'}
        aria-expanded={expanded}
        aria-controls={bodyId}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="composer-todo-summary">
          <span className="composer-todo-mark" aria-hidden="true" />
          <strong>任务</strong>
          <span className="composer-todo-count">{completedCount} / {todos.length} 完成</span>
          {!expanded && current !== null ? (
            <span className="composer-todo-current">
              <span aria-hidden="true">· </span>
              {current.content}
            </span>
          ) : null}
        </span>
        <span className={`composer-todo-state ${status.tone}`} role="status" aria-live="polite">
          <span className="composer-todo-state-dot" aria-hidden="true" />
          {status.label}
        </span>
        <span className="composer-todo-chevron" aria-hidden="true">
          <Icon name="chevron-down" size="sm" />
        </span>
      </button>

      <div className="composer-todo-body" id={bodyId} aria-hidden={!expanded}>
        <div className="composer-todo-body-inner">
          <ol className="composer-todo-list">
            {todos.map((todo, index) => (
              <li
                className={`composer-todo-item ${todo.status}`}
                data-priority={todo.priority ?? undefined}
                aria-current={todo.status === 'in_progress' ? 'step' : undefined}
                key={todo.id ?? `${index}:${todo.content}`}
              >
                <span className="composer-todo-item-mark" aria-hidden="true" />
                <span className="composer-todo-item-content">{todo.content}</span>
                <span className="composer-todo-item-status">{todoStatusLabel(todo.status)}</span>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  )
}

function todoPanelStatus(todos: readonly KernelTodoItem[]): {
  label: string
  tone: 'active' | 'waiting' | 'settled'
} {
  if (todos.some(({ status }) => status === 'in_progress')) {
    return { label: '正在处理', tone: 'active' }
  }
  if (todos.some(({ status }) => status === 'pending')) {
    return { label: '等待继续', tone: 'waiting' }
  }
  return { label: '已结束', tone: 'settled' }
}

function todoStatusLabel(status: KernelTodoStatus): string {
  if (status === 'in_progress') return '进行中'
  if (status === 'completed') return '已完成'
  if (status === 'cancelled') return '已取消'
  return '待处理'
}
