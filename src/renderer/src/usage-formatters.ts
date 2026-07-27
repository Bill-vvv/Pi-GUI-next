import type { AppearanceSettings } from '../../shared/kernel-contract'

export function normalizeContextPercent(value: number | null): number | null {
  if (value === null || !Number.isFinite(value) || value < 0) return null
  return Math.min(100, value)
}

export function formatTokenCount(
  value: number | null,
  format: AppearanceSettings['tokenCountFormat'] = 'full'
): string {
  if (value === null || !Number.isSafeInteger(value) || value < 0) return '—'
  if (format === 'full' || value < 1_000) return value.toLocaleString()

  const units = [
    { divisor: 1_000, suffix: 'k' },
    { divisor: 1_000_000, suffix: 'm' },
    { divisor: 1_000_000_000, suffix: 'b' }
  ] as const
  let unitIndex = value >= units[2].divisor ? 2 : value >= units[1].divisor ? 1 : 0

  while (true) {
    const unit = units[unitIndex]
    const scaled = value / unit.divisor
    const fractionDigits = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2
    const rounded = Number(scaled.toFixed(fractionDigits))
    if (rounded >= 1_000 && unitIndex < units.length - 1) {
      unitIndex += 1
      continue
    }
    return `${rounded}${unit.suffix}`
  }
}

export function formatPercent(value: number | null): string {
  const normalized = normalizeContextPercent(value)
  return normalized === null ? '—' : `${normalized.toFixed(1)}%`
}
