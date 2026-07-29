import { randomUUID } from 'node:crypto'

import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent'

import {
  ensureExtensionRunnerInventoryBridge,
  invokeRegisteredToolFromContext,
  readExtensionInventoryFromContext
} from './inventory-bridge.mjs'
import {
  DEFAULT_PROVIDER_COLLECT_MS,
  DEFAULT_PROVIDER_PREPARE_TIMEOUT_MS,
  DEFAULT_SUBAGENT_RPC_TIMEOUT_MS,
  LEASE_COMMAND_NAME,
  LEASE_STATUS_KEY,
  MAX_NONCE_LENGTH,
  MIN_NONCE_LENGTH,
  PROVIDER_ID_MAGIC_CONTEXT,
  PROVIDER_ID_SUBAGENTS,
  PROVIDER_LEASE_COMMIT_EVENT,
  PROVIDER_LEASE_PREPARE_EVENT,
  PROVIDER_LEASE_RELEASE_EVENT,
  PROVIDER_QUERY_EVENT,
  PROVIDER_REGISTER_EVENT,
  QUIESCENCE_COMMAND_NAME,
  QUIESCENCE_STATUS_KEY,
  SENTINEL_ID_COMMAND_DISCOVERY,
  SENTINEL_ID_EVENT_BUS,
  SENTINEL_ID_TOOL_DISCOVERY,
  SUBAGENT_RPC_PROTOCOL_VERSION,
  SUBAGENT_RPC_REQUEST_EVENT,
  boundReason,
  buildLeaseResultPayload,
  buildMagicContextUnknownReport,
  buildQuiescenceResultPayload,
  buildUnregisteredExtensionReport,
  classifyCommandEntries,
  classifyExactExtensionInventory,
  classifyToolEntries,
  extractToolResultText,
  isValidNonce,
  normalizeDiscoveredCommandEntries,
  normalizeDiscoveredToolEntries,
  parseLeaseCommandArgs,
  parseProviderLeaseReplyEvent,
  parseProviderRegisterEvent,
  parseProviderReplyEvent,
  parseSubagentFleetStatusText,
  parseSubagentRpcStatusReply,
  parseSubagentScheduleListText,
  providerLeaseReplyEventName,
  providerReplyEventName,
  resolveRegisteredProviderReports,
  subagentRpcReplyEventName
} from './protocol.mjs'

type ProviderReport = {
  id: string
  state: 'idle' | 'busy' | 'unknown'
  reason?: string
}

type EventBus = {
  on(event: string, handler: (data: unknown) => void): (() => void) | void
  emit(event: string, data: unknown): void
}

type ActiveLease = {
  sessionId: string
  generation: number
  providerGeneration: number
  attemptId: string
  token: string
  inventoryFingerprint: string
  preparedProviders: string[]
  /** Provider-specific compatibility identities; absent entries use canonical sessionId. */
  providerSessionIds: Record<string, string>
  phase: 'prepared' | 'committed'
}

