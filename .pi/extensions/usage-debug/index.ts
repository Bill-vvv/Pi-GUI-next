import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { StringEnum } from "@earendil-works/pi-ai"
import { mkdir, readFile, rename, rm, writeFile, appendFile, chmod } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Type } from "typebox"
import {
  addTokenUsage,
  compactStatus,
  countRecord,
  createUsageDebugState,
  formatSnapshot,
  isRecord,
  markRunStarted,
  normalizeTokenUsage,
  parsePersistedState,
  recordAdvisorUsageEvent,
  recordMagicContextUsageEvent,
  recordSubagentCompletionEvent,
  recordSubagentPayload,
  refreshAdvisorEnabled,
  sampleContextUsage,
  type UsageDebugState,
} from "./usage.ts"

const STATUS_KEY = "usage-debug"
const SUBAGENT_STARTED_EVENT = "subagent:async-started"
const SUBAGENT_COMPLETE_EVENTS = ["subagent:async-complete", "subagent:foreground-complete"] as const
const ADVISORY_TYPE = "pi-gui.multi-advisor/advisory"
const ADVISOR_USAGE_EVENT = "pi-gui.multi-advisor/usage"
const MAGIC_CONTEXT_USAGE_EVENT = "magic-context:subagent-usage"
const SUBAGENT_TOOL_NAMES = new Set(["subagent", "subagent_wait", "subagent_supervisor", "intercom"])
const ACTIONS = ["status", "reset", "path"] as const

type DebugAction = (typeof ACTIONS)[number]
type RuntimeFiles = { directory: string; statePath: string; logPath: string }

