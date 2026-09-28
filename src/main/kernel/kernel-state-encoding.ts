import type {
  KernelConversationEntry,
  KernelConversationEntryPatch,
  KernelConversationState,
  KernelMessageAttachment,
  KernelModelState,
  KernelSessionSummary,
  KernelState,
  KernelStatePatch,
  KernelSubagentParticipant,
  KernelSubagentRun,
  KernelToolEntry,
  KernelToolEntryPatchMetadata
} from '../../shared/kernel-contract.ts'
import {
  copyAppearanceSettings,
  copyGeneralSettings,
  copySessionNamingSettings,
  copySubagentSettings
} from '../../shared/workbench-settings.ts'
import { copyShortcutSettings } from '../../shared/shortcut-settings.ts'
import { copyToolImageAttachments, sameToolImageAttachments } from './tool-result-images.ts'

// Pure snapshot isolation and incremental event encoding. Runtime ownership,
// revision allocation, conversation windows and publication remain in the Kernel.
function copySessionSummary(session: KernelSessionSummary): KernelSessionSummary {
  return {
    ...session,
    ...(session.provisional === true ? { provisional: true as const } : {}),
    statistics: session.statistics === null ? null : { ...session.statistics }
  }
}

export function copyState(
  state: KernelState,
  conversation: KernelConversationState = state.conversation
): KernelState {
  return {
    projects: state.projects.map((project) => ({
      ...project,
      ...(project.sessions === undefined
        ? {}
        : { sessions: project.sessions.map(copySessionSummary) })
    })),
    navigatorKind: state.navigatorKind,
    activeProjectKey: state.activeProjectKey,
    sessions: state.sessions.map(copySessionSummary),
    activeSessionKey: state.activeSessionKey,
    projectTrustRequest: state.projectTrustRequest === null
      ? null
      : { ...state.projectTrustRequest },
    extensionDialog: state.extensionDialog === null || state.extensionDialog === undefined
      ? null
      : {
          ...state.extensionDialog,
          options: [...state.extensionDialog.options]
        },
    commands: state.commands.map((command) => ({
      ...command,
      sourceInfo: command.sourceInfo === null ? null : { ...command.sourceInfo }
    })),
    extensions: state.extensions.map((extension) => ({ ...extension })),
    availableModels: state.availableModels.map((model) => ({
      ...model,
      thinkingLevelMap: { ...model.thinkingLevelMap },
      ...(model.pricing === undefined ? {} : { pricing: copyModelPricing(model.pricing) })
    })),
    sessionNaming: copySessionNamingSettings(state.sessionNaming),
    appearance: copyAppearanceSettings(state.appearance),
    general: copyGeneralSettings(state.general),
    subagent: copySubagentSettings(state.subagent),
    shortcuts: copyShortcutSettings(state.shortcuts),
    advisor: { ...state.advisor },
    runtime: { ...state.runtime },
    session: {
      ...state.session,
      pendingSteeringMessages: [...state.session.pendingSteeringMessages],
      pendingFollowUpMessages: [...state.session.pendingFollowUpMessages],
      compaction: state.session.compaction === null ? null : { ...state.session.compaction },
      usage: state.session.usage === null ? null : { ...state.session.usage },
      model: state.session.model === null
        ? null
        : {
            ...state.session.model,
            thinkingLevelMap: { ...state.session.model.thinkingLevelMap },
            ...(state.session.model.pricing === undefined
              ? {}
              : { pricing: copyModelPricing(state.session.model.pricing) })
          }
    },
    conversation: {
      entries: conversation.entries.map(copyConversationEntry),
      startIndex: conversation.startIndex,
      activeRunStartIndex: conversation.activeRunStartIndex
    }
  }
}

function copyModelPricing(
  pricing: NonNullable<KernelModelState['pricing']>
): NonNullable<KernelModelState['pricing']> {
  return {
    ...pricing,
    ...(pricing.tiers === undefined
      ? {}
      : { tiers: pricing.tiers.map((tier) => ({ ...tier })) })
  }
}

