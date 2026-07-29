export const QUIESCENCE_PROTOCOL_VERSION: 1
export const QUIESCENCE_COMMAND_NAME: 'pi-gui-runtime-quiescence'
export const QUIESCENCE_STATUS_KEY: 'pi-gui.runtime-quiescence'
export const QUIESCENCE_RESULT_KIND: 'pi-gui.runtime-quiescence/query-result'
export const PROVIDER_QUERY_EVENT: 'pi-gui.runtime-quiescence/provider-query/v1'
export const PROVIDER_REPLY_EVENT_PREFIX: 'pi-gui.runtime-quiescence/provider-reply/v1:'
export const PROVIDER_REGISTER_EVENT: 'pi-gui.runtime-quiescence/provider-register/v1'
export const SUBAGENT_RPC_PROTOCOL_VERSION: 1
export const SUBAGENT_RPC_REQUEST_EVENT: 'subagents:rpc:v1:request'
export const SUBAGENT_RPC_REPLY_EVENT_PREFIX: 'subagents:rpc:v1:reply:'
export const SUBAGENT_FLEET_IDLE_TEXT: string
export const SUBAGENT_FLEET_BUSY_PATTERN: RegExp
export const SUBAGENT_ASYNC_ONLY_IDLE_TEXT: string
export const SUBAGENT_SPAWN_BUDGET_PATTERN: RegExp
export const SUBAGENT_TOOL_NAMES: readonly string[]
export const MAGIC_CONTEXT_TOOL_NAMES: readonly string[]
export const MAGIC_CONTEXT_SOURCE_MARKERS: readonly string[]
export const BUILTIN_TOOL_SOURCE_TOKENS: readonly string[]
export const INTERNAL_QUIESCENCE_SOURCE_MARKERS: readonly string[]
export const SUBAGENT_SOURCE_MARKERS: readonly string[]
export const MULTI_ADVISOR_SOURCE_MARKERS: readonly string[]
export const PROVIDER_ID_SUBAGENTS: 'pi-subagents'
export const PROVIDER_ID_MAGIC_CONTEXT: 'magic-context'
export const PROVIDER_ID_MULTI_ADVISOR: 'pi-gui-multi-advisor'
export const SENTINEL_ID_TOOL_DISCOVERY: 'tool-discovery'
export const SENTINEL_ID_COMMAND_DISCOVERY: 'command-discovery'
export const SENTINEL_ID_EVENT_BUS: 'event-bus'
export const SENTINEL_ID_UNREGISTERED_EXTENSION: 'unregistered-extension'
export const DEFAULT_SUBAGENT_RPC_TIMEOUT_MS: number
export const DEFAULT_PROVIDER_COLLECT_MS: number
export const DEFAULT_QUIESCENCE_QUERY_TIMEOUT_MS: number
export const DEFAULT_HIBERNATE_LEASE_TIMEOUT_MS: number
export const DEFAULT_PROVIDER_PREPARE_TIMEOUT_MS: number
export const LEASE_PROTOCOL_VERSION: 1
export const LEASE_COMMAND_NAME: 'pi-gui-runtime-hibernate-lease'
export const LEASE_STATUS_KEY: 'pi-gui.runtime-hibernate-lease'
export const LEASE_RESULT_KIND: 'pi-gui.runtime-hibernate-lease/result'
export const PROVIDER_LEASE_PREPARE_EVENT: string
export const PROVIDER_LEASE_COMMIT_EVENT: string
export const PROVIDER_LEASE_RELEASE_EVENT: string
export const PROVIDER_LEASE_REPLY_EVENT_PREFIX: string
export const MIN_NONCE_LENGTH: number
export const MAX_NONCE_LENGTH: number
export const MIN_REQUEST_ID_LENGTH: number
export const MAX_REQUEST_ID_LENGTH: number
export const MIN_PROVIDER_ID_LENGTH: number
export const MAX_PROVIDER_ID_LENGTH: number
export const PROVIDER_ID_PATTERN: RegExp
export const RPC_ERROR_CODE_PATTERN: RegExp
export const MAX_REASON_LENGTH: number
export const MAX_PROVIDER_COUNT: number
export const MAX_STATUS_TEXT_LENGTH: number
export const MIN_TIMEOUT_MS: number
export const MAX_TIMEOUT_MS: number

export type ProviderState = 'idle' | 'busy' | 'unknown'

export type ProviderReport = {
  id: string
  state: ProviderState
  reason?: string
}

export type QuiescenceResultPayload = {
  version: 1
  kind: typeof QUIESCENCE_RESULT_KIND
  nonce: string
  core: {
    idle: boolean
    pendingMessages: boolean
  }
  providers: ProviderReport[]
  quiescent: boolean
}

export type MagicContextDetection = 'none' | 'source' | 'name-fallback-ambiguous'

export type DetectLoadedToolSetsResult =
  | {
      ok: true
      subagentLoaded: boolean
      magicContextLoaded: boolean
      magicContextTools: string[]
      magicContextDetection: MagicContextDetection
      magicContextSource?: string
      unregisteredToolSources: number
      unregisteredNameOnlyTools: number
    }
  | {
      ok: false
      reason: string
    }

