import { existsSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DEFAULT_HIBERNATE_LEASE_TIMEOUT_MS,
  DEFAULT_QUIESCENCE_QUERY_TIMEOUT_MS,
  LEASE_COMMAND_NAME,
  LEASE_RESULT_KIND,
  LEASE_STATUS_KEY,
  MAX_NONCE_LENGTH,
  MAX_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  QUIESCENCE_COMMAND_NAME,
  QUIESCENCE_RESULT_KIND,
  QUIESCENCE_STATUS_KEY,
  buildLeaseCommandArgs,
  isInternalQuiescenceCommandName,
  isValidAttemptId,
  isValidLeaseToken,
  isValidNonce,
  isValidRuntimeGeneration,
  isValidSessionId,
  normalizeHibernateLeaseTimeoutMs,
  normalizeQuiescenceTimeoutMs,
  parseLeaseStatusPayload,
  parseQuiescenceStatusPayload
} from '../../../extensions/pi-gui-runtime-quiescence/src/protocol.mjs'

export {
  DEFAULT_HIBERNATE_LEASE_TIMEOUT_MS,
  DEFAULT_QUIESCENCE_QUERY_TIMEOUT_MS,
  LEASE_COMMAND_NAME,
  LEASE_RESULT_KIND,
  LEASE_STATUS_KEY,
  MAX_NONCE_LENGTH,
  MAX_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  QUIESCENCE_COMMAND_NAME,
  QUIESCENCE_RESULT_KIND,
  QUIESCENCE_STATUS_KEY,
  buildLeaseCommandArgs,
  isInternalQuiescenceCommandName,
  isValidAttemptId,
  isValidLeaseToken,
  isValidNonce,
  isValidRuntimeGeneration,
  isValidSessionId,
  normalizeHibernateLeaseTimeoutMs,
  normalizeQuiescenceTimeoutMs,
  parseLeaseStatusPayload,
  parseQuiescenceStatusPayload
}

export type RuntimeQuiescenceProviderState = 'idle' | 'busy' | 'unknown'

export type RuntimeQuiescenceProviderReport = {
  id: string
  state: RuntimeQuiescenceProviderState
  reason?: string
}

export type RuntimeQuiescenceResultPayload = {
  version: 1
  kind: typeof QUIESCENCE_RESULT_KIND
  nonce: string
  core: {
    idle: boolean
    pendingMessages: boolean
  }
  providers: RuntimeQuiescenceProviderReport[]
  quiescent: boolean
}

export type RuntimeQuiescenceQueryFailureReason =
  | 'runtime-not-running'
  | 'stopping'
  | 'timeout'
  | 'malformed'
  | 'nonce-mismatch'
  | 'prompt-failed'
  | 'extension-missing'

export type RuntimeQuiescenceQueryResult =
  | { ok: true; result: RuntimeQuiescenceResultPayload }
  | {
      ok: false
      reason: RuntimeQuiescenceQueryFailureReason
      message: string
      nonce?: string
    }

export type RuntimeHibernateLeaseAction = 'prepare' | 'commit' | 'release'

export type RuntimeHibernateLeaseSuccess = {
  ok: true
  action: RuntimeHibernateLeaseAction
  sessionId: string
  generation: number
  attemptId: string
  token?: string
  inventoryFingerprint?: string
  preparedProviders?: string[]
}

export type RuntimeHibernateLeaseFailureReason =
  | 'runtime-not-running'
  | 'stopping'
  | 'timeout'
  | 'malformed'
  | 'nonce-mismatch'
  | 'prompt-failed'
  | 'extension-missing'
  | 'lease-rejected'
  | 'fenced'
  | 'identity-mismatch'
  | 'invalid-input'

export type RuntimeHibernateLeaseBlocker = {
  id: string
  reason: string
}