export default function runtimeQuiescenceExtension(pi: ExtensionAPI): void {
  // Start installing the private inventory bridge without delaying command registration.
  // Prepare awaits the same idempotent installation and fails closed if it is unavailable.
  void ensureExtensionRunnerInventoryBridge()

  /** Versioned discovery roster: providers declare IDs; QUERY snapshots this set. */
  const registeredProviderIds = new Set<string>()
  /** Active generation-fenced lease for this Runtime process, if any. */
  let activeLease: ActiveLease | null = null
  /** Provider lifecycle generation advances on every Pi session_start in this process. */
  let providerGeneration = 0
  let lifecycleEpoch = 0
  let lifecycleSessionId: string | null = null

  const events = getEventBus(pi)
  let eventBusOperational = events !== null
  if (events !== null) {
    try {
      events.on(PROVIDER_REGISTER_EVENT, (raw) => {
        const registration = parseProviderRegisterEvent(raw)
        if (registration === null) return
        registeredProviderIds.add(registration.providerId)
      })
    } catch {
      eventBusOperational = false
    }
  }

  pi.on('session_start', (_event, ctx) => {
    providerGeneration += 1
    lifecycleEpoch += 1
    lifecycleSessionId = readSessionId(ctx)
    activeLease = null
  })
  pi.on('session_shutdown', () => {
    lifecycleEpoch += 1
    lifecycleSessionId = null
    activeLease = null
  })

  pi.registerCommand(QUIESCENCE_COMMAND_NAME, {
    description: 'Internal Pi GUI runtime quiescence query. Not a user command.',
    handler: async (args, ctx) => {
      const nonce = parseNonce(args)
      if (nonce === null) {
        // Fail closed without writing status that RuntimeHost could mis-correlate.
        return
      }
      const payload = await collectQuiescencePayload(
        pi,
        ctx,
        nonce,
        registeredProviderIds,
        eventBusOperational
      )
      ctx.ui.setStatus(QUIESCENCE_STATUS_KEY, JSON.stringify(payload))
      // Clear footer status after delivery so RPC clients only need the correlated event.
      ctx.ui.setStatus(QUIESCENCE_STATUS_KEY, undefined)
    }
  })

  pi.registerCommand(LEASE_COMMAND_NAME, {
    description:
      'Internal Pi GUI generation-fenced hibernate lease. Not a user command. QUERY is not authority.',
    handler: async (args, ctx) => {
      const parsed = parseLeaseCommandArgs(args)
      if (!parsed.ok) return
      const request = parsed.request
      let payload: ReturnType<typeof buildLeaseResultPayload>
      try {
        if (request.action === 'prepare') {
          const commandEpoch = lifecycleEpoch
          const commandProviderGeneration = providerGeneration
          const prepared = await prepareLease(
            ctx,
            request,
            eventBusOperational ? events : null,
            activeLease,
            {
              providerGeneration: commandProviderGeneration,
              isCurrent: () =>
                commandProviderGeneration >= 1 &&
                lifecycleEpoch === commandEpoch &&
                lifecycleSessionId === request.sessionId
            }
          )
          if (prepared.ok) {
            activeLease = prepared.lease
            payload = buildLeaseResultPayload({
              action: 'prepare',
              nonce: request.nonce,
              sessionId: request.sessionId,
              generation: request.generation,
              attemptId: request.attemptId,
              ok: true,
              token: prepared.lease.token,
              inventoryFingerprint: prepared.lease.inventoryFingerprint,
              preparedProviders: prepared.lease.preparedProviders
            })
          } else {
            if (prepared.retainedLease !== undefined) {
              activeLease = prepared.retainedLease
            }
            payload = buildLeaseResultPayload({
              action: 'prepare',
              nonce: request.nonce,
              sessionId: request.sessionId,
              generation: request.generation,
              attemptId: request.attemptId,
              ok: false,
              reason: prepared.reason,
              ...(prepared.blockers !== undefined ? { blockers: prepared.blockers } : {})
            })
          }
        } else if (request.action === 'commit') {
          const committed = await commitLease(
            request,
            eventBusOperational ? events : null,
            activeLease
          )
          if (committed.ok) {
            activeLease = committed.lease
            payload = buildLeaseResultPayload({
              action: 'commit',
              nonce: request.nonce,
              sessionId: request.sessionId,
              generation: request.generation,
              attemptId: request.attemptId,
              ok: true,
              token: request.token
            })
          } else {
            payload = buildLeaseResultPayload({
              action: 'commit',
              nonce: request.nonce,
              sessionId: request.sessionId,
              generation: request.generation,
              attemptId: request.attemptId,
              ok: false,
              reason: committed.reason
            })
          }
        } else {
          const released = await releaseLease(
            request,
            eventBusOperational ? events : null,
            activeLease
          )
          if (released.ok) {
            activeLease = null
            payload = buildLeaseResultPayload({
              action: 'release',
              nonce: request.nonce,
              sessionId: request.sessionId,
              generation: request.generation,
              attemptId: request.attemptId,
              ok: true,
              token: request.token
            })
          } else {
            if (released.retainedLease !== undefined) {
              activeLease = released.retainedLease
            }
            payload = buildLeaseResultPayload({
              action: 'release',
              nonce: request.nonce,
              sessionId: request.sessionId,
              generation: request.generation,
              attemptId: request.attemptId,
              ok: false,
              reason: released.reason
            })
          }
        }
      } catch {
        payload = buildLeaseResultPayload({
          action: request.action,
          nonce: request.nonce,
          sessionId: request.sessionId,
          generation: request.generation,
          attemptId: request.attemptId,
          ok: false,
          reason: 'lease-handler-error'
        })
      }
      ctx.ui.setStatus(LEASE_STATUS_KEY, JSON.stringify(payload))
      ctx.ui.setStatus(LEASE_STATUS_KEY, undefined)
    }
  })
}

async function prepareLease(
  ctx: ExtensionCommandContext,
  request: {
    nonce: string
    sessionId: string
    generation: number
    attemptId: string
  },
  events: EventBus | null,
  previousLease: ActiveLease | null,
  lifecycle: {
    providerGeneration: number
    isCurrent: () => boolean
  }
): Promise<
  | { ok: true; lease: ActiveLease }
  | {
      ok: false
      reason: string
      blockers?: { id: string; reason: string }[]
      retainedLease?: ActiveLease | null
    }
