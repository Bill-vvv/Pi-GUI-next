import type {
  KernelConversationEntry,
  KernelMessageEntry,
  KernelThinkingEntry,
  KernelToolEntry
} from '../../../../shared/kernel-contract'
import { subagentCoordinationToolPresentation } from './subagent-coordination-presentation.ts'

export type CommentaryEntry = KernelMessageEntry & {
  role: 'assistant'
  phase: 'commentary'
}

export type ProcessEntry = KernelThinkingEntry | KernelToolEntry | CommentaryEntry

export type ProcessSequenceItem =
  | { type: 'entry'; entry: KernelToolEntry | CommentaryEntry }
  | { type: 'thinking-group'; entries: KernelThinkingEntry[] }

export type StandardProcessItem = ProcessSequenceItem |
  { type: 'tool-group'; entries: KernelToolEntry[] }

export type StandardToolSummaryPart = {
  action: string
  detail: string
  detailKind: 'code' | 'meta'
}

type ToolFileOperation = 'read' | 'modify'

export type ToolFileInfo = {
  operation: ToolFileOperation
  path: string
  detail: string | null
}

type ToolFileReference = ToolFileInfo & {
  entry: KernelToolEntry
}

export function groupAdjacentThinking(
  entries: readonly ProcessEntry[]
): ProcessSequenceItem[] {
  const items: ProcessSequenceItem[] = []
  let thinkingEntries: KernelThinkingEntry[] = []
  const flushThinking = (): void => {
    if (thinkingEntries.length === 0) return
    items.push({ type: 'thinking-group', entries: thinkingEntries })
    thinkingEntries = []
  }

  for (const entry of entries) {
    if (entry.kind === 'thinking') {
      thinkingEntries.push(entry)
      continue
    }
    flushThinking()
    items.push({ type: 'entry', entry })
  }
  flushThinking()
  return items
}

export function standardProcessItems(
  entries: readonly ProcessEntry[],
  hiddenEntryIds?: ReadonlySet<string>
): StandardProcessItem[] {
  const items: StandardProcessItem[] = []
  let groupedThinking: KernelThinkingEntry[] = []
  let groupedTools: KernelToolEntry[] = []
  const flushThinking = (): void => {
    if (groupedThinking.length === 0) return
    items.push({ type: 'thinking-group', entries: groupedThinking })
    groupedThinking = []
  }
  const flushTools = (): void => {
    if (groupedTools.length === 0) return
    items.push({ type: 'tool-group', entries: groupedTools })
    groupedTools = []
  }

  for (const entry of entries) {
    if (hiddenEntryIds?.has(entry.id)) {
      if (entry.kind !== 'thinking') {
        flushThinking()
        flushTools()
      }
      continue
    }
    if (entry.kind === 'thinking') {
      flushTools()
      groupedThinking.push(entry)
      continue
    }
    flushThinking()
    if (isStandardToolGroupEntry(entry)) {
      groupedTools.push(entry)
      continue
    }
    flushTools()
    items.push({ type: 'entry', entry })
  }
  flushThinking()
  flushTools()
  return items
}

export function isStandardToolGroupEntry(entry: ProcessEntry): entry is KernelToolEntry {
  return entry.kind === 'tool' &&
    entry.ask === undefined &&
    entry.subagent === null &&
    subagentCoordinationToolPresentation(entry) === null
}

export function latestThinkingSummaryLabel(
  entries: readonly KernelConversationEntry[]
): string | null {
  for (let entryIndex = entries.length - 1; entryIndex >= 0; entryIndex -= 1) {
    const entry = entries[entryIndex]
    if (entry?.kind !== 'thinking') continue
    const label = thinkingSummaryEntryLabel(entry)
    if (label !== null) return label
  }
  return null
}

export function thinkingSummaryEntryLabel(entry: KernelThinkingEntry): string | null {
  const lines = entry.text.split(/\r?\n/u)
  if (entry.summary) {
    for (let lineIndex = lines.length - 1; lineIndex >= 0; lineIndex -= 1) {
      const label = thinkingSummaryLineLabel(lines[lineIndex] ?? '')
      if (label !== null) return label
    }
    return null
  }
  if (!entry.streaming) return null

  let latestLabel: string | null = null
  for (const line of lines) {
    if (line.trim().length === 0) continue
    const label = streamingThinkingSummaryLineLabel(line)
    if (label === null) return null
    latestLabel = label
  }
  return latestLabel
}