export function createStatePatch(previous: KernelState, next: KernelState): KernelStatePatch | null {
  if (
    next.projects !== previous.projects ||
    next.navigatorKind !== previous.navigatorKind ||
    next.sessions !== previous.sessions ||
    next.activeProjectKey !== previous.activeProjectKey ||
    next.activeSessionKey !== previous.activeSessionKey ||
    next.projectTrustRequest !== previous.projectTrustRequest ||
    next.sessionNaming !== previous.sessionNaming ||
    next.appearance !== previous.appearance ||
    next.general !== previous.general ||
    next.subagent !== previous.subagent ||
    next.shortcuts !== previous.shortcuts ||
    next.advisor !== previous.advisor
  ) {
    return null
  }
  const patch: KernelStatePatch = {
    projectKey: next.activeProjectKey,
    sessionKey: next.activeSessionKey
  }
  if (next.runtime !== previous.runtime) patch.runtime = next.runtime
  if (next.session !== previous.session) patch.session = next.session

  const conversationPatch: NonNullable<KernelStatePatch['conversation']> = {}
  const previousEntries = previous.conversation.entries
  const nextEntries = next.conversation.entries
  if (nextEntries !== previousEntries) {
    if (nextEntries.length < previousEntries.length) return null
    const entries: NonNullable<typeof conversationPatch.entries> = []
    for (let index = 0; index < nextEntries.length; index += 1) {
      const entry = nextEntries[index]
      if (entry === undefined) return null
      if (index < previousEntries.length) {
        const previousEntry = previousEntries[index]
        if (previousEntry === undefined || previousEntry.id !== entry.id) return null
        if (previousEntry === entry) continue
        entries.push(createConversationEntryPatch(previousEntry, entry, index))
        continue
      }
      entries.push({ type: 'insert', index, entry })
    }
    if (entries.length > 0) conversationPatch.entries = entries
  }
  if (next.conversation.activeRunStartIndex !== previous.conversation.activeRunStartIndex) {
    conversationPatch.activeRunStartIndex = next.conversation.activeRunStartIndex
  }
  if (Object.keys(conversationPatch).length > 0) patch.conversation = conversationPatch
  return patch
}

export function copyPatch(patch: KernelStatePatch): KernelStatePatch {
  return {
    projectKey: patch.projectKey,
    sessionKey: patch.sessionKey,
    ...(patch.runtime === undefined ? {} : { runtime: { ...patch.runtime } }),
    ...(patch.session === undefined
      ? {}
      : {
          session: {
            ...patch.session,
            pendingSteeringMessages: [...patch.session.pendingSteeringMessages],
            pendingFollowUpMessages: [...patch.session.pendingFollowUpMessages],
            compaction: patch.session.compaction === null ? null : { ...patch.session.compaction },
            usage: patch.session.usage === null ? null : { ...patch.session.usage },
            model: patch.session.model === null
              ? null
              : {
                  ...patch.session.model,
                  thinkingLevelMap: { ...patch.session.model.thinkingLevelMap },
                  ...(patch.session.model.pricing === undefined
                    ? {}
                    : { pricing: copyModelPricing(patch.session.model.pricing) })
                }
          }
        }),
    ...(patch.conversation === undefined
      ? {}
      : {
          conversation: {
            ...(patch.conversation.entries === undefined
              ? {}
              : {
                  entries: patch.conversation.entries.map((entryPatch) => {
                    if (
                      entryPatch.type === 'insert' ||
                      entryPatch.type === 'replace-entry'
                    ) {
                      return { ...entryPatch, entry: copyConversationEntry(entryPatch.entry) }
                    }
                    if (entryPatch.type === 'append-tool-output') {
                      return {
                        ...entryPatch,
                        subagent: copySubagentRun(entryPatch.subagent)
                      }
                    }
                    if (entryPatch.type === 'replace-tool-metadata') {
                      return {
                        ...entryPatch,
                        expected: copyToolEntryPatchMetadata(entryPatch.expected),
                        metadata: copyToolEntryPatchMetadata(entryPatch.metadata)
                      }
                    }
                    return { ...entryPatch }
                  })
                }),
            ...('activeRunStartIndex' in patch.conversation
              ? { activeRunStartIndex: patch.conversation.activeRunStartIndex }
              : {})
          }
        })
  }
}

function createConversationEntryPatch(
  previous: KernelConversationEntry,
  next: KernelConversationEntry,
  index: number
): KernelConversationEntryPatch {
  if (
    previous.kind === 'message' &&
    next.kind === 'message' &&
    previous.role === next.role &&
    previous.timestamp === next.timestamp &&
    sameMessageAttachments(previous.attachments, next.attachments) &&
    next.text.startsWith(previous.text) &&
    next.text.length > previous.text.length
  ) {
    return {
      type: 'append-message-text',
      index,
      from: previous.text.length,
      text: next.text.slice(previous.text.length),
      streaming: next.streaming,
      stopReason: next.stopReason,
      error: next.error
    }
  }

  if (
    previous.kind === 'thinking' &&
    next.kind === 'thinking' &&
    previous.timestamp === next.timestamp &&
    next.text.startsWith(previous.text) &&
    next.text.length > previous.text.length
  ) {
    return {
      type: 'append-thinking-text',
      index,
      from: previous.text.length,
      text: next.text.slice(previous.text.length),
      streaming: next.streaming
    }
  }

  if (
    previous.kind === 'tool' &&
    next.kind === 'tool' &&
    previous.toolCallId === next.toolCallId &&
    previous.name === next.name &&
    previous.args === next.args &&
    previous.timestamp === next.timestamp &&
    sameAskToolState(previous.ask, next.ask) &&
    next.output.startsWith(previous.output)
  ) {
    if (
      next.output.length > previous.output.length &&
      sameTodoItems(previous.todos, next.todos) &&
      sameToolImageAttachments(previous.attachments, next.attachments)
    ) {
      return {
        type: 'append-tool-output',
        index,
        toolCallId: next.toolCallId,
        from: previous.output.length,
        output: next.output.slice(previous.output.length),
        status: next.status,
        details: next.details,
        truncated: next.truncated,
        durationMs: next.durationMs,
        subagent: next.subagent
      }
    }
    if (next.output.length === previous.output.length) {
      return {
        type: 'replace-tool-metadata',
        index,
        toolCallId: next.toolCallId,
        expectedOutputLength: previous.output.length,
        expected: toolEntryPatchMetadata(previous),
        metadata: toolEntryPatchMetadata(next)
      }
    }
  }

  return {
    type: 'replace-entry',
    index,
    expectedId: previous.id,
    entry: next
  }
}

