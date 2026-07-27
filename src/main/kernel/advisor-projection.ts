import type { KernelAdvisorState } from '../../shared/kernel-contract.ts'
import { isRecord } from '../utils/guards.ts'

const CAPABILITY_TYPE = 'pi-gui.multi-advisor/capabilities'
const INCOMPATIBLE_ERROR = 'Advisor extension capabilities are incompatible.'
const MAX_VERSION_CHARS = 256
const CAPABILITY_KEYS = [
  'protocolVersion',
  'identity',
  'version',
  'enabled',
  'multiAdvisor',
  'liveToggle',
  'roster',
  'status',
  'usage',
  'dump',
  'subagents',
  'severities',
  'deliveries',
  'readOnlyTools',
  'optionalTools'
] as const

export const UNAVAILABLE_ADVISOR_STATE: KernelAdvisorState = {
  compatibility: 'unavailable',
  extensionVersion: null,
  systemEnabled: null,
  liveToggle: false,
  multiAdvisor: false,
  roster: false,
  error: null
}

export function projectAdvisorState(entries: readonly unknown[]): KernelAdvisorState {
  const capabilityEntries = entries.filter((entry) =>
    isRecord(entry) &&
    entry.type === 'custom' &&
    entry.customType === CAPABILITY_TYPE
  )
  if (capabilityEntries.length === 0) return { ...UNAVAILABLE_ADVISOR_STATE }

  const latest = capabilityEntries.at(-1)
  const data = isRecord(latest) ? latest.data : undefined
  if (!isAdvisorCapabilities(data)) {
    return {
      compatibility: 'incompatible',
      extensionVersion: null,
      systemEnabled: null,
      liveToggle: false,
      multiAdvisor: false,
      roster: false,
      error: INCOMPATIBLE_ERROR
    }
  }

  return {
    compatibility: 'ready',
    extensionVersion: data.version,
    systemEnabled: data.enabled,
    liveToggle: true,
    multiAdvisor: true,
    roster: true,
    error: null
  }
}

function isAdvisorCapabilities(value: unknown): value is Record<string, unknown> & {
  version: string
  enabled: boolean
} {
  if (!isRecord(value) || !hasExactKeys(value, CAPABILITY_KEYS)) return false
  return value.protocolVersion === 2 &&
    value.identity === 'pi-gui-multi-advisor' &&
    isBoundedNonEmptyString(value.version, MAX_VERSION_CHARS) &&
    typeof value.enabled === 'boolean' &&
    value.multiAdvisor === true &&
    value.liveToggle === true &&
    value.roster === true &&
    value.status === true &&
    typeof value.usage === 'boolean' &&
    value.dump === false &&
    value.subagents === false &&
    isExactStringArray(value.severities, ['nit', 'concern', 'blocker']) &&
    isExactStringArray(value.deliveries, ['aside', 'steer']) &&
    isExactStringArray(value.readOnlyTools, ['read', 'grep', 'find', 'ls']) &&
    isExactStringArray(value.optionalTools, ['edit', 'write'])
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[]
): boolean {
  const keys = Object.keys(value)
  return keys.length === expected.length && expected.every((key) => keys.includes(key))
}

function isExactStringArray(value: unknown, expected: readonly string[]): boolean {
  return Array.isArray(value) &&
    value.length === expected.length &&
    value.every((item, index) => item === expected[index])
}

function isBoundedNonEmptyString(value: unknown, maxChars: number): value is string {
  return typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= maxChars &&
    !value.includes('\0')
}
