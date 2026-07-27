export function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return '—'
  return `$${value.toFixed(value > 0 && value < 0.01 ? 4 : 2)}`
}