> {
  if (!lifecycle.isCurrent()) {
    return { ok: false, reason: 'runtime-lifecycle-changed' }
  }

  // Core must already be idle; lease is not a force-stop path.
  if (ctx.isIdle() !== true || ctx.hasPendingMessages() === true) {
    return { ok: false, reason: 'core-not-idle' }
  }

  const sessionId = readSessionId(ctx)
  if (sessionId === null || sessionId !== request.sessionId) {
    return { ok: false, reason: 'session-identity-mismatch' }
  }

  const bridge = await ensureExtensionRunnerInventoryBridge()
  if (!bridge.ok) {
    return { ok: false, reason: boundReason(`inventory-bridge:${bridge.reason}`) }
  }

  const paths = readExtensionInventoryFromContext(ctx)
  if (paths === null) {
    return { ok: false, reason: 'inventory-unavailable' }
  }

  const inventory = classifyExactExtensionInventory(paths)
  if (!inventory.ok) {
    return { ok: false, reason: boundReason(inventory.reason) }
  }

  // Exact loaded inventory is the authority for prepare. Registration events
  // are diagnostic only because globally configured extensions can load before
  // this app-owned extension installs its listener. Every expected provider must
  // still answer the fenced prepare request or the attempt fails closed.
  if (inventory.expectedProviderIds.length > 0 && events === null) {
    return { ok: false, reason: 'event-bus-unavailable' }
  }

  const token = randomUUID()
  const preparedProviders: string[] = []
  const providerSessionIds: Record<string, string> = {}
  const blockers: { id: string; reason: string }[] = []

  // A failed rollback keeps the exact prior lease so a later sweep can retry
  // restoration. Never overwrite it with a different attempt identity.
  if (previousLease !== null) {
    if (events === null && previousLease.preparedProviders.length > 0) {
      return {
        ok: false,
        reason: 'previous-lease-release-failed',
        retainedLease: previousLease
      }
    }
    const releasedPrevious = events === null
      ? { ok: true, prepared: [], blockers: [] }
      : await notifyLeaseProviders(
          events,
          PROVIDER_LEASE_RELEASE_EVENT,
          previousLease,
          previousLease.preparedProviders,
          `${request.nonce}:release-prev`,
          250
        )
    if (!releasedPrevious.ok) {
      return {
        ok: false,
        reason: 'previous-lease-release-failed',
        retainedLease: {
          ...previousLease,
          preparedProviders: releasedPrevious.blockers.map(({ id }) => id).sort()
        }
      }
    }
    // Make lease replacement a separate sweep so no provider sees two attempt
    // identities in one command turn.
    return {
      ok: false,
      reason: 'previous-lease-released-retry',
      retainedLease: null
    }
  }

  // Freeze every owner/provider before running diagnostic adapters. This closes the
  // snapshot→new-work race; adapters now inspect a stable owner state.
  if (events !== null && inventory.expectedProviderIds.length > 0) {
    const canonicalProviders = inventory.expectedProviderIds.filter(
      (providerId) => providerId !== PROVIDER_ID_SUBAGENTS
    )
    if (canonicalProviders.length > 0) {
      const providerResult = await prepareRegisteredProviders(
        events,
        request,
        lifecycle.providerGeneration,
        token,
        canonicalProviders
      )
      preparedProviders.push(...providerResult.prepared)
      blockers.push(...providerResult.blockers)
    }

    if (inventory.expectedProviderIds.includes(PROVIDER_ID_SUBAGENTS)) {
      // Canonical identity always wins. The currently deployed pi-subagents owner
      // fence records getSessionFile() for persisted Sessions, so retry only that
      // provider with the bounded file identity when canonical prepare is rejected.
      // Commit/release remain bound to whichever identity actually prepared.
      const identities = [request.sessionId]
      const compatibilityIdentity = readSessionFileIdentity(ctx)
      if (compatibilityIdentity !== null && compatibilityIdentity !== request.sessionId) {
        identities.push(compatibilityIdentity)
      }

      let subagentsPrepared = false
      let subagentsBlocker = {
        id: PROVIDER_ID_SUBAGENTS,
        reason: 'missing-or-late'
      }
      for (const providerSessionId of identities) {
        const providerResult = await prepareRegisteredProviders(
          events,
          { ...request, sessionId: providerSessionId },
          lifecycle.providerGeneration,
          token,
          [PROVIDER_ID_SUBAGENTS]
        )
        if (providerResult.prepared.includes(PROVIDER_ID_SUBAGENTS)) {
          preparedProviders.push(PROVIDER_ID_SUBAGENTS)
          if (providerSessionId !== request.sessionId) {
            providerSessionIds[PROVIDER_ID_SUBAGENTS] = providerSessionId
          }
          subagentsPrepared = true
          break
        }
        if (providerResult.blockers[0] !== undefined) {
          subagentsBlocker = providerResult.blockers[0]
        }
      }
      if (!subagentsPrepared) blockers.push(subagentsBlocker)
    }
  }

  if (!lifecycle.isCurrent()) {
    blockers.push({ id: 'runtime-lifecycle', reason: 'changed-during-prepare' })
  }

  if (
    inventory.requiresSubagentsAdapter &&
    !preparedProviders.includes(PROVIDER_ID_SUBAGENTS) &&
    !blockers.some((blocker) => blocker.id === PROVIDER_ID_SUBAGENTS)
  ) {
    const subagents = await prepareSubagentsAdapter(ctx)
    if (subagents.state !== 'idle') {
      blockers.push({
        id: PROVIDER_ID_SUBAGENTS,
        reason: boundReason(subagents.reason ?? 'subagents-not-idle')
      })
    }
  }

  if (
    !lifecycle.isCurrent() &&
    !blockers.some((blocker) => blocker.id === 'runtime-lifecycle')
  ) {
    blockers.push({ id: 'runtime-lifecycle', reason: 'changed-during-prepare' })
  }

  if (blockers.length > 0) {
    // Partial prepare must release every owner that accepted the shared token.
    if (events !== null && preparedProviders.length > 0) {
      const partialLease: ActiveLease = {
        sessionId: request.sessionId,
        generation: request.generation,
        providerGeneration: lifecycle.providerGeneration,
        attemptId: request.attemptId,
        token,
        inventoryFingerprint: inventory.fingerprint,
        preparedProviders: [...preparedProviders],
        providerSessionIds: { ...providerSessionIds },
        phase: 'prepared'
      }
      const releasedPartial = await notifyLeaseProviders(
        events,
        PROVIDER_LEASE_RELEASE_EVENT,
        partialLease,
        preparedProviders,
        `${request.nonce}:release-partial`,
        250
      )
      if (!releasedPartial.ok) {
        return {
          ok: false,
          reason: 'provider-release-failed',
          blockers: [...blockers, ...releasedPartial.blockers],
          retainedLease: {
            sessionId: request.sessionId,
            generation: request.generation,
            providerGeneration: lifecycle.providerGeneration,
            attemptId: request.attemptId,
            token,
            inventoryFingerprint: inventory.fingerprint,
            preparedProviders: releasedPartial.blockers.map(({ id }) => id).sort(),
            providerSessionIds: filterProviderSessionIds(
              providerSessionIds,
              releasedPartial.blockers.map(({ id }) => id)
            ),
            phase: 'prepared'
          }
        }
      }
    }
    return {
      ok: false,
      reason: 'provider-prepare-failed',
      blockers
    }
  }

  return {
    ok: true,
    lease: {
      sessionId: request.sessionId,
      generation: request.generation,
      providerGeneration: lifecycle.providerGeneration,
      attemptId: request.attemptId,
      token,
      inventoryFingerprint: inventory.fingerprint,
      preparedProviders: [...preparedProviders].sort(),
      providerSessionIds: { ...providerSessionIds },
      phase: 'prepared'
    }
  }
}

