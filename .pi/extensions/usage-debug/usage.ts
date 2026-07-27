export type TokenUsage = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  cost: number
  turns: number
}

export type ContextUsage = {
  tokens: number
  contextWindow: number
  percent: number
}

export type UsageDebugState = {
  version: 1
  startedAt: number
  updatedAt: number
  parentResponses: number
  parentUsage: TokenUsage
  subagent: {
    toolCalls: Record<string, number>
    runsStarted: number
    runsCompleted: number
    unmeteredCompletions: number
    activeRunIds: string[]
    seenRunIds: string[]
    seenCompletionIds: string[]
    seenUsageIds: string[]
    usage: TokenUsage
  }
  advisor: {
    enabled: boolean | null
    reviewCycles: number
    advisories: number
    reviewsCompleted: number
    reviewsFailed: number
    reviewsAborted: number
    reviewsSkipped: number
    seenUsageIds: string[]
    usage: TokenUsage
  }
  magicContext: {
    toolCalls: Record<string, number>
    failures: number
    totalDurationMs: number
    contextSamples: number
    lastContextUsage: ContextUsage | null
    maxContextPercent: number
    modelRuns: number
    modelFailures: number
    modelAborted: number
    seenUsageIds: string[]
    subagents: Record<string, number>
    modelUsage: TokenUsage
  }
}

export function emptyTokenUsage(): TokenUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 }
}

export function createUsageDebugState(now = Date.now()): UsageDebugState {
  return {
    version: 1,
    startedAt: now,
    updatedAt: now,
    parentResponses: 0,
    parentUsage: emptyTokenUsage(),
    subagent: {
      toolCalls: {},
      runsStarted: 0,
      runsCompleted: 0,
      unmeteredCompletions: 0,
      activeRunIds: [],
      seenRunIds: [],
      seenCompletionIds: [],
      seenUsageIds: [],
      usage: emptyTokenUsage(),
    },
    advisor: {
      enabled: null,
      reviewCycles: 0,
      advisories: 0,
      reviewsCompleted: 0,
      reviewsFailed: 0,
      reviewsAborted: 0,
      reviewsSkipped: 0,
      seenUsageIds: [],
      usage: emptyTokenUsage(),
    },
    magicContext: {
      toolCalls: {},
      failures: 0,
      totalDurationMs: 0,
      contextSamples: 0,
      lastContextUsage: null,
      maxContextPercent: 0,
      modelRuns: 0,
      modelFailures: 0,
      modelAborted: 0,
      seenUsageIds: [],
      subagents: {},
      modelUsage: emptyTokenUsage(),
    },
  }
}

export function normalizeTokenUsage(value: unknown): TokenUsage | null {
  if (!isRecord(value)) return null
  const costValue = isRecord(value.cost) ? finiteNumber(value.cost.total) : finiteNumber(value.cost)
  const usage = {
    input: finiteNumber(value.input) ?? finiteNumber(value.inputTokens) ?? 0,
    output: finiteNumber(value.output) ?? finiteNumber(value.outputTokens) ?? 0,
    cacheRead: finiteNumber(value.cacheRead) ?? 0,
    cacheWrite: finiteNumber(value.cacheWrite) ?? 0,
    cost: costValue ?? 0,
    turns: finiteNumber(value.turns) ?? 0,
  }
  return Object.values(usage).some((item) => item !== 0) ? usage : null
}

export function addTokenUsage(target: TokenUsage, addition: TokenUsage): void {
  target.input += addition.input
  target.output += addition.output
  target.cacheRead += addition.cacheRead
  target.cacheWrite += addition.cacheWrite
  target.cost += addition.cost
  target.turns += addition.turns
}

export function countRecord(record: Record<string, number>, key: string): void {
  record[key] = (record[key] ?? 0) + 1
}

export function sampleContextUsage(state: UsageDebugState, value: unknown): void {
  if (!isRecord(value)) return
  const tokens = finiteNumber(value.tokens)
  const contextWindow = finiteNumber(value.contextWindow)
  const directPercent = finiteNumber(value.percent)
  if (tokens === undefined || contextWindow === undefined || contextWindow <= 0) return
  const percent = directPercent ?? (tokens / contextWindow) * 100
  state.magicContext.contextSamples += 1
  state.magicContext.lastContextUsage = { tokens, contextWindow, percent }
  state.magicContext.maxContextPercent = Math.max(state.magicContext.maxContextPercent, percent)
}

