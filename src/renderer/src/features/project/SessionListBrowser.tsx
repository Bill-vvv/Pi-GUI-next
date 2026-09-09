import { useMemo, useState, type ReactNode } from 'react'

import {
  countRevealableSessionListItems,
  filterSessionListItems,
  selectRevealedSessionListItems,
  SESSION_LIST_REVEAL_STEP,
  type SessionListQuery,
  type SessionListQueryItem
} from './session-list-query'

const EMPTY_RETAINED = new Set<string>()

type SessionListBrowserProps<T extends SessionListQueryItem> = {
  listId: string
  items: readonly T[]
  query: SessionListQuery
  now: number
  retainedKeys?: ReadonlySet<string>
  resultNoun: string
  emptyLabel: string
  noMatchLabel: string
  renderItem: (item: T) => ReactNode
}

export function SessionListBrowser<T extends SessionListQueryItem>({
  listId,
  items,
  query,
  now,
  retainedKeys = EMPTY_RETAINED,
  resultNoun,
  emptyLabel,
  noMatchLabel,
  renderItem
}: SessionListBrowserProps<T>): React.JSX.Element {
  const [revealState, setRevealState] = useState(() => ({
    search: query.search,
    timeFilter: query.timeFilter,
    itemCount: SESSION_LIST_REVEAL_STEP
  }))
  const revealedItemCount =
    revealState.search === query.search && revealState.timeFilter === query.timeFilter
      ? revealState.itemCount
      : SESSION_LIST_REVEAL_STEP
  const filteredItems = useMemo(
    () => filterSessionListItems(items, query, now, retainedKeys),
    [items, now, query, retainedKeys]
  )
  const visibleItems = useMemo(
    () => selectRevealedSessionListItems(filteredItems, revealedItemCount, retainedKeys),
    [filteredItems, retainedKeys, revealedItemCount]
  )
  const revealableItemCount = countRevealableSessionListItems(filteredItems, retainedKeys)
  const remainingItemCount = Math.max(0, revealableItemCount - revealedItemCount)
  const canCollapse = revealableItemCount > SESSION_LIST_REVEAL_STEP && remainingItemCount === 0
  const itemListId = `${listId}-items`

  if (items.length === 0) {
    return <p className="empty-session-state muted">{emptyLabel}</p>
  }

  if (filteredItems.length === 0) {
    return (
      <div className="session-list-browser" id={listId}>
        <p className="empty-session-state muted">{noMatchLabel}</p>
      </div>
    )
  }

  return (
    <div className="session-list-browser" id={listId}>
      <div
        className="session-list"
        id={itemListId}
        aria-label={`${resultNoun}列表，共 ${filteredItems.length} 条`}
      >
        {visibleItems.map((item) => renderItem(item))}
      </div>
      {remainingItemCount > 0 || canCollapse ? (
        <button
          className="session-list-reveal"
          type="button"
          aria-controls={itemListId}
          aria-expanded={canCollapse}
          onClick={() => setRevealState({
            search: query.search,
            timeFilter: query.timeFilter,
            itemCount: canCollapse ? SESSION_LIST_REVEAL_STEP : revealableItemCount
          })}
        >
          {canCollapse
            ? `收起至 ${SESSION_LIST_REVEAL_STEP} 个${resultNoun}`
            : `展开其余 ${remainingItemCount} 个${resultNoun}`}
        </button>
      ) : null}
    </div>
  )
}
