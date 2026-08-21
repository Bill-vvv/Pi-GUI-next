import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'

import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  createEventBus,
  getAgentDir,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionRuntime,
  type AgentSessionServices,
  type ExtensionUIContext
} from '@earendil-works/pi-coding-agent'

import type { KernelPromptImage, ThinkingLevel } from '../../shared/kernel-contract.ts'
import {
  normalizePiRpcSessionEntry,
  normalizePiRpcTreeResult,
  type PiRpcAvailableModel,
  type PiRpcEntriesResult,
  type PiRpcEvent,
  type PiRpcExtensionEvent,
  type PiRpcExtensionInventory,
  type PiRpcModel,
  type PiRpcNavigateTreeResult,
  type PiRpcSessionState,
  type PiRpcSessionStats,
  type PiRpcSlashCommand,
  type PiRpcTreeResult
} from '../pi-rpc/pi-rpc-client.ts'
import { errorMessage } from '../utils/errors.ts'
import {
  HISTORY_NAVIGATION_COMMAND_DESCRIPTION,
  HISTORY_NAVIGATION_COMMAND_NAME,
  buildHistoryNavigationCommandArgs
} from './history-navigation.ts'
import type { RuntimeCommand, RuntimeCommandResult } from './runtime-host.ts'
import type {
  SharedPiEnvironmentOverrides,
  SharedPiProcessEnvironment
} from './shared-pi-process-environment.ts'

const MAX_EXTENSION_COMMAND_NAME_LENGTH = 256
const MAX_EXTENSION_COMMAND_ARGS_LENGTH = 8_192
const MAX_EXTENSION_EVENT_CHANNELS = 32
const MAX_EXTENSION_EVENT_CHANNEL_LENGTH = 256
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u

const PROGRESS_SYSTEM_PROMPT =
  'For non-trivial tasks, provide brief user-visible commentary before important tool operations and after important discoveries. Do not narrate every tool call. Use commentary for progress updates and final_answer for the final response.'

type PendingExtensionRequest = {
  resolve: (response: { value?: string, cancelled?: boolean }) => void
}

export type SharedPiAgentSessionOptions = {
  cwd: string
  sessionFile?: string
  projectTrust?: boolean
  subagentMaxDepth?: number
  fastExtensionLoading?: boolean
  extensionPaths: string[]
  desktopNotification?: {
    socketPath: string
    token: string
  }
  openAiFastMode?: boolean
}

export type SharedPiAgentSessionCallbacks = {
  onEvent: (event: PiRpcEvent) => void
  onExtensionEvent: (event: PiRpcExtensionEvent) => void
  onIdentityChange: (previousSessionFile: string | null, nextSessionFile: string) => Promise<void>
  onShutdownRequested: () => void
}

export interface SharedPiSessionDriver {
  readonly sessionFile: string
  readonly isStreaming: boolean
  send(command: RuntimeCommand): Promise<RuntimeCommandResult>
  getLoadedExtensions(): PiRpcExtensionInventory
  dispose(): Promise<void>
}

export type SharedPiSessionFactory = (
  environment: SharedPiProcessEnvironment,
  options: SharedPiAgentSessionOptions,
  callbacks: SharedPiAgentSessionCallbacks
) => Promise<SharedPiSessionDriver>

function buildExtensionCommandPrompt(name: string, args?: string): string {
  if (
    name.length === 0 ||
    name.length > MAX_EXTENSION_COMMAND_NAME_LENGTH ||
    name.trim() !== name ||
    CONTROL_CHARACTER_PATTERN.test(name) ||
    /\s/u.test(name)
  ) {
    throw new Error('Extension command name is malformed.')
  }
  if (
    args !== undefined &&
    (args.length > MAX_EXTENSION_COMMAND_ARGS_LENGTH || CONTROL_CHARACTER_PATTERN.test(args))
  ) {
    throw new Error('Extension command arguments are malformed.')
  }
  return args === undefined || args.length === 0 ? `/${name}` : `/${name} ${args}`
}

