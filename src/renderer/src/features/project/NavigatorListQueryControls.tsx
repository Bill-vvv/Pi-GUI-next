import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { IconButton } from '../../components/IconButton'
import { useViewportPopoverPosition } from '../../components/useViewportPopoverPosition'
import {
  EMPTY_SESSION_LIST_QUERY,
  SESSION_LIST_TIME_FILTER_LABELS,
  SESSION_LIST_TIME_FILTERS,
  sessionListSearchActive,
  sessionListTimeFilterActive,
  type SessionListQuery,
  type SessionListTimeFilter
} from './session-list-query'

const POPOVER_MAX_HEIGHT = 280

type NavigatorListQueryControlsProps = {
  query: SessionListQuery
  onQueryChange: (query: SessionListQuery) => void
  searchPlaceholder: string
  resultNoun: string
}

export function NavigatorListQueryControls({
  query,
  onQueryChange,
  searchPlaceholder,
  resultNoun
}: NavigatorListQueryControlsProps): React.JSX.Element {
  const [openPanel, setOpenPanel] = useState<'search' | 'filter' | null>(null)
  const searchTriggerRef = useRef<HTMLButtonElement>(null)
  const filterTriggerRef = useRef<HTMLButtonElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const activeTriggerRef = openPanel === 'filter' ? filterTriggerRef : searchTriggerRef
  const searchMenuId = useId()
  const filterMenuId = useId()
  const { popoverRef, position } = useViewportPopoverPosition<HTMLDivElement>(
    openPanel !== null,
    activeTriggerRef,
    POPOVER_MAX_HEIGHT,
    { preferredWidth: openPanel === 'search' ? 240 : 180, align: 'end' }
  )
  const searchActive = sessionListSearchActive(query)
  const filterActive = sessionListTimeFilterActive(query)
  const queryActive = searchActive || filterActive

  useEffect(() => {
    if (openPanel !== 'search') return
    const frame = window.requestAnimationFrame(() => {
      searchInputRef.current?.focus()
      searchInputRef.current?.select()
    })
    return () => window.cancelAnimationFrame(frame)
  }, [openPanel])

  useEffect(() => {
    if (openPanel === null) return

    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (searchTriggerRef.current?.contains(target)) return
      if (filterTriggerRef.current?.contains(target)) return
      if (popoverRef.current?.contains(target)) return
      setOpenPanel(null)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      const trigger = openPanel === 'filter' ? filterTriggerRef.current : searchTriggerRef.current
      setOpenPanel(null)
      trigger?.focus()
    }

    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('keydown', onKeyDown, true)
    }
  }, [openPanel, popoverRef])

  return (
    <>
      <IconButton
        ref={searchTriggerRef}
        className={`workspace-navigator-group-query-action${searchActive ? ' active' : ''}${openPanel === 'search' ? ' open' : ''}`}
        icon="search"
        iconSize="sm"
        label={searchActive ? `搜索${resultNoun}（已启用）` : `搜索${resultNoun}`}
        title={searchActive ? `搜索：${query.search.trim()}` : `搜索${resultNoun}`}
        aria-haspopup="dialog"
        aria-expanded={openPanel === 'search'}
        aria-controls={openPanel === 'search' ? searchMenuId : undefined}
        data-query-active={searchActive || openPanel === 'search' ? 'true' : undefined}
        onClick={() => setOpenPanel((current) => current === 'search' ? null : 'search')}
      />
      <IconButton
        ref={filterTriggerRef}
        className={`workspace-navigator-group-query-action${filterActive ? ' active' : ''}${openPanel === 'filter' ? ' open' : ''}`}
        icon="filter"
        iconSize="sm"
        label={filterActive
          ? `筛选${resultNoun}（${SESSION_LIST_TIME_FILTER_LABELS[query.timeFilter]}）`
          : `筛选${resultNoun}`}
        title={filterActive
          ? `时间：${SESSION_LIST_TIME_FILTER_LABELS[query.timeFilter]}`
          : `按时间筛选${resultNoun}`}
        aria-haspopup="menu"
        aria-expanded={openPanel === 'filter'}
        aria-controls={openPanel === 'filter' ? filterMenuId : undefined}
        data-query-active={filterActive || openPanel === 'filter' ? 'true' : undefined}
        onClick={() => setOpenPanel((current) => current === 'filter' ? null : 'filter')}
      />
      {queryActive ? (
        <IconButton
          className="workspace-navigator-group-query-action active"
          icon="close"
          iconSize="sm"
          label={`清除${resultNoun}搜索与筛选`}
          data-query-active="true"
          onClick={() => {
            onQueryChange(EMPTY_SESSION_LIST_QUERY)
            setOpenPanel(null)
          }}
        />
      ) : null}
      {openPanel !== null && position !== null
        ? createPortal(
            openPanel === 'search' ? (
              <div
                ref={popoverRef}
                id={searchMenuId}
                className="session-list-query-popover"
                role="dialog"
                aria-label={`搜索${resultNoun}`}
                data-placement={position.placement}
                style={position.style}
              >
                <input
                  ref={searchInputRef}
                  className="session-list-search-input"
                  type="search"
                  value={query.search}
                  placeholder={searchPlaceholder}
                  aria-label={searchPlaceholder}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => {
                    const search = event.currentTarget.value
                    onQueryChange({ ...query, search })
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter') return
                    event.preventDefault()
                    setOpenPanel(null)
                    searchTriggerRef.current?.focus()
                  }}
                />
              </div>
            ) : (
              <div
                ref={popoverRef}
                id={filterMenuId}
                className="session-list-query-popover"
                role="menu"
                aria-label={`${resultNoun}时间筛选`}
                data-placement={position.placement}
                style={position.style}
              >
                <div className="session-list-time-menu">
                  {SESSION_LIST_TIME_FILTERS.map((timeFilter) => (
                    <TimeFilterMenuItem
                      key={timeFilter}
                      timeFilter={timeFilter}
                      pressed={query.timeFilter === timeFilter}
                      onSelect={(next) => {
                        onQueryChange({ ...query, timeFilter: next })
                        setOpenPanel(null)
                        filterTriggerRef.current?.focus()
                      }}
                    />
                  ))}
                </div>
              </div>
            ),
            document.body
          )
        : null}
    </>
  )
}

function TimeFilterMenuItem({
  timeFilter,
  pressed,
  onSelect
}: {
  timeFilter: SessionListTimeFilter
  pressed: boolean
  onSelect: (timeFilter: SessionListTimeFilter) => void
}): React.JSX.Element {
  return (
    <button
      className="session-list-time-menu-item"
      type="button"
      role="menuitemradio"
      aria-checked={pressed}
      onClick={() => onSelect(timeFilter)}
    >
      <span className="session-list-time-menu-check" aria-hidden="true">
        {pressed ? '✓' : ''}
      </span>
      <span>{SESSION_LIST_TIME_FILTER_LABELS[timeFilter]}</span>
    </button>
  )
}
