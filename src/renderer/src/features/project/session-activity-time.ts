const MIN_SESSION_ACTIVITY_TIMESTAMP = Date.UTC(2000, 0, 1)

export function formatSessionActivityAge(timestamp: number | null, now: number): string | null {
  if (
    timestamp === null ||
    !Number.isFinite(timestamp) ||
    timestamp < MIN_SESSION_ACTIVITY_TIMESTAMP
  ) {
    return null
  }

  const elapsedMinutes = Math.max(0, Math.floor((now - timestamp) / 60_000))
  if (elapsedMinutes < 1) return '刚刚'
  if (elapsedMinutes < 60) return `${elapsedMinutes} 分钟`
  const elapsedHours = Math.floor(elapsedMinutes / 60)
  if (elapsedHours < 24) return `${elapsedHours} 小时`
  return `${Math.floor(elapsedHours / 24)} 天`
}
