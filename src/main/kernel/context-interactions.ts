import type { KernelAskAnswer, KernelExtensionDialogRequest } from '../../shared/kernel-contract.ts'
import type { PiRpcEvent } from '../pi-rpc/pi-rpc-data.ts'
import type { RuntimeHost } from '../runtime/runtime-host.ts'
import { errorMessage } from '../utils/errors.ts'
import { adaptedExtensionCommandAllowsBlockingUi } from './command-catalog.ts'
import { projectPiEvent } from './conversation-projection.ts'
import {
  askUiRequestMatchesStep,
  createAskResponsePlan,
  createInitialAskResponseStep,
  isAskToolName,
  normalizeAskUiRequest,
  projectAskQuestions
} from './ask-tool.ts'
import { assertExtensionDialogResponse, normalizeExtensionDialogRequest } from './extension-dialog.ts'
import {
  type AskInteraction,
  type ExtensionDialogInteraction,
  type RuntimeContext,
  type ProjectNavigationState
} from './workbench-kernel-types.ts'
import { unsupportedBlockingExtensionUiRequest } from './workbench-kernel-helpers.ts'

/** What Ask and Extension dialog interactions need from the Kernel. */
export type ContextInteractionsHost = {
  activeContext(): RuntimeContext | null
  activeRuntime(): RuntimeHost | null
  activeProjectKey(): string | null
  activeSessionKey(): string | null
  activeSessionId(): string | null
  projectNavigationState(projectPath: string): ProjectNavigationState
  publishContextState(
    context: RuntimeContext,
    navigationBefore: ProjectNavigationState | null,
    publication: 'patch' | 'snapshot'
  ): void
}

/**
 * Blocking user interactions raised by a Runtime: the inline Ask tool form and dialogs of
 * adapted Extension commands (moved unchanged from WorkbenchKernel, D-098).
 */
export class ContextInteractions {
  private readonly host: ContextInteractionsHost

  constructor(host: ContextInteractionsHost) {
    this.host = host
  }

  async submitAsk(
    sessionKey: string,
    toolCallId: string,
    answers: KernelAskAnswer[]
  ): Promise<void> {
    const context = this.requireActiveAskContext(sessionKey, toolCallId)
    const interaction = context.askInteraction!
    if (interaction.cancelling) throw new Error('Ask cancellation is already in progress.')
    if (interaction.responsePlan !== null) throw new Error('Ask answers are already being submitted.')
    const responsePlan = createAskResponsePlan(interaction.questions, answers)
    const pendingRequest = interaction.pendingRequest
    const firstStep = responsePlan[0]
    if (
      pendingRequest === null ||
      firstStep === undefined ||
      !askUiRequestMatchesStep(pendingRequest, firstStep)
    ) {
      throw new Error('Ask request is stale or mismatched.')
    }
    interaction.responsePlan = responsePlan
    interaction.nextResponseIndex = 0
    this.updateAskToolState(context, interaction, 'submitting', null)
    await this.deliverPendingAskResponse(context, interaction)
  }

  async cancelAsk(sessionKey: string, toolCallId: string): Promise<void> {
    const context = this.requireActiveAskContext(sessionKey, toolCallId)
    const interaction = context.askInteraction!
    if (interaction.cancelling && interaction.pendingRequest === null) {
      throw new Error('Ask cancellation is already in progress.')
    }
    interaction.cancelling = true
    this.updateAskToolState(context, interaction, 'submitting', null)
    if (interaction.pendingRequest !== null) {
      await this.deliverPendingAskResponse(context, interaction)
    }
  }

  async respondExtensionDialog(
    projectKey: string,
    sessionKey: string,
    sessionId: string,
    requestId: string,
    commandInvocationId: string,
    value: string
  ): Promise<void> {
    const { context, interaction } = this.requireActiveExtensionDialog(
      projectKey,
      sessionKey,
      sessionId,
      requestId,
      commandInvocationId
    )
    assertExtensionDialogResponse(interaction.request, value)
    await this.deliverExtensionDialogResponse(context, interaction, { value })
  }

  async cancelExtensionDialog(
    projectKey: string,
    sessionKey: string,
    sessionId: string,
    requestId: string,
    commandInvocationId: string
  ): Promise<void> {
    const { context, interaction } = this.requireActiveExtensionDialog(
      projectKey,
      sessionKey,
      sessionId,
      requestId,
      commandInvocationId
    )
    await this.deliverExtensionDialogResponse(context, interaction, { cancelled: true })
  }

  private requireActiveAskContext(sessionKey: string, toolCallId: string): RuntimeContext {
    const context = this.host.activeContext()
    if (
      context === null ||
      context.runtime !== this.host.activeRuntime() ||
      this.host.activeSessionKey() !== sessionKey ||
      context.state.activeSessionKey !== sessionKey
    ) {
      throw new Error('Ask request is stale or belongs to another Session.')
    }
    if (context.askInteraction?.toolCallId !== toolCallId) {
      throw new Error('Ask request is stale or mismatched.')
    }
    return context
  }

