// Test-only Pi Runtime process entry: the real SharedPiHost and process server with fake
// Sessions. PI_RUNTIME_FIXTURE selects comma-separated behaviours for supervisor tests.
import type { PiRpcExtensionInventory } from '../pi-rpc/pi-rpc-data.ts'
import { servePiRuntimeHost } from './pi-runtime-host-server.ts'
import type { RuntimeCommand, RuntimeCommandResult } from './runtime-host.ts'
import { QUIESCENCE_COMMAND_NAME, QUIESCENCE_STATUS_KEY } from './runtime-quiescence.ts'
import type { SharedPiAgentSessionCallbacks, SharedPiSessionDriver } from './shared-pi-agent-session.ts'
import { SharedPiHost } from './shared-pi-host.ts'

const behaviours = new Set((process.env.PI_RUNTIME_FIXTURE ?? '').split(',').filter(Boolean))
let sessionCount = 0

class FixtureDriver implements SharedPiSessionDriver {
  readonly isStreaming = false
  readonly sessionFile: string
  private readonly callbacks: SharedPiAgentSessionCallbacks

  constructor(sessionFile: string, callbacks: SharedPiAgentSessionCallbacks) {
    this.sessionFile = sessionFile
    this.callbacks = callbacks
  }

  async send(command: RuntimeCommand): Promise<RuntimeCommandResult> {
    if (command.type === 'get_state') {
      return {
        type: 'state',
        state: {
          sessionFile: this.sessionFile,
          isStreaming: false,
          launchEnvironment: [process.env.ELECTRON_RUN_AS_NODE ?? null, process.env.PI_GUI_LOG_DIRECTORY ?? null]
        }
      }
    }
    if (command.type === 'get_commands') return { type: 'commands', commands: [] }
    if (command.type === 'invoke_extension_command' && command.name === QUIESCENCE_COMMAND_NAME) {
      this.callbacks.onEvent({
        type: 'extension_ui_request',
        method: 'setStatus',
        statusKey: QUIESCENCE_STATUS_KEY,
        statusText: JSON.stringify({
          version: 1,
          kind: 'pi-gui.runtime-quiescence/query-result',
          nonce: command.args,
          core: { idle: true, pendingMessages: false },
          providers: [],
          quiescent: true
        })
      })
      return { type: 'accepted' }
    }
    if (command.type === 'prompt') {
      if (behaviours.has('noisy')) console.log('extension output on stdout')
      if (behaviours.has('exit-on-prompt')) process.exit(9)
      if (behaviours.has('flood')) {
        const chunk = 'x'.repeat(1024 * 1024)
        for (let index = 0; index < 16; index++) this.callbacks.onEvent({ type: 'message_update', chunk })
      }
      this.callbacks.onEvent({ type: 'agent_start' })
      this.callbacks.onEvent({ type: 'message_update', text: command.message })
      this.callbacks.onEvent({ type: 'agent_settled' })
      this.callbacks.onExtensionEvent({ type: 'extension_event', channel: 'fixture', data: { ok: true } })
      return { type: 'accepted' }
    }
    throw new Error(`Unexpected fixture command: ${command.type}`)
  }

  getLoadedExtensions(): PiRpcExtensionInventory {
    return { protocolVersion: 1, complete: true, loading: 'eager_complete', extensions: [], loadErrorCount: 0 }
  }

  async dispose(): Promise<void> {
    if (behaviours.has('hang-dispose')) await new Promise(() => {})
  }
}

servePiRuntimeHost(() => new SharedPiHost({
  createSession: async (_environment, options, callbacks) => {
    if (behaviours.has('fail-start')) throw new Error('fixture start failure')
    const sessionFile = options.sessionFile ?? `/tmp/pi-runtime-fixture-${process.pid}-${++sessionCount}.jsonl`
    await callbacks.onIdentityChange(null, sessionFile)
    return new FixtureDriver(sessionFile, callbacks)
  }
}), { outputBacklogLimitChars: behaviours.has('flood') ? 4 * 1024 * 1024 : undefined })
