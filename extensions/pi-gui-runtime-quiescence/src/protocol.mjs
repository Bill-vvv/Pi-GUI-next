/**
 * Shared quiescence QUERY protocol constants and pure helpers.
 * Loaded by the Pi extension (in-process) and by GUI Main tests/host code.
 */

export const QUIESCENCE_PROTOCOL_VERSION = 1
export const QUIESCENCE_COMMAND_NAME = 'pi-gui-runtime-quiescence'
export const QUIESCENCE_STATUS_KEY = 'pi-gui.runtime-quiescence'
export const QUIESCENCE_RESULT_KIND = 'pi-gui.runtime-quiescence/query-result'

/** In-repo / external extensions answer provider queries on the Pi event bus. */
export const PROVIDER_QUERY_EVENT = 'pi-gui.runtime-quiescence/provider-query/v1'
export const PROVIDER_REPLY_EVENT_PREFIX = 'pi-gui.runtime-quiescence/provider-reply/v1:'
/** Providers declare themselves so QUERY can snapshot an expected roster. */
export const PROVIDER_REGISTER_EVENT = 'pi-gui.runtime-quiescence/provider-register/v1'

export const SUBAGENT_RPC_PROTOCOL_VERSION = 1
export const SUBAGENT_RPC_REQUEST_EVENT = 'subagents:rpc:v1:request'
export const SUBAGENT_RPC_REPLY_EVENT_PREFIX = 'subagents:rpc:v1:reply:'

/**
 * Exact idle fleet status text from pi-subagents inspectSubagentFleet.
 * Drift from this string is treated as unknown/blocking.
 */
export const SUBAGENT_FLEET_IDLE_TEXT =
  'No active subagent fleet. Background runs that already finished are available through completion notifications or subagent({ action: "status", id: "..." }).'

/** Busy fleet header produced by pi-subagents. Number must be >= 1. */
export const SUBAGENT_FLEET_BUSY_PATTERN = /^Subagent fleet: ([1-9]\d*) tracked(?:\n|$)/u
/** Current default status result when RPC drops `view: fleet`; insufficient for quiescence. */
export const SUBAGENT_ASYNC_ONLY_IDLE_TEXT = 'No active async runs.'
/** Exact spawn-budget prefix added by current pi-subagents management responses. */
export const SUBAGENT_SPAWN_BUDGET_PATTERN =
  /^Spawn budget: (?:unlimited|\d+\/\d+ used, \d+ remaining \(configured \d+; granted \d+; grant allowance \d+\))$/u

export const SUBAGENT_TOOL_NAMES = Object.freeze([
  'subagent',
  'subagent_wait',
  'intercom',
  'subagent_supervisor'
])

/** Known Magic Context tools. Name-only matches are ambiguous until source metadata confirms. */
export const MAGIC_CONTEXT_TOOL_NAMES = Object.freeze([
  'ctx_memory',
  'ctx_search',
  'ctx_expand',
  'ctx_note',
  'ctx_reduce',
  'todowrite'
])

/**
 * Known Magic Context package/source markers (ToolInfo.sourceInfo.source).
 * Prefer these over bare tool-name fallback.
 */
export const MAGIC_CONTEXT_SOURCE_MARKERS = Object.freeze([
  '@cortexkit/pi-magic-context',
  'pi-magic-context',
  'magic-context'
])

export const PROVIDER_ID_SUBAGENTS = 'pi-subagents'
export const PROVIDER_ID_MAGIC_CONTEXT = 'magic-context'
export const PROVIDER_ID_MULTI_ADVISOR = 'pi-gui-multi-advisor'

/** Explicit blocking sentinels when foundational discovery surfaces fail. */
export const SENTINEL_ID_TOOL_DISCOVERY = 'tool-discovery'
export const SENTINEL_ID_COMMAND_DISCOVERY = 'command-discovery'
export const SENTINEL_ID_EVENT_BUS = 'event-bus'
/** One generic blocker for any discoverable non-builtin extension surface that is not a known/adopted provider. */
export const SENTINEL_ID_UNREGISTERED_EXTENSION = 'unregistered-extension'

/** Pi built-in tool source tokens that never require a quiescence provider. */
export const BUILTIN_TOOL_SOURCE_TOKENS = Object.freeze(['builtin'])

/** Source/path markers for the app-owned internal quiescence extension (never a blocker). */
export const INTERNAL_QUIESCENCE_SOURCE_MARKERS = Object.freeze([
  'pi-gui-runtime-quiescence',
  QUIESCENCE_COMMAND_NAME
])

/** Source/path markers for known pi-subagents package identity. */
export const SUBAGENT_SOURCE_MARKERS = Object.freeze(['pi-subagents'])

/** Source/path markers for in-repo Multi Advisor package identity. */
export const MULTI_ADVISOR_SOURCE_MARKERS = Object.freeze(['pi-gui-multi-advisor'])

export const DEFAULT_SUBAGENT_RPC_TIMEOUT_MS = 1_500
export const DEFAULT_PROVIDER_COLLECT_MS = 75
export const DEFAULT_QUIESCENCE_QUERY_TIMEOUT_MS = 3_000
export const DEFAULT_HIBERNATE_LEASE_TIMEOUT_MS = 8_000
export const DEFAULT_PROVIDER_PREPARE_TIMEOUT_MS = 4_000

/**
 * Generation-fenced hibernate lease protocol (safe automatic path).
 * QUERY remains observability-only and never authorizes stop.
 */
export const LEASE_PROTOCOL_VERSION = 1
export const LEASE_COMMAND_NAME = 'pi-gui-runtime-hibernate-lease'
export const LEASE_STATUS_KEY = 'pi-gui.runtime-hibernate-lease'
export const LEASE_RESULT_KIND = 'pi-gui.runtime-hibernate-lease/result'
export const PROVIDER_LEASE_PREPARE_EVENT =
  'pi-gui.runtime-hibernate-lease/provider-prepare/v1'
export const PROVIDER_LEASE_COMMIT_EVENT =
  'pi-gui.runtime-hibernate-lease/provider-commit/v1'
export const PROVIDER_LEASE_RELEASE_EVENT =
  'pi-gui.runtime-hibernate-lease/provider-release/v1'
export const PROVIDER_LEASE_REPLY_EVENT_PREFIX =
  'pi-gui.runtime-hibernate-lease/provider-reply/v1:'

/** Exact idle schedule-list text from pi-subagents 0.37.0. */
export const SUBAGENT_SCHEDULE_IDLE_TEXT = 'No scheduled subagent runs for this session.'

/**
 * Exact source markers that require a registered prepare/commit/release provider.
 * These packages have background work that is NOT fully awaited by Pi core idle:
 * task-notify (async notify after settle), ask (active execute), MCP (health/
 * reconnect/OAuth), CPA responses WS (sockets/timers). Classification never
 * serializes filesystem paths. Until a provider registers and prepares, inventory
 * fail-closes automatic hibernation.
 */
export const REQUIRED_PROVIDER_EXTENSION_MARKERS = Object.freeze([
  { marker: 'pi-gui-task-notify', providerId: 'pi-gui-task-notify' },
  { marker: 'pi-gui-ask', providerId: 'pi-gui-ask' },
  { marker: 'pi-mcp-adapter', providerId: 'pi-mcp-adapter' },
  { marker: 'pi-cpa-responses-ws', providerId: 'pi-cpa-responses-ws' }
])

/** Supported Pi coding-agent version for the private ExtensionRunner inventory bridge. */
export const SUPPORTED_PI_CODING_AGENT_VERSION = '0.80.10'

/** Non-enumerable context accessors installed by the private runner bridge. */
export const EXTENSION_INVENTORY_ACCESSOR = Symbol.for(
  'pi-gui.runtime-hibernate-lease/extension-inventory/v1'
)
export const EXTENSION_TOOL_INVOKE_ACCESSOR = Symbol.for(
  'pi-gui.runtime-hibernate-lease/tool-invoke-v1'
)