async function commitLease(
  request: {
    sessionId: string
    generation: number
    attemptId: string
    token?: string
  },
  events: EventBus | null,
  activeLease: ActiveLease | null
): Promise<{ ok: true; lease: ActiveLease } | { ok: false; reason: string }> {
  if (activeLease === null) return { ok: false, reason: 'no-active-lease' }
  if (
    activeLease.sessionId !== request.sessionId ||
    activeLease.generation !== request.generation ||
    activeLease.attemptId !== request.attemptId ||
    activeLease.token !== request.token
  ) {
    return { ok: false, reason: 'lease-identity-mismatch' }
  }
  if (activeLease.phase === 'committed') {
    return { ok: true, lease: activeLease }
  }

  const providerIds = activeLease.preparedProviders
  if (providerIds.length > 0) {
    if (events === null) return { ok: false, reason: 'event-bus-unavailable' }
    const result = await notifyLeaseProviders(
      events,
      PROVIDER_LEASE_COMMIT_EVENT,
      activeLease,
      providerIds,
      `${request.attemptId}:commit`,
      DEFAULT_PROVIDER_PREPARE_TIMEOUT_MS
    )
    if (!result.ok) return { ok: false, reason: 'provider-commit-failed' }
  }

  return {
    ok: true,
    lease: { ...activeLease, phase: 'committed' }
  }
}

async function releaseLease(
  request: {
    sessionId: string
    generation: number
    attemptId: string
    token?: string
  },
  events: EventBus | null,
  activeLease: ActiveLease | null
): Promise<
  | { ok: true }
  | { ok: false; reason: string; retainedLease?: ActiveLease }