export type RuntimeHibernateLeaseResult =
  | RuntimeHibernateLeaseSuccess
  | {
      ok: false
      reason: RuntimeHibernateLeaseFailureReason
      message: string
      action?: RuntimeHibernateLeaseAction
      nonce?: string
      leaseReason?: string
      blockers?: RuntimeHibernateLeaseBlocker[]
    }

export type ResolveRuntimeQuiescenceExtensionPathOptions = {
  isPackaged?: boolean
  resourcesPath?: string
  /**
   * Optional override used by tests. Defaults to this module's directory so
   * source checkouts and electron-vite `out/main` builds both resolve.
   */
  fromDirectory?: string
}

export function buildQuiescencePrompt(nonce: string): string {
  if (!isValidNonce(nonce)) {
    throw new Error('Quiescence query nonce must be a single-line non-empty token within bounds.')
  }
  return `/${QUIESCENCE_COMMAND_NAME} ${nonce}`
}

export function buildHibernateLeasePrompt(input: {
  action: RuntimeHibernateLeaseAction
  nonce: string
  sessionId: string
  generation: number
  attemptId: string
  token?: string
}): string {
  const args = buildLeaseCommandArgs(input)
  return `/${LEASE_COMMAND_NAME} ${args}`
}

export function isQuiescenceStatusEvent(event: {
  type?: unknown
  method?: unknown
  statusKey?: unknown
}): boolean {
  return (
    event.type === 'extension_ui_request' &&
    event.method === 'setStatus' &&
    event.statusKey === QUIESCENCE_STATUS_KEY
  )
}

export function isHibernateLeaseStatusEvent(event: {
  type?: unknown
  method?: unknown
  statusKey?: unknown
}): boolean {
  return (
    event.type === 'extension_ui_request' &&
    event.method === 'setStatus' &&
    event.statusKey === LEASE_STATUS_KEY
  )
}

/** Internal setStatus events that must never enter Kernel conversation state. */
export function isInternalRuntimeStatusEvent(event: {
  type?: unknown
  method?: unknown
  statusKey?: unknown
}): boolean {
  return isQuiescenceStatusEvent(event) || isHibernateLeaseStatusEvent(event)
}

const APP_OWNED_RUNTIME_EXTENSION_NAMES = [
  'pi-gui-runtime-quiescence',
  'pi-gui-task-notify',
  'pi-gui-ask',
  'pi-gui-openai-fast-mode',
  'pi-gui-history-navigation'
] as const

export function resolveRuntimeExtensionPaths(
  options: ResolveRuntimeQuiescenceExtensionPathOptions = {}
): string[] {
  return APP_OWNED_RUNTIME_EXTENSION_NAMES.map((name) =>
    resolveAppOwnedExtensionPath(name, options)
  )
}

export function resolveRuntimeQuiescenceExtensionPath(
  options: ResolveRuntimeQuiescenceExtensionPathOptions = {}
): string {
  return resolveAppOwnedExtensionPath('pi-gui-runtime-quiescence', options)
}

function resolveAppOwnedExtensionPath(
  name: (typeof APP_OWNED_RUNTIME_EXTENSION_NAMES)[number],
  options: ResolveRuntimeQuiescenceExtensionPathOptions
): string {
  const candidates: string[] = []
  if (options.isPackaged === true && typeof options.resourcesPath === 'string') {
    candidates.push(join(options.resourcesPath, `extensions/${name}/src/index.ts`))
  }

  const fromDirectory = options.fromDirectory ?? dirname(fileURLToPath(import.meta.url))
  // Source tree: src/main/runtime -> ../../../extensions/...
  candidates.push(join(fromDirectory, `../../../extensions/${name}/src/index.ts`))
  // electron-vite out/main bundle: out/main -> ../../extensions/...
  candidates.push(join(fromDirectory, `../../extensions/${name}/src/index.ts`))
  if (name === 'pi-gui-runtime-quiescence') {
    const envOverride = process.env.PI_GUI_QUIESCENCE_EXTENSION
    if (typeof envOverride === 'string' && envOverride.length > 0 && isAbsolute(envOverride)) {
      candidates.unshift(envOverride)
    }
  }

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  throw new Error(
    `${name} was not found. Expected source or packaged extensions path.`
  )
}

