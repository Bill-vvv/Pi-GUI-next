import type { ThinkingLevelMap } from '../../shared/kernel-contract.ts'
import {
  OPENAI_FAST_MODE_ENTRY_TYPE,
  parseOpenAiFastModeEntryData
} from '../../../extensions/pi-gui-openai-fast-mode/src/protocol.mjs'
import { isRecord } from '../utils/guards.ts'

/*
 * Pi Session data shapes and Main-side projections shared by the Kernel and the
 * Shared Pi Runtime. Moved unchanged from the retired external RPC client (D-098).
 */

const MAX_ENTRY_ID_LENGTH = 512
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u
/** Main-memory projection bounds for one get_tree response. */
export const PI_RPC_TREE_MAX_NODES = 10_000
export const PI_RPC_TREE_MAX_DEPTH = 2_048
export const PI_RPC_TREE_MAX_LABEL_CHARS = 4_096
export const PI_RPC_TREE_MAX_LABEL_TIMESTAMP_CHARS = 256
const ADVISOR_CAPABILITY_CUSTOM_TYPE = 'pi-gui.multi-advisor/capabilities'
const MAGIC_CONTEXT_CUSTOM_TYPE = 'ctx-status'
const MAX_MAGIC_CONTEXT_TITLE_CHARS = 256
const MAX_MAGIC_CONTEXT_TEXT_CHARS = 30_000
const EXTENSION_CAPABILITIES = [
  'event',
  'tool',
  'command',
  'flag',
  'shortcut',
  'message_renderer',
  'entry_renderer'
] as const

export type PiRpcModel = {
  id: string
  name?: string
  provider: string
  reasoning?: boolean
  thinkingLevelMap?: ThinkingLevelMap
  contextWindow?: number
  [key: string]: unknown
}

export type PiRpcModelCostTier = {
  inputTokensAbove: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export type PiRpcModelCost = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  tiers?: PiRpcModelCostTier[]
}

export type PiRpcAvailableModel = {
  id: string
  provider: string
  name?: string
  reasoning?: boolean
  thinkingLevelMap?: ThinkingLevelMap
  contextWindow?: number
  cost?: PiRpcModelCost
}

export type PiRpcSessionStats = {
  sessionFile?: string
  sessionId: string
  userMessages: number
  assistantMessages: number
  toolCalls: number
  toolResults: number
  totalMessages: number
  tokens: {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
    total: number
  }
  cost: number
  contextUsage?: {
    tokens: number | null
    contextWindow: number
    percent: number | null
  }
}

export type PiRpcSessionState = {
  sessionId?: string
  sessionFile?: string
  sessionName?: string
  model?: PiRpcModel | null
  thinkingLevel?: string
  isStreaming?: boolean
  isCompacting?: boolean
  messageCount?: number
  pendingMessageCount?: number
  sessionStats?: PiRpcSessionStats
  [key: string]: unknown
}

export type PiRpcSessionEntry = {
  id: string
  parentId: string | null
  type: string
  timestamp: string
  customType?:
    | typeof ADVISOR_CAPABILITY_CUSTOM_TYPE
    | typeof MAGIC_CONTEXT_CUSTOM_TYPE
    | typeof OPENAI_FAST_MODE_ENTRY_TYPE
  data?: unknown
  message?: {
    role: string
    content?: {
      text: string
      hasImage: boolean
    }
  }
}

export type PiRpcEntriesResult = {
  entries: PiRpcSessionEntry[]
  leafId: string | null
}

export type PiRpcTreeNode = {
  entry: PiRpcSessionEntry
  children: PiRpcTreeNode[]
  label?: string
  labelTimestamp?: string
}

export type PiRpcTreeResult = {
  tree: PiRpcTreeNode[]
  leafId: string | null
}

export type PiRpcNavigateTreeResult = {
  targetEntryId: string
  cancelled: boolean
  leafId: string | null
  editorText?: string
}

export type PiRpcExtensionEvent =
  | { type: 'extension_event'; channel: string; data: unknown }
  | {
      type: 'extension_event_diagnostic'
      reason: 'invalid_payload' | 'record_too_large' | 'queue_overflow'
    }

export type PiRpcForkResult = {
  text: string
  cancelled: boolean
}

export type PiRpcSlashCommand = {
  name: string
  description?: string
  source: 'extension' | 'prompt' | 'skill'
  sourceInfo: {
    source: string
    scope: 'user' | 'project' | 'temporary'
    origin: 'package' | 'top-level'
  }
}

export type PiRpcExtensionCapability = typeof EXTENSION_CAPABILITIES[number]

export type PiRpcLoadedExtension = {
  id: string
  capabilities: PiRpcExtensionCapability[]
}