> {
  if (activeLease === null) {
    // Stale release after natural process stop or already-cleared lease: reject.
    return { ok: false, reason: 'no-active-lease' }
  }
  if (
    activeLease.sessionId !== request.sessionId ||
    activeLease.generation !== request.generation ||
    activeLease.attemptId !== request.attemptId ||
    activeLease.token !== request.token
  ) {
    // Exact match only. Stale release must not reopen a newer generation/attempt.
    return { ok: false, reason: 'lease-identity-mismatch' }
  }

  const providerIds = activeLease.preparedProviders
  if (providerIds.length > 0) {
    if (events === null) return { ok: false, reason: 'event-bus-unavailable' }
    const result = await notifyLeaseProviders(
      events,
      PROVIDER_LEASE_RELEASE_EVENT,
      activeLease,
      providerIds,
      `${request.attemptId}:release`,
      DEFAULT_PROVIDER_PREPARE_TIMEOUT_MS
    )
    if (!result.ok) {
      return {
        ok: false,
        reason: 'provider-release-failed',
        retainedLease: {
          ...activeLease,
          preparedProviders: result.blockers.map(({ id }) => id).sort(),
          providerSessionIds: filterProviderSessionIds(
            activeLease.providerSessionIds,
            result.blockers.map(({ id }) => id)
          )
        }
      }
    }
  }
  return { ok: true }
}

async function prepareRegisteredProviders(
  events: EventBus,
  request: {
    nonce: string
    sessionId: string
    generation: number
    attemptId: string
  },
  providerGeneration: number,
  token: string,
  providerIds: readonly string[]
): Promise<{ prepared: string[]; blockers: { id: string; reason: string }[] }> {
  const requestId = `${request.nonce}:lease-prepare:${randomUUID()}`
  const result = await notifyProviders(
    events,
    PROVIDER_LEASE_PREPARE_EVENT,
    {
      version: 1,
      requestId,
      sessionId: request.sessionId,
      generation: providerGeneration,
      attemptId: request.attemptId,
      token
    },
    providerIds,
    DEFAULT_PROVIDER_PREPARE_TIMEOUT_MS
  )
  return {
    prepared: result.prepared,
    blockers: result.blockers
  }
}

async function notifyLeaseProviders(
  events: EventBus,
  eventName: string,
  lease: ActiveLease,
  providerIds: readonly string[],
  requestIdPrefix: string,
  timeoutMs: number
): Promise<{
  ok: boolean
  prepared: string[]
  blockers: { id: string; reason: string }[]
}> {
  const groups = new Map<string, string[]>()
  for (const providerId of providerIds) {
    const providerSessionId = lease.providerSessionIds[providerId] ?? lease.sessionId
    const group = groups.get(providerSessionId) ?? []
    group.push(providerId)
    groups.set(providerSessionId, group)
  }

  const orderedGroups = [...groups.entries()].sort(([left], [right]) => {
    if (left === lease.sessionId) return -1
    if (right === lease.sessionId) return 1
    return left.localeCompare(right)
  })
  const prepared: string[] = []
  const blockers: { id: string; reason: string }[] = []
  for (const [providerSessionId, groupProviderIds] of orderedGroups) {
    const result = await notifyProviders(
      events,
      eventName,
      {
        version: 1,
        requestId: `${requestIdPrefix}:${randomUUID()}`,
        sessionId: providerSessionId,
        generation: lease.providerGeneration,
        attemptId: lease.attemptId,
        token: lease.token
      },
      groupProviderIds,
      timeoutMs
    )
    prepared.push(...result.prepared)
    blockers.push(...result.blockers)
  }
  return { ok: blockers.length === 0, prepared, blockers }
}

function filterProviderSessionIds(
  providerSessionIds: Readonly<Record<string, string>>,
  providerIds: readonly string[]
): Record<string, string> {
  const retained: Record<string, string> = {}
  for (const providerId of providerIds) {
    const providerSessionId = providerSessionIds[providerId]
    if (providerSessionId !== undefined) retained[providerId] = providerSessionId
  }
  return retained
}

async function notifyProviders(
  events: EventBus,
  eventName: string,
  payload: {
    version: 1
    requestId: string
    sessionId: string
    generation: number
    attemptId: string
    token?: string
  },
  providerIds: readonly string[],
  timeoutMs: number
): Promise<{
  ok: boolean
  prepared: string[]
  blockers: { id: string; reason: string }[]
}> {
  if (providerIds.length === 0) {
    return { ok: true, prepared: [], blockers: [] }
  }

  const replyEvent = providerLeaseReplyEventName(payload.requestId)
  const valid = new Map<string, { ok: boolean; reason?: string }>()
  let unsubscribe: (() => void) | void

  try {
    unsubscribe = events.on(replyEvent, (raw) => {
      const reply = parseProviderLeaseReplyEvent(raw, payload.requestId)
      if (reply === null) return
      if (!providerIds.includes(reply.providerId)) return
      if (valid.has(reply.providerId)) return
      valid.set(reply.providerId, {
        ok: reply.ok,
        ...(reply.reason !== undefined ? { reason: reply.reason } : {})
      })
    })
    events.emit(eventName, payload)
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline && valid.size < providerIds.length) {
      await sleep(10)
    }
  } catch {
    // Preserve providers that already acknowledged before a later synchronous
    // event listener threw. Only unresolved providers become notify blockers.
    for (const providerId of providerIds) {
      if (!valid.has(providerId)) {
        valid.set(providerId, { ok: false, reason: 'provider-notify-failed' })
      }
    }
  } finally {
    try {
      unsubscribe?.()
    } catch {
      // Ignore disposer failures.
    }
  }

  const prepared: string[] = []
  const blockers: { id: string; reason: string }[] = []
  for (const providerId of providerIds) {
    const reply = valid.get(providerId)
    if (reply === undefined) {
      blockers.push({ id: providerId, reason: 'missing-or-late' })
      continue
    }
    if (!reply.ok) {
      blockers.push({
        id: providerId,
        reason: boundReason(reply.reason ?? 'provider-rejected')
      })
      continue
    }
    prepared.push(providerId)
  }
  return { ok: blockers.length === 0, prepared, blockers }
}

