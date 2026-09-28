import { VERSION } from '@earendil-works/pi-coding-agent'

import { createJsonlLogger, NOOP_LOGGER, type JsonlLogger } from '../utils/jsonl-log.ts'
import { errorMessage } from '../utils/errors.ts'
import {
  PI_RUNTIME_EXIT_DISPOSE_FAILED,
  PI_RUNTIME_EXIT_OUTPUT_BACKLOG,
  PI_RUNTIME_LOG_DIRECTORY_ENV,
  PI_RUNTIME_OUTPUT_BACKLOG_LIMIT_CHARS,
  isPiRuntimeRequest,
  type PiRuntimeMessage,
  type PiRuntimeRequest
} from './pi-runtime-protocol.ts'
import type { RuntimeHost } from './runtime-host.ts'
import type { SharedPiHost } from './shared-pi-host.ts'

type ServedRuntime = {
  runtime: RuntimeHost
  unsubscribe: () => void
}

const PARENT_DISCONNECT_EXIT_MS = 5_000

/**
 * Child side of the Pi Runtime process (D-094). Runs the existing SharedPiHost unchanged
 * and relays RuntimeHost calls, results and events to the Main-side proxy.
 */
export function servePiRuntimeHost(
  createHost: () => SharedPiHost,
  options: { outputBacklogLimitChars?: number } = {}
): void {
  if (typeof process.send !== 'function') {
    throw new Error('The Pi Runtime host must be started with an IPC channel.')
  }
  const logDirectory = process.env[PI_RUNTIME_LOG_DIRECTORY_ENV]
  // Both variables only launch this process. Remove them so Sessions, tools and their
  // descendants see the same environment they had inside Electron Main.
  delete process.env[PI_RUNTIME_LOG_DIRECTORY_ENV]
  delete process.env.ELECTRON_RUN_AS_NODE
  const logger: JsonlLogger = logDirectory === undefined || logDirectory.length === 0
    ? NOOP_LOGGER
    : createJsonlLogger({ directory: logDirectory, name: 'pi-runtime' })
  const outputBacklogLimitChars = options.outputBacklogLimitChars ?? PI_RUNTIME_OUTPUT_BACKLOG_LIMIT_CHARS
  const host = createHost()
  const runtimes = new Map<string, ServedRuntime>()
  let pendingChars = 0
  let exiting = false

  const exit = (code: number): void => {
    exiting = true
    process.exit(code)
  }

  const post = (message: PiRuntimeMessage): Promise<void> => {
    if (exiting) return Promise.resolve()
    const text = JSON.stringify(message)
    pendingChars += text.length
    if (pendingChars > outputBacklogLimitChars) {
      logger.write('error', 'pi-runtime-host', 'output-backlog-exceeded', { pendingChars })
      process.stderr.write('[Pi Runtime] Main stopped reading Runtime events; exiting.\n')
      exit(PI_RUNTIME_EXIT_OUTPUT_BACKLOG)
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      try {
        process.send!(text, (error: Error | null) => {
          pendingChars -= text.length
          // A closed channel means Main is gone; the disconnect handler owns shutdown.
          void error
          resolve()
        })
      } catch {
        pendingChars -= text.length
        resolve()
      }
    })
  }

  const respond = (id: number, result: { ok: true, value: unknown } | { ok: false, message: string }, runtime?: RuntimeHost): Promise<void> =>
    post({ type: 'response', id, ...result, ...(runtime === undefined ? {} : { state: runtime.getState() }) } as PiRuntimeMessage)

  const startRuntime = async (request: Extract<PiRuntimeRequest, { type: 'start' }>): Promise<void> => {
    if (runtimes.has(request.runtimeId)) {
      await respond(request.id, { ok: false, message: 'Pi Runtime identity is already in use.' })
      return
    }
    let runtime: RuntimeHost
    try {
      runtime = host.createRuntime(request.options)
    } catch (error) {
      await respond(request.id, { ok: false, message: errorMessage(error) })
      return
    }
    const unsubscribeEvents = runtime.subscribe((event) => {
      void post({ type: 'event', runtimeId: request.runtimeId, event, state: runtime.getState() })
    })
    const unsubscribeExtensionEvents = runtime.subscribeExtensionEvents?.((event) => {
      void post({ type: 'extension-event', runtimeId: request.runtimeId, event })
    }) ?? (() => {})
    runtimes.set(request.runtimeId, {
      runtime,
      unsubscribe: () => {
        unsubscribeEvents()
        unsubscribeExtensionEvents()
      }
    })
    try {
      await runtime.start()
      await respond(request.id, { ok: true, value: null }, runtime)
    } catch (error) {
      await respond(request.id, { ok: false, message: errorMessage(error) }, runtime)
    }
  }

  const callRuntime = async (request: Extract<PiRuntimeRequest, { type: 'call' }>): Promise<void> => {
    const served = runtimes.get(request.runtimeId)
    if (served === undefined) {
      await respond(request.id, { ok: false, message: 'Pi Runtime is not known to this process.' })
      return
    }
    const runtime = served.runtime
    try {
      const method = runtime[request.method] as (...args: unknown[]) => Promise<unknown>
      const value = await method.apply(runtime, request.args)
      if (request.method === 'stop') {
        served.unsubscribe()
        runtimes.delete(request.runtimeId)
      }
      await respond(request.id, { ok: true, value: value ?? null }, runtime)
    } catch (error) {
      await respond(request.id, { ok: false, message: errorMessage(error) }, runtime)
    }
  }

  const disposeHost = async (id: number): Promise<void> => {
    let failed = false
    try {
      await host.dispose()
      await respond(id, { ok: true, value: null })
    } catch (error) {
      failed = true
      logger.write('error', 'pi-runtime-host', 'dispose-failed', { message: errorMessage(error) })
      await respond(id, { ok: false, message: errorMessage(error) })
    }
    logger.write('info', 'pi-runtime-host', 'exit', { disposeFailed: failed })
    exit(failed ? PI_RUNTIME_EXIT_DISPOSE_FAILED : 0)
  }

  process.on('message', (message: unknown) => {
    if (!isPiRuntimeRequest(message)) {
      logger.write('error', 'pi-runtime-host', 'invalid-request')
      return
    }
    if (message.type === 'start') void startRuntime(message)
    else if (message.type === 'call') void callRuntime(message)
    else void disposeHost(message.id)
  })

  process.on('disconnect', () => {
    if (exiting) return
    logger.write('warn', 'pi-runtime-host', 'parent-disconnected', { runtimes: runtimes.size })
    setTimeout(() => exit(0), PARENT_DISCONNECT_EXIT_MS).unref()
    void host.dispose().catch(() => undefined).finally(() => exit(0))
  })

  // Keep the Electron Main behaviour this host replaces: a faulty Extension callback is
  // reported, not allowed to take down every other Session.
  process.on('uncaughtException', (error) => {
    logger.write('error', 'pi-runtime-host', 'uncaught-exception', { message: errorMessage(error) })
    process.stderr.write(`[Pi Runtime] Uncaught exception: ${error.stack ?? errorMessage(error)}\n`)
  })
  process.on('unhandledRejection', (reason) => {
    logger.write('error', 'pi-runtime-host', 'unhandled-rejection', { message: errorMessage(reason) })
    process.stderr.write(`[Pi Runtime] Unhandled rejection: ${reason instanceof Error ? reason.stack : errorMessage(reason)}\n`)
  })

  logger.write('info', 'pi-runtime-host', 'ready', { pid: process.pid, version: VERSION })
  void post({ type: 'ready', pid: process.pid, version: VERSION })
}
