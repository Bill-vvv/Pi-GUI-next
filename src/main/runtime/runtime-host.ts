import type { ThinkingLevel } from '../../shared/kernel-contract.ts'
import type {
  PiRpcEvent,
  PiRpcAvailableModel,
  PiRpcModel,
  PiRpcSessionState,
  PiRpcSlashCommand
} from '../pi-rpc/pi-rpc-client.ts'

export type RuntimeCommand =
  | { type: 'get_state' }
  | { type: 'get_messages' }
  | { type: 'prompt'; message: string }
  | { type: 'abort' }
  | { type: 'set_model'; provider: string; modelId: string }
  | { type: 'set_thinking_level'; level: ThinkingLevel }
  | { type: 'get_commands' }
  | { type: 'get_available_models' }
  | { type: 'compact'; customInstructions?: string }
  | { type: 'set_session_name'; name: string }

export type RuntimeCommandResult =
  | { type: 'state'; state: PiRpcSessionState }
  | { type: 'messages'; messages: unknown[] }
  | { type: 'accepted' }
  | { type: 'model'; model: PiRpcModel }
  | { type: 'commands'; commands: PiRpcSlashCommand[] }
  | { type: 'available-models'; models: PiRpcAvailableModel[] }

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
  subscribe(listener: (event: RuntimeHostEvent) => void): () => void
}