async function prepareSubagentsAdapter(
  ctx: ExtensionCommandContext
): Promise<{ state: 'idle' | 'busy' | 'unknown'; reason?: string }> {
  const fleetResult = await invokeRegisteredToolFromContext(ctx, 'subagent', {
    action: 'status',
    view: 'fleet'
  })
  if (fleetResult === null) {
    return { state: 'unknown', reason: 'subagent-tool-unavailable' }
  }
  const fleetText = extractToolResultText(fleetResult)
  const fleet = parseSubagentFleetStatusText(fleetText ?? undefined)
  if (fleet.state !== 'idle') {
    return {
      state: fleet.state,
      reason: fleet.reason ?? 'subagent-fleet-not-idle'
    }
  }

  const scheduleResult = await invokeRegisteredToolFromContext(ctx, 'subagent', {
    action: 'schedule-list'
  })
  if (scheduleResult === null) {
    return { state: 'unknown', reason: 'subagent-schedule-unavailable' }
  }
  const scheduleText = extractToolResultText(scheduleResult)
  const schedule = parseSubagentScheduleListText(scheduleText ?? undefined)
  if (schedule.state !== 'idle') {
    return {
      state: schedule.state,
      reason: schedule.reason ?? 'subagent-schedule-not-idle'
    }
  }

  return { state: 'idle' }
}

function readSessionFileIdentity(ctx: ExtensionCommandContext): string | null {
  try {
    const sessionManager = ctx.sessionManager
    if (
      sessionManager === undefined ||
      sessionManager === null ||
      typeof sessionManager.getSessionFile !== 'function'
    ) {
      return null
    }
    const sessionFile = sessionManager.getSessionFile()
    return typeof sessionFile === 'string' &&
      sessionFile.length > 0 &&
      sessionFile.length <= 256 &&
      !/[\r\n]/u.test(sessionFile)
      ? sessionFile
      : null
  } catch {
    return null
  }
}

function readSessionId(ctx: ExtensionCommandContext): string | null {
  try {
    const sessionManager = ctx.sessionManager
    if (
      sessionManager === undefined ||
      sessionManager === null ||
      typeof sessionManager.getSessionId !== 'function'
    ) {
      return null
    }
    const sessionId = sessionManager.getSessionId()
    return typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : null
  } catch {
    return null
  }
}

async function collectQuiescencePayload(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  nonce: string,
  registeredProviderIds: ReadonlySet<string>,
  eventBusOperational: boolean
) {
  const providers: ProviderReport[] = []
  const discovery = discoverSurfaces(pi, registeredProviderIds)

  for (const failure of discovery.failures) {
    providers.push({
      id: failure.id,
      state: 'unknown',
      reason: boundReason(failure.reason)
    })
  }

  const loaded = discovery.loaded

  const events = eventBusOperational ? getEventBus(pi) : null
  if (events === null) {
    providers.push({
      id: SENTINEL_ID_EVENT_BUS,
      state: 'unknown',
      reason: 'event-bus-unavailable'
    })
  }

  if (loaded.subagentLoaded && !registeredProviderIds.has(PROVIDER_ID_SUBAGENTS)) {
    // Compatibility adapter for pi-subagents versions that predate the provider protocol.
    providers.push(
      events === null
        ? { id: PROVIDER_ID_SUBAGENTS, state: 'unknown', reason: 'event-bus-unavailable' }
        : await querySubagentProvider(events, nonce)
    )
  }

  if (
    loaded.magicContextLoaded &&
    loaded.magicContextDetection !== 'none' &&
    !registeredProviderIds.has(PROVIDER_ID_MAGIC_CONTEXT)
  ) {
    // Older Magic Context builds expose tools without a provider. Current builds
    // register and are queried through the roster below.
    providers.push(
      buildMagicContextUnknownReport({
        magicContextTools: loaded.magicContextTools,
        magicContextDetection: loaded.magicContextDetection,
        magicContextSource: loaded.magicContextSource
      })
    )
  }

  const unregistered = buildUnregisteredExtensionReport(loaded)
  if (unregistered !== null) {
    providers.push(unregistered)
  }

  // Snapshot roster before emit so late registrations during collect cannot race expectations.
  const rosterSnapshot = [...registeredProviderIds]
  if (events === null) {
    for (const providerId of rosterSnapshot) {
      providers.push({
        id: providerId,
        state: 'unknown',
        reason: 'event-bus-unavailable'
      })
    }
  } else {
    providers.push(...(await queryRegisteredProviders(events, nonce, rosterSnapshot)))
  }

  return buildQuiescenceResultPayload({
    nonce,
    core: {
      idle: ctx.isIdle() === true,
      pendingMessages: ctx.hasPendingMessages() === true
    },
    providers: dedupeProviders(providers)
  })
}