  private requireActiveExtensionDialog(
    projectKey: string,
    sessionKey: string,
    sessionId: string,
    requestId: string,
    commandInvocationId: string
  ): { context: RuntimeContext, interaction: ExtensionDialogInteraction } {
    const context = this.host.activeContext()
    if (
      context === null ||
      context.runtime !== this.host.activeRuntime() ||
      context.projectPath !== projectKey ||
      this.host.activeProjectKey() !== projectKey ||
      this.host.activeSessionKey() !== sessionKey ||
      this.host.activeSessionId() !== sessionId
    ) {
      throw new Error('Extension dialog is stale or belongs to another Session.')
    }
    const interaction = context.extensionDialogInteraction
    if (
      interaction?.request.requestId !== requestId ||
      interaction.request.commandInvocationId !== commandInvocationId
    ) {
      throw new Error('Extension dialog is stale or mismatched.')
    }
    if (
      context.extensionCommandInvocation?.id !== commandInvocationId ||
      context.extensionCommandInvocation.name !== interaction.request.commandName
    ) {
      throw new Error('Extension dialog command invocation is no longer active.')
    }
    if (interaction.request.status !== 'waiting') {
      throw new Error('Extension dialog response is already being submitted.')
    }
    return { context, interaction }
  }

  handleExtensionDialogRequest(context: RuntimeContext, event: PiRpcEvent): boolean {
    const normalized = normalizeExtensionDialogRequest(event)
    if (normalized === null) return false
    const invocation = context.extensionCommandInvocation
    if (
      invocation === null ||
      !invocation.active ||
      invocation.id !== normalized.commandInvocationId ||
      invocation.name !== normalized.commandName
    ) return false
    const command = context.state.commands.find((candidate) =>
      candidate.source === 'extension' && candidate.name === normalized.commandName
    )
    if (
      command === undefined ||
      !adaptedExtensionCommandAllowsBlockingUi(command, normalized.method)
    ) return false

    const sessionKey = context.state.activeSessionKey
    const sessionId = context.state.session.id
    if (sessionKey === null || sessionId === null) return false
    const existing = context.extensionDialogInteraction
    if (existing !== null) {
      return existing.request.requestId === normalized.requestId &&
        existing.request.commandInvocationId === normalized.commandInvocationId
    }

    const request: KernelExtensionDialogRequest = {
      ...normalized,
      projectKey: context.projectPath,
      sessionKey,
      sessionId,
      status: 'waiting',
      error: null
    }
    const interaction = { request }
    context.extensionDialogInteraction = interaction
    this.updateExtensionDialogState(context, interaction, 'waiting', null)
    return true
  }

  private async deliverExtensionDialogResponse(
    context: RuntimeContext,
    interaction: ExtensionDialogInteraction,
    response: { value: string } | { cancelled: true }
  ): Promise<void> {
    this.updateExtensionDialogState(context, interaction, 'submitting', null)
    context.extensionDialogInteraction = null
    try {
      await context.runtime.send(
        'value' in response
          ? {
              type: 'extension_ui_response',
              id: interaction.request.requestId,
              value: response.value
            }
          : {
              type: 'extension_ui_response',
              id: interaction.request.requestId,
              cancelled: true
            }
      )
    } catch (error) {
      if (
        context.extensionDialogInteraction === null &&
        context.state.extensionDialog?.requestId === interaction.request.requestId
      ) {
        context.extensionDialogInteraction = interaction
        this.updateExtensionDialogState(
          context,
          interaction,
          'waiting',
          `提交失败：${errorMessage(error)}`
        )
      }
      throw error
    }
    if (
      context.extensionDialogInteraction === null &&
      context.state.extensionDialog?.requestId === interaction.request.requestId
    ) {
      this.clearExtensionDialogState(context)
    }
  }

  private updateExtensionDialogState(
    context: RuntimeContext,
    interaction: ExtensionDialogInteraction,
    status: KernelExtensionDialogRequest['status'],
    error: string | null
  ): void {
    const navigationBefore = this.host.projectNavigationState(context.projectPath)
    interaction.request = { ...interaction.request, status, error }
    context.state = {
      ...context.state,
      extensionDialog: {
        ...interaction.request,
        options: [...interaction.request.options]
      }
    }
    this.host.publishContextState(context, navigationBefore, 'snapshot')
  }

  private clearExtensionDialogState(context: RuntimeContext): void {
    const navigationBefore = this.host.projectNavigationState(context.projectPath)
    context.extensionDialogInteraction = null
    context.state = { ...context.state, extensionDialog: null }
    this.host.publishContextState(context, navigationBefore, 'snapshot')
  }