export function interpretQuiescenceStatusText(
  statusText: string | undefined,
  expectedNonce: string
): RuntimeQuiescenceQueryResult {
  if (statusText === undefined) {
    return {
      ok: false,
      reason: 'malformed',
      message: 'Quiescence status was cleared before delivery.',
      nonce: expectedNonce
    }
  }
  const parsed = parseQuiescenceStatusPayload(statusText, expectedNonce)
  if (!parsed.ok) {
    const reason: RuntimeQuiescenceQueryFailureReason =
      parsed.reason === 'nonce-mismatch' ? 'nonce-mismatch' : 'malformed'
    return {
      ok: false,
      reason,
      message: `Quiescence status payload rejected: ${parsed.reason}.`,
      nonce: expectedNonce
    }
  }
  return { ok: true, result: parsed.result as RuntimeQuiescenceResultPayload }
}

export function interpretHibernateLeaseStatusText(
  statusText: string | undefined,
  expectedNonce: string,
  expectedAction: RuntimeHibernateLeaseAction
): RuntimeHibernateLeaseResult {
  if (statusText === undefined) {
    return {
      ok: false,
      reason: 'malformed',
      message: 'Hibernate lease status was cleared before delivery.',
      action: expectedAction,
      nonce: expectedNonce
    }
  }
  const parsed = parseLeaseStatusPayload(statusText, expectedNonce)
  if (!parsed.ok) {
    const reason: RuntimeHibernateLeaseFailureReason =
      parsed.reason === 'nonce-mismatch' ? 'nonce-mismatch' : 'malformed'
    return {
      ok: false,
      reason,
      message: `Hibernate lease status payload rejected: ${parsed.reason}.`,
      action: expectedAction,
      nonce: expectedNonce
    }
  }
  const result = parsed.result as {
    action: RuntimeHibernateLeaseAction
    ok: boolean
    sessionId: string
    generation: number
    attemptId: string
    token?: string
    inventoryFingerprint?: string
    preparedProviders?: string[]
    reason?: string
    blockers?: RuntimeHibernateLeaseBlocker[]
  }
  if (result.action !== expectedAction) {
    return {
      ok: false,
      reason: 'malformed',
      message: 'Hibernate lease status action mismatch.',
      action: expectedAction,
      nonce: expectedNonce
    }
  }
  if (!result.ok) {
    return {
      ok: false,
      reason: 'lease-rejected',
      message: `Hibernate lease ${expectedAction} rejected by extension.`,
      action: expectedAction,
      nonce: expectedNonce,
      leaseReason: typeof result.reason === 'string' ? result.reason : 'lease-rejected',
      ...(Array.isArray(result.blockers)
        ? { blockers: result.blockers.map((blocker) => ({ ...blocker })) }
        : {})
    }
  }
  return {
    ok: true,
    action: result.action,
    sessionId: result.sessionId,
    generation: result.generation,
    attemptId: result.attemptId,
    ...(typeof result.token === 'string' ? { token: result.token } : {}),
    ...(typeof result.inventoryFingerprint === 'string'
      ? { inventoryFingerprint: result.inventoryFingerprint }
      : {}),
    ...(Array.isArray(result.preparedProviders)
      ? { preparedProviders: result.preparedProviders }
      : {})
  }
}

/** Mutating RuntimeHost.send commands blocked once prepare begins. */
export function isMutatingRuntimeCommandType(type: string): boolean {
  switch (type) {
    case 'prompt':
    case 'steer':
    case 'follow_up':
    case 'abort':
    case 'set_model':
    case 'set_thinking_level':
    case 'compact':
    case 'set_session_name':
    case 'fork':
    case 'navigate_tree':
    case 'invoke_extension_command':
    case 'subscribe_extension_events':
      return true
    default:
      return false
  }
}