export function copyConversationEntry(entry: KernelConversationEntry): KernelConversationEntry {
  if (entry.kind === 'tool') {
    const attachments = copyToolImageAttachments(entry.attachments)
    return {
      ...entry,
      subagent: copySubagentRun(entry.subagent),
      ...(entry.ask === undefined
        ? {}
        : {
            ask: {
              status: entry.ask.status,
              error: entry.ask.error,
              questions: entry.ask.questions.map((question) => ({
                ...question,
                options: question.options.map((option) => ({ ...option }))
              }))
            }
          }),
      ...(entry.todos === undefined
        ? {}
        : { todos: entry.todos.map((todo) => ({ ...todo })) }),
      ...(attachments === undefined ? {} : { attachments })
    }
  }
  if (entry.kind === 'subagent-notice') {
    return {
      ...entry,
      ...(entry.completion === undefined
        ? {}
        : { completion: copySubagentParticipant(entry.completion) }),
      ...(entry.coordination === undefined
        ? {}
        : { coordination: { ...entry.coordination } })
    }
  }
  if (entry.kind !== 'message' || entry.attachments === undefined) return { ...entry }
  return {
    ...entry,
    attachments: entry.attachments.map((attachment) => attachment.type === 'image'
      ? { ...attachment, hints: [...attachment.hints] }
      : { ...attachment })
  }
}

function toolEntryPatchMetadata(entry: KernelToolEntry): KernelToolEntryPatchMetadata {
  return {
    status: entry.status,
    details: entry.details,
    truncated: entry.truncated,
    durationMs: entry.durationMs,
    subagent: entry.subagent,
    todos: entry.todos,
    attachments: entry.attachments
  }
}

function copyToolEntryPatchMetadata(
  metadata: KernelToolEntryPatchMetadata
): KernelToolEntryPatchMetadata {
  return {
    ...metadata,
    subagent: copySubagentRun(metadata.subagent),
    todos: metadata.todos?.map((todo) => ({ ...todo })),
    attachments: copyToolImageAttachments(metadata.attachments)
  }
}

function sameAskToolState(
  left: KernelToolEntry['ask'],
  right: KernelToolEntry['ask']
): boolean {
  if (left === right) return true
  if (
    left === undefined ||
    right === undefined ||
    left.status !== right.status ||
    left.error !== right.error ||
    left.questions.length !== right.questions.length
  ) return false
  return left.questions.every((question, index) => {
    const candidate = right.questions[index]
    return candidate !== undefined &&
      question.id === candidate.id &&
      question.prompt === candidate.prompt &&
      question.type === candidate.type &&
      question.placeholder === candidate.placeholder &&
      question.options.length === candidate.options.length &&
      question.options.every((option, optionIndex) => {
        const other = candidate.options[optionIndex]
        return other !== undefined &&
          option.value === other.value &&
          option.label === other.label &&
          option.description === other.description
      })
  })
}

function sameTodoItems(
  left: KernelToolEntry['todos'],
  right: KernelToolEntry['todos']
): boolean {
  if (left === right) return true
  if (left === undefined || right === undefined || left.length !== right.length) return false
  return left.every((todo, index) => {
    const candidate = right[index]
    return candidate !== undefined &&
      todo.id === candidate.id &&
      todo.content === candidate.content &&
      todo.status === candidate.status &&
      todo.priority === candidate.priority
  })
}

function copySubagentRun(subagent: KernelSubagentRun | null): KernelSubagentRun | null {
  return subagent === null
    ? null
    : {
        ...subagent,
        participants: subagent.participants.map(copySubagentParticipant)
      }
}

function copySubagentParticipant(
  participant: KernelSubagentParticipant
): KernelSubagentParticipant {
  return {
    ...participant,
    usage: participant.usage === null ? null : { ...participant.usage },
    outputReferences: participant.outputReferences.map((reference) => ({ ...reference }))
  }
}

function sameMessageAttachments(
  first: KernelMessageAttachment[] | undefined,
  second: KernelMessageAttachment[] | undefined
): boolean {
  if (first === second) return true
  if (first === undefined || second === undefined || first.length !== second.length) return false
  return first.every((attachment, index) => {
    const other = second[index]
    if (
      other === undefined ||
      attachment.type !== other.type ||
      attachment.name !== other.name ||
      attachment.path !== other.path
    ) return false
    return attachment.type === 'file' ||
      (
        other.type === 'image' &&
        attachment.hints.length === other.hints.length &&
        attachment.hints.every((hint, hintIndex) => hint === other.hints[hintIndex])
      )
  })
}