/** Exact bounded schema limits (inclusive). */
export const MIN_NONCE_LENGTH = 1
export const MAX_NONCE_LENGTH = 128
export const MIN_REQUEST_ID_LENGTH = 1
export const MAX_REQUEST_ID_LENGTH = 160
export const MIN_PROVIDER_ID_LENGTH = 1
export const MAX_PROVIDER_ID_LENGTH = 64
export const PROVIDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/u
export const RPC_ERROR_CODE_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/u
export const MAX_REASON_LENGTH = 256
export const MAX_PROVIDER_COUNT = 32
export const MAX_STATUS_TEXT_LENGTH = 16_384
export const MIN_TIMEOUT_MS = 1
export const MAX_TIMEOUT_MS = 60_000
export const MIN_SESSION_ID_LENGTH = 1
export const MAX_SESSION_ID_LENGTH = 256
export const MIN_ATTEMPT_ID_LENGTH = 1
export const MAX_ATTEMPT_ID_LENGTH = 128
export const MIN_LEASE_TOKEN_LENGTH = 8
export const MAX_LEASE_TOKEN_LENGTH = 128
export const MAX_INVENTORY_FINGERPRINT_LENGTH = 256
export const MAX_LEASE_BLOCKER_COUNT = 32
export const LEASE_TOKEN_PATTERN = /^[A-Za-z0-9._:-]+$/u
export const ATTEMPT_ID_PATTERN = /^[A-Za-z0-9._:-]+$/u
export const SESSION_ID_PATTERN = /^[A-Za-z0-9._:@/-]+$/u

/**
 * Strip the exact management-response budget line while rejecting malformed
 * lookalikes. Responses without a budget prefix remain compatible.
 *
 * @param {string} text
 * @returns {string | null}
 */
export function stripSubagentSpawnBudgetPrefix(text) {
  if (!text.startsWith('Spawn budget:')) return text
  const newline = text.indexOf('\n')
  if (newline < 0) return null
  const prefix = text.slice(0, newline)
  if (!SUBAGENT_SPAWN_BUDGET_PATTERN.test(prefix)) return null
  return text.slice(newline + 1)
}

/**
 * @param {string | undefined} text
 * @returns {{ state: 'idle' | 'busy' | 'unknown', reason?: string }}
 */
export function parseSubagentFleetStatusText(text) {
  if (typeof text !== 'string') {
    return { state: 'unknown', reason: 'missing-text' }
  }
  if (text.length === 0 || text.length > MAX_STATUS_TEXT_LENGTH) {
    return { state: 'unknown', reason: 'status-length' }
  }
  const normalized = stripSubagentSpawnBudgetPrefix(text)
  if (normalized === null) {
    return { state: 'unknown', reason: 'invalid-spawn-budget-prefix' }
  }
  if (normalized === SUBAGENT_ASYNC_ONLY_IDLE_TEXT) {
    return { state: 'unknown', reason: 'fleet-view-unsupported' }
  }
  if (normalized === SUBAGENT_FLEET_IDLE_TEXT) {
    return { state: 'idle' }
  }
  const busy = SUBAGENT_FLEET_BUSY_PATTERN.exec(normalized)
  if (busy !== null) {
    // Count digits may be huge within MAX_STATUS_TEXT_LENGTH; never exceed reason bounds.
    return { state: 'busy', reason: boundReason(`fleet-tracked:${busy[1]}`) }
  }
  return { state: 'unknown', reason: 'unrecognized-status-text' }
}

/**
 * @param {unknown} reply
 * @param {string} requestId
 * @returns {{ state: 'idle' | 'busy' | 'unknown', reason?: string }}
 */
export function parseSubagentRpcStatusReply(reply, requestId) {
  if (!isPlainObject(reply)) {
    return { state: 'unknown', reason: 'malformed-reply' }
  }
  if (hasUnknownKeys(reply, ['version', 'requestId', 'method', 'success', 'data', 'error'])) {
    return { state: 'unknown', reason: 'unknown-properties' }
  }
  if (reply.version !== SUBAGENT_RPC_PROTOCOL_VERSION) {
    return { state: 'unknown', reason: 'unsupported-version' }
  }
  if (reply.requestId !== requestId) {
    return { state: 'unknown', reason: 'request-id-mismatch' }
  }
  if (reply.method !== undefined && reply.method !== 'status') {
    return { state: 'unknown', reason: 'unexpected-method' }
  }
  if (reply.success === false) {
    if (reply.data !== undefined) {
      return { state: 'unknown', reason: 'malformed-reply' }
    }
    const rawCode = isPlainObject(reply.error) ? reply.error.code : undefined
    const code = typeof rawCode === 'string' && RPC_ERROR_CODE_PATTERN.test(rawCode)
      ? rawCode
      : 'invalid-code'
    return { state: 'unknown', reason: `rpc-error:${code}` }
  }
  if (reply.success !== true) {
    return { state: 'unknown', reason: 'malformed-reply' }
  }
  if (reply.error !== undefined) {
    return { state: 'unknown', reason: 'malformed-reply' }
  }
  const data = reply.data
  if (!isPlainObject(data) || typeof data.text !== 'string') {
    return { state: 'unknown', reason: 'missing-text' }
  }
  return parseSubagentFleetStatusText(data.text)
}

/**
 * @param {unknown} tools
 *   Either tool name strings or ToolInfo-like objects with optional sourceInfo.source/path.
 * @returns {{
 *   ok: true,
 *   subagentLoaded: boolean,
 *   magicContextLoaded: boolean,
 *   magicContextTools: string[],
 *   magicContextDetection: 'none' | 'source' | 'name-fallback-ambiguous',
 *   magicContextSource?: string,
 *   unregisteredToolSources: number,
 *   unregisteredNameOnlyTools: number
 * } | {
 *   ok: false,
 *   reason: string
 * }}
 */
export function detectLoadedToolSets(tools) {
  const normalized = normalizeDiscoveredToolEntries(tools)
  if (!normalized.ok) return normalized
  return classifyToolEntries(normalized.entries)
}

/**
 * Normalize getAllTools()-like input into bounded name/source/path entries.
 * @param {unknown} tools
 */
export function normalizeDiscoveredToolEntries(tools) {
  if (!Array.isArray(tools)) {
    return { ok: false, reason: 'tool-discovery-invalid' }
  }

  /** @type {{ name: string, source?: string, path?: string }[]} */
  const entries = []
  for (const tool of tools) {
    if (typeof tool === 'string') {
      if (tool.length === 0) continue
      entries.push({ name: tool })
      continue
    }
    if (!isPlainObject(tool) || typeof tool.name !== 'string' || tool.name.length === 0) {
      return { ok: false, reason: 'tool-discovery-invalid' }
    }
    /** @type {{ name: string, source?: string, path?: string }} */
    const entry = { name: tool.name }
    if (tool.sourceInfo !== undefined) {
      if (!isPlainObject(tool.sourceInfo)) {
        return { ok: false, reason: 'tool-discovery-invalid' }
      }
      if (typeof tool.sourceInfo.source === 'string' && tool.sourceInfo.source.length > 0) {
        entry.source = tool.sourceInfo.source
      }
      if (typeof tool.sourceInfo.path === 'string' && tool.sourceInfo.path.length > 0) {
        entry.path = tool.sourceInfo.path
      }
    }
    entries.push(entry)
  }
  return { ok: true, entries }
}

/**
 * Normalize getCommands()-like input into bounded command entries.
 * @param {unknown} commands
 */
export function normalizeDiscoveredCommandEntries(commands) {
  if (!Array.isArray(commands)) {
    return { ok: false, reason: 'command-discovery-invalid' }
  }

  /** @type {{ name: string, commandSource?: string, source?: string, path?: string }[]} */
  const entries = []
  for (const command of commands) {
    if (!isPlainObject(command) || typeof command.name !== 'string' || command.name.length === 0) {
      return { ok: false, reason: 'command-discovery-invalid' }
    }
    /** @type {{ name: string, commandSource?: string, source?: string, path?: string }} */
    const entry = { name: command.name }
    if (command.source !== undefined) {
      if (typeof command.source !== 'string' || command.source.length === 0) {
        return { ok: false, reason: 'command-discovery-invalid' }
      }
      entry.commandSource = command.source
    }
    if (command.sourceInfo !== undefined) {
      if (!isPlainObject(command.sourceInfo)) {
        return { ok: false, reason: 'command-discovery-invalid' }
      }
      if (typeof command.sourceInfo.source === 'string' && command.sourceInfo.source.length > 0) {
        entry.source = command.sourceInfo.source
      }
      if (typeof command.sourceInfo.path === 'string' && command.sourceInfo.path.length > 0) {
        entry.path = command.sourceInfo.path
      }
    }
    entries.push(entry)
  }
  return { ok: true, entries }
}

/**
 * Classify tool entries into known providers and a single generic unregistered bucket.
 * Arbitrary source/tool names never become provider ids.
 *
 * @param {readonly { name: string, source?: string, path?: string }[]} entries
 * @param {ReadonlySet<string>} [registeredProviderIds]
 */