function thinkingSummaryLineLabel(line: string): string | null {
  let label = normalizedThinkingSummaryLine(line)
  if (label === null) return null
  for (const wrapper of [
    /^(\*\*)(.+)\1$/u,
    /^(__)(.+)\1$/u,
    /^(\*)(.+)\1$/u,
    /^(_)(.+)\1$/u,
    /^(`)(.+)\1$/u
  ]) {
    const match = wrapper.exec(label)
    if (match?.[2] !== undefined) {
      label = match[2].trim()
      break
    }
  }
  return label.length === 0 ? null : label
}

function streamingThinkingSummaryLineLabel(line: string): string | null {
  const label = normalizedThinkingSummaryLine(line)
  if (label === null) return null
  for (const wrapper of ['**', '__', '*', '_', '`'] as const) {
    if (!label.startsWith(wrapper)) continue
    const content = label.endsWith(wrapper) && label.length > wrapper.length * 2
      ? label.slice(wrapper.length, -wrapper.length)
      : label.slice(wrapper.length)
    return content.trim() || null
  }
  return null
}

function normalizedThinkingSummaryLine(line: string): string | null {
  const label = line.trim()
    .replace(/^#{1,6}\s+/u, '')
    .replace(/^[-+]\s+/u, '')
    .trim()
  return label.length === 0 ? null : label
}

export function thinkingGroupDetailText(
  entries: readonly KernelThinkingEntry[],
  excludedActiveLabel: string | null
): string {
  const blocks = entries.map((entry) => entry.text)
  if (excludedActiveLabel !== null) {
    removeActiveLabel: for (
      let entryIndex = entries.length - 1;
      entryIndex >= 0;
      entryIndex -= 1
    ) {
      const entry = entries[entryIndex]
      if (entry === undefined || thinkingSummaryEntryLabel(entry) !== excludedActiveLabel) continue
      const lines = blocks[entryIndex]!.split(/\r?\n/u)
      for (let lineIndex = lines.length - 1; lineIndex >= 0; lineIndex -= 1) {
        if (thinkingSummaryLineLabel(lines[lineIndex] ?? '') !== excludedActiveLabel) continue
        lines.splice(lineIndex, 1)
        blocks[entryIndex] = lines.join('\n')
        break removeActiveLabel
      }
    }
  }
  return blocks
    .map(trimThinkingBlock)
    .filter((block) => block.length > 0)
    .join('\n\n')
}

function trimThinkingBlock(text: string): string {
  const lines = text.split(/\r?\n/u)
  while (lines[0]?.trim().length === 0) lines.shift()
  while (lines.at(-1)?.trim().length === 0) lines.pop()
  return lines.join('\n')
}

export function thinkingGroupElapsedMs(
  entries: readonly KernelThinkingEntry[],
  thinkingElapsedByEntryId: ReadonlyMap<string, number>
): number | null {
  let longest = 0
  for (const entry of entries) {
    const elapsed = thinkingElapsedByEntryId.get(entry.id)
    if (elapsed === undefined) return null
    longest = Math.max(longest, elapsed)
  }
  return longest
}

export function summarizeTools(tools: KernelToolEntry[]): string {
  const files = uniqueToolFiles(tools)
  const readCount = files.filter((file) => file.operation === 'read').length
  const modifiedCount = files.filter((file) => file.operation === 'modify').length
  const fileToolIds = new Set(
    tools.filter((entry) => toolFileInfo(entry) !== null).map((entry) => entry.id)
  )
  const commandCount = tools.filter(
    (entry) => !fileToolIds.has(entry.id) && compactToolName(entry.name) === 'bash'
  ).length
  const coordinationTools = tools.filter((entry) =>
    !fileToolIds.has(entry.id) && subagentCoordinationToolPresentation(entry) !== null
  )
  const coordinationIds = new Set(coordinationTools.map((entry) => entry.id))
  const otherToolCount = tools.filter((entry) =>
    !fileToolIds.has(entry.id) &&
    compactToolName(entry.name) !== 'bash' &&
    !coordinationIds.has(entry.id)
  ).length
  const coordinationLabel = coordinationTools.length === 1
    ? subagentCoordinationToolPresentation(coordinationTools[0]!)?.groupLabel ?? null
    : coordinationTools.length > 1 ? `处理 ${coordinationTools.length} 次 Subagent 协作` : null
  return [
    readCount > 0 ? `读取 ${readCount} 个文件` : null,
    modifiedCount > 0 ? `修改 ${modifiedCount} 个文件` : null,
    commandCount > 0 ? `运行 ${commandCount} 条命令` : null,
    coordinationLabel,
    otherToolCount > 0 ? `调用 ${otherToolCount} 个工具` : null
  ].filter((part): part is string => part !== null).join('，') || '处理工具调用'
}

export function standardToolSummaryParts(tools: KernelToolEntry[]): StandardToolSummaryPart[] {
  const files = uniqueToolFiles(tools)
  const readFiles = files.filter((file) => file.operation === 'read')
  const modifiedFiles = files.filter((file) => file.operation === 'modify')
  const fileToolIds = new Set(
    tools.filter((entry) => toolFileInfo(entry) !== null).map((entry) => entry.id)
  )
  const commandTools = tools.filter(
    (entry) => !fileToolIds.has(entry.id) && compactToolName(entry.name) === 'bash'
  )
  const otherTools = tools.filter(
    (entry) => !fileToolIds.has(entry.id) && compactToolName(entry.name) !== 'bash'
  )
  const activeTool = tools.findLast(
    (entry) => entry.status === 'pending' || entry.status === 'running'
  )
  const activeFile = activeTool === undefined ? null : toolFileInfo(activeTool)
  const activeKind = activeFile?.operation ?? (
    activeTool === undefined
      ? null
      : compactToolName(activeTool.name) === 'bash' ? 'command' : 'other'
  )
  const parts: StandardToolSummaryPart[] = []

  if (readFiles.length > 0) {
    parts.push({
      action: activeKind === 'read' ? '正在读取' : '读取',
      ...standardFileSummary(readFiles)
    })
  }
  if (modifiedFiles.length > 0) {
    parts.push({
      action: activeKind === 'modify' ? '正在修改' : '修改',
      ...standardFileSummary(modifiedFiles)
    })
  }
  if (commandTools.length > 0) {
    parts.push({
      action: activeKind === 'command' ? '正在运行' : '运行',
      detail: `${commandTools.length} 条命令`,
      detailKind: 'meta'
    })
  }
  if (otherTools.length > 0) {
    parts.push({
      action: activeKind === 'other' ? '正在调用' : '调用',
      detail: `${otherTools.length} 个工具`,
      detailKind: 'meta'
    })
  }
  return parts.length > 0
    ? parts
    : [{
        action: activeTool === undefined ? '处理' : '正在处理',
        detail: '工具调用',
        detailKind: 'meta'
      }]
}

function standardFileSummary(
  files: ToolFileReference[]
): Pick<StandardToolSummaryPart, 'detail' | 'detailKind'> {
  const basenames = files.map((file) => fileBasename(file.path))
  return files.length <= 2 && new Set(basenames).size === basenames.length
    ? { detail: basenames.join('、'), detailKind: 'code' }
    : { detail: `${files.length} 个文件`, detailKind: 'meta' }
}

function uniqueToolFiles(tools: KernelToolEntry[]): ToolFileReference[] {
  const files = new Map<string, ToolFileReference>()
  for (const entry of tools) {
    const file = toolFileInfo(entry)
    if (file === null) continue
    files.set(`${file.operation}:${file.path}`, { ...file, entry })
  }
  return [...files.values()]
}

export function toolFileInfo(entry: KernelToolEntry): ToolFileInfo | null {
  const name = compactToolName(entry.name)
  const args = parseToolArgs(entry.args)
  if (args === null) return null
  const path = stringArgument(args, ['path', 'file_path'])
  if (path === null) return null

  if (name === 'read' || name === 'read_file') {
    const offset = numericArgument(args.offset)
    const limit = numericArgument(args.limit)
    const start = offset ?? 1
    const detail = offset === null && limit === null
      ? null
      : limit === null ? `从第 ${start} 行开始` : `第 ${start}–${start + limit - 1} 行`
    return { operation: 'read', path, detail }
  }

  if (name === 'edit' || name === 'write' || name === 'write_file' || name === 'apply_patch') {
    let detail: string | null = null
    if (name === 'edit' && Array.isArray(args.edits)) detail = `${args.edits.length} 处修改`
    if ((name === 'write' || name === 'write_file') && typeof args.content === 'string') {
      detail = `${lineCount(args.content)} 行内容`
    }
    return { operation: 'modify', path, detail }
  }

  return null
}

export function parseToolArgs(value: string): Record<string, unknown> | null {
  if (value.trim().length === 0) return null
  try {
    const parsed: unknown = JSON.parse(value)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

export function stringArgument(args: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    if (typeof args[key] === 'string' && args[key].trim().length > 0) return args[key]
  }
  return null
}

function numericArgument(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

export function compactToolName(name: string): string {
  const normalized = name.trim().toLowerCase()
  return normalized.split(/[.:/]/u).at(-1) || normalized || 'tool'
}

export function fileBasename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts.at(-1) ?? path
}

function lineCount(value: string): number {
  if (value.length === 0) return 0
  return value.split('\n').length
}
