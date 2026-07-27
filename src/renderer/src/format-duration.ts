export function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return '—'
  if (durationMs < 1_000) return `${durationMs}ms`
  if (durationMs >= 60_000) {
    const totalSeconds = Math.round(durationMs / 1_000)
    return `${Math.floor(totalSeconds / 60)}m ${totalSeconds % 60}s`
  }
  return `${(durationMs / 1_000).toFixed(durationMs < 10_000 ? 1 : 0)}s`
}