export function classifyToolEntries(entries, registeredProviderIds = new Set()) {
  const names = new Set(entries.map((entry) => entry.name))
  const subagentByName = SUBAGENT_TOOL_NAMES.some((name) => names.has(name))
  const subagentBySource = entries.some((entry) =>
    matchesKnownSourceMarkers(entry.source, entry.path, SUBAGENT_SOURCE_MARKERS)
  )
  const subagentLoaded = subagentByName || subagentBySource

  const sourceMatched = entries.find((entry) => isMagicContextSource(entry.source, entry.path))
  /** @type {'none' | 'source' | 'name-fallback-ambiguous'} */
  let magicContextDetection = 'none'
  /** @type {string[]} */
  let magicContextTools = []
  /** @type {string | undefined} */
  let magicContextSource
  if (sourceMatched !== undefined) {
    magicContextDetection = 'source'
    magicContextSource = redactSourceForReason(
      sourceMatched.source,
      sourceMatched.path,
      MAGIC_CONTEXT_SOURCE_MARKERS
    )
    magicContextTools = [
      ...new Set(
        entries
          .filter(
            (entry) =>
              isMagicContextSource(entry.source, entry.path) ||
              MAGIC_CONTEXT_TOOL_NAMES.includes(entry.name)
          )
          .map((entry) => entry.name)
      )
    ]
  } else {
    magicContextTools = MAGIC_CONTEXT_TOOL_NAMES.filter((name) => names.has(name))
    if (magicContextTools.length > 0) {
      magicContextDetection = 'name-fallback-ambiguous'
    }
  }

  let unregisteredToolSources = 0
  let unregisteredNameOnlyTools = 0
  for (const entry of entries) {
    if (isBuiltinToolSource(entry.source)) continue
    if (matchesKnownSourceMarkers(entry.source, entry.path, INTERNAL_QUIESCENCE_SOURCE_MARKERS)) continue
    if (matchesKnownSourceMarkers(entry.source, entry.path, SUBAGENT_SOURCE_MARKERS)) continue
    if (SUBAGENT_TOOL_NAMES.includes(entry.name)) continue
    if (isMagicContextSource(entry.source, entry.path)) continue
    if (MAGIC_CONTEXT_TOOL_NAMES.includes(entry.name)) continue
    if (matchesKnownSourceMarkers(entry.source, entry.path, MULTI_ADVISOR_SOURCE_MARKERS)) continue
    if (isRegisteredProviderSurface(entry.source, entry.path, registeredProviderIds)) continue

    if (entry.source === undefined) {
      // Name-only unknown tools fail closed; never promote the bare name to a provider id.
      unregisteredNameOnlyTools += 1
      continue
    }
    unregisteredToolSources += 1
  }

  return {
    ok: true,
    subagentLoaded,
    magicContextLoaded: magicContextDetection !== 'none',
    magicContextTools,
    magicContextDetection,
    ...(magicContextSource !== undefined ? { magicContextSource } : {}),
    unregisteredToolSources,
    unregisteredNameOnlyTools
  }
}

/**
 * Classify command entries. Only extension-origin commands can contribute unregistered blockers.
 * Prompt/skill catalogs are ignored; the app-owned quiescence command is ignored.
 *
 * @param {readonly { name: string, commandSource?: string, source?: string, path?: string }[]} entries
 * @param {ReadonlySet<string>} [registeredProviderIds]
 */
export function classifyCommandEntries(entries, registeredProviderIds = new Set()) {
  let unregisteredCommandSources = 0
  let unregisteredNameOnlyCommands = 0
  for (const entry of entries) {
    if (isInternalQuiescenceSurface(entry.name, entry.source, entry.path)) continue
    // Non-extension command catalogs are not extension surfaces.
    if (entry.commandSource === 'prompt' || entry.commandSource === 'skill') continue
    if (entry.commandSource !== undefined && entry.commandSource !== 'extension') {
      // Unknown command origin fails closed as one unregistered surface unit.
      if (entry.source === undefined) {
        unregisteredNameOnlyCommands += 1
      } else if (!isBuiltinToolSource(entry.source)) {
        unregisteredCommandSources += 1
      }
      continue
    }
    // commandSource === 'extension' or omitted: treat as extension-origin and classify.
    if (isBuiltinToolSource(entry.source)) continue
    if (matchesKnownSourceMarkers(entry.source, entry.path, SUBAGENT_SOURCE_MARKERS)) continue
    if (isMagicContextSource(entry.source, entry.path)) continue
    if (matchesKnownSourceMarkers(entry.source, entry.path, MULTI_ADVISOR_SOURCE_MARKERS)) continue
    if (isRegisteredProviderSurface(entry.source, entry.path, registeredProviderIds)) continue

    if (entry.source === undefined) {
      unregisteredNameOnlyCommands += 1
      continue
    }
    unregisteredCommandSources += 1
  }
  return {
    ok: true,
    unregisteredCommandSources,
    unregisteredNameOnlyCommands
  }
}

/**
 * Fold tool + command discovery into one generic unregistered-extension sentinel when needed.
 * @param {{
 *   unregisteredToolSources?: number,
 *   unregisteredNameOnlyTools?: number,
 *   unregisteredCommandSources?: number,
 *   unregisteredNameOnlyCommands?: number
 * }} counts
 * @returns {{ id: string, state: 'unknown', reason: string } | null}
 */
export function buildUnregisteredExtensionReport(counts) {
  const toolSources = asNonNegativeCount(counts.unregisteredToolSources)
  const toolNames = asNonNegativeCount(counts.unregisteredNameOnlyTools)
  const commandSources = asNonNegativeCount(counts.unregisteredCommandSources)
  const commandNames = asNonNegativeCount(counts.unregisteredNameOnlyCommands)
  const total = toolSources + toolNames + commandSources + commandNames
  if (total <= 0) return null
  return {
    id: SENTINEL_ID_UNREGISTERED_EXTENSION,
    state: /** @type {const} */ ('unknown'),
    reason: boundReason(
      `discovered:tool-sources=${toolSources};tool-name-only=${toolNames};command-sources=${commandSources};command-name-only=${commandNames}`
    )
  }
}

/**
 * @param {string | undefined} source
 * @param {string | undefined} [path]
 */
export function isMagicContextSource(source, path) {
  return matchesKnownSourceMarkers(source, path, MAGIC_CONTEXT_SOURCE_MARKERS)
}

/**
 * @param {string | undefined} source
 */
export function isBuiltinToolSource(source) {
  if (typeof source !== 'string' || source.length === 0) return false
  const normalized = source.toLocaleLowerCase()
  return BUILTIN_TOOL_SOURCE_TOKENS.some((token) => normalized === token)
}

/**
 * @param {string} name
 * @param {string | undefined} source
 * @param {string | undefined} path
 */
export function isInternalQuiescenceSurface(name, source, path) {
  if (name === QUIESCENCE_COMMAND_NAME) return true
  return matchesKnownSourceMarkers(source, path, INTERNAL_QUIESCENCE_SOURCE_MARKERS)
}

/**
 * @param {string | undefined} source
 * @param {string | undefined} path
 * @param {ReadonlySet<string>} registeredProviderIds
 */
export function isRegisteredProviderSurface(source, path, registeredProviderIds) {
  if (registeredProviderIds.size === 0) return false
  for (const providerId of registeredProviderIds) {
    if (matchesExactProviderSurface(source, providerId)) return true
    if (matchesExactProviderSurface(path, providerId)) return true
  }
  return false
}

/**
 * Match known package markers against source metadata and/or path.
 * Path is classification-only and must never be copied into provider ids/reasons.
 *
 * @param {string | undefined} source
 * @param {string | undefined} path
 * @param {readonly string[]} markers
 */
export function matchesKnownSourceMarkers(source, path, markers) {
  return matchesMarkers(source, markers) || matchesMarkers(path, markers)
}

/**
 * Build a non-sensitive reason token from source metadata.
 * Filesystem paths and raw path-like strings are replaced by the matched marker.
 *
 * @param {string | undefined} source
 * @param {string | undefined} path
 * @param {readonly string[]} markers
 */
export function redactSourceForReason(source, path, markers) {
  const matched = findMatchedMarker(source, markers) ?? findMatchedMarker(path, markers)
  if (matched === undefined) return 'source-metadata'
  return markers.find((marker) => !/[\/\\]/u.test(marker)) ?? 'source-metadata'
}

/**
 * Build Magic Context blocking report until the external package adopts the provider protocol.
 * @param {{
 *   magicContextTools: readonly string[],
 *   magicContextDetection: 'source' | 'name-fallback-ambiguous',
 *   magicContextSource?: string
 * }} input
 */
