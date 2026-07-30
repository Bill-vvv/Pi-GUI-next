import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode
} from 'react'

import { IconButton } from '../components/IconButton'
import {
  RIGHT_SIDEBAR_DEFAULT_WIDTH,
  clampRightSidebarWidth,
  readRightSidebarWidthPreference,
  rightSidebarDomIds,
  rightSidebarTabIdFromKey,
  rightSidebarWidthBounds,
  validateRightSidebarTabs,
  writeRightSidebarWidthPreference
} from './right-sidebar-model'

export const RIGHT_SIDEBAR_ID = 'workbench-right-sidebar'

const RIGHT_SIDEBAR_KEYBOARD_STEP = 16

type RightSidebarTab = {
  id: string
  label: string
  content: ReactNode
}

type PointerResize = {
  pointerId: number
  startX: number
  startRenderedWidth: number
  startPreferredWidth: number
  currentPreferredWidth: number
  changed: boolean
}

export function RightSidebar({
  tabs,
  activeTabId,
  onTabChange,
  onCollapse,
  onClose,
  onResizeCancelChange,
  focusActiveTabRequest = 0
}: {
  tabs: readonly RightSidebarTab[]
  activeTabId: string
  onTabChange: (tabId: string) => void
  onCollapse: () => void
  onClose: () => void
  onResizeCancelChange: (cancel: (() => void) | null) => void
  focusActiveTabRequest?: number
}): React.JSX.Element {
  const generatedId = useId()
  const componentId = generatedId.replace(/[^a-zA-Z0-9_-]/g, '') || 'root'
  const tabIds = tabs.map((tab) => tab.id)
  const activeTabIndex = validateRightSidebarTabs(tabIds, activeTabId)
  const domIds = tabs.map((_tab, index) => rightSidebarDomIds(componentId, index))
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])
  const separatorRef = useRef<HTMLDivElement>(null)
  const pointerResizeRef = useRef<PointerResize | null>(null)
  const [resizing, setResizing] = useState(false)
  const [viewportWidth, setViewportWidth] = useState(() =>
    typeof window === 'undefined' ? 1600 : window.innerWidth
  )
  const [preferredWidth, setPreferredWidth] = useState(() => {
    const storage = rightSidebarStorage()
    return storage === null
      ? RIGHT_SIDEBAR_DEFAULT_WIDTH
      : readRightSidebarWidthPreference(storage)
  })
  const bounds = rightSidebarWidthBounds(viewportWidth)
  const width = clampRightSidebarWidth(preferredWidth, viewportWidth)

  const persistPreferredWidth = (nextPreferredWidth: number): void => {
    const storage = rightSidebarStorage()
    if (storage !== null) writeRightSidebarWidthPreference(storage, nextPreferredWidth)
  }

  const finishPointerResize = (commit: boolean): void => {
    const separator = separatorRef.current
    const gesture = pointerResizeRef.current
    if (gesture === null) return
    try {
      if (commit) {
        if (gesture.changed) persistPreferredWidth(gesture.currentPreferredWidth)
      } else {
        setPreferredWidth(gesture.startPreferredWidth)
      }
    } finally {
      pointerResizeRef.current = null
      if (separator !== null) delete separator.dataset.rightSidebarResizing
      setResizing(false)
      onResizeCancelChange(null)
      try {
        if (separator?.hasPointerCapture(gesture.pointerId)) {
          separator.releasePointerCapture(gesture.pointerId)
        }
      } catch {
        // The gesture is already cleared even if the platform rejects a late release.
      }
    }
  }

  useEffect(() => {
    const handleResize = (): void => setViewportWidth(window.innerWidth)
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  useEffect(() => {
    if (focusActiveTabRequest > 0) tabRefs.current[activeTabIndex]?.focus()
  }, [activeTabIndex, focusActiveTabRequest])

  useEffect(() => () => {
    const separator = separatorRef.current
    const gesture = pointerResizeRef.current
    pointerResizeRef.current = null
    if (separator !== null) delete separator.dataset.rightSidebarResizing
    onResizeCancelChange(null)
    if (gesture === null) return
    try {
      if (separator?.hasPointerCapture(gesture.pointerId)) {
        separator.releasePointerCapture(gesture.pointerId)
      }
    } catch {
      // Unmount cleanup is complete even if pointer capture already disappeared.
    }
  }, [onResizeCancelChange])

  const selectTabFromKeyboard = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    index: number
  ): void => {
    const nextId = rightSidebarTabIdFromKey(tabIds, index, event.key)
    if (nextId === null) return
    event.preventDefault()
    const nextIndex = tabs.findIndex((tab) => tab.id === nextId)
    tabRefs.current[nextIndex]?.focus()
    if (nextId !== activeTabId) onTabChange(nextId)
  }

  const commitRenderedWidth = (nextWidth: number): void => {
    const nextPreferredWidth = clampRightSidebarWidth(nextWidth, viewportWidth)
    if (nextPreferredWidth === width) return
    setPreferredWidth(nextPreferredWidth)
    persistPreferredWidth(nextPreferredWidth)
  }

  const handleSeparatorKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape' && pointerResizeRef.current !== null) {
      event.preventDefault()
      event.stopPropagation()
      finishPointerResize(false)
      return
    }
    const nextWidth = event.key === 'ArrowLeft'
      ? width + RIGHT_SIDEBAR_KEYBOARD_STEP
      : event.key === 'ArrowRight'
        ? width - RIGHT_SIDEBAR_KEYBOARD_STEP
        : event.key === 'Home'
          ? bounds.min
          : event.key === 'End'
            ? bounds.max
            : null
    if (nextWidth === null) return
    event.preventDefault()
    event.stopPropagation()
    commitRenderedWidth(nextWidth)
  }

  const style = {
    '--right-sidebar-width': `${width}px`
  } as CSSProperties

  return (
    <aside
      className="workbench-right-sidebar"
      id={RIGHT_SIDEBAR_ID}
      aria-label="工作台右侧栏"
      style={style}
    >
      <div
        ref={separatorRef}
        className="right-sidebar-separator"
        role="separator"
        tabIndex={0}
        aria-label="调整右侧栏宽度"
        aria-orientation="vertical"
        aria-valuemin={bounds.min}
        aria-valuemax={bounds.max}
        aria-valuenow={width}
        aria-valuetext={`${width} 像素`}
        data-resizing={resizing ? 'true' : undefined}
        onKeyDown={handleSeparatorKeyDown}
        onPointerDown={(event: ReactPointerEvent<HTMLDivElement>) => {
          if (!event.isPrimary || event.button !== 0) return
          event.preventDefault()
          event.currentTarget.focus()
          event.currentTarget.setPointerCapture(event.pointerId)
          event.currentTarget.dataset.rightSidebarResizing = 'true'
          pointerResizeRef.current = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startRenderedWidth: width,
            startPreferredWidth: preferredWidth,
            currentPreferredWidth: preferredWidth,
            changed: false
          }
          onResizeCancelChange(() => finishPointerResize(false))
          setResizing(true)
        }}
        onPointerMove={(event) => {
          const gesture = pointerResizeRef.current
          if (gesture === null || gesture.pointerId !== event.pointerId) return
          const nextRenderedWidth = clampRightSidebarWidth(
            gesture.startRenderedWidth + gesture.startX - event.clientX,
            viewportWidth
          )
          gesture.changed = nextRenderedWidth !== gesture.startRenderedWidth
          gesture.currentPreferredWidth = gesture.changed
            ? nextRenderedWidth
            : gesture.startPreferredWidth
          setPreferredWidth(gesture.currentPreferredWidth)
        }}
        onPointerUp={(event) => {
          if (pointerResizeRef.current?.pointerId !== event.pointerId) return
          finishPointerResize(true)
        }}
        onPointerCancel={(event) => {
          if (pointerResizeRef.current?.pointerId !== event.pointerId) return
          finishPointerResize(false)
        }}
        onLostPointerCapture={(event) => {
          if (pointerResizeRef.current?.pointerId !== event.pointerId) return
          finishPointerResize(false)
        }}
      />

      <header className="right-sidebar-header">
        <IconButton
          className="right-sidebar-back"
          icon="arrow-left"
          label="返回对话"
          onClick={onCollapse}
        />
        <div className="right-sidebar-tabs" role="tablist" aria-label="右侧栏模块">
          {tabs.map((tab, index) => {
            const selected = index === activeTabIndex
            const ids = domIds[index]!
            return (
              <button
                ref={(element) => {
                  tabRefs.current[index] = element
                }}
                className="right-sidebar-tab"
                id={ids.tabId}
                key={tab.id}
                type="button"
                role="tab"
                aria-controls={ids.panelId}
                aria-selected={selected}
                tabIndex={selected ? 0 : -1}
                onKeyDown={(event) => selectTabFromKeyboard(event, index)}
                onClick={() => onTabChange(tab.id)}
              >
                {tab.label}
              </button>
            )
          })}
        </div>
        <div className="right-sidebar-actions">
          <IconButton
            className="right-sidebar-collapse"
            icon="right-sidebar-close"
            iconSize="lg"
            label="收起右侧栏"
            onClick={onCollapse}
          />
          <IconButton
            className="right-sidebar-close"
            icon="close"
            label="关闭右侧栏"
            onClick={onClose}
          />
        </div>
      </header>

      {tabs.map((tab, index) => {
        const selected = index === activeTabIndex
        const ids = domIds[index]!
        return (
          <div
            className="right-sidebar-panel"
            id={ids.panelId}
            key={tab.id}
            role="tabpanel"
            aria-labelledby={ids.tabId}
            hidden={!selected}
          >
            {selected ? tab.content : null}
          </div>
        )
      })}
    </aside>
  )
}

function rightSidebarStorage(): Storage | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage
  } catch {
    return null
  }
}