export function recordSubagentPayload(
  state: UsageDebugState,
  raw: unknown,
  fallbackId: string,
): { completions: number; metered: number } {
  if (!isRecord(raw)) return { completions: 0, metered: 0 }
  const runId = safeId(raw.runId) ?? safeId(raw.asyncId) ?? fallbackId
  markRunStarted(state, runId)
  const results = Array.isArray(raw.results) ? raw.results : []
  let completions = 0
  let metered = 0

  for (const [index, result] of results.entries()) {
    if (!isRecord(result)) continue
    const agent = safeId(result.agent) ?? `child-${index}`
    const completionId = `${runId}:${index}:${agent}`
    if (!state.subagent.seenCompletionIds.includes(completionId)) {
      state.subagent.seenCompletionIds.push(completionId)
      state.subagent.runsCompleted += 1
      completions += 1
    }
    const usage = normalizeTokenUsage(result.usage)
    if (usage && !state.subagent.seenUsageIds.includes(completionId)) {
      state.subagent.seenUsageIds.push(completionId)
      addTokenUsage(state.subagent.usage, usage)
      metered += 1
    }
  }

  if (results.length === 0) {
    const usage = normalizeTokenUsage(raw.totalChildUsage)
    const usageId = `${runId}:aggregate`
    if (usage && !state.subagent.seenUsageIds.includes(usageId)) {
      state.subagent.seenUsageIds.push(usageId)
      addTokenUsage(state.subagent.usage, usage)
      metered += 1
    }
  }

  if (completions > 0 || raw.state === "complete" || raw.state === "completed" || raw.state === "failed") {
    removeActiveRun(state, runId)
  }
  return { completions, metered }
}

export function recordSubagentCompletionEvent(
  state: UsageDebugState,
  raw: unknown,
  fallbackId: string,
): void {
  if (!isRecord(raw)) return
  const runId = safeId(raw.runId) ?? safeId(raw.id) ?? fallbackId
  markRunStarted(state, runId)
  const results = Array.isArray(raw.results) ? raw.results : []
  const beforeUsageIds = state.subagent.seenUsageIds.length
  recordSubagentPayload(state, raw, runId)

  if (results.length === 0) {
    const completionId = safeId(raw.id) ?? `${runId}:event`
    if (!state.subagent.seenCompletionIds.includes(completionId)) {
      state.subagent.seenCompletionIds.push(completionId)
      state.subagent.runsCompleted += 1
      if (state.subagent.seenUsageIds.length === beforeUsageIds) {
        state.subagent.unmeteredCompletions += 1
      }
    }
  }
  removeActiveRun(state, runId)
}

export function markRunStarted(state: UsageDebugState, runId: string): void {
  if (!state.subagent.seenRunIds.includes(runId)) {
    state.subagent.seenRunIds.push(runId)
    state.subagent.runsStarted += 1
  }
  if (!state.subagent.activeRunIds.includes(runId)) state.subagent.activeRunIds.push(runId)
}

export function refreshAdvisorEnabled(state: UsageDebugState, entries: unknown): void {
  if (!Array.isArray(entries)) return
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== "pi-gui.multi-advisor/capabilities") continue
    if (!isRecord(entry.data) || entry.data.identity !== "pi-gui-multi-advisor" || typeof entry.data.enabled !== "boolean") continue
    state.advisor.enabled = entry.data.enabled
    return
  }
}

export function recordAdvisorUsageEvent(state: UsageDebugState, raw: unknown): boolean {
  if (!isRecord(raw) || raw.protocolVersion !== 2 || raw.identity !== "pi-gui-multi-advisor") return false
  const advisorSlug = safeId(raw.advisorSlug)
  const startedAt = finiteNumber(raw.startedAt)
  const status = safeId(raw.status)
  if (!advisorSlug || startedAt === undefined || !status) return false
  if (!["completed", "failed", "aborted", "skipped"].includes(status)) return false
  const usageId = `${advisorSlug}:${startedAt}`
  if (state.advisor.seenUsageIds.includes(usageId)) return false
  state.advisor.seenUsageIds.push(usageId)

  if (status === "completed") state.advisor.reviewsCompleted += 1
  else if (status === "failed") state.advisor.reviewsFailed += 1
  else if (status === "aborted") state.advisor.reviewsAborted += 1
  else state.advisor.reviewsSkipped += 1

  const usage = normalizeTokenUsage(raw.usage)
  if (usage) addTokenUsage(state.advisor.usage, usage)
  return true
}

export function recordMagicContextUsageEvent(state: UsageDebugState, raw: unknown): boolean {
  if (!isRecord(raw) || raw.version !== 1 || raw.identity !== "@cortexkit/pi-magic-context") return false
  const sessionId = safeId(raw.sessionId)
  const subagent = safeId(raw.subagent)
  const startedAt = finiteNumber(raw.startedAt)
  const status = safeId(raw.status)
  if (!sessionId || !subagent || startedAt === undefined || !status) return false
  const invocation = finiteNumber(raw.invocationId)
  if (!["completed", "failed", "aborted"].includes(status)) return false
  const usageId = invocation === undefined
    ? `${sessionId}:${subagent}:${startedAt}`
    : `${sessionId}:invocation:${invocation}`
  if (state.magicContext.seenUsageIds.includes(usageId)) return false
  state.magicContext.seenUsageIds.push(usageId)
  state.magicContext.modelRuns += 1
  countRecord(state.magicContext.subagents, subagent)
  if (status === "failed") state.magicContext.modelFailures += 1
  else if (status === "aborted") state.magicContext.modelAborted += 1

  const usage = normalizeTokenUsage(raw.usage)
  if (usage) addTokenUsage(state.magicContext.modelUsage, usage)
  return true
}

