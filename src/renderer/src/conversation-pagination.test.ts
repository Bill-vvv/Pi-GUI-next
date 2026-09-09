import assert from 'node:assert/strict'
import test from 'node:test'

import type {
  KernelConversationEntry,
  KernelConversationPage,
  KernelSessionPreview,
  KernelSessionPreviewPageRequest,
  KernelState
} from '../../shared/kernel-contract.ts'
import { timelineConversation } from './composition/conversation-presentation.ts'
import {
  mergeEarlierConversationPage,
  mergeEarlierSessionPreviewPage,
  preserveEarlierConversationWindow
} from './kernel/conversation-page-merge.ts'
import { applyStatePatches } from './kernel/kernel-state-patches.ts'

const message = (id: string): KernelConversationEntry => ({
  id,
  kind: 'message',
  role: 'assistant',
  text: id,
  timestamp: 1,
  streaming: false,
  stopReason: 'stop',
  error: null
})

function state(startIndex = 4): KernelState {
  return {
    activeProjectKey: '/tmp/project',
    activeSessionKey: '/tmp/session.jsonl',
    runtime: { status: 'ready' },
    session: { id: 'session-1', settled: true },
    conversation: {
      startIndex,
      entries: [message('e4'), message('e5')],
      activeRunStartIndex: 5
    }
  } as unknown as KernelState
}

function page(overrides: Partial<KernelConversationPage> = {}): KernelConversationPage {
  return {
    projectKey: '/tmp/project',
    sessionKey: '/tmp/session.jsonl',
    sessionId: 'session-1',
    beforeIndex: 4,
    beforeEntryId: 'e4',
    startIndex: 2,
    entries: [message('e2'), message('e3')],
    ...overrides
  }
}

test('absolute patches keep working after an authoritative prepend', () => {
  const merged = mergeEarlierConversationPage(state(), page())
  assert.equal(merged.conversation.startIndex, 2)
  assert.deepEqual(merged.conversation.entries.map(({ id }) => id), ['e2', 'e3', 'e4', 'e5'])

  const patched = applyStatePatches(merged, [{
    projectKey: merged.activeProjectKey,
    sessionKey: merged.activeSessionKey,
    conversation: {
      entries: [{
        type: 'append-message-text',
        index: 5,
        from: 2,
        text: '-done',
        streaming: false,
        stopReason: 'stop',
        error: null
      }]
    }
  }])
  assert.equal(patched.conversation.entries[3]?.kind === 'message'
    ? patched.conversation.entries[3].text
    : null, 'e5-done')
  assert.throws(() => applyStatePatches(patched, [{
    projectKey: patched.activeProjectKey,
    sessionKey: patched.activeSessionKey,
    conversation: { entries: [{
      type: 'insert', index: 1, entry: message('outside')
    }] }
  }]), /outside the loaded window/)
})

test('page merge is strict, boundary-only, and idempotent once fully covered', () => {
  const first = mergeEarlierConversationPage(state(), page())
  assert.equal(mergeEarlierConversationPage(first, page()), first)
  assert.throws(() => mergeEarlierConversationPage(state(), page({ sessionId: 'stale' })), /identity is stale/)
  assert.throws(() => mergeEarlierConversationPage(state(), page({ startIndex: 1 })), /range is invalid/)
  assert.throws(() => mergeEarlierConversationPage(state(), page({ entries: [message('e2'), message('e2')] })), /duplicated/)
  assert.throws(() => mergeEarlierConversationPage(
    { ...state(), conversation: { ...state().conversation, startIndex: 3 } },
    page()
  ), /stale for the current window/)
})

test('detached preview page merge requires exact preview, response, and boundary identity', () => {
  const preview: KernelSessionPreview = {
    previewId: 'preview-1',
    projectKey: '/tmp/project',
    sessionKey: '/tmp/session.jsonl',
    sessionId: 'session-1',
    sessionName: null,
    conversation: {
      startIndex: 4,
      entries: [message('e4'), message('e5')],
      activeRunStartIndex: null
    }
  }
  const request: KernelSessionPreviewPageRequest = {
    previewId: preview.previewId,
    projectKey: preview.projectKey,
    sessionKey: preview.sessionKey,
    sessionId: preview.sessionId,
    beforeIndex: 4,
    beforeEntryId: 'e4'
  }

  const merged = mergeEarlierSessionPreviewPage(preview, request, page())
  assert.equal(merged.conversation.startIndex, 2)
  assert.deepEqual(merged.conversation.entries.map(({ id }) => id), ['e2', 'e3', 'e4', 'e5'])
  assert.equal(mergeEarlierSessionPreviewPage(merged, request, page()), merged)
  assert.throws(
    () => mergeEarlierSessionPreviewPage(preview, { ...request, previewId: 'stale' }, page()),
    /identity is stale/
  )
  assert.throws(
    () => mergeEarlierSessionPreviewPage(preview, request, page({ beforeEntryId: 'other' })),
    /response identity is stale/
  )
})

test('a newer bounded authority tail preserves only an exact overlapping local prefix', () => {
  const current = mergeEarlierConversationPage(state(), page())
  const next = {
    ...state(4),
    conversation: {
      startIndex: 4,
      entries: [message('e4'), message('e5'), message('e6')],
      activeRunStartIndex: 6
    }
  }
  const preserved = preserveEarlierConversationWindow(current, next)
  assert.equal(preserved.conversation.startIndex, 2)
  assert.deepEqual(preserved.conversation.entries.map(({ id }) => id), ['e2', 'e3', 'e4', 'e5', 'e6'])
  assert.equal(preserved.conversation.entries[2], next.conversation.entries[0])
  assert.equal(preserved.conversation.activeRunStartIndex, 6)

  const switched = { ...next, activeSessionKey: '/tmp/other.jsonl' }
  assert.equal(preserveEarlierConversationWindow(current, switched), switched)
  const mismatch = {
    ...next,
    conversation: { ...next.conversation, entries: [message('changed'), message('e5')] }
  }
  assert.equal(preserveEarlierConversationWindow(current, mismatch), mismatch)
})

test('Workbench converts only authoritative absolute run boundaries to Timeline-local indexes', () => {
  const source = state()
  const projected = timelineConversation(source.conversation)
  assert.equal(projected.activeRunStartIndex, 1)
  assert.equal(projected.entries, source.conversation.entries)
  assert.throws(() => timelineConversation({
    startIndex: 4,
    entries: [message('e4')],
    activeRunStartIndex: 3
  }), /outside the loaded window/)
})