export function buildMagicContextUnknownReport(input) {
  if (input.magicContextDetection === 'source' && typeof input.magicContextSource === 'string') {
    const redacted = isPathLike(input.magicContextSource)
      ? redactSourceForReason(input.magicContextSource, undefined, MAGIC_CONTEXT_SOURCE_MARKERS)
      : input.magicContextSource
    return {
      id: PROVIDER_ID_MAGIC_CONTEXT,
      state: /** @type {const} */ ('unknown'),
      reason: boundReason(`provider-not-adopted:source:${redacted}`)
    }
  }
  const tools = input.magicContextTools.join(',') || MAGIC_CONTEXT_TOOL_NAMES[0]
  return {
    id: PROVIDER_ID_MAGIC_CONTEXT,
    state: /** @type {const} */ ('unknown'),
    reason: boundReason(`provider-not-adopted:name-fallback-ambiguous:${tools}`)
  }
}

/**
 * @param {object} input
 * @param {string} input.nonce
 * @param {{ idle: boolean, pendingMessages: boolean }} input.core
 * @param {readonly { id: string, state: 'idle' | 'busy' | 'unknown', reason?: string }} input.providers
 */
export function buildQuiescenceResultPayload(input) {
  if (!isValidNonce(input.nonce)) {
    throw new Error('Quiescence result nonce is out of bounds.')
  }
  if (input.providers.length > MAX_PROVIDER_COUNT) {
    throw new Error(`Quiescence provider count exceeds ${MAX_PROVIDER_COUNT}.`)
  }
  const seen = new Set()
  const providers = input.providers.map((provider) => {
    if (!isValidProviderId(provider.id)) {
      throw new Error('Quiescence provider id is out of bounds.')
    }
    if (seen.has(provider.id)) {
      throw new Error(`Duplicate quiescence provider id: ${provider.id}`)
    }
    seen.add(provider.id)
    if (provider.state !== 'idle' && provider.state !== 'busy' && provider.state !== 'unknown') {
      throw new Error('Quiescence provider state is invalid.')
    }
    /** @type {{ id: string, state: 'idle' | 'busy' | 'unknown', reason?: string }} */
    const report = {
      id: provider.id,
      state: provider.state
    }
    if (provider.reason !== undefined) {
      if (typeof provider.reason !== 'string') {
        throw new Error('Quiescence provider reason is invalid.')
      }
      // Never serialize raw path-like provider diagnostics; clamp safe tokens in place.
      report.reason = redactProviderReason(provider.reason)
    }
    return report
  })
  const coreBlocking = input.core.idle !== true || input.core.pendingMessages === true
  const providerBlocking = providers.some((provider) => provider.state !== 'idle')
  return {
    version: QUIESCENCE_PROTOCOL_VERSION,
    kind: QUIESCENCE_RESULT_KIND,
    nonce: input.nonce,
    core: {
      idle: input.core.idle === true,
      pendingMessages: input.core.pendingMessages === true
    },
    providers,
    quiescent: !coreBlocking && !providerBlocking
  }
}

/**
 * @param {unknown} value
 * @param {string} expectedNonce
 * @returns
 *   | { ok: true, result: ReturnType<typeof buildQuiescenceResultPayload> }
 *   | { ok: false, reason: string }
 */
export function parseQuiescenceStatusPayload(value, expectedNonce) {
  if (!isValidNonce(expectedNonce)) {
    return { ok: false, reason: 'invalid-expected-nonce' }
  }
  let raw = value
  if (typeof raw === 'string') {
    if (raw.length === 0 || raw.length > MAX_STATUS_TEXT_LENGTH) {
      return { ok: false, reason: 'status-length' }
    }
    try {
      raw = JSON.parse(raw)
    } catch {
      return { ok: false, reason: 'malformed-json' }
    }
  }
  if (!isPlainObject(raw)) return { ok: false, reason: 'malformed-payload' }
  if (hasUnknownKeys(raw, ['version', 'kind', 'nonce', 'core', 'providers', 'quiescent'])) {
    return { ok: false, reason: 'unknown-properties' }
  }
  if (raw.version !== QUIESCENCE_PROTOCOL_VERSION) return { ok: false, reason: 'unsupported-version' }
  if (raw.kind !== QUIESCENCE_RESULT_KIND) return { ok: false, reason: 'unexpected-kind' }
  if (!isValidNonce(raw.nonce)) return { ok: false, reason: 'missing-nonce' }
  if (raw.nonce !== expectedNonce) return { ok: false, reason: 'nonce-mismatch' }
  if (!isPlainObject(raw.core)) return { ok: false, reason: 'malformed-core' }
  if (hasUnknownKeys(raw.core, ['idle', 'pendingMessages'])) {
    return { ok: false, reason: 'unknown-properties' }
  }
  if (typeof raw.core.idle !== 'boolean' || typeof raw.core.pendingMessages !== 'boolean') {
    return { ok: false, reason: 'malformed-core' }
  }
  if (!Array.isArray(raw.providers)) return { ok: false, reason: 'malformed-providers' }
  if (raw.providers.length > MAX_PROVIDER_COUNT) return { ok: false, reason: 'provider-count' }
  /** @type {{ id: string, state: 'idle' | 'busy' | 'unknown', reason?: string }[]} */
  const providers = []
  const seenIds = new Set()
  for (const entry of raw.providers) {
    if (!isPlainObject(entry)) return { ok: false, reason: 'malformed-providers' }
    if (hasUnknownKeys(entry, ['id', 'state', 'reason'])) {
      return { ok: false, reason: 'unknown-properties' }
    }
    if (!isValidProviderId(entry.id)) return { ok: false, reason: 'malformed-providers' }
    if (seenIds.has(entry.id)) return { ok: false, reason: 'duplicate-provider-id' }
    seenIds.add(entry.id)
    if (entry.state !== 'idle' && entry.state !== 'busy' && entry.state !== 'unknown') {
      return { ok: false, reason: 'malformed-providers' }
    }
    /** @type {{ id: string, state: 'idle' | 'busy' | 'unknown', reason?: string }} */
    const provider = { id: entry.id, state: entry.state }
    if (entry.reason !== undefined) {
      if (!isSafeProviderReason(entry.reason)) {
        return { ok: false, reason: 'malformed-providers' }
      }
      provider.reason = entry.reason
    }
    providers.push(provider)
  }
  if (typeof raw.quiescent !== 'boolean') return { ok: false, reason: 'malformed-quiescent' }
  let expected
  try {
    expected = buildQuiescenceResultPayload({
      nonce: raw.nonce,
      core: {
        idle: raw.core.idle,
        pendingMessages: raw.core.pendingMessages
      },
      providers
    })
  } catch {
    return { ok: false, reason: 'malformed-providers' }
  }
  if (raw.quiescent !== expected.quiescent) {
    return { ok: false, reason: 'inconsistent-quiescent' }
  }
  return { ok: true, result: expected }
}

/**
 * @param {unknown} raw
 * @returns {{ version: 1, requestId: string, nonce?: string } | null}
 */
export function parseProviderQueryEvent(raw) {
  if (!isPlainObject(raw)) return null
  if (hasUnknownKeys(raw, ['version', 'requestId', 'nonce'])) return null
  if (raw.version !== QUIESCENCE_PROTOCOL_VERSION) return null
  if (!isValidRequestId(raw.requestId)) return null
  /** @type {{ version: 1, requestId: string, nonce?: string }} */
  const query = { version: QUIESCENCE_PROTOCOL_VERSION, requestId: raw.requestId }
  if (raw.nonce !== undefined) {
    if (!isValidNonce(raw.nonce)) return null
    query.nonce = raw.nonce
  }
  return query
}

/**
 * @param {unknown} raw
 * @returns {{ version: 1, providerId: string } | null}
 */
export function parseProviderRegisterEvent(raw) {
  if (!isPlainObject(raw)) return null
  if (hasUnknownKeys(raw, ['version', 'providerId'])) return null
  if (raw.version !== QUIESCENCE_PROTOCOL_VERSION) return null
  if (!isValidProviderId(raw.providerId)) return null
  return { version: QUIESCENCE_PROTOCOL_VERSION, providerId: raw.providerId }
}

/**
 * @param {string} providerId
 */
export function buildProviderRegister(providerId) {
  if (!isValidProviderId(providerId)) {
    throw new Error('Provider id is out of bounds.')
  }
  return {
    version: QUIESCENCE_PROTOCOL_VERSION,
    providerId
  }
}

/**
 * @param {object} input
 * @param {string} input.requestId
 * @param {string} input.providerId
 * @param {'idle' | 'busy' | 'unknown'} input.state
 * @param {string} [input.reason]
 */