type LoadedSurface = {
  subagentLoaded: boolean
  magicContextLoaded: boolean
  magicContextTools: string[]
  magicContextDetection: 'none' | 'source' | 'name-fallback-ambiguous'
  magicContextSource?: string
  unregisteredToolSources: number
  unregisteredNameOnlyTools: number
  unregisteredCommandSources: number
  unregisteredNameOnlyCommands: number
}

function emptyLoadedSurface(): LoadedSurface {
  return {
    subagentLoaded: false,
    magicContextLoaded: false,
    magicContextTools: [],
    magicContextDetection: 'none',
    unregisteredToolSources: 0,
    unregisteredNameOnlyTools: 0,
    unregisteredCommandSources: 0,
    unregisteredNameOnlyCommands: 0
  }
}

function discoverSurfaces(
  pi: ExtensionAPI,
  registeredProviderIds: ReadonlySet<string>
): {
  failures: ProviderReport[]
  loaded: LoadedSurface
} {
  const failures: ProviderReport[] = []
  const loaded = emptyLoadedSurface()

  try {
    if (typeof pi.getAllTools !== 'function') {
      failures.push({
        id: SENTINEL_ID_TOOL_DISCOVERY,
        state: 'unknown',
        reason: 'tool-api-missing'
      })
    } else {
      const rawTools = pi.getAllTools().map((tool) => ({
        name: tool.name,
        sourceInfo:
          tool.sourceInfo !== undefined && tool.sourceInfo !== null
            ? {
                source: tool.sourceInfo.source,
                path:
                  typeof (tool.sourceInfo as { path?: unknown }).path === 'string'
                    ? (tool.sourceInfo as { path: string }).path
                    : undefined
              }
            : undefined
      }))
      const normalized = normalizeDiscoveredToolEntries(rawTools)
      if (!normalized.ok) {
        failures.push({
          id: SENTINEL_ID_TOOL_DISCOVERY,
          state: 'unknown',
          reason: boundReason(normalized.reason)
        })
      } else {
        const classified = classifyToolEntries(normalized.entries, registeredProviderIds)
        loaded.subagentLoaded = classified.subagentLoaded
        loaded.magicContextLoaded = classified.magicContextLoaded
        loaded.magicContextTools = classified.magicContextTools
        loaded.magicContextDetection = classified.magicContextDetection
        if (classified.magicContextSource !== undefined) {
          loaded.magicContextSource = classified.magicContextSource
        }
        loaded.unregisteredToolSources = classified.unregisteredToolSources
        loaded.unregisteredNameOnlyTools = classified.unregisteredNameOnlyTools
      }
    }
  } catch {
    failures.push({
      id: SENTINEL_ID_TOOL_DISCOVERY,
      state: 'unknown',
      reason: 'tool-api-throw'
    })
  }

  try {
    if (typeof pi.getCommands !== 'function') {
      failures.push({
        id: SENTINEL_ID_COMMAND_DISCOVERY,
        state: 'unknown',
        reason: 'command-api-missing'
      })
    } else {
      const rawCommands = pi.getCommands().map((command) => ({
        name: command.name,
        source: command.source,
        sourceInfo:
          command.sourceInfo !== undefined && command.sourceInfo !== null
            ? {
                source: command.sourceInfo.source,
                path:
                  typeof (command.sourceInfo as { path?: unknown }).path === 'string'
                    ? (command.sourceInfo as { path: string }).path
                    : undefined
              }
            : undefined
      }))
      const normalized = normalizeDiscoveredCommandEntries(rawCommands)
      if (!normalized.ok) {
        failures.push({
          id: SENTINEL_ID_COMMAND_DISCOVERY,
          state: 'unknown',
          reason: boundReason(normalized.reason)
        })
      } else {
        const classified = classifyCommandEntries(normalized.entries, registeredProviderIds)
        loaded.unregisteredCommandSources = classified.unregisteredCommandSources
        loaded.unregisteredNameOnlyCommands = classified.unregisteredNameOnlyCommands
      }
    }
  } catch {
    failures.push({
      id: SENTINEL_ID_COMMAND_DISCOVERY,
      state: 'unknown',
      reason: 'command-api-throw'
    })
  }

  return { failures, loaded }
}

