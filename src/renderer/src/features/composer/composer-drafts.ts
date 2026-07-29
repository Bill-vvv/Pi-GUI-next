import type { KernelPromptAttachment } from '../../../../shared/kernel-contract'

export type ComposerPendingAttachment = {
  id: string
  attachment: KernelPromptAttachment
}

export type ComposerDraft = {
  prompt: string
  pendingAttachments: ComposerPendingAttachment[]
  cursorPosition: number
}

export type ComposerDraftContext = {
  key: string
  projectKey: string | null
  sessionKey: string | null
  kind: 'none' | 'new' | 'session'
  provisional: boolean
}

export function resolveComposerDraftContext({
  projectKey,
  viewingNewSession,
  sessionKey,
  sessionId,
  provisional
}: {
  projectKey: string | null
  viewingNewSession: boolean
  sessionKey: string | null
  sessionId: string | null
  provisional: boolean
}): ComposerDraftContext {
  const kind = projectKey === null || (!viewingNewSession && sessionKey === null)
    ? 'none'
    : viewingNewSession ? 'new' : 'session'
  const identity = kind === 'new'
    ? 'new-session'
    : kind === 'session' ? sessionId ?? sessionKey : null

  return {
    key: JSON.stringify([projectKey, kind, identity]),
    projectKey,
    sessionKey: kind === 'session' ? sessionKey : null,
    kind,
    provisional: kind === 'session' && provisional
  }
}

export function switchComposerDraft(
  drafts: Map<string, ComposerDraft>,
  previousContext: ComposerDraftContext,
  nextContext: ComposerDraftContext,
  currentDraft: ComposerDraft
): ComposerDraft {
  if (hasComposerDraft(currentDraft)) {
    drafts.set(previousContext.key, copyComposerDraft(currentDraft))
  } else {
    drafts.delete(previousContext.key)
  }

  const savedDraft = drafts.get(nextContext.key)
  if (savedDraft !== undefined) return copyComposerDraft(savedDraft)

  const sameSessionKey =
    previousContext.kind === 'session' &&
    nextContext.kind === 'session' &&
    previousContext.projectKey === nextContext.projectKey &&
    previousContext.sessionKey !== null &&
    previousContext.sessionKey === nextContext.sessionKey
  const materializedNewSession =
    previousContext.kind === 'new' &&
    nextContext.kind === 'session' &&
    nextContext.provisional &&
    previousContext.projectKey === nextContext.projectKey
  if (sameSessionKey || materializedNewSession) {
    drafts.delete(previousContext.key)
    return copyComposerDraft(currentDraft)
  }

  return {
    prompt: '',
    pendingAttachments: [],
    cursorPosition: 0
  }
}

function hasComposerDraft(draft: ComposerDraft): boolean {
  return draft.prompt.length > 0 || draft.pendingAttachments.length > 0
}

function copyComposerDraft(draft: ComposerDraft): ComposerDraft {
  return {
    prompt: draft.prompt,
    pendingAttachments: [...draft.pendingAttachments],
    cursorPosition: Math.min(draft.cursorPosition, draft.prompt.length)
  }
}