export type PiRpcExtensionInventory = {
  protocolVersion: 1
  complete: boolean
  loading: 'eager_complete' | 'lazy_partial'
  extensions: PiRpcLoadedExtension[]
  loadErrorCount: number
}

export type PiRpcEvent = Record<string, unknown> & { type: string }

export function normalizePiRpcTreeResult(value: unknown): PiRpcTreeResult {
  try {
    if (
      !hasExactKeys(value, ['tree', 'leafId']) ||
      !Array.isArray(value.tree) ||
      !(value.leafId === null || typeof value.leafId === 'string')
    ) {
      throw new Error('invalid tree envelope')
    }

    const leafId = value.leafId === null
      ? null
      : validateIdentifier(value.leafId, 'Pi RPC tree leaf ID', MAX_ENTRY_ID_LENGTH)
    const tree: PiRpcTreeNode[] = []
    const ids = new Set<string>()
    const roots: PiRpcSessionEntry[] = []
    const stack: Array<{
      value: unknown
      parent: PiRpcTreeNode | null
      depth: number
    }> = []
    for (let index = value.tree.length - 1; index >= 0; index--) {
      stack.push({ value: value.tree[index], parent: null, depth: 1 })
    }

    let nodeCount = 0
    while (stack.length > 0) {
      const frame = stack.pop()!
      nodeCount += 1
      if (nodeCount > PI_RPC_TREE_MAX_NODES || frame.depth > PI_RPC_TREE_MAX_DEPTH) {
        throw new Error('tree bounds exceeded')
      }
      if (
        !isRecord(frame.value) ||
        !hasRequiredAndAllowedKeys(frame.value, ['entry', 'children'], [
          'entry',
          'children',
          'label',
          'labelTimestamp'
        ]) ||
        !Array.isArray(frame.value.children)
      ) {
        throw new Error('invalid tree node')
      }

      const normalizedEntry = projectPiRpcTreeEntry(frame.value.entry)
      validateIdentifier(normalizedEntry.id, 'Pi RPC tree entry ID', MAX_ENTRY_ID_LENGTH)
      if (normalizedEntry.parentId !== null) {
        validateIdentifier(normalizedEntry.parentId, 'Pi RPC tree parent ID', MAX_ENTRY_ID_LENGTH)
      }
      if (ids.has(normalizedEntry.id)) {
        throw new Error('duplicate tree entry ID')
      }
      ids.add(normalizedEntry.id)

      if (frame.parent === null) {
        roots.push(normalizedEntry)
      } else if (normalizedEntry.parentId !== frame.parent.entry.id) {
        throw new Error('inconsistent tree parent')
      }

      const label = normalizeOptionalBoundedString(
        frame.value.label,
        PI_RPC_TREE_MAX_LABEL_CHARS
      )
      const labelTimestamp = normalizeOptionalBoundedString(
        frame.value.labelTimestamp,
        PI_RPC_TREE_MAX_LABEL_TIMESTAMP_CHARS
      )
      const projected: PiRpcTreeNode = {
        entry: normalizedEntry,
        children: [],
        ...(label === undefined ? {} : { label }),
        ...(labelTimestamp === undefined ? {} : { labelTimestamp })
      }
      if (frame.parent === null) tree.push(projected)
      else frame.parent.children.push(projected)

      for (let index = frame.value.children.length - 1; index >= 0; index--) {
        stack.push({
          value: frame.value.children[index],
          parent: projected,
          depth: frame.depth + 1
        })
      }
    }

    for (const root of roots) {
      if (root.parentId === root.id || (root.parentId !== null && ids.has(root.parentId))) {
        throw new Error('cyclic or inconsistent root parent')
      }
    }
    if (leafId !== null && !ids.has(leafId)) {
      throw new Error('tree leaf is missing')
    }
    if (tree.length === 0 && leafId !== null) {
      throw new Error('empty tree has a leaf')
    }

    return { tree, leafId }
  } catch {
    throw new Error('Invalid Pi RPC get_tree response')
  }
}

function projectPiRpcTreeEntry(value: unknown): PiRpcSessionEntry {
  const entry = normalizePiRpcSessionEntry(value)
  if (
    (entry.customType === ADVISOR_CAPABILITY_CUSTOM_TYPE ||
      entry.customType === OPENAI_FAST_MODE_ENTRY_TYPE) &&
    'data' in entry
  ) {
    const { data: _privateInternalData, ...projected } = entry
    return projected
  }
  return entry
}

