export const COLLAPSED_SESSION_LIMIT = 5
export const SESSION_EXPANSION_STEP = 5

export function resolveVisibleSessionCount(
  totalSessionCount: number,
  requestedVisibleSessionCount?: number
): number {
  return Math.min(
    totalSessionCount,
    Math.max(COLLAPSED_SESSION_LIMIT, requestedVisibleSessionCount ?? COLLAPSED_SESSION_LIMIT)
  )
}

export function nextVisibleSessionCount(
  totalSessionCount: number,
  requestedVisibleSessionCount?: number
): number {
  return Math.min(
    totalSessionCount,
    resolveVisibleSessionCount(totalSessionCount, requestedVisibleSessionCount) +
      SESSION_EXPANSION_STEP
  )
}

export function selectVisibleSessions<T extends { key: string }>(
  sessions: readonly T[],
  visibleSessionCount: number,
  retainedSessionKeys: ReadonlySet<string>
): T[] {
  return sessions.filter((session, index) =>
    index < visibleSessionCount || retainedSessionKeys.has(session.key)
  )
}

export function nextVisibleSessionCountWithRetained<T extends { key: string }>(
  sessions: readonly T[],
  requestedVisibleSessionCount: number | undefined,
  retainedSessionKeys: ReadonlySet<string>
): number {
  let nextCount = resolveVisibleSessionCount(sessions.length, requestedVisibleSessionCount)
  let newlyVisibleCount = 0
  while (nextCount < sessions.length && newlyVisibleCount < SESSION_EXPANSION_STEP) {
    const session = sessions[nextCount]
    nextCount += 1
    if (session !== undefined && !retainedSessionKeys.has(session.key)) {
      newlyVisibleCount += 1
    }
  }
  return nextCount
}