export function buildProviderReply(input) {
  if (!isValidRequestId(input.requestId)) {
    throw new Error('Provider reply requestId is out of bounds.')
  }
  if (!isValidProviderId(input.providerId)) {
    throw new Error('Provider reply providerId is out of bounds.')
  }
  if (input.state !== 'idle' && input.state !== 'busy' && input.state !== 'unknown') {
    throw new Error('Provider reply state is invalid.')
  }
  /** @type {{ version: 1, requestId: string, providerId: string, state: 'idle' | 'busy' | 'unknown', reason?: string }} */
  const reply = {
    version: QUIESCENCE_PROTOCOL_VERSION,
    requestId: input.requestId,
    providerId: input.providerId,
    state: input.state
  }
  if (input.reason !== undefined) {
    if (!isSafeProviderReason(input.reason)) {
      throw new Error('Provider reply reason is out of bounds or contains path separators.')
    }
    reply.reason = input.reason
  }
  return reply
}

/**
 * @param {unknown} raw
 * @param {string} requestId
 * @returns {{ id: string, state: 'idle' | 'busy' | 'unknown', reason?: string } | null}
 */
export function parseProviderReplyEvent(raw, requestId) {
  if (!isValidRequestId(requestId)) return null
  if (!isPlainObject(raw)) return null
  if (hasUnknownKeys(raw, ['version', 'requestId', 'providerId', 'state', 'reason'])) return null
  if (raw.version !== QUIESCENCE_PROTOCOL_VERSION) return null
  if (raw.requestId !== requestId) return null
  if (!isValidProviderId(raw.providerId)) return null
  if (raw.state !== 'idle' && raw.state !== 'busy' && raw.state !== 'unknown') return null
  /** @type {{ id: string, state: 'idle' | 'busy' | 'unknown', reason?: string }} */
  const provider = { id: raw.providerId, state: raw.state }
  if (raw.reason !== undefined) {
    if (!isSafeProviderReason(raw.reason)) return null
    provider.reason = raw.reason
  }
  return provider
}

/**
 * Snapshot registered provider IDs and fold collected replies into fail-closed reports.
 * Missing, late, or invalid replies become unknown.
 *
 * @param {object} input
 * @param {readonly string[]} input.registeredIds snapshot of roster at query start
 * @param {ReadonlyMap<string, { id: string, state: 'idle' | 'busy' | 'unknown', reason?: string }>} input.validReplies
 * @param {ReadonlySet<string>} [input.invalidReplyIds] ids that replied with unusable envelopes
 */
export function resolveRegisteredProviderReports(input) {
  /** @type {{ id: string, state: 'idle' | 'busy' | 'unknown', reason?: string }[]} */
  const reports = []
  const seen = new Set()
  for (const providerId of input.registeredIds) {
    if (!isValidProviderId(providerId) || seen.has(providerId)) continue
    seen.add(providerId)
    const valid = input.validReplies.get(providerId)
    if (valid !== undefined) {
      reports.push(valid)
      continue
    }
    if (input.invalidReplyIds?.has(providerId) === true) {
      reports.push({
        id: providerId,
        state: 'unknown',
        reason: 'invalid-reply'
      })
      continue
    }
    reports.push({
      id: providerId,
      state: 'unknown',
      reason: 'missing-or-late'
    })
  }
  return reports
}

export function providerReplyEventName(requestId) {
  if (!isValidRequestId(requestId)) {
    throw new Error('Provider reply event requestId is out of bounds.')
  }
  return `${PROVIDER_REPLY_EVENT_PREFIX}${requestId}`
}

export function subagentRpcReplyEventName(requestId) {
  if (!isValidRequestId(requestId)) {
    throw new Error('Subagent reply event requestId is out of bounds.')
  }
  return `${SUBAGENT_RPC_REPLY_EVENT_PREFIX}${requestId}`
}

export function isInternalQuiescenceCommandName(name) {
  return name === QUIESCENCE_COMMAND_NAME || name === LEASE_COMMAND_NAME
}

export function providerLeaseReplyEventName(requestId) {
  if (!isValidRequestId(requestId)) {
    throw new Error('Provider lease reply event requestId is out of bounds.')
  }
  return `${PROVIDER_LEASE_REPLY_EVENT_PREFIX}${requestId}`
}

/**
 * @param {unknown} sessionId
 * @returns {sessionId is string}
 */
export function isValidSessionId(sessionId) {
  return (
    typeof sessionId === 'string' &&
    sessionId.length >= MIN_SESSION_ID_LENGTH &&
    sessionId.length <= MAX_SESSION_ID_LENGTH &&
    SESSION_ID_PATTERN.test(sessionId) &&
    !/[\r\n]/u.test(sessionId)
  )
}

/**
 * @param {unknown} attemptId
 * @returns {attemptId is string}
 */
export function isValidAttemptId(attemptId) {
  return (
    typeof attemptId === 'string' &&
    attemptId.length >= MIN_ATTEMPT_ID_LENGTH &&
    attemptId.length <= MAX_ATTEMPT_ID_LENGTH &&
    ATTEMPT_ID_PATTERN.test(attemptId) &&
    !/\s/u.test(attemptId)
  )
}

/**
 * @param {unknown} token
 * @returns {token is string}
 */
export function isValidLeaseToken(token) {
  return (
    typeof token === 'string' &&
    token.length >= MIN_LEASE_TOKEN_LENGTH &&
    token.length <= MAX_LEASE_TOKEN_LENGTH &&
    LEASE_TOKEN_PATTERN.test(token) &&
    !/\s/u.test(token)
  )
}

/**
 * @param {unknown} generation
 * @returns {generation is number}
 */
export function isValidRuntimeGeneration(generation) {
  return (
    typeof generation === 'number' &&
    Number.isInteger(generation) &&
    Number.isFinite(generation) &&
    generation >= 1 &&
    generation <= Number.MAX_SAFE_INTEGER
  )
}

/**
 * @param {unknown} timeoutMs
 * @returns {{ ok: true, timeoutMs: number } | { ok: false, reason: string }}
 */
export function normalizeHibernateLeaseTimeoutMs(timeoutMs) {
  if (timeoutMs === undefined) {
    return { ok: true, timeoutMs: DEFAULT_HIBERNATE_LEASE_TIMEOUT_MS }
  }
  if (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || !Number.isFinite(timeoutMs)) {
    return { ok: false, reason: 'timeout-not-finite-integer' }
  }
  if (timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS) {
    return { ok: false, reason: 'timeout-out-of-bounds' }
  }
  return { ok: true, timeoutMs }
}

/**
 * Classify one loaded extension path into bounded tokens. Never returns the path.
 * @param {string} extensionPath
 * @returns
 *   | { kind: 'self' }
 *   | { kind: 'provider', providerId: string }
 *   | { kind: 'subagents' }
 *   | { kind: 'certified-core', marker: string }
 *   | { kind: 'unknown' }
 */
export function classifyLoadedExtensionPath(extensionPath) {
  if (typeof extensionPath !== 'string' || extensionPath.length === 0) {
    return { kind: 'unknown' }
  }
  if (matchesMarkers(extensionPath, INTERNAL_QUIESCENCE_SOURCE_MARKERS)) {
    return { kind: 'self' }
  }
  if (matchesMarkers(extensionPath, SUBAGENT_SOURCE_MARKERS)) {
    return { kind: 'subagents' }
  }
  if (matchesMarkers(extensionPath, MULTI_ADVISOR_SOURCE_MARKERS)) {
    return { kind: 'provider', providerId: PROVIDER_ID_MULTI_ADVISOR }
  }
  if (matchesMarkers(extensionPath, MAGIC_CONTEXT_SOURCE_MARKERS)) {
    return { kind: 'provider', providerId: PROVIDER_ID_MAGIC_CONTEXT }
  }
  for (const entry of REQUIRED_PROVIDER_EXTENSION_MARKERS) {
    if (matchesMarkers(extensionPath, [entry.marker])) {
      return { kind: 'provider', providerId: entry.providerId }
    }
  }
  return { kind: 'unknown' }
}

/**
 * Exact loaded-path inventory → expected prepare roster + redacted fingerprint.
 * Unknown paths fail closed. Raw paths are never included in the result.
 *
 * @param {unknown} extensionPaths
 * @returns
 *   | {
 *       ok: true,
 *       expectedProviderIds: string[],
 *       requiresSubagentsAdapter: boolean,
 *       certifiedCoreMarkers: string[],
 *       fingerprint: string
 *     }
 *   | { ok: false, reason: string }
 */