export function formatSnapshot(state: UsageDebugState, logPath: string, now = Date.now()): string {
  const parent = formatUsage(state.parentUsage)
  const child = formatUsage(state.subagent.usage)
  const advisorUsage = formatUsage(state.advisor.usage)
  const magicModelUsage = formatUsage(state.magicContext.modelUsage)
  const context = state.magicContext.lastContextUsage
  const contextText = context
    ? `${formatCount(context.tokens)} / ${formatCount(context.contextWindow)} (${context.percent.toFixed(1)}%, max ${state.magicContext.maxContextPercent.toFixed(1)}%)`
    : "not sampled"
  const magicCalls = formatCounts(state.magicContext.toolCalls)
  const advisorEnabled = state.advisor.enabled === null ? "unknown" : state.advisor.enabled ? "on" : "off"
  const elapsed = formatDuration(Math.max(0, now - state.startedAt))

  return [
    `Usage Debug · ${elapsed}`,
    `Parent: ${state.parentResponses} responses · ${parent}`,
    `Subagents: calls ${formatCounts(state.subagent.toolCalls) || "none"} · ${state.subagent.runsStarted} launch(es) · ${state.subagent.runsCompleted} child completion(s) · ${state.subagent.activeRunIds.length} active · ${child}`,
    `Subagent coverage: ${state.subagent.unmeteredCompletions} completion(s) had no exposed usage payload`,
    `Advisor: ${advisorEnabled} · ${state.advisor.reviewCycles} enabled turn cycle(s) · ${state.advisor.reviewsCompleted} completed / ${state.advisor.reviewsFailed} failed / ${state.advisor.reviewsAborted} aborted / ${state.advisor.reviewsSkipped} skipped · ${state.advisor.advisories} advisory message(s) · ${advisorUsage}`,
    `Magic Context: ${contextText} · tools ${magicCalls || "none"} · ${state.magicContext.failures} tool failure(s) · ${formatDuration(state.magicContext.totalDurationMs)} tool time · model runs ${formatCounts(state.magicContext.subagents) || "none"} (${state.magicContext.modelFailures} failed, ${state.magicContext.modelAborted} aborted) · ${magicModelUsage}`,
    `Aggregate-only log: ${logPath}`,
  ].join("\n")
}

export function compactStatus(state: UsageDebugState): string {
  const context = state.magicContext.lastContextUsage
  const pct = context ? `${context.percent.toFixed(0)}%` : "?"
  const totalChildTokens = state.subagent.usage.input + state.subagent.usage.output
  return `dbg · ctx ${pct} · sub ${state.subagent.activeRunIds.length}/${state.subagent.runsCompleted} · ${formatCount(totalChildTokens)} tok · adv ${state.advisor.advisories}`
}

export function parsePersistedState(value: unknown): UsageDebugState | null {
  if (!isRecord(value) || value.version !== 1) return null
  const fresh = createUsageDebugState()
  try {
    return {
      ...fresh,
      ...value,
      parentUsage: { ...fresh.parentUsage, ...(isRecord(value.parentUsage) ? value.parentUsage : {}) },
      subagent: {
        ...fresh.subagent,
        ...(isRecord(value.subagent) ? value.subagent : {}),
        usage: {
          ...fresh.subagent.usage,
          ...(isRecord(value.subagent) && isRecord(value.subagent.usage) ? value.subagent.usage : {}),
        },
      },
      advisor: {
        ...fresh.advisor,
        ...(isRecord(value.advisor) ? value.advisor : {}),
        usage: {
          ...fresh.advisor.usage,
          ...(isRecord(value.advisor) && isRecord(value.advisor.usage) ? value.advisor.usage : {}),
        },
      },
      magicContext: {
        ...fresh.magicContext,
        ...(isRecord(value.magicContext) ? value.magicContext : {}),
        modelUsage: {
          ...fresh.magicContext.modelUsage,
          ...(isRecord(value.magicContext) && isRecord(value.magicContext.modelUsage) ? value.magicContext.modelUsage : {}),
        },
      },
    } as UsageDebugState
  } catch {
    return null
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function removeActiveRun(state: UsageDebugState, runId: string): void {
  state.subagent.activeRunIds = state.subagent.activeRunIds.filter((item) => item !== runId)
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function safeId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim().slice(0, 160) : undefined
}

function formatUsage(usage: TokenUsage): string {
  const tokens = `${formatCount(usage.input)} in / ${formatCount(usage.output)} out`
  const cache = usage.cacheRead || usage.cacheWrite
    ? ` · cache ${formatCount(usage.cacheRead)} read / ${formatCount(usage.cacheWrite)} write`
    : ""
  const cost = usage.cost ? ` · $${usage.cost.toFixed(4)}` : " · cost n/a or zero"
  return `${tokens}${cache}${cost}`
}

function formatCounts(values: Record<string, number>): string {
  return Object.entries(values)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join(", ")
}

function formatCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}m`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return Math.round(value).toString()
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1_000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}