function validateExtensionEventChannels(channels: readonly string[]): string[] {
  if (channels.length > MAX_EXTENSION_EVENT_CHANNELS) {
    throw new Error(
      `Pi RPC extension event channel count exceeds maximum of ${MAX_EXTENSION_EVENT_CHANNELS}`
    )
  }
  const seen = new Set<string>()
  const result: string[] = []
  for (const channel of channels) {
    if (
      channel.length === 0 ||
      channel.length > MAX_EXTENSION_EVENT_CHANNEL_LENGTH ||
      channel.trim() !== channel ||
      CONTROL_CHARACTER_PATTERN.test(channel)
    ) {
      throw new Error('Pi RPC extension event channel is malformed')
    }
    if (seen.has(channel)) continue
    seen.add(channel)
    result.push(channel)
  }
  return result
}

function environmentOverrides(options: SharedPiAgentSessionOptions): SharedPiEnvironmentOverrides {
  const fastExtensionLoading = options.fastExtensionLoading === true
  return {
    PI_PARALLEL_EXTENSION_IMPORTS: fastExtensionLoading ? '1' : '0',
    PI_NATIVE_COMPILED_EXTENSION_IMPORTS: fastExtensionLoading ? '1' : '0',
    JITI_TRY_NATIVE: fastExtensionLoading ? '0' : '1',
    PI_SUBAGENT_MAX_DEPTH: options.subagentMaxDepth === undefined
      ? undefined
      : String(options.subagentMaxDepth),
    PI_GUI_NOTIFICATION_SOCKET: options.desktopNotification?.socketPath,
    PI_GUI_NOTIFICATION_TOKEN: options.desktopNotification?.token,
    OPENAI_FAST_MODE: options.openAiFastMode === true ? '1' : undefined
  }
}

function createSessionManager(options: SharedPiAgentSessionOptions): SessionManager {
  return options.sessionFile === undefined
    ? SessionManager.create(options.cwd)
    : SessionManager.open(options.sessionFile)
}

function projectModel(model: AgentSession['model']): PiRpcModel | null {
  return model === undefined ? null : model as unknown as PiRpcModel
}

function requireSessionFile(session: AgentSession): string {
  const sessionFile = session.sessionFile
  if (sessionFile === undefined) throw new Error('Pi SDK Session did not expose a session file.')
  return sessionFile
}

function projectAvailableModel(model: Awaited<ReturnType<AgentSession['modelRuntime']['getAvailable']>>[number]): PiRpcAvailableModel {
  return {
    id: model.id,
    provider: model.provider,
    ...(typeof model.name === 'string' ? { name: model.name } : {}),
    ...(typeof model.reasoning === 'boolean' ? { reasoning: model.reasoning } : {}),
    ...(model.thinkingLevelMap === undefined ? {} : { thinkingLevelMap: model.thinkingLevelMap }),
    ...(typeof model.contextWindow === 'number' ? { contextWindow: model.contextWindow } : {}),
    ...(model.cost === undefined ? {} : { cost: model.cost })
  } as PiRpcAvailableModel
}

function commandSourceInfo(sourceInfo: { source: string, scope: string, origin: string }): PiRpcSlashCommand['sourceInfo'] {
  if (
    (sourceInfo.scope !== 'user' && sourceInfo.scope !== 'project' && sourceInfo.scope !== 'temporary') ||
    (sourceInfo.origin !== 'package' && sourceInfo.origin !== 'top-level')
  ) {
    throw new Error('Pi command source metadata is malformed.')
  }
  return {
    source: sourceInfo.source,
    scope: sourceInfo.scope,
    origin: sourceInfo.origin
  }
}

function extensionInventory(services: AgentSessionServices): PiRpcExtensionInventory {
  const result = services.resourceLoader.getExtensions()
  return {
    protocolVersion: 1,
    complete: true,
    loading: 'eager_complete',
    loadErrorCount: result.errors.length,
    extensions: result.extensions.map((extension, index) => {
      const capabilities: PiRpcExtensionInventory['extensions'][number]['capabilities'] = []
      if (extension.handlers.size > 0) capabilities.push('event')
      if (extension.tools.size > 0) capabilities.push('tool')
      if (extension.commands.size > 0) capabilities.push('command')
      if (extension.flags.size > 0) capabilities.push('flag')
      if (extension.shortcuts.size > 0) capabilities.push('shortcut')
      if (extension.messageRenderers.size > 0) capabilities.push('message_renderer')
      if ((extension.entryRenderers?.size ?? 0) > 0) capabilities.push('entry_renderer')
      const stem = basename(extension.resolvedPath).replace(/[^A-Za-z0-9._:@-]/gu, '-')
      return {
        id: `${stem.length === 0 ? 'extension' : stem}-${index + 1}`,
        capabilities
      }
    })
  }
}