  handleAskUiRequest(context: RuntimeContext, event: PiRpcEvent): boolean {
    const request = normalizeAskUiRequest(event)
    if (request === null) return false

    const interaction = context.askInteraction
    if (interaction === null) {
      const candidates = context.state.conversation.entries.flatMap((entry) => {
        if (
          entry.kind !== 'tool' ||
          entry.status !== 'running' ||
          !isAskToolName(entry.name)
        ) return []
        const questions = projectAskQuestions(entry.args)
        if (questions === null) return []
        const firstQuestion = questions[0]
        if (firstQuestion === undefined) return []
        const firstStep = createInitialAskResponseStep(firstQuestion)
        return askUiRequestMatchesStep(request, firstStep)
          ? [{ toolCallId: entry.toolCallId, questions }]
          : []
      })
      if (candidates.length !== 1) return false
      const candidate = candidates[0]!
      const nextInteraction: AskInteraction = {
        toolCallId: candidate.toolCallId,
        questions: candidate.questions,
        pendingRequest: request,
        responsePlan: null,
        nextResponseIndex: 0,
        cancelling: false
      }
      const navigationBefore = this.host.projectNavigationState(context.projectPath)
      context.askInteraction = nextInteraction
      this.updateAskToolState(context, nextInteraction, 'waiting', null, navigationBefore)
      return true
    }

    const step = interaction.responsePlan?.[interaction.nextResponseIndex]
    if (step === undefined || !askUiRequestMatchesStep(request, step)) return false
    interaction.pendingRequest = request
    void this.deliverPendingAskResponse(context, interaction).catch(() => undefined)
    return true
  }

  cancelUnsupportedExtensionUiRequest(context: RuntimeContext, event: PiRpcEvent): void {
    const request = unsupportedBlockingExtensionUiRequest(event)
    if (request === null) return
    void context.runtime.send({
      type: 'extension_ui_response',
      id: request.id,
      cancelled: true
    }).catch((error: unknown) => {
      const message = `Could not cancel unsupported Extension ${request.method} UI: ${errorMessage(error)}`
      const entries = projectPiEvent(context.state.conversation.entries, {
        type: 'extension_error',
        error: message
      })
      if (entries === context.state.conversation.entries) return
      const navigationBefore = this.host.projectNavigationState(context.projectPath)
      context.state = {
        ...context.state,
        conversation: { ...context.state.conversation, entries }
      }
      this.host.publishContextState(context, navigationBefore, 'snapshot')
    })
  }

  private async deliverPendingAskResponse(
    context: RuntimeContext,
    interaction: AskInteraction
  ): Promise<void> {
    if (context.askInteraction !== interaction) throw new Error('Ask request became stale.')
    const pendingRequest = interaction.pendingRequest
    if (pendingRequest === null) return

    const cancelling = interaction.cancelling
    const responseIndex = interaction.nextResponseIndex
    const step = cancelling ? undefined : interaction.responsePlan?.[responseIndex]
    if (!cancelling && (step === undefined || !askUiRequestMatchesStep(pendingRequest, step))) {
      throw new Error('Ask response sequence is stale or mismatched.')
    }

    interaction.pendingRequest = null
    if (!cancelling) interaction.nextResponseIndex += 1
    try {
      await context.runtime.send(
        cancelling
          ? { type: 'extension_ui_response', id: pendingRequest.id, cancelled: true }
          : { type: 'extension_ui_response', id: pendingRequest.id, value: step!.value }
      )
    } catch (error) {
      if (context.askInteraction === interaction) {
        interaction.pendingRequest = pendingRequest
        if (!cancelling) interaction.nextResponseIndex = responseIndex
        this.updateAskToolState(
          context,
          interaction,
          'submitting',
          `回答提交失败：${errorMessage(error)}`
        )
      }
      throw error
    }
  }

  private updateAskToolState(
    context: RuntimeContext,
    interaction: AskInteraction,
    status: 'waiting' | 'submitting',
    error: string | null,
    navigationBefore = this.host.projectNavigationState(context.projectPath)
  ): void {
    let changed = false
    const entries = context.state.conversation.entries.map((entry) => {
      if (
        entry.kind !== 'tool' ||
        entry.toolCallId !== interaction.toolCallId ||
        entry.status !== 'running'
      ) return entry
      changed = true
      return {
        ...entry,
        ask: {
          status,
          error,
          questions: interaction.questions.map((question) => ({
            ...question,
            options: question.options.map((option) => ({ ...option }))
          }))
        }
      }
    })
    if (!changed) throw new Error('Ask tool entry is unavailable.')
    context.state = {
      ...context.state,
      conversation: { ...context.state.conversation, entries }
    }
    this.host.publishContextState(context, navigationBefore, 'snapshot')
  }

  clearAskInteractionForEvent(
    context: RuntimeContext,
    event: PiRpcEvent
  ): ProjectNavigationState | null {
    const interaction = context.askInteraction
    if (
      interaction === null ||
      event.type !== 'tool_execution_end' ||
      event.toolCallId !== interaction.toolCallId
    ) return null
    const navigationBefore = this.host.projectNavigationState(context.projectPath)
    context.askInteraction = null
    return navigationBefore
  }
}