export function classifyExactExtensionInventory(extensionPaths) {
  if (!Array.isArray(extensionPaths)) {
    return { ok: false, reason: 'inventory-invalid' }
  }
  if (extensionPaths.length > MAX_PROVIDER_COUNT * 4) {
    return { ok: false, reason: 'inventory-too-large' }
  }

  /** @type {Set<string>} */
  const expectedProviderIds = new Set()
  let requiresSubagentsAdapter = false
  let sawSelf = false
  let unknownCount = 0

  for (const entry of extensionPaths) {
    if (typeof entry !== 'string' || entry.length === 0) {
      return { ok: false, reason: 'inventory-entry-invalid' }
    }
    const classified = classifyLoadedExtensionPath(entry)
    if (classified.kind === 'self') {
      sawSelf = true
      continue
    }
    if (classified.kind === 'subagents') {
      requiresSubagentsAdapter = true
      expectedProviderIds.add(PROVIDER_ID_SUBAGENTS)
      continue
    }
    if (classified.kind === 'provider') {
      expectedProviderIds.add(classified.providerId)
      continue
    }
    unknownCount += 1
  }

  if (unknownCount > 0) {
    return {
      ok: false,
      reason: boundReason(`inventory-unknown-paths:${unknownCount}`)
    }
  }
  if (!sawSelf) {
    // The app-owned bridge must be present in the exact inventory.
    return { ok: false, reason: 'inventory-missing-self' }
  }

  const providers = [...expectedProviderIds].sort()
  const fingerprint = boundInventoryFingerprint(
    [
      'v1',
      `providers=${providers.join(',') || '-'}`,
      `subagents=${requiresSubagentsAdapter ? '1' : '0'}`
    ].join(';')
  )
  return {
    ok: true,
    expectedProviderIds: providers,
    requiresSubagentsAdapter,
    fingerprint
  }
}

/**
 * @param {string} fingerprint
 */
function boundInventoryFingerprint(fingerprint) {
  if (fingerprint.length <= MAX_INVENTORY_FINGERPRINT_LENGTH) return fingerprint
  return fingerprint.slice(0, MAX_INVENTORY_FINGERPRINT_LENGTH)
}

/**
 * Extract exact text from a read-only tool execute result.
 * @param {unknown} result
 * @returns {string | null}
 */
export function extractToolResultText(result) {
  if (!isPlainObject(result) || !Array.isArray(result.content)) return null
  /** @type {string[]} */
  const parts = []
  for (const block of result.content) {
    if (!isPlainObject(block)) return null
    if (block.type !== 'text' || typeof block.text !== 'string') return null
    parts.push(block.text)
  }
  if (parts.length === 0) return null
  const text = parts.join('\n')
  if (text.length === 0 || text.length > MAX_STATUS_TEXT_LENGTH) return null
  return text
}

/**
 * @param {string | undefined} text
 * @returns {{ state: 'idle' | 'busy' | 'unknown', reason?: string }}
 */
export function parseSubagentScheduleListText(text) {
  if (typeof text !== 'string') {
    return { state: 'unknown', reason: 'missing-text' }
  }
  if (text.length === 0 || text.length > MAX_STATUS_TEXT_LENGTH) {
    return { state: 'unknown', reason: 'status-length' }
  }
  const normalized = stripSubagentSpawnBudgetPrefix(text)
  if (normalized === null) {
    return { state: 'unknown', reason: 'invalid-spawn-budget-prefix' }
  }
  if (normalized === SUBAGENT_SCHEDULE_IDLE_TEXT) {
    return { state: 'idle' }
  }
  if (normalized.startsWith('Scheduled subagent runs:')) {
    return { state: 'busy', reason: 'scheduled-runs-present' }
  }
  return { state: 'unknown', reason: 'unrecognized-schedule-text' }
}

/**
 * @param {unknown} snapshot
 * @param {string} sessionId
 * @returns {{ state: 'idle' | 'busy' | 'unknown', reason?: string }}
 */
export function parseSubagentBackgroundWorkSnapshot(snapshot, sessionId) {
  if (!isValidSessionId(sessionId)) {
    return { state: 'unknown', reason: 'invalid-session-id' }
  }
  if (!isPlainObject(snapshot)) {
    return { state: 'unknown', reason: 'malformed-background-snapshot' }
  }
  if (hasUnknownKeys(snapshot, ['providers', 'items'])) {
    return { state: 'unknown', reason: 'unknown-properties' }
  }
  if (!Array.isArray(snapshot.providers) || !Array.isArray(snapshot.items)) {
    return { state: 'unknown', reason: 'malformed-background-snapshot' }
  }
  if (snapshot.providers.length > MAX_PROVIDER_COUNT) {
    return { state: 'unknown', reason: 'background-providers-bound' }
  }
  if (snapshot.items.length > MAX_PROVIDER_COUNT * 8) {
    return { state: 'unknown', reason: 'background-items-bound' }
  }
  for (const provider of snapshot.providers) {
    if (typeof provider !== 'string' || provider.length === 0 || provider.length > MAX_PROVIDER_ID_LENGTH) {
      return { state: 'unknown', reason: 'malformed-background-provider' }
    }
  }
  let sessionItems = 0
  for (const item of snapshot.items) {
    if (!isPlainObject(item)) {
      return { state: 'unknown', reason: 'malformed-background-item' }
    }
    if (typeof item.sessionId !== 'string' || typeof item.id !== 'string') {
      return { state: 'unknown', reason: 'malformed-background-item' }
    }
    if (item.sessionId === sessionId) sessionItems += 1
  }
  if (sessionItems > 0) {
    return {
      state: 'busy',
      reason: boundReason(`background-work:${sessionItems}`)
    }
  }
  return { state: 'idle' }
}

/**
 * @param {object} input
 * @param {'prepare' | 'commit' | 'release'} input.action
 * @param {string} input.nonce
 * @param {string} input.sessionId
 * @param {number} input.generation
 * @param {string} input.attemptId
 * @param {string} [input.token]
 */
export function buildLeaseCommandArgs(input) {
  if (
    input.action !== 'prepare' &&
    input.action !== 'commit' &&
    input.action !== 'release'
  ) {
    throw new Error('Lease action is invalid.')
  }
  if (!isValidNonce(input.nonce)) throw new Error('Lease nonce is out of bounds.')
  if (!isValidSessionId(input.sessionId)) throw new Error('Lease sessionId is out of bounds.')
  if (!isValidRuntimeGeneration(input.generation)) {
    throw new Error('Lease generation is out of bounds.')
  }
  if (!isValidAttemptId(input.attemptId)) throw new Error('Lease attemptId is out of bounds.')
  /** @type {Record<string, unknown>} */
  const payload = {
    version: LEASE_PROTOCOL_VERSION,
    action: input.action,
    nonce: input.nonce,
    sessionId: input.sessionId,
    generation: input.generation,
    attemptId: input.attemptId
  }
  if (input.action === 'commit' || input.action === 'release') {
    if (!isValidLeaseToken(input.token)) throw new Error('Lease token is out of bounds.')
    payload.token = input.token
  } else if (input.token !== undefined) {
    throw new Error('Prepare must not carry a token.')
  }
  return JSON.stringify(payload)
}

/**
 * @param {unknown} args
 * @returns
 *   | {
 *       ok: true,
 *       request: {
 *         version: 1,
 *         action: 'prepare' | 'commit' | 'release',
 *         nonce: string,
 *         sessionId: string,
 *         generation: number,
 *         attemptId: string,
 *         token?: string
 *       }
 *     }
 *   | { ok: false, reason: string }
 */
export function parseLeaseCommandArgs(args) {
  if (typeof args !== 'string') return { ok: false, reason: 'args-not-string' }
  const trimmed = args.trim()
  if (trimmed.length === 0 || trimmed.length > MAX_STATUS_TEXT_LENGTH) {
    return { ok: false, reason: 'args-length' }
  }
  let raw
  try {
    raw = JSON.parse(trimmed)
  } catch {
    return { ok: false, reason: 'malformed-json' }
  }
  if (!isPlainObject(raw)) return { ok: false, reason: 'malformed-payload' }
  if (
    hasUnknownKeys(raw, [
      'version',
      'action',
      'nonce',
      'sessionId',
      'generation',
      'attemptId',
      'token'
    ])
  ) {
    return { ok: false, reason: 'unknown-properties' }
  }
  if (raw.version !== LEASE_PROTOCOL_VERSION) {
    return { ok: false, reason: 'unsupported-version' }
  }
  if (raw.action !== 'prepare' && raw.action !== 'commit' && raw.action !== 'release') {
    return { ok: false, reason: 'invalid-action' }
  }
  if (!isValidNonce(raw.nonce)) return { ok: false, reason: 'invalid-nonce' }
  if (!isValidSessionId(raw.sessionId)) return { ok: false, reason: 'invalid-session-id' }
  if (!isValidRuntimeGeneration(raw.generation)) {
    return { ok: false, reason: 'invalid-generation' }
  }
  if (!isValidAttemptId(raw.attemptId)) return { ok: false, reason: 'invalid-attempt-id' }
  /** @type {{
    version: 1,
    action: 'prepare' | 'commit' | 'release',
    nonce: string,
    sessionId: string,
    generation: number,
    attemptId: string,
    token?: string
  }} */
  const request = {
    version: LEASE_PROTOCOL_VERSION,
    action: raw.action,
    nonce: raw.nonce,
    sessionId: raw.sessionId,
    generation: raw.generation,
    attemptId: raw.attemptId
  }
  if (raw.action === 'prepare') {
    if (raw.token !== undefined) return { ok: false, reason: 'unexpected-token' }
    return { ok: true, request }
  }
  if (!isValidLeaseToken(raw.token)) return { ok: false, reason: 'invalid-token' }
  request.token = raw.token
  return { ok: true, request }
}