export type DiscoveredToolEntry = {
  name: string
  source?: string
  path?: string
}

export type DiscoveredCommandEntry = {
  name: string
  commandSource?: string
  source?: string
  path?: string
}

export function stripSubagentSpawnBudgetPrefix(text: string): string | null

export function parseSubagentFleetStatusText(
  text: string | undefined
): { state: ProviderState; reason?: string }

export function parseSubagentRpcStatusReply(
  reply: unknown,
  requestId: string
): { state: ProviderState; reason?: string }

export function detectLoadedToolSets(tools: unknown): DetectLoadedToolSetsResult

export function normalizeDiscoveredToolEntries(
  tools: unknown
): { ok: true; entries: DiscoveredToolEntry[] } | { ok: false; reason: string }

export function normalizeDiscoveredCommandEntries(
  commands: unknown
): { ok: true; entries: DiscoveredCommandEntry[] } | { ok: false; reason: string }

export function classifyToolEntries(
  entries: readonly DiscoveredToolEntry[],
  registeredProviderIds?: ReadonlySet<string>
): Extract<DetectLoadedToolSetsResult, { ok: true }>

export function classifyCommandEntries(
  entries: readonly DiscoveredCommandEntry[],
  registeredProviderIds?: ReadonlySet<string>
): {
  ok: true
  unregisteredCommandSources: number
  unregisteredNameOnlyCommands: number
}

export function buildUnregisteredExtensionReport(counts: {
  unregisteredToolSources?: number
  unregisteredNameOnlyTools?: number
  unregisteredCommandSources?: number
  unregisteredNameOnlyCommands?: number
}): ProviderReport | null

export function isMagicContextSource(
  source: string | undefined,
  path?: string | undefined
): boolean

export function isBuiltinToolSource(source: string | undefined): boolean

export function isInternalQuiescenceSurface(
  name: string,
  source?: string | undefined,
  path?: string | undefined
): boolean

export function isSafeProviderReason(reason: unknown): reason is string
export function redactProviderReason(reason: string): string

export function isRegisteredProviderSurface(
  source: string | undefined,
  path: string | undefined,
  registeredProviderIds: ReadonlySet<string>
): boolean

export function matchesKnownSourceMarkers(
  source: string | undefined,
  path: string | undefined,
  markers: readonly string[]
): boolean

export function redactSourceForReason(
  source: string | undefined,
  path: string | undefined,
  markers: readonly string[]
): string

export function buildMagicContextUnknownReport(input: {
  magicContextTools: readonly string[]
  magicContextDetection: Exclude<MagicContextDetection, 'none'>
  magicContextSource?: string
}): ProviderReport

export function buildQuiescenceResultPayload(input: {
  nonce: string
  core: { idle: boolean; pendingMessages: boolean }
  providers: readonly ProviderReport[]
}): QuiescenceResultPayload

export function parseQuiescenceStatusPayload(
  value: unknown,
  expectedNonce: string
):
  | { ok: true; result: QuiescenceResultPayload }
  | { ok: false; reason: string }

export function buildLeaseCommandArgs(input: {
  action: 'prepare' | 'commit' | 'release'
  nonce: string
  sessionId: string
  generation: number
  attemptId: string
  token?: string
}): string

export function parseLeaseStatusPayload(
  value: unknown,
  expectedNonce: string
):
  | { ok: true; result: Record<string, unknown> }
  | { ok: false; reason: string }

export function parseProviderQueryEvent(
  raw: unknown
): { version: 1; requestId: string; nonce?: string } | null

export function parseProviderRegisterEvent(
  raw: unknown
): { version: 1; providerId: string } | null

export function buildProviderRegister(providerId: string): {
  version: 1
  providerId: string
}

export function buildProviderReply(input: {
  requestId: string
  providerId: string
  state: ProviderState
  reason?: string
}): {
  version: 1
  requestId: string
  providerId: string
  state: ProviderState
  reason?: string
}

export function parseProviderReplyEvent(
  raw: unknown,
  requestId: string
): ProviderReport | null

export function resolveRegisteredProviderReports(input: {
  registeredIds: readonly string[]
  validReplies: ReadonlyMap<string, ProviderReport>
  invalidReplyIds?: ReadonlySet<string>
}): ProviderReport[]

export function providerReplyEventName(requestId: string): string
export function subagentRpcReplyEventName(requestId: string): string
export function isInternalQuiescenceCommandName(name: string): boolean
export function isValidNonce(nonce: unknown): nonce is string
export function isValidRequestId(requestId: unknown): requestId is string
export function isValidProviderId(providerId: unknown): providerId is string
export function isValidSessionId(sessionId: unknown): sessionId is string
export function isValidRuntimeGeneration(generation: unknown): generation is number
export function isValidAttemptId(attemptId: unknown): attemptId is string
export function isValidLeaseToken(token: unknown): token is string
export function normalizeHibernateLeaseTimeoutMs(
  timeoutMs: unknown
): { ok: true; timeoutMs: number } | { ok: false; reason: string }
export function normalizeQuiescenceTimeoutMs(
  timeoutMs: unknown
): { ok: true; timeoutMs: number } | { ok: false; reason: string }
export function boundReason(reason: string): string