export class SharedPiAgentSession implements SharedPiSessionDriver {
  private readonly environment: SharedPiProcessEnvironment
  private readonly options: SharedPiAgentSessionOptions
  private readonly callbacks: SharedPiAgentSessionCallbacks
  private readonly overrides: SharedPiEnvironmentOverrides
  private runtime: AgentSessionRuntime | null = null
  private currentSessionFile: string | null = null
  private unsubscribeSession: (() => void) | null = null
  private pendingExtensionRequests = new Map<string, PendingExtensionRequest>()
  private extensionEventChannels = new Set<string>()
  private disposed = false

  private constructor(
    environment: SharedPiProcessEnvironment,
    options: SharedPiAgentSessionOptions,
    callbacks: SharedPiAgentSessionCallbacks
  ) {
    this.environment = environment
    this.options = options
    this.callbacks = callbacks
    this.overrides = environmentOverrides(options)
  }

  static async create(
    environment: SharedPiProcessEnvironment,
    options: SharedPiAgentSessionOptions,
    callbacks: SharedPiAgentSessionCallbacks
  ): Promise<SharedPiAgentSession> {
    const driver = new SharedPiAgentSession(environment, options, callbacks)
    try {
      await driver.initialize()
      return driver
    } catch (startupError) {
      try {
        await driver.dispose()
      } catch (cleanupError) {
        throw new AggregateError(
          [startupError, cleanupError],
          'Shared Pi Session startup and cleanup both failed.'
        )
      }
      throw startupError
    }
  }

  get sessionFile(): string {
    return requireSessionFile(this.requireSession())
  }

  get isStreaming(): boolean {
    return this.runtime?.session.isStreaming === true
  }

  private runScoped<T>(operation: () => T): T {
    if (this.disposed) throw new Error('Shared Pi Session is disposed.')
    return this.environment.run(this.overrides, operation)
  }

  private async initialize(): Promise<void> {
    await this.runScoped(async () => {
      const agentDir = getAgentDir()
      const createRuntime = async (input: {
        cwd: string
        agentDir: string
        sessionManager: SessionManager
        sessionStartEvent?: Parameters<typeof createAgentSessionFromServices>[0]['sessionStartEvent']
      }) => {
        const eventBus = createEventBus()
        const bridgedEventBus = {
          emit: (channel: string, data: unknown) => {
            eventBus.emit(channel, data)
            if (this.extensionEventChannels.has(channel)) {
              this.callbacks.onExtensionEvent({ type: 'extension_event', channel, data })
            }
          },
          on: eventBus.on,
          clear: eventBus.clear
        }
        const settingsManager = SettingsManager.create(input.cwd, input.agentDir, {
          projectTrusted: this.options.projectTrust ?? true
        })
        const services = await createAgentSessionServices({
          cwd: input.cwd,
          agentDir: input.agentDir,
          settingsManager,
          resourceLoaderOptions: {
            eventBus: bridgedEventBus,
            appendSystemPrompt: [PROGRESS_SYSTEM_PROMPT],
            additionalExtensionPaths: this.options.extensionPaths
          }
        })
        const errorCount = services.diagnostics.filter(({ type }) => type === 'error').length
        if (errorCount > 0) {
          eventBus.clear()
          throw new Error(`Pi SDK runtime initialization failed with ${errorCount} error diagnostic(s).`)
        }
        const created = await createAgentSessionFromServices({
          services,
          sessionManager: input.sessionManager,
          sessionStartEvent: input.sessionStartEvent
        })
        return { ...created, services, diagnostics: services.diagnostics }
      }

      this.runtime = await createAgentSessionRuntime(createRuntime, {
        cwd: this.options.cwd,
        agentDir,
        sessionManager: createSessionManager(this.options),
        sessionStartEvent: { type: 'session_start', reason: 'startup' }
      })
      this.runtime.setRebindSession(async () => {
        await this.bindCurrentSession()
      })
      await this.bindCurrentSession()
    })
  }

