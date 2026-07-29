import type { KernelPromptImage, ThinkingLevel } from '../../shared/kernel-contract.ts'
import type {
  PiRpcEvent,
  PiRpcAvailableModel,
  PiRpcEntriesResult,
  PiRpcExtensionEvent,
  PiRpcExtensionInventory,
  PiRpcForkResult,
  PiRpcModel,
  PiRpcSessionStats,
  PiRpcNavigateTreeResult,
  PiRpcSessionState,
  PiRpcSlashCommand,
  PiRpcTreeResult
} from '../pi-rpc/pi-rpc-client.ts'
import type {
  RuntimeHibernateLeaseResult,
  RuntimeQuiescenceQueryResult
} from './runtime-quiescence.ts'

export type RuntimeCommand =
  | { type: 'get_state' }
  | { type: 'get_session_stats' }
  | { type: 'get_messages' }
  | { type: 'get_entries' }
  | { type: 'get_tree' }
  | { type: 'navigate_tree'; targetEntryId: string }
  | { type: 'fork'; entryId: string }
  | { type: 'prompt'; message: string; images?: KernelPromptImage[] }
  | { type: 'steer'; message: string; images?: KernelPromptImage[] }
  | { type: 'follow_up'; message: string; images?: KernelPromptImage[] }
  | { type: 'abort' }
  | { type: 'set_model'; provider: string; modelId: string }
  | { type: 'set_thinking_level'; level: ThinkingLevel }
  | { type: 'get_commands' }
  | { type: 'get_available_models' }
  | { type: 'compact'; customInstructions?: string }
  | { type: 'set_session_name'; name: string }
  | { type: 'invoke_extension_command'; name: string; args?: string }
  | { type: 'subscribe_extension_events'; channels: string[] }
  | { type: 'extension_ui_response'; id: string; value: string }
  | { type: 'extension_ui_response'; id: string; cancelled: true }

export type RuntimeCommandResult =
  | { type: 'state'; state: PiRpcSessionState }
  | { type: 'session-statistics'; statistics: PiRpcSessionStats }
  | { type: 'messages'; messages: unknown[] }
  | ({ type: 'entries' } & PiRpcEntriesResult)
  | ({ type: 'tree' } & PiRpcTreeResult)
  | ({ type: 'tree-navigation' } & PiRpcNavigateTreeResult)
  | ({ type: 'forked' } & PiRpcForkResult)
  | { type: 'accepted' }
  | { type: 'model'; model: PiRpcModel }
  | { type: 'commands'; commands: PiRpcSlashCommand[] }
  | { type: 'available-models'; models: PiRpcAvailableModel[] }
  | { type: 'extension-event-subscription'; channels: string[] }

export type RuntimeHostState = {
  executable: string | null
  version: string | null
  stderrChars: number
  stderrSummary: string | null
  lastError: string | null
  exitCode: number | null
  exitSignal: string | null
}

export type RuntimeHostEvent =
  | { type: 'activity-started' }
  | { type: 'activity-settled' }
  | { type: 'pi-event'; event: PiRpcEvent }
  | {
      type: 'diagnostic'
      kind: 'stderr' | 'protocol' | 'process'
      message: string
      stderrChars: number
    }
  | {
      type: 'process-exit'
      code: number | null
      signal: string | null
    }

export interface RuntimeHost {
  start(): Promise<void>
  send(command: RuntimeCommand): Promise<RuntimeCommandResult>
  stop(): Promise<void>
  getState(): RuntimeHostState
  /**
   * Root Pi RPC process id while the child is alive.
   * Null when stopped, not started, or the host cannot expose a PID.
   * Descendants are intentionally out of scope for this identity.
   */
  getRpcPid(): number | null
  /**
   * Fetch the Pi host loaded-Extension inventory through the future `get_extensions` RPC.
   * The inventory carries no Main-owned runtimeId. A future Workbench caller must capture
   * the same RuntimeContext and runtimeId, then fence context membership and RuntimeHost
   * identity both before dispatch and after await. Any unsupported command or malformed
   * response rejects; callers must not infer inventory from commands, tools, or events.
   */
  getLoadedExtensions(): Promise<PiRpcExtensionInventory>
  subscribe(listener: (event: RuntimeHostEvent) => void): () => void
  /**
   * Subscribe to generic Pi Extension EventBus records on a dedicated Main-only path.
   * These records are never conversation/lifecycle RuntimeHostEvents. A caller must
   * fence the owning RuntimeContext/runtimeId around subscription and consumption.
   */
  subscribeExtensionEvents?(listener: (event: PiRpcExtensionEvent) => void): () => void
  /**
   * Query Pi-side quiescence through the app-owned internal extension command.
   * Fail-closed on timeout/malformed/nonce mismatch. Does not write Session transcript
   * and must not leak the internal setStatus event into GUI conversation state.
   * QUERY is observability only and never authorizes automatic hibernation.
   */
  queryQuiescence(options?: { timeoutMs?: number }): Promise<RuntimeQuiescenceQueryResult>
  /**
   * Generation-fenced prepare for safe automatic hibernation. Fences mutating host
   * commands locally, then asks the app-owned lease extension to prepare every expected
   * provider. Failure leaves the process running and clears the host fence.
   */
  prepareHibernation(input: {
    sessionId: string
    generation: number
    attemptId: string
    timeoutMs?: number
  }): Promise<RuntimeHibernateLeaseResult>
  /**
   * Commit a previously prepared lease. Keeps provider fences closed until process stop.
   */
  commitHibernation(input: {
    sessionId: string
    generation: number
    attemptId: string
    token: string
    timeoutMs?: number
  }): Promise<RuntimeHibernateLeaseResult>
  /**
   * Release an exact prepared/committed lease after stop failure. Stale identity/token
   * must not reopen a newer generation.
   */
  releaseHibernation(input: {
    sessionId: string
    generation: number
    attemptId: string
    token: string
    timeoutMs?: number
  }): Promise<RuntimeHibernateLeaseResult>
}