function validateIdentifier(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`)
  if (value.length === 0) throw new Error(`${label} must not be empty`)
  if (value.length > maxLength) throw new Error(`${label} exceeds maximum length of ${maxLength}`)
  if (value.trim() !== value || CONTROL_CHARACTER_PATTERN.test(value)) {
    throw new Error(`${label} is malformed`)
  }
  return value
}

function normalizeOptionalBoundedString(value: unknown, maxChars: number): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length > maxChars || value.includes('\0')) {
    throw new Error('invalid bounded string')
  }
  return value
}

function hasRequiredAndAllowedKeys(
  value: Record<string, unknown>,
  requiredKeys: readonly string[],
  allowedKeys: readonly string[]
): boolean {
  const actualKeys = Object.keys(value)
  return requiredKeys.every((key) => Object.hasOwn(value, key)) &&
    actualKeys.every((key) => allowedKeys.includes(key))
}

function hasExactKeys<T extends readonly string[]>(
  value: unknown,
  keys: T
): value is Record<T[number], unknown> {
  if (!isRecord(value)) return false
  const actualKeys = Object.keys(value)
  return actualKeys.length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}

export function normalizePiRpcSessionEntry(value: unknown): PiRpcSessionEntry {
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.id) ||
    !(value.parentId === null || typeof value.parentId === 'string') ||
    !isNonEmptyString(value.type) ||
    !isNonEmptyString(value.timestamp)
  ) {
    throw new Error('Invalid Pi RPC get_entries response')
  }

  const entry = {
    id: value.id,
    parentId: value.parentId,
    type: value.type,
    timestamp: value.timestamp
  }
  if (
    value.type === 'custom' &&
    (
      value.customType === ADVISOR_CAPABILITY_CUSTOM_TYPE ||
      value.customType === MAGIC_CONTEXT_CUSTOM_TYPE ||
      value.customType === OPENAI_FAST_MODE_ENTRY_TYPE
    )
  ) {
    return {
      ...entry,
      customType: value.customType,
      data: value.customType === MAGIC_CONTEXT_CUSTOM_TYPE
        ? normalizeMagicContextData(value.data)
        : value.customType === OPENAI_FAST_MODE_ENTRY_TYPE
          ? normalizeOpenAiFastModeEntryData(value.data)
          : value.data
    }
  }
  if (value.type !== 'message') {
    return entry
  }
  if (!isRecord(value.message) || !isNonEmptyString(value.message.role)) {
    throw new Error('Invalid Pi RPC get_entries response')
  }
  if (value.message.role !== 'user') {
    return { ...entry, message: { role: value.message.role } }
  }

  return {
    ...entry,
    message: {
      role: value.message.role,
      content: normalizeUserContent(value.message.content)
    }
  }
}

function normalizeOpenAiFastModeEntryData(value: unknown): { enabled: boolean } {
  const enabled = parseOpenAiFastModeEntryData(value)
  if (enabled === null) throw new Error('Invalid Pi RPC get_entries response')
  return { enabled }
}

function normalizeMagicContextData(value: unknown): unknown {
  if (!isRecord(value)) return undefined
  if (
    !isSafeMagicContextString(value.title, MAX_MAGIC_CONTEXT_TITLE_CHARS) ||
    !isSafeMagicContextString(value.text, MAX_MAGIC_CONTEXT_TEXT_CHARS)
  ) return undefined
  const level = value.level
  if (
    level !== undefined &&
    level !== 'info' &&
    level !== 'success' &&
    level !== 'warning' &&
    level !== 'error'
  ) return undefined
  return {
    title: value.title,
    text: value.text,
    ...(level === undefined ? {} : { level })
  }
}

function isSafeMagicContextString(value: unknown, maxChars: number): value is string {
  return typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= maxChars &&
    !value.includes('\0')
}

function normalizeUserContent(content: unknown): { text: string; hasImage: boolean } {
  if (typeof content === 'string') {
    return { text: content, hasImage: false }
  }
  if (!Array.isArray(content)) {
    throw new Error('Invalid Pi RPC get_entries response')
  }

  const text: string[] = []
  let hasImage = false
  for (const block of content) {
    if (!isRecord(block) || !isNonEmptyString(block.type)) {
      throw new Error('Invalid Pi RPC get_entries response')
    }
    if (block.type === 'text') {
      if (typeof block.text !== 'string') {
        throw new Error('Invalid Pi RPC get_entries response')
      }
      text.push(block.text)
    } else if (block.type === 'image') {
      if (!isNonEmptyString(block.mimeType) || !isNonEmptyString(block.data)) {
        throw new Error('Invalid Pi RPC get_entries response')
      }
      hasImage = true
    } else {
      throw new Error('Invalid Pi RPC get_entries response')
    }
  }
  return { text: text.join(''), hasImage }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}