  private async bindCurrentSession(): Promise<void> {
    const runtime = this.requireRuntime()
    const session = runtime.session
    const nextSessionFile = requireSessionFile(session)
    const previousSessionFile = this.currentSessionFile
    await this.callbacks.onIdentityChange(previousSessionFile, nextSessionFile)
    this.currentSessionFile = nextSessionFile

    const baseUi = session.extensionRunner.getUIContext()
    await session.bindExtensions({
      uiContext: this.createExtensionUiContext(baseUi),
      mode: 'rpc',
      commandContextActions: {
        waitForIdle: () => session.waitForIdle(),
        newSession: async (options) => runtime.newSession(options),
        fork: async (entryId, options) => {
          const result = await runtime.fork(entryId, options)
          return { cancelled: result.cancelled }
        },
        navigateTree: async (targetId, options) => {
          const result = await session.navigateTree(targetId, options)
          return { cancelled: result.cancelled }
        },
        switchSession: async (sessionPath, options) => runtime.switchSession(sessionPath, options),
        reload: async () => {
          await session.reload()
        }
      },
      shutdownHandler: this.callbacks.onShutdownRequested,
      onError: (error) => {
        this.callbacks.onEvent({
          type: 'extension_error',
          extensionPath: error.extensionPath,
          event: error.event,
          error: error.error
        })
      }
    })
    this.unsubscribeSession?.()
    this.unsubscribeSession = session.subscribe((event) => {
      this.callbacks.onEvent(event as PiRpcEvent)
    })
  }

  private createExtensionUiContext(baseUi: ExtensionUIContext): ExtensionUIContext {
    const request = (
      method: 'select' | 'confirm' | 'input' | 'editor',
      payload: Record<string, unknown>
    ): Promise<{ value?: string, cancelled?: boolean }> => {
      const id = randomUUID()
      this.callbacks.onEvent({ type: 'extension_ui_request', id, method, ...payload })
      return new Promise((resolve) => {
        this.pendingExtensionRequests.set(id, { resolve })
      })
    }

    return {
      select: async (title, options) => {
        const response = await request('select', { title, options })
        return response.cancelled === true ? undefined : response.value
      },
      confirm: async (title, message) => {
        const response = await request('confirm', { title, message })
        return response.cancelled !== true && response.value === 'true'
      },
      input: async (title, placeholder) => {
        const response = await request('input', { title, placeholder })
        return response.cancelled === true ? undefined : response.value
      },
      notify: (message, notifyType) => {
        this.callbacks.onEvent({
          type: 'extension_ui_request',
          id: randomUUID(),
          method: 'notify',
          message,
          notifyType
        })
      },
      onTerminalInput: () => () => {},
      setStatus: (statusKey, statusText) => {
        this.callbacks.onEvent({
          type: 'extension_ui_request',
          id: randomUUID(),
          method: 'setStatus',
          statusKey,
          statusText
        })
      },
      setWorkingMessage: (message) => {
        this.callbacks.onEvent({
          type: 'extension_ui_request',
          id: randomUUID(),
          method: 'setWorkingMessage',
          message
        })
      },
      setWorkingVisible: () => {},
      setWorkingIndicator: () => {},
      setHiddenThinkingLabel: () => {},
      setWidget: () => {},
      setFooter: () => {},
      setHeader: () => {},
      setTitle: (title) => {
        this.callbacks.onEvent({
          type: 'extension_ui_request',
          id: randomUUID(),
          method: 'setTitle',
          title
        })
      },
      custom: async () => undefined as never,
      pasteToEditor: () => {},
      setEditorText: () => {},
      getEditorText: () => '',
      editor: async (title, prefill) => {
        const response = await request('editor', { title, prefill })
        return response.cancelled === true ? undefined : response.value
      },
      addAutocompleteProvider: () => {},
      setEditorComponent: () => {},
      getEditorComponent: () => undefined,
      get theme() {
        return baseUi.theme
      },
      getAllThemes: () => baseUi.getAllThemes(),
      getTheme: (name) => baseUi.getTheme(name),
      setTheme: () => ({ success: false, error: 'Theme switching not supported in RPC mode' }),
      getToolsExpanded: () => false,
      setToolsExpanded: () => {}
    }
  }

