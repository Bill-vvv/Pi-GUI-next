import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import {
  PROVIDER_QUERY_EVENT,
  PROVIDER_REGISTER_EVENT,
  PROVIDER_LEASE_PREPARE_EVENT,
  PROVIDER_LEASE_COMMIT_EVENT,
  PROVIDER_LEASE_RELEASE_EVENT,
  buildProviderReply,
  parseProviderQueryEvent,
  providerReplyEventName,
  PROVIDER_LEASE_REPLY_EVENT_PREFIX,
  isValidRequestId,
  isValidSessionId,
  isValidAttemptId,
  isValidLeaseToken,
  isValidRuntimeGeneration
} from '../../../extensions/pi-gui-runtime-quiescence/src/protocol.mjs'
import { isRecord } from '../utils/guards.ts'

export const NATIVE_AGENT_PROVIDER_ID = 'pi-gui-native-agents'

/** One fence for app-owned tool requests and background child Sessions. */
export class NativeAgentLease {
  private operations = 0
  private generation = 0
  private identity: string | null = null

  get activeCount(): number { return this.operations }

  begin(): () => void {
    if (this.identity !== null) throw new Error('Native agent operations are fenced for Runtime hibernation.')
    this.operations += 1
    let ended = false
    return () => {
      if (ended) return
      ended = true
      this.operations -= 1
    }
  }

  install(pi: ExtensionAPI): void {
    pi.on('session_start', () => {
      this.generation += 1
      this.identity = null
      pi.events.emit(PROVIDER_REGISTER_EVENT, { version: 1, providerId: NATIVE_AGENT_PROVIDER_ID })
    })
    pi.events.on(PROVIDER_QUERY_EVENT, (raw) => {
      const query = parseProviderQueryEvent(raw)
      if (query === null) return
      pi.events.emit(providerReplyEventName(query.requestId), buildProviderReply({
        requestId: query.requestId,
        providerId: NATIVE_AGENT_PROVIDER_ID,
        state: this.operations === 0 ? 'idle' : 'busy',
        ...(this.operations === 0 ? {} : { reason: 'native-agent-operation-active' })
      }))
    })
    for (const [eventName, action] of [
      [PROVIDER_LEASE_PREPARE_EVENT, 'prepare'],
      [PROVIDER_LEASE_COMMIT_EVENT, 'commit'],
      [PROVIDER_LEASE_RELEASE_EVENT, 'release']
    ] as const) {
      pi.events.on(eventName, (raw) => {
        if (!isRecord(raw) || raw.version !== 1 || !isValidRequestId(raw.requestId) ||
          !isValidSessionId(raw.sessionId) || !isValidRuntimeGeneration(raw.generation) ||
          !isValidAttemptId(raw.attemptId) || !isValidLeaseToken(raw.token)) return
        if (Object.keys(raw).some((key) => !['version', 'requestId', 'sessionId', 'generation', 'attemptId', 'token'].includes(key))) return
        const key = JSON.stringify([raw.sessionId, raw.generation, raw.attemptId, raw.token])
        const ok = action === 'prepare'
          ? raw.generation === this.generation && this.operations === 0 && (this.identity === null || this.identity === key)
          : this.identity === key
        if (ok) this.identity = action === 'release' ? null : key
        pi.events.emit(`${PROVIDER_LEASE_REPLY_EVENT_PREFIX}${raw.requestId}`, {
          version: 1,
          requestId: raw.requestId,
          providerId: NATIVE_AGENT_PROVIDER_ID,
          ok,
          ...(ok ? {} : { reason: 'native-agent-active-or-lease-mismatch' })
        })
      })
    }
  }
}
