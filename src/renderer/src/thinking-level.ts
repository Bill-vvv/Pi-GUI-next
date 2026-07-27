import type { ThinkingLevel } from '../../shared/kernel-contract'

export const THINKING_LEVELS = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max'
] as const satisfies readonly ThinkingLevel[]

const LOCALIZED_THINKING_LEVEL_LABELS: Record<ThinkingLevel, string> = {
  off: '关闭',
  minimal: '最小',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '极高',
  max: '最高'
}

const TECHNICAL_THINKING_LEVEL_LABELS: Record<ThinkingLevel, string> = {
  off: 'Off',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra High',
  max: 'Max'
}

export function isThinkingLevel(value: string): value is ThinkingLevel {
  return (THINKING_LEVELS as readonly string[]).includes(value)
}

export function localizedThinkingLevelLabel(level: ThinkingLevel): string {
  return LOCALIZED_THINKING_LEVEL_LABELS[level]
}

export function technicalThinkingLevelLabel(level: ThinkingLevel): string {
  return TECHNICAL_THINKING_LEVEL_LABELS[level]
}