  private requireRuntime(): AgentSessionRuntime {
    if (this.runtime === null) throw new Error('Shared Pi Session is not running.')
    return this.runtime
  }

  private requireSession(): AgentSession {
    return this.requireRuntime().session
  }

  private async acceptPrompt(message: string, images?: readonly KernelPromptImage[]): Promise<void> {
    const session = this.requireSession()
    await new Promise<void>((resolve, reject) => {
      let accepted = false
      void session.prompt(message, {
        images: images === undefined ? undefined : [...images],
        source: 'rpc',
        preflightResult: (succeeded) => {
          if (!succeeded || accepted) return
          accepted = true
          resolve()
        }
      }).catch((error: unknown) => {
        if (!accepted) reject(error)
      })
    })
  }

  async send(command: RuntimeCommand): Promise<RuntimeCommandResult> {
    return await this.runScoped(async () => {
      const session = this.requireSession()
      const runtime = this.requireRuntime()

      if (command.type === 'get_state') {
        const state: PiRpcSessionState = {
          model: projectModel(session.model),
          thinkingLevel: session.thinkingLevel,
          isStreaming: session.isStreaming,
          isCompacting: session.isCompacting,
          steeringMode: session.steeringMode,
          followUpMode: session.followUpMode,
          sessionFile: session.sessionFile,
          sessionId: session.sessionId,
          sessionName: session.sessionName,
          autoCompactionEnabled: session.autoCompactionEnabled,
          messageCount: session.messages.length,
          pendingMessageCount: session.pendingMessageCount,
          sessionStats: session.getSessionStats() as PiRpcSessionStats
        }
        return { type: 'state', state }
      }
      if (command.type === 'get_session_stats') {
        return {
          type: 'session-statistics',
          statistics: session.getSessionStats() as PiRpcSessionStats
        }
      }
      if (command.type === 'get_messages') {
        return { type: 'messages', messages: [...session.messages] }
      }
      if (command.type === 'get_entries') {
        const result: PiRpcEntriesResult = {
          entries: session.sessionManager.getEntries().map(normalizePiRpcSessionEntry),
          leafId: session.sessionManager.getLeafId()
        }
        return { type: 'entries', ...result }
      }
      if (command.type === 'get_tree') {
        const result: PiRpcTreeResult = normalizePiRpcTreeResult({
          tree: session.sessionManager.getTree(),
          leafId: session.sessionManager.getLeafId()
        })
        return { type: 'tree', ...result }
      }
      if (command.type === 'navigate_tree') {
        const before = session.sessionManager.getEntries().map(normalizePiRpcSessionEntry)
        const target = before.find(({ id }) => id === command.targetEntryId)
        if (
          target?.type !== 'message' ||
          target.message?.role !== 'user' ||
          target.message.content === undefined
        ) {
          throw new Error('History navigation target must be a projected user message.')
        }
        const extensionCommand = this.projectCommands().find((candidate) =>
          candidate.name === HISTORY_NAVIGATION_COMMAND_NAME &&
          candidate.description === HISTORY_NAVIGATION_COMMAND_DESCRIPTION &&
          candidate.source === 'extension' &&
          candidate.sourceInfo.source === 'cli' &&
          candidate.sourceInfo.scope === 'temporary' &&
          candidate.sourceInfo.origin === 'top-level'
        )
        if (extensionCommand === undefined) {
          throw new Error('Pi GUI history navigation Extension command is unavailable.')
        }
        await this.acceptPrompt(buildExtensionCommandPrompt(
          HISTORY_NAVIGATION_COMMAND_NAME,
          buildHistoryNavigationCommandArgs(command.targetEntryId)
        ))
        const result: PiRpcNavigateTreeResult = {
          targetEntryId: command.targetEntryId,
          cancelled: false,
          leafId: session.sessionManager.getLeafId(),
          editorText: target.message.content.text
        }
        if (result.leafId !== target.parentId) {
          throw new Error('Pi history navigation did not select the prompt parent.')
        }
        return { type: 'tree-navigation', ...result }
      }
      if (command.type === 'fork') {
        const result = await runtime.fork(command.entryId)
        return {
          type: 'forked',
          text: result.selectedText ?? '',
          cancelled: result.cancelled
        }
      }
      if (command.type === 'prompt') {
        await this.acceptPrompt(command.message, command.images)
        return { type: 'accepted' }
      }
      if (command.type === 'steer') {
        await session.steer(command.message, command.images === undefined ? undefined : [...command.images])
        return { type: 'accepted' }
      }
      if (command.type === 'follow_up') {
        await session.followUp(command.message, command.images === undefined ? undefined : [...command.images])
        return { type: 'accepted' }
      }
      if (command.type === 'abort') {
        await session.abort()
        return { type: 'accepted' }
      }
      if (command.type === 'set_model') {
        const model = (await session.modelRuntime.getAvailable()).find((candidate) =>
          candidate.provider === command.provider && candidate.id === command.modelId
        )
        if (model === undefined) {
          throw new Error(`Model not found: ${command.provider}/${command.modelId}`)
        }
        await session.setModel(model)
        return { type: 'model', model: model as unknown as PiRpcModel }
      }
      if (command.type === 'set_thinking_level') {
        session.setThinkingLevel(command.level as ThinkingLevel)
        return { type: 'accepted' }
      }
      if (command.type === 'get_commands') {
        return { type: 'commands', commands: this.projectCommands() }
      }
      if (command.type === 'get_available_models') {
        return {
          type: 'available-models',
          models: (await session.modelRuntime.getAvailable()).map(projectAvailableModel)
        }
      }
      if (command.type === 'compact') {
        await session.compact(command.customInstructions)
        return { type: 'accepted' }
      }
      if (command.type === 'set_session_name') {
        const name = command.name.trim()
        if (name.length === 0) throw new Error('Session name cannot be empty')
        session.setSessionName(name)
        return { type: 'accepted' }
      }
      if (command.type === 'invoke_extension_command') {
        await this.acceptPrompt(buildExtensionCommandPrompt(command.name, command.args))
        return { type: 'accepted' }
      }
      if (command.type === 'subscribe_extension_events') {
        const channels = validateExtensionEventChannels(command.channels)
        this.extensionEventChannels = new Set(channels)
        return { type: 'extension-event-subscription', channels }
      }
      if (command.type === 'extension_ui_response') {
        const pending = this.pendingExtensionRequests.get(command.id)
        if (pending !== undefined) {
          this.pendingExtensionRequests.delete(command.id)
          pending.resolve('value' in command
            ? { value: command.value }
            : { cancelled: true })
        }
        return { type: 'accepted' }
      }

      command satisfies never
      throw new Error('Unsupported runtime command.')
    })
  }