async function querySubagentProvider(events: EventBus, nonce: string): Promise<ProviderReport> {
  const requestId = `${nonce}:subagent:${randomUUID()}`
  const replyEvent = subagentRpcReplyEventName(requestId)

  try {
    const reply = await waitForEvent(events, replyEvent, DEFAULT_SUBAGENT_RPC_TIMEOUT_MS, () => {
      events.emit(SUBAGENT_RPC_REQUEST_EVENT, {
        version: SUBAGENT_RPC_PROTOCOL_VERSION,
        requestId,
        method: 'status',
        params: { view: 'fleet' },
        source: { extension: 'pi-gui-runtime-quiescence' }
      })
    })
    if (reply === null) {
      return { id: PROVIDER_ID_SUBAGENTS, state: 'unknown', reason: 'timeout' }
    }
    const parsed = parseSubagentRpcStatusReply(reply, requestId)
    return {
      id: PROVIDER_ID_SUBAGENTS,
      state: parsed.state,
      ...(parsed.reason !== undefined ? { reason: parsed.reason } : {})
    }
  } catch {
    return {
      id: PROVIDER_ID_SUBAGENTS,
      state: 'unknown',
      reason: 'subagent-query-error'
    }
  }
}

async function queryRegisteredProviders(
  events: EventBus,
  nonce: string,
  registeredIds: readonly string[]
): Promise<ProviderReport[]> {
  if (registeredIds.length === 0) return []

  const requestId = `${nonce}:providers:${randomUUID()}`
  const replyEvent = providerReplyEventName(requestId)
  const validReplies = new Map<string, ProviderReport>()
  const invalidReplyIds = new Set<string>()

  let unsubscribe: (() => void) | void
  try {
    unsubscribe = events.on(replyEvent, (raw) => {
      const provider = parseProviderReplyEvent(raw, requestId)
      if (provider !== null) {
        // First valid reply wins per provider id; later drift is ignored.
        if (!validReplies.has(provider.id) && !invalidReplyIds.has(provider.id)) {
          validReplies.set(provider.id, provider)
        }
        return
      }
      // Track invalid replies that still name a registered provider id when possible.
      if (
        raw !== null &&
        typeof raw === 'object' &&
        !Array.isArray(raw) &&
        typeof (raw as { providerId?: unknown }).providerId === 'string'
      ) {
        const providerId = (raw as { providerId: string }).providerId
        if (
          registeredIds.includes(providerId) &&
          !validReplies.has(providerId)
        ) {
          invalidReplyIds.add(providerId)
        }
      }
    })
    events.emit(PROVIDER_QUERY_EVENT, {
      version: 1,
      requestId,
      nonce
    })
    await sleep(DEFAULT_PROVIDER_COLLECT_MS)
  } catch {
    return registeredIds.map((id) => ({
      id,
      state: 'unknown' as const,
      reason: 'provider-query-failed'
    }))
  } finally {
    try {
      unsubscribe?.()
    } catch {
      // Ignore disposer failures.
    }
  }

  return resolveRegisteredProviderReports({
    registeredIds,
    validReplies,
    invalidReplyIds
  })
}

function getEventBus(pi: ExtensionAPI): EventBus | null {
  const candidate = (pi as { events?: EventBus }).events
  if (
    candidate === undefined ||
    typeof candidate.on !== 'function' ||
    typeof candidate.emit !== 'function'
  ) {
    return null
  }
  return candidate
}

function waitForEvent(
  events: EventBus,
  eventName: string,
  timeoutMs: number,
  start: () => void
): Promise<unknown | null> {
  return new Promise((resolve) => {
    let settled = false
    let unsubscribe: (() => void) | void
    const timer = setTimeout(() => finish(null), timeoutMs)
    const finish = (value: unknown | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        unsubscribe?.()
      } catch {
        // Ignore disposer failures.
      }
      resolve(value)
    }
    try {
      unsubscribe = events.on(eventName, (data) => finish(data))
      start()
    } catch {
      finish(null)
    }
  })
}

function parseNonce(args: string): string | null {
  const nonce = args.trim()
  if (!isValidNonce(nonce)) return null
  if (nonce.length < MIN_NONCE_LENGTH || nonce.length > MAX_NONCE_LENGTH) return null
  return nonce
}

function dedupeProviders(providers: readonly ProviderReport[]): ProviderReport[] {
  const byId = new Map<string, ProviderReport>()
  for (const provider of providers) {
    const existing = byId.get(provider.id)
    if (existing === undefined) {
      byId.set(provider.id, provider)
      continue
    }
    // Prefer busy over unknown over idle when multiple sources report the same id.
    byId.set(provider.id, pickStricterProvider(existing, provider))
  }
  return [...byId.values()]
}

function pickStricterProvider(left: ProviderReport, right: ProviderReport): ProviderReport {
  const rank = { busy: 2, unknown: 1, idle: 0 } as const
  return rank[right.state] > rank[left.state] ? right : left
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