/**
 * @param {object} input
 * @param {'prepare' | 'commit' | 'release'} input.action
 * @param {string} input.nonce
 * @param {string} input.sessionId
 * @param {number} input.generation
 * @param {string} input.attemptId
 * @param {boolean} input.ok
 * @param {string} [input.token]
 * @param {string} [input.inventoryFingerprint]
 * @param {readonly string[]} [input.preparedProviders]
 * @param {string} [input.reason]
 * @param {readonly { id: string, reason: string }[]} [input.blockers]
 */
export function buildLeaseResultPayload(input) {
  if (
    input.action !== 'prepare' &&
    input.action !== 'commit' &&
    input.action !== 'release'
  ) {
    throw new Error('Lease result action is invalid.')
  }
  if (!isValidNonce(input.nonce)) throw new Error('Lease result nonce is out of bounds.')
  if (!isValidSessionId(input.sessionId)) {
    throw new Error('Lease result sessionId is out of bounds.')
  }
  if (!isValidRuntimeGeneration(input.generation)) {
    throw new Error('Lease result generation is out of bounds.')
  }
  if (!isValidAttemptId(input.attemptId)) {
    throw new Error('Lease result attemptId is out of bounds.')
  }
  if (typeof input.ok !== 'boolean') throw new Error('Lease result ok is invalid.')

  /** @type {Record<string, unknown>} */
  const payload = {
    version: LEASE_PROTOCOL_VERSION,
    kind: LEASE_RESULT_KIND,
    action: input.action,
    nonce: input.nonce,
    sessionId: input.sessionId,
    generation: input.generation,
    attemptId: input.attemptId,
    ok: input.ok
  }

  if (input.ok) {
    if (input.reason !== undefined || input.blockers !== undefined) {
      throw new Error('Successful lease result cannot carry failure fields.')
    }
    if (input.action === 'prepare') {
      if (!isValidLeaseToken(input.token)) {
        throw new Error('Successful prepare requires a lease token.')
      }
      if (
        typeof input.inventoryFingerprint !== 'string' ||
        input.inventoryFingerprint.length === 0 ||
        input.inventoryFingerprint.length > MAX_INVENTORY_FINGERPRINT_LENGTH ||
        /[\/\\\r\n]/u.test(input.inventoryFingerprint)
      ) {
        throw new Error('Successful prepare requires a redacted inventory fingerprint.')
      }
      if (!Array.isArray(input.preparedProviders)) {
        throw new Error('Successful prepare requires preparedProviders.')
      }
      if (input.preparedProviders.length > MAX_PROVIDER_COUNT) {
        throw new Error('preparedProviders exceeds bounds.')
      }
      const seen = new Set()
      for (const providerId of input.preparedProviders) {
        if (!isValidProviderId(providerId) || seen.has(providerId)) {
          throw new Error('preparedProviders contains an invalid id.')
        }
        seen.add(providerId)
      }
      payload.token = input.token
      payload.inventoryFingerprint = input.inventoryFingerprint
      payload.preparedProviders = [...input.preparedProviders]
    } else if (input.token !== undefined) {
      // commit/release success may echo the matched token for host correlation.
      if (!isValidLeaseToken(input.token)) {
        throw new Error('Lease result token is out of bounds.')
      }
      payload.token = input.token
    }
    return payload
  }

  if (input.token !== undefined || input.inventoryFingerprint !== undefined) {
    throw new Error('Failed lease result cannot carry success fields.')
  }
  if (typeof input.reason !== 'string' || !isSafeProviderReason(input.reason)) {
    throw new Error('Failed lease result requires a safe reason token.')
  }
  payload.reason = input.reason
  if (input.blockers !== undefined) {
    if (!Array.isArray(input.blockers) || input.blockers.length > MAX_LEASE_BLOCKER_COUNT) {
      throw new Error('Lease blockers are out of bounds.')
    }
    const blockers = input.blockers.map((blocker) => {
      if (!isPlainObject(blocker)) throw new Error('Lease blocker is invalid.')
      if (!isValidProviderId(blocker.id)) throw new Error('Lease blocker id is invalid.')
      if (typeof blocker.reason !== 'string' || !isSafeProviderReason(blocker.reason)) {
        throw new Error('Lease blocker reason is invalid.')
      }
      return { id: blocker.id, reason: blocker.reason }
    })
    payload.blockers = blockers
  }
  return payload
}

/**
 * @param {unknown} value
 * @param {string} expectedNonce
 * @returns
 *   | { ok: true, result: ReturnType<typeof buildLeaseResultPayload> }
 *   | { ok: false, reason: string }
 */
export function parseLeaseStatusPayload(value, expectedNonce) {
  if (!isValidNonce(expectedNonce)) return { ok: false, reason: 'invalid-expected-nonce' }
  let raw = value
  if (typeof raw === 'string') {
    if (raw.length === 0 || raw.length > MAX_STATUS_TEXT_LENGTH) {
      return { ok: false, reason: 'status-length' }
    }
    try {
      raw = JSON.parse(raw)
    } catch {
      return { ok: false, reason: 'malformed-json' }
    }
  }
  if (!isPlainObject(raw)) return { ok: false, reason: 'malformed-payload' }
  if (
    hasUnknownKeys(raw, [
      'version',
      'kind',
      'action',
      'nonce',
      'sessionId',
      'generation',
      'attemptId',
      'ok',
      'token',
      'inventoryFingerprint',
      'preparedProviders',
      'reason',
      'blockers'
    ])
  ) {
    return { ok: false, reason: 'unknown-properties' }
  }
  if (raw.version !== LEASE_PROTOCOL_VERSION) return { ok: false, reason: 'unsupported-version' }
  if (raw.kind !== LEASE_RESULT_KIND) return { ok: false, reason: 'unexpected-kind' }
  if (raw.nonce !== expectedNonce) return { ok: false, reason: 'nonce-mismatch' }
  if (!isValidNonce(raw.nonce)) return { ok: false, reason: 'invalid-nonce' }
  if (raw.action !== 'prepare' && raw.action !== 'commit' && raw.action !== 'release') {
    return { ok: false, reason: 'invalid-action' }
  }
  if (!isValidSessionId(raw.sessionId)) return { ok: false, reason: 'invalid-session-id' }
  if (!isValidRuntimeGeneration(raw.generation)) {
    return { ok: false, reason: 'invalid-generation' }
  }
  if (!isValidAttemptId(raw.attemptId)) return { ok: false, reason: 'invalid-attempt-id' }
  if (typeof raw.ok !== 'boolean') return { ok: false, reason: 'malformed-ok' }

  /** @type {{ id: string, reason: string }[] | undefined} */
  let blockers
  if (raw.blockers !== undefined) {
    if (!Array.isArray(raw.blockers) || raw.blockers.length > MAX_LEASE_BLOCKER_COUNT) {
      return { ok: false, reason: 'malformed-blockers' }
    }
    blockers = []
    for (const entry of raw.blockers) {
      if (!isPlainObject(entry)) return { ok: false, reason: 'malformed-blockers' }
      if (hasUnknownKeys(entry, ['id', 'reason'])) {
        return { ok: false, reason: 'malformed-blockers' }
      }
      if (!isValidProviderId(entry.id) || !isSafeProviderReason(entry.reason)) {
        return { ok: false, reason: 'malformed-blockers' }
      }
      blockers.push({ id: entry.id, reason: entry.reason })
    }
  }

  try {
    const expected = buildLeaseResultPayload({
      action: raw.action,
      nonce: raw.nonce,
      sessionId: raw.sessionId,
      generation: raw.generation,
      attemptId: raw.attemptId,
      ok: raw.ok,
      ...(typeof raw.token === 'string' ? { token: raw.token } : {}),
      ...(typeof raw.inventoryFingerprint === 'string'
        ? { inventoryFingerprint: raw.inventoryFingerprint }
        : {}),
      ...(Array.isArray(raw.preparedProviders)
        ? { preparedProviders: raw.preparedProviders }
        : {}),
      ...(typeof raw.reason === 'string' ? { reason: raw.reason } : {}),
      ...(blockers !== undefined ? { blockers } : {})
    })
    return { ok: true, result: expected }
  } catch {
    return { ok: false, reason: 'malformed-payload' }
  }
}

