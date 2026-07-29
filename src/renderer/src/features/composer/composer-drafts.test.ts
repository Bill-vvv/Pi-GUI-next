import assert from 'node:assert/strict'
import test from 'node:test'

import {
  resolveComposerDraftContext,
  switchComposerDraft,
  type ComposerDraft
} from './composer-drafts.ts'

const projectKey = '/workspace/project'

function sessionContext(sessionKey: string, sessionId: string, provisional = false) {
  return resolveComposerDraftContext({
    projectKey,
    viewingNewSession: false,
    sessionKey,
    sessionId,
    provisional
  })
}

function draft(prompt: string): ComposerDraft {
  return {
    prompt,
    pendingAttachments: [],
    cursorPosition: prompt.length
  }
}

test('keeps Composer drafts independent per Session and restores them on return', () => {
  const drafts = new Map<string, ComposerDraft>()
  const sessionA = sessionContext('/sessions/a.jsonl', 'session-a')
  const sessionB = sessionContext('/sessions/b.jsonl', 'session-b')

  const openedB = switchComposerDraft(drafts, sessionA, sessionB, draft('draft for A'))
  assert.deepEqual(openedB, draft(''))

  const reopenedA = switchComposerDraft(drafts, sessionB, sessionA, draft('draft for B'))
  assert.deepEqual(reopenedA, draft('draft for A'))

  const reopenedB = switchComposerDraft(drafts, sessionA, sessionB, reopenedA)
  assert.deepEqual(reopenedB, draft('draft for B'))
})

test('uses stable Session id across provisional and canonical session keys', () => {
  const provisional = sessionContext('provisional:1', 'session-1', true)
  const canonical = sessionContext('/sessions/session-1.jsonl', 'session-1')

  assert.equal(provisional.key, canonical.key)
})

test('keeps the draft when a stable Session id appears after the session key', () => {
  const drafts = new Map<string, ComposerDraft>()
  const keyOnly = resolveComposerDraftContext({
    projectKey,
    viewingNewSession: false,
    sessionKey: 'provisional:1',
    sessionId: null,
    provisional: true
  })
  const identified = sessionContext('provisional:1', 'session-1', true)
  const current = draft('draft before Session id projection')

  assert.deepEqual(switchComposerDraft(drafts, keyOnly, identified, current), current)
})

test('moves a new-session draft into its provisional Session identity', () => {
  const drafts = new Map<string, ComposerDraft>()
  const newSession = resolveComposerDraftContext({
    projectKey,
    viewingNewSession: true,
    sessionKey: null,
    sessionId: null,
    provisional: false
  })
  const provisional = sessionContext('provisional:1', 'session-1', true)
  const current = draft('typed while the Runtime starts')

  assert.deepEqual(
    switchComposerDraft(drafts, newSession, provisional, current),
    current
  )
  assert.equal(drafts.has(newSession.key), false)
})