export default function usageDebugExtension(pi: ExtensionAPI) {
  let state = createUsageDebugState()
  let files: RuntimeFiles | null = null
  let currentContext: ExtensionContext | null = null
  let writeQueue = Promise.resolve()
  const toolStartedAt = new Map<string, number>()
  const magicToolNames = new Set<string>()
  const unsubscribers: Array<() => void> = []

  const isMagicTool = (toolName: string) => toolName.startsWith("ctx_") || magicToolNames.has(toolName)

  const updateUi = (ctx = currentContext) => {
    if (!ctx) return
    ctx.ui.setStatus(STATUS_KEY, compactStatus(state))
  }

  const enqueueWrite = (operation: () => Promise<void>) => {
    writeQueue = writeQueue
      .then(operation, operation)
      .catch((error) => {
        console.error("usage-debug persistence failed:", error instanceof Error ? error.message : String(error))
      })
    return writeQueue
  }

  const persist = (event: string, details: Record<string, unknown> = {}) => {
    if (!files) return Promise.resolve()
    state.updatedAt = Date.now()
    const snapshot = JSON.stringify(state, null, 2)
    const logLine = `${JSON.stringify({ at: state.updatedAt, event, ...details })}\n`
    const { statePath, logPath } = files
    return enqueueWrite(async () => {
      const temporaryPath = `${statePath}.${process.pid}.tmp`
      await writeFile(temporaryPath, snapshot, { encoding: "utf8", mode: 0o600 })
      await rename(temporaryPath, statePath)
      await appendFile(logPath, logLine, { encoding: "utf8", mode: 0o600 })
      await Promise.allSettled([chmod(statePath, 0o600), chmod(logPath, 0o600)])
    })
  }

  const observeContextUsage = (ctx: ExtensionContext) => {
    try {
      sampleContextUsage(state, ctx.getContextUsage?.())
    } catch {
      // Debugging must never affect the agent run.
    }
  }

  const showStatus = (ctx: ExtensionContext) => {
    refreshAdvisorEnabled(state, ctx.sessionManager.getEntries())
    observeContextUsage(ctx)
    const text = formatSnapshot(state, files?.logPath ?? "not initialized")
    ctx.ui.notify(text, "info")
    updateUi(ctx)
    return text
  }

  const reset = async (ctx: ExtensionContext) => {
    state = createUsageDebugState()
    refreshAdvisorEnabled(state, ctx.sessionManager.getEntries())
    observeContextUsage(ctx)
    if (files) {
      await enqueueWrite(async () => {
        await rm(files!.statePath, { force: true })
        await rm(files!.logPath, { force: true })
      })
    }
    await persist("reset")
    updateUi(ctx)
    return showStatus(ctx)
  }

  const runAction = async (action: string | undefined, ctx: ExtensionContext) => {
    const normalized = (action?.trim() || "status") as DebugAction
    if (!ACTIONS.includes(normalized)) {
      const message = "Usage: status | reset | path"
      ctx.ui.notify(message, "warning")
      return message
    }
    if (normalized === "reset") return reset(ctx)
    if (normalized === "path") {
      const path = files?.logPath ?? "Usage monitor has not received session_start yet."
      ctx.ui.notify(path, "info")
      return path
    }
    return showStatus(ctx)
  }

  pi.registerTool({
    name: "usage_debug",
    label: "Usage Debug",
    description: "Inspect or reset aggregate debug counters for parent, subagent, Advisor, and Magic Context usage. It never returns prompts or tool output.",
    parameters: Type.Object({
      action: Type.Optional(StringEnum(ACTIONS)),
    }, { additionalProperties: false }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const text = await runAction(params.action, ctx)
      return {
        content: [{ type: "text", text }],
        details: {
          state,
          logPath: files?.logPath ?? null,
          telemetry: {
            advisor: "pi-gui.multi-advisor/usage",
            magicContext: "magic-context:subagent-usage",
          },
        },
      }
    },
  })

  pi.registerCommand("usage-debug", {
    description: "Show/reset temporary aggregate usage telemetry: /usage-debug [status|reset|path]",
    getArgumentCompletions: (prefix) => ACTIONS
      .filter((action) => action.startsWith(prefix.trim()))
      .map((action) => ({ value: action, label: action })),
    handler: async (args, ctx) => {
      await runAction(args, ctx)
    },
  })

  pi.on("session_start", async (event, ctx) => {
    currentContext = ctx
    const sessionId = sanitizeSegment(ctx.sessionManager.getSessionId?.() ?? "ephemeral")
    const directory = join(tmpdir(), `pi-usage-debug-${process.getuid?.() ?? "user"}`)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await chmod(directory, 0o700).catch(() => undefined)
    files = {
      directory,
      statePath: join(directory, `${sessionId}.state.json`),
      logPath: join(directory, `${sessionId}.jsonl`),
    }
    state = await loadState(files.statePath)
    magicToolNames.clear()
    for (const tool of pi.getAllTools()) {
      const source = tool.sourceInfo?.source ?? ""
      if (source.includes("pi-magic-context")) magicToolNames.add(tool.name)
    }
    refreshAdvisorEnabled(state, ctx.sessionManager.getEntries())
    observeContextUsage(ctx)
    await persist("session_start", { reason: event.reason })
    updateUi(ctx)
  })

  pi.on("context", (_event, ctx) => {
    currentContext = ctx
    observeContextUsage(ctx)
    updateUi(ctx)
  })

  pi.on("message_end", (event, ctx) => {
    currentContext = ctx
    const message = event.message as unknown
    if (!isRecord(message)) return

    if (message.role === "assistant") {
      state.parentResponses += 1
      const usage = normalizeTokenUsage(message.usage)
      if (usage) {
        if (usage.turns === 0) usage.turns = 1
        addTokenUsage(state.parentUsage, usage)
      }
      observeContextUsage(ctx)
      void persist("parent_response", { metered: usage !== null })
      updateUi(ctx)
      return
    }

    if (message.role === "custom" && message.customType === ADVISORY_TYPE) {
      state.advisor.advisories += 1
      void persist("advisor_advisory")
      updateUi(ctx)
    }
  })

  pi.on("turn_end", (_event, ctx) => {
    currentContext = ctx
    refreshAdvisorEnabled(state, ctx.sessionManager.getEntries())
    if (state.advisor.enabled === true) state.advisor.reviewCycles += 1
    void persist("turn_end", { advisorEnabled: state.advisor.enabled })
    updateUi(ctx)
  })

  pi.on("tool_execution_start", (event, ctx) => {
    currentContext = ctx
    toolStartedAt.set(event.toolCallId, Date.now())
    if (SUBAGENT_TOOL_NAMES.has(event.toolName)) {
      countRecord(state.subagent.toolCalls, event.toolName)
      void persist("subagent_tool_start", { toolName: event.toolName })
    } else if (isMagicTool(event.toolName)) {
      countRecord(state.magicContext.toolCalls, event.toolName)
      void persist("magic_tool_start", { toolName: event.toolName })
    }
    updateUi(ctx)
  })

  pi.on("tool_execution_end", (event, ctx) => {
    currentContext = ctx
    const startedAt = toolStartedAt.get(event.toolCallId)
    toolStartedAt.delete(event.toolCallId)
    const durationMs = startedAt === undefined ? 0 : Math.max(0, Date.now() - startedAt)

    if (isMagicTool(event.toolName)) {
      state.magicContext.totalDurationMs += durationMs
      if (event.isError) state.magicContext.failures += 1
      observeContextUsage(ctx)
      void persist("magic_tool_end", { toolName: event.toolName, durationMs, failed: event.isError })
    }

    if (SUBAGENT_TOOL_NAMES.has(event.toolName) && isRecord(event.result)) {
      const details = event.result.details
      const fallbackId = `tool-${event.toolCallId}`
      const recorded = recordSubagentPayload(state, details, fallbackId)
      void persist("subagent_tool_end", {
        toolName: event.toolName,
        durationMs,
        failed: event.isError,
        completions: recorded.completions,
        metered: recorded.metered,
      })
    }
    updateUi(ctx)
  })

  unsubscribers.push(pi.events.on(SUBAGENT_STARTED_EVENT, (raw) => {
    if (!isRecord(raw)) return
    const runId = typeof raw.id === "string" ? raw.id : `async-${Date.now()}`
    markRunStarted(state, runId)
    void persist("subagent_async_started", { runId })
    updateUi()
  }))

  unsubscribers.push(pi.events.on(ADVISOR_USAGE_EVENT, (raw) => {
    if (!recordAdvisorUsageEvent(state, raw)) return
    const status = isRecord(raw) && typeof raw.status === "string" ? raw.status : "unknown"
    void persist("advisor_usage", { status })
    updateUi()
  }))

  unsubscribers.push(pi.events.on(MAGIC_CONTEXT_USAGE_EVENT, (raw) => {
    if (!recordMagicContextUsageEvent(state, raw)) return
    const status = isRecord(raw) && typeof raw.status === "string" ? raw.status : "unknown"
    const subagent = isRecord(raw) && typeof raw.subagent === "string" ? raw.subagent : "unknown"
    void persist("magic_context_usage", { status, subagent })
    updateUi()
  }))

  for (const eventName of SUBAGENT_COMPLETE_EVENTS) {
    unsubscribers.push(pi.events.on(eventName, (raw) => {
      recordSubagentCompletionEvent(state, raw, `${eventName}-${Date.now()}`)
      void persist(eventName.replaceAll(":", "_"))
      updateUi()
    }))
  }

  pi.on("session_shutdown", async (event, ctx) => {
    currentContext = ctx
    observeContextUsage(ctx)
    await persist("session_shutdown", { reason: event.reason })
    await writeQueue
    for (const unsubscribe of unsubscribers.splice(0)) {
      try {
        unsubscribe()
      } catch {
        // The shared event bus may already be gone.
      }
    }
    ctx.ui.setStatus(STATUS_KEY, undefined)
    currentContext = null
  })
}

async function loadState(path: string): Promise<UsageDebugState> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown
    return parsePersistedState(parsed) ?? createUsageDebugState()
  } catch {
    return createUsageDebugState()
  }
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120) || "ephemeral"
}
