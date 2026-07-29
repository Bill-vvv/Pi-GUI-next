import assert from 'node:assert/strict'
import test from 'node:test'

import type {
  KernelConversationEntry,
  KernelForkCandidate
} from '../../shared/kernel-contract.ts'
import type { PiRpcSessionEntry } from '../pi-rpc/pi-rpc-client.ts'
import {
  forkCandidatesOnActivePath,
  resolveVisiblePromptCandidate,
  sessionEntriesOnActivePath
} from './session-branch.ts'

function entry(
  id: string,
  parentId: string | null,
  overrides: Partial<PiRpcSessionEntry> = {}
): PiRpcSessionEntry {
  return {
    id,
    parentId,
    type: 'message',
    timestamp: `2026-01-01T00:00:0${id.length}.000Z`,
    message: {
      role: 'user',
      content: { text: id, hasImage: false }
    },
    ...overrides
  }
}

test('returns the exact root-to-leaf active branch', () => {
  const root = entry('root', null)
  const active = entry('active', 'root')
  const leaf = entry('leaf', 'active')
  const abandoned = entry('abandoned', 'root')

  assert.deepEqual(
    sessionEntriesOnActivePath([abandoned, leaf, root, active], 'leaf'),
    [root, active, leaf]
  )
})

test('returns no active entries for a null leaf', () => {
  assert.deepEqual(sessionEntriesOnActivePath([entry('root', null)], null), [])
  assert.deepEqual(forkCandidatesOnActivePath([entry('root', null)], null), [])
})

test('fork candidates exclude abandoned branches, non-user messages, and images', () => {
  const root = entry('root', null)
  const assistant = entry('assistant', 'root', {
    message: {
      role: 'assistant',
      content: { text: 'answer', hasImage: false }
    }
  })
  const image = entry('image', 'assistant', {
    message: {
      role: 'user',
      content: { text: 'image prompt', hasImage: true }
    }
  })
  const eligible = entry('eligible', 'image', {
    timestamp: '2026-01-01T00:00:04.000Z',
    message: {
      role: 'user',
      content: { text: 'fork here', hasImage: false }
    }
  })
  const abandoned = entry('abandoned', 'root')

  assert.deepEqual(
    forkCandidatesOnActivePath([root, abandoned, assistant, image, eligible], 'eligible'),
    [
      {
        entryId: 'root',
        text: 'root',
        timestamp: root.timestamp
      },
      {
        entryId: 'eligible',
        text: 'fork here',
        timestamp: '2026-01-01T00:00:04.000Z'
      }
    ]
  )
})

test('resolves a visible prompt against the native active-path candidates', () => {
  const entries: KernelConversationEntry[] = [
    message('visible-root', 'Root prompt'),
    message('answer-root', 'Answer', 'assistant'),
    message('visible-recent', 'Repeated prompt'),
    message('answer-recent', 'Answer', 'assistant')
  ]
  const candidates: KernelForkCandidate[] = [
    { entryId: 'root', text: 'Root prompt', timestamp: '2026-01-01T00:00:00.000Z' },
    { entryId: 'compacted-away', text: 'Compacted prompt', timestamp: '2026-01-01T00:00:01.000Z' },
    { entryId: 'recent', text: 'Repeated prompt', timestamp: '2026-01-01T00:00:02.000Z' }
  ]

  assert.equal(
    resolveVisiblePromptCandidate(entries, candidates, 'visible-recent')?.entryId,
    'recent'
  )
  assert.equal(
    resolveVisiblePromptCandidate(entries, candidates, 'visible-root')?.entryId,
    'root'
  )
})

test('fails closed when the visible prompt cannot be mapped to the active path', () => {
  assert.equal(
    resolveVisiblePromptCandidate(
      [message('visible', 'Visible prompt')],
      [{ entryId: 'different', text: 'Different prompt', timestamp: '2026-01-01T00:00:00.000Z' }],
      'visible'
    ),
    null
  )
  assert.equal(
    resolveVisiblePromptCandidate(
      [message('image', 'Image prompt', 'user', true)],
      [{ entryId: 'image-entry', text: 'Image prompt', timestamp: '2026-01-01T00:00:00.000Z' }],
      'image'
    ),
    null
  )
})

test('fails closed when repeated prompt text does not identify one active-path entry', () => {
  assert.equal(
    resolveVisiblePromptCandidate(
      [message('visible', 'Repeat')],
      [
        { entryId: 'first', text: 'Repeat', timestamp: '2026-01-01T00:00:00.000Z' },
        { entryId: 'second', text: 'Repeat', timestamp: '2026-01-01T00:00:01.000Z' }
      ],
      'visible'
    ),
    null
  )
})

test('rejects duplicate entry IDs', () => {
  assert.throws(
    () => sessionEntriesOnActivePath([entry('same', null), entry('same', null)], 'same'),
    /Runtime returned duplicate session entry ID: same/
  )
})

test('rejects a cycle on the active path', () => {
  assert.throws(
    () => sessionEntriesOnActivePath([entry('first', 'second'), entry('second', 'first')], 'first'),
    /Runtime returned a cyclic session entry path at: first/
  )
})

test('rejects a missing parent on the active path', () => {
  assert.throws(
    () => sessionEntriesOnActivePath([entry('leaf', 'missing')], 'leaf'),
    /Runtime active session path references a missing entry: missing/
  )
})

function message(
  id: string,
  text: string,
  role: 'user' | 'assistant' = 'user',
  image = false
): KernelConversationEntry {
  return {
    id,
    kind: 'message',
    role,
    phase: null,
    text,
    timestamp: 1,
    streaming: false,
    stopReason: null,
    error: null,
    ...(image
      ? { attachments: [{ type: 'image', name: 'image.png', path: '/tmp/image.png', hints: [] }] }
      : {})
  }
}