  private projectCommands(): PiRpcSlashCommand[] {
    const session = this.requireSession()
    const commands: PiRpcSlashCommand[] = []
    for (const command of session.extensionRunner.getRegisteredCommands()) {
      commands.push({
        name: command.invocationName,
        ...(command.description === undefined ? {} : { description: command.description }),
        source: 'extension',
        sourceInfo: commandSourceInfo(command.sourceInfo)
      })
    }
    for (const template of session.promptTemplates) {
      commands.push({
        name: template.name,
        ...(template.description === undefined ? {} : { description: template.description }),
        source: 'prompt',
        sourceInfo: commandSourceInfo(template.sourceInfo)
      })
    }
    for (const skill of session.resourceLoader.getSkills().skills) {
      commands.push({
        name: `skill:${skill.name}`,
        description: skill.description,
        source: 'skill',
        sourceInfo: commandSourceInfo(skill.sourceInfo)
      })
    }
    return commands
  }

  getLoadedExtensions(): PiRpcExtensionInventory {
    return extensionInventory(this.requireRuntime().services)
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    await this.runScoped(async () => {
      const runtime = this.runtime
      if (runtime !== null) {
        await runtime.session.abort()
        await runtime.session.waitForIdle()
        await runtime.dispose()
      }
    }).catch((error: unknown) => {
      throw new Error(`Shared Pi Session disposal failed: ${errorMessage(error)}`)
    })
    this.disposed = true
    this.unsubscribeSession?.()
    this.unsubscribeSession = null
    for (const pending of this.pendingExtensionRequests.values()) {
      pending.resolve({ cancelled: true })
    }
    this.pendingExtensionRequests.clear()
    this.extensionEventChannels.clear()
    this.runtime = null
  }
}