/**
 * @param {unknown} raw
 * @returns
 *   | {
 *       version: 1,
 *       requestId: string,
 *       sessionId: string,
 *       generation: number,
 *       attemptId: string,
 *       token?: string
 *     }
 *   | null
 */
export function parseProviderLeaseEvent(raw) {
  if (!isPlainObject(raw)) return null
  if (
    hasUnknownKeys(raw, [
      'version',
      'requestId',
      'sessionId',
      'generation',
      'attemptId',
      'token'
    ])
  ) {
    return null
  }
  if (raw.version !== LEASE_PROTOCOL_VERSION) return null
  if (!isValidRequestId(raw.requestId)) return null
  if (!isValidSessionId(raw.sessionId)) return null
  if (!isValidRuntimeGeneration(raw.generation)) return null
  if (!isValidAttemptId(raw.attemptId)) return null
  /** @type {{
    version: 1,
    requestId: string,
    sessionId: string,
    generation: number,
    attemptId: string,
    token?: string
  }} */
  const event = {
    version: LEASE_PROTOCOL_VERSION,
    requestId: raw.requestId,
    sessionId: raw.sessionId,
    generation: raw.generation,
    attemptId: raw.attemptId
  }
  if (raw.token !== undefined) {
    if (!isValidLeaseToken(raw.token)) return null
    event.token = raw.token
  }
  return event
}

/**
 * @param {object} input
 * @param {string} input.requestId
 * @param {string} input.providerId
 * @param {boolean} input.ok
 * @param {string} [input.reason]
 */
export function buildProviderLeaseReply(input) {
  if (!isValidRequestId(input.requestId)) {
    throw new Error('Provider lease reply requestId is out of bounds.')
  }
  if (!isValidProviderId(input.providerId)) {
    throw new Error('Provider lease reply providerId is out of bounds.')
  }
  if (typeof input.ok !== 'boolean') {
    throw new Error('Provider lease reply ok is invalid.')
  }
  /** @type {{ version: 1, requestId: string, providerId: string, ok: boolean, reason?: string }} */
  const reply = {
    version: LEASE_PROTOCOL_VERSION,
    requestId: input.requestId,
    providerId: input.providerId,
    ok: input.ok
  }
  if (input.ok) {
    if (input.reason !== undefined) {
      throw new Error('Successful provider lease reply cannot carry a reason.')
    }
    return reply
  }
  if (typeof input.reason !== 'string' || !isSafeProviderReason(input.reason)) {
    throw new Error('Failed provider lease reply requires a safe reason.')
  }
  reply.reason = input.reason
  return reply
}

/**
 * @param {unknown} raw
 * @param {string} requestId
 * @returns {{ providerId: string, ok: boolean, reason?: string } | null}
 */
export function parseProviderLeaseReplyEvent(raw, requestId) {
  if (!isValidRequestId(requestId)) return null
  if (!isPlainObject(raw)) return null
  if (hasUnknownKeys(raw, ['version', 'requestId', 'providerId', 'ok', 'reason'])) {
    return null
  }
  if (raw.version !== LEASE_PROTOCOL_VERSION) return null
  if (raw.requestId !== requestId) return null
  if (!isValidProviderId(raw.providerId)) return null
  if (typeof raw.ok !== 'boolean') return null
  if (raw.ok === true) {
    if (raw.reason !== undefined) return null
    return { providerId: raw.providerId, ok: true }
  }
  if (!isSafeProviderReason(raw.reason)) return null
  return { providerId: raw.providerId, ok: false, reason: raw.reason }
}

/**
 * @param {unknown} nonce
 * @returns {nonce is string}
 */
export function isValidNonce(nonce) {
  return (
    typeof nonce === 'string' &&
    nonce.length >= MIN_NONCE_LENGTH &&
    nonce.length <= MAX_NONCE_LENGTH &&
    !/\s/u.test(nonce) &&
    !/[\r\n]/u.test(nonce)
  )
}

/**
 * @param {unknown} requestId
 * @returns {requestId is string}
 */
export function isValidRequestId(requestId) {
  return (
    typeof requestId === 'string' &&
    requestId.length >= MIN_REQUEST_ID_LENGTH &&
    requestId.length <= MAX_REQUEST_ID_LENGTH &&
    !/[\r\n]/u.test(requestId)
  )
}

/**
 * @param {unknown} providerId
 * @returns {providerId is string}
 */
export function isValidProviderId(providerId) {
  return (
    typeof providerId === 'string' &&
    providerId.length >= MIN_PROVIDER_ID_LENGTH &&
    providerId.length <= MAX_PROVIDER_ID_LENGTH &&
    PROVIDER_ID_PATTERN.test(providerId)
  )
}

/**
 * Provider reasons are internal diagnostic tokens, never raw exception/path text.
 * @param {unknown} reason
 */
export function isSafeProviderReason(reason) {
  return (
    typeof reason === 'string' &&
    reason.length <= MAX_REASON_LENGTH &&
    !/[\/\\\r\n]/u.test(reason)
  )
}

/**
 * @param {string} reason
 */
export function redactProviderReason(reason) {
  const bounded = boundReason(reason)
  return isSafeProviderReason(bounded) ? bounded : 'provider-detail-redacted'
}

/**
 * @param {unknown} timeoutMs
 * @returns {{ ok: true, timeoutMs: number } | { ok: false, reason: string }}
 */
export function normalizeQuiescenceTimeoutMs(timeoutMs) {
  if (timeoutMs === undefined) {
    return { ok: true, timeoutMs: DEFAULT_QUIESCENCE_QUERY_TIMEOUT_MS }
  }
  if (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || !Number.isFinite(timeoutMs)) {
    return { ok: false, reason: 'timeout-not-finite-integer' }
  }
  if (timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS) {
    return { ok: false, reason: 'timeout-out-of-bounds' }
  }
  return { ok: true, timeoutMs }
}

/**
 * @param {string} reason
 */
export function boundReason(reason) {
  if (reason.length <= MAX_REASON_LENGTH) return reason
  return reason.slice(0, MAX_REASON_LENGTH)
}

/**
 * @param {unknown} value
 * @param {readonly string[]} allowed
 */
function hasUnknownKeys(value, allowed) {
  if (!isPlainObject(value)) return true
  const allowedSet = new Set(allowed)
  return Object.keys(value).some((key) => !allowedSet.has(key))
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * @param {string | undefined} value
 * @param {readonly string[]} markers
 */
function matchesMarkers(value, markers) {
  return findMatchedMarker(value, markers) !== undefined
}

/**
 * @param {string | undefined} value
 * @param {readonly string[]} markers
 * @returns {string | undefined}
 */
function findMatchedMarker(value, markers) {
  if (typeof value !== 'string' || value.length === 0) return undefined
  const normalized = value.toLocaleLowerCase()
  for (const marker of markers) {
    const needle = marker.toLocaleLowerCase()
    if (normalized === needle || normalized.includes(needle)) return marker
  }
  return undefined
}

/**
 * Dynamic provider ids may suppress only an exact source token or a complete
 * path segment sequence. Arbitrary substring matches would let a short id hide
 * an unrelated extension surface.
 *
 * @param {string | undefined} value
 * @param {string} providerId
 */
function matchesExactProviderSurface(value, providerId) {
  if (typeof value !== 'string' || value.length === 0) return false
  const normalized = value.replaceAll('\\', '/').toLocaleLowerCase()
  const needle = providerId.replaceAll('\\', '/').toLocaleLowerCase()
  if (normalized === needle) return true
  return normalized.endsWith(`/${needle}`) || normalized.includes(`/${needle}/`)
}

/**
 * @param {string} value
 */
function isPathLike(value) {
  return (
    value.startsWith('/') ||
    value.startsWith('\\') ||
    value.startsWith('<') ||
    value.includes('/') ||
    value.includes('\\') ||
    /^[A-Za-z]:[\\/]/u.test(value)
  )
}

/**
 * @param {unknown} value
 */
function asNonNegativeCount(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0
  return Math.floor(value)
}
