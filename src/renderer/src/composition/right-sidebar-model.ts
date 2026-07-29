export const RIGHT_SIDEBAR_WIDTH_STORAGE_KEY = 'pi-workbench.right-sidebar-width'
export const RIGHT_SIDEBAR_MIN_WIDTH = 320
export const RIGHT_SIDEBAR_DEFAULT_WIDTH = 400
export const RIGHT_SIDEBAR_MAX_WIDTH = 520

const RIGHT_SIDEBAR_VIEWPORT_RESERVE = 800

export function rightSidebarWidthBounds(viewportWidth: number): {
  min: number
  max: number
} {
  return {
    min: RIGHT_SIDEBAR_MIN_WIDTH,
    max: Math.max(
      RIGHT_SIDEBAR_MIN_WIDTH,
      Math.min(RIGHT_SIDEBAR_MAX_WIDTH, Math.floor(viewportWidth - RIGHT_SIDEBAR_VIEWPORT_RESERVE))
    )
  }
}

export function clampRightSidebarWidth(width: number, viewportWidth: number): number {
  const bounds = rightSidebarWidthBounds(viewportWidth)
  const finiteWidth = Number.isFinite(width) ? width : RIGHT_SIDEBAR_DEFAULT_WIDTH
  return Math.max(bounds.min, Math.min(bounds.max, Math.round(finiteWidth)))
}

export function clampRightSidebarWidthPreference(width: number): number {
  const finiteWidth = Number.isFinite(width) ? width : RIGHT_SIDEBAR_DEFAULT_WIDTH
  return Math.max(
    RIGHT_SIDEBAR_MIN_WIDTH,
    Math.min(RIGHT_SIDEBAR_MAX_WIDTH, Math.round(finiteWidth))
  )
}

export function readRightSidebarWidthPreference(
  storage: Pick<Storage, 'getItem'>
): number {
  try {
    const stored = Number(storage.getItem(RIGHT_SIDEBAR_WIDTH_STORAGE_KEY))
    return clampRightSidebarWidthPreference(
      Number.isFinite(stored) && stored > 0 ? stored : RIGHT_SIDEBAR_DEFAULT_WIDTH
    )
  } catch {
    return RIGHT_SIDEBAR_DEFAULT_WIDTH
  }
}

export function writeRightSidebarWidthPreference(
  storage: Pick<Storage, 'setItem'>,
  width: number
): void {
  try {
    storage.setItem(
      RIGHT_SIDEBAR_WIDTH_STORAGE_KEY,
      String(clampRightSidebarWidthPreference(width))
    )
  } catch {
    // Persistence is optional; the in-memory resize remains authoritative for this mount.
  }
}

export function validateRightSidebarTabs(
  tabIds: readonly string[],
  activeTabId: string
): number {
  if (tabIds.length === 0) {
    throw new Error('RightSidebar requires at least one concrete tab.')
  }
  const seen = new Set<string>()
  for (const tabId of tabIds) {
    if (tabId.trim().length === 0) {
      throw new Error('RightSidebar tab IDs must be non-empty.')
    }
    if (seen.has(tabId)) {
      throw new Error(`RightSidebar tab IDs must be unique: ${JSON.stringify(tabId)}.`)
    }
    seen.add(tabId)
  }
  const activeTabIndex = tabIds.indexOf(activeTabId)
  if (activeTabIndex < 0) {
    throw new Error('RightSidebar requires a concrete active tab.')
  }
  return activeTabIndex
}

export function rightSidebarDomIds(
  componentId: string,
  tabIndex: number
): { tabId: string; panelId: string } {
  if (!Number.isSafeInteger(tabIndex) || tabIndex < 0) {
    throw new Error('RightSidebar tab index must be a non-negative safe integer.')
  }
  return {
    tabId: `right-sidebar-${componentId}-tab-${tabIndex}`,
    panelId: `right-sidebar-${componentId}-panel-${tabIndex}`
  }
}

export function rightSidebarTabIdFromKey(
  tabIds: readonly string[],
  currentIndex: number,
  key: string
): string | null {
  if (tabIds.length === 0) return null
  const nextIndex = key === 'ArrowLeft'
    ? (currentIndex - 1 + tabIds.length) % tabIds.length
    : key === 'ArrowRight'
      ? (currentIndex + 1) % tabIds.length
      : key === 'Home'
        ? 0
        : key === 'End'
          ? tabIds.length - 1
          : null
  return nextIndex === null ? null : tabIds[nextIndex] ?? null
}
