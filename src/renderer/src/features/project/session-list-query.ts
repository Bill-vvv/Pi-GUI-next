export type SessionListTimeFilter = 'all' | 'today' | 'week' | 'older'

export type SessionListQueryItem = {
  key: string
  title: string
  lastActivityAt: number | null
}

export type SessionListQuery = {
  search: string
  timeFilter: SessionListTimeFilter
}

export const SESSION_LIST_TIME_FILTERS: readonly SessionListTimeFilter[] = [
  'all',
  'today',
  'week',
  'older'
]

export const SESSION_LIST_TIME_FILTER_LABELS: Record<SessionListTimeFilter, string> = {
  all: '全部',
  today: '今天',
  week: '本周',
  older: '更早'
}

/** Default and incremental reveal size for ordinary Session summaries. */
export const SESSION_LIST_REVEAL_STEP = 6

export function normalizeSessionListSearch(search: string): string {
  return search.trim().toLocaleLowerCase()
}

export function sessionListTimeBounds(now: number): {
  dayStart: number
  weekStart: number
} {
  const date = new Date(now)
  const dayStart = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
  const weekStart = dayStart - ((date.getDay() + 6) % 7) * 86_400_000
  return { dayStart, weekStart }
}

export function matchesSessionListTimeFilter(
  lastActivityAt: number | null,
  timeFilter: SessionListTimeFilter,
  now: number
): boolean {
  if (timeFilter === 'all') return true
  if (lastActivityAt === null || !Number.isFinite(lastActivityAt)) return timeFilter === 'older'

  const { dayStart, weekStart } = sessionListTimeBounds(now)
  if (timeFilter === 'today') return lastActivityAt >= dayStart
  if (timeFilter === 'week') return lastActivityAt >= weekStart
  return lastActivityAt < weekStart
}

export function matchesSessionListSearch(title: string, normalizedSearch: string): boolean {
  if (normalizedSearch.length === 0) return true
  return title.toLocaleLowerCase().includes(normalizedSearch)
}

/**
 * Filter the same ordered list by search ∩ time.
 * Retained keys that fail the filter stay visible at the front so the active/busy row never vanishes.
 */
export function filterSessionListItems<T extends SessionListQueryItem>(
  items: readonly T[],
  query: SessionListQuery,
  now: number,
  retainedKeys: ReadonlySet<string> = new Set()
): T[] {
  const normalizedSearch = normalizeSessionListSearch(query.search)
  const matched: T[] = []
  const retainedMisses: T[] = []

  for (const item of items) {
    const matches =
      matchesSessionListSearch(item.title, normalizedSearch) &&
      matchesSessionListTimeFilter(item.lastActivityAt, query.timeFilter, now)
    if (matches) {
      matched.push(item)
      continue
    }
    if (retainedKeys.has(item.key)) retainedMisses.push(item)
  }

  if (retainedMisses.length === 0) return matched
  return [...retainedMisses, ...matched]
}

export function selectRevealedSessionListItems<T extends { key: string }>(
  items: readonly T[],
  revealedItemCount: number,
  retainedKeys: ReadonlySet<string> = new Set()
): T[] {
  const revealLimit = Math.max(0, revealedItemCount)
  let revealedOrdinaryItemCount = 0

  return items.filter((item) => {
    if (retainedKeys.has(item.key)) return true
    if (revealedOrdinaryItemCount >= revealLimit) return false
    revealedOrdinaryItemCount += 1
    return true
  })
}

export function countRevealableSessionListItems<T extends { key: string }>(
  items: readonly T[],
  retainedKeys: ReadonlySet<string> = new Set()
): number {
  return items.reduce(
    (count, item) => count + (retainedKeys.has(item.key) ? 0 : 1),
    0
  )
}

export function sessionListQueryActive(query: SessionListQuery): boolean {
  return sessionListSearchActive(query) || sessionListTimeFilterActive(query)
}

export function sessionListSearchActive(query: SessionListQuery): boolean {
  return normalizeSessionListSearch(query.search).length > 0
}

export function sessionListTimeFilterActive(query: SessionListQuery): boolean {
  return query.timeFilter !== 'all'
}

export const EMPTY_SESSION_LIST_QUERY: SessionListQuery = {
  search: '',
  timeFilter: 'all'
}
