import assert from 'node:assert/strict'
import test from 'node:test'

import { OPENAI_FAST_MODE_ENTRY_TYPE } from '../../../extensions/pi-gui-openai-fast-mode/src/protocol.mjs'
import {
  PI_RPC_TREE_MAX_DEPTH,
  PI_RPC_TREE_MAX_LABEL_CHARS,
  PI_RPC_TREE_MAX_LABEL_TIMESTAMP_CHARS,
  PI_RPC_TREE_MAX_NODES,
  normalizePiRpcSessionEntry,
  normalizePiRpcTreeResult
} from './pi-rpc-data.ts'

// Ported from the retired external RPC client tests (D-098); inputs and expectations unchanged.

function treeEntry(
  id: string,
  parentId: string | null,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id,
    parentId,
    type: 'message',
    timestamp: '2026-07-29T00:00:00.000Z',
    message: { role: 'assistant', content: 'private assistant payload' },
    ...overrides
  }
}

function deepTree(depth: number): Record<string, unknown> {
  let node: Record<string, unknown> | null = null
  for (let index = depth - 1; index >= 0; index--) {
    const id = `entry-${index}`
    node = {
      entry: treeEntry(id, index === 0 ? null : `entry-${index - 1}`),
      children: node === null ? [] : [node]
    }
  }
  return node!
}

test('normalizes entries without retaining image or non-user payloads', () => {
  const input = {
      entries: [
        {
          id: 'user-1',
          parentId: null,
          type: 'message',
          timestamp: '2026-07-24T01:00:00.000Z',
          message: {
            role: 'user',
            content: [
              { type: 'text', text: 'Inspect ' },
              { type: 'image', mimeType: 'image/png', data: 'large-private-payload' },
              { type: 'text', text: 'this' }
            ]
          }
        },
        {
          id: 'assistant-1',
          parentId: 'user-1',
          type: 'message',
          timestamp: '2026-07-24T01:00:01.000Z',
          message: { role: 'assistant', content: [{ type: 'text', text: 'private response' }] }
        },
        {
          id: 'branch-1',
          parentId: 'assistant-1',
          type: 'branch',
          timestamp: '2026-07-24T01:00:02.000Z',
          summary: 'private branch payload'
        },
        {
          id: 'advisor-capability-1',
          parentId: 'branch-1',
          type: 'custom',
          timestamp: '2026-07-24T01:00:03.000Z',
          customType: 'pi-gui.multi-advisor/capabilities',
          data: {
            protocolVersion: 1,
            identity: 'pi-gui-multi-advisor',
            enabled: true
          }
        },
        {
          id: 'fast-mode-1',
          parentId: 'advisor-capability-1',
          type: 'custom',
          timestamp: '2026-07-24T01:00:04.000Z',
          customType: OPENAI_FAST_MODE_ENTRY_TYPE,
          data: { enabled: true }
        },
        {
          id: 'unrelated-custom-1',
          parentId: 'fast-mode-1',
          type: 'custom',
          timestamp: '2026-07-24T01:00:05.000Z',
          customType: 'third-party/private',
          data: { secret: 'do-not-retain' }
        },
        {
          id: 'magic-context-status-1',
          parentId: 'unrelated-custom-1',
          type: 'custom',
          timestamp: '2026-07-24T01:00:06.000Z',
          customType: 'ctx-status',
          data: {
            title: 'Dream complete',
            text: 'Embedded 4 memories.',
            level: 'success',
            details: { retainedForStrictProjection: true }
          }
        }
      ],
      leafId: 'assistant-1'
  }
  const entries = { leafId: input.leafId, entries: input.entries.map(normalizePiRpcSessionEntry) }
  assert.deepEqual(entries, {
    leafId: 'assistant-1',
    entries: [
      {
        id: 'user-1',
        parentId: null,
        type: 'message',
        timestamp: '2026-07-24T01:00:00.000Z',
        message: {
          role: 'user',
          content: { text: 'Inspect this', hasImage: true }
        }
      },
      {
        id: 'assistant-1',
        parentId: 'user-1',
        type: 'message',
        timestamp: '2026-07-24T01:00:01.000Z',
        message: { role: 'assistant' }
      },
      {
        id: 'branch-1',
        parentId: 'assistant-1',
        type: 'branch',
        timestamp: '2026-07-24T01:00:02.000Z'
      },
      {
        id: 'advisor-capability-1',
        parentId: 'branch-1',
        type: 'custom',
        timestamp: '2026-07-24T01:00:03.000Z',
        customType: 'pi-gui.multi-advisor/capabilities',
        data: {
          protocolVersion: 1,
          identity: 'pi-gui-multi-advisor',
          enabled: true
        }
      },
      {
        id: 'fast-mode-1',
        parentId: 'advisor-capability-1',
        type: 'custom',
        timestamp: '2026-07-24T01:00:04.000Z',
        customType: OPENAI_FAST_MODE_ENTRY_TYPE,
        data: { enabled: true }
      },
      {
        id: 'unrelated-custom-1',
        parentId: 'fast-mode-1',
        type: 'custom',
        timestamp: '2026-07-24T01:00:05.000Z'
      },
      {
        id: 'magic-context-status-1',
        parentId: 'unrelated-custom-1',
        type: 'custom',
        timestamp: '2026-07-24T01:00:06.000Z',
        customType: 'ctx-status',
        data: {
          title: 'Dream complete',
          text: 'Embedded 4 memories.',
          level: 'success'
        }
      }
    ]
  })
  assert.equal(JSON.stringify(entries).includes('large-private-payload'), false)
  assert.equal(JSON.stringify(entries).includes('do-not-retain'), false)
  assert.equal(JSON.stringify(entries).includes('retainedForStrictProjection'), false)
})

test('rejects malformed entries and unknown user content blocks', () => {
  const invalidData = [
    {
      entries: [{
        id: 'fast-mode-1',
        parentId: null,
        type: 'custom',
        timestamp: 'now',
        customType: OPENAI_FAST_MODE_ENTRY_TYPE,
        data: { enabled: 'yes' }
      }],
      leafId: 'fast-mode-1'
    },
    {
      entries: [{ id: '', parentId: null, type: 'message', timestamp: 'now', message: { role: 'user', content: '' } }],
      leafId: null
    },
    {
      entries: [{ id: 'entry-1', parentId: null, type: 'message', timestamp: 'now', message: {} }],
      leafId: null
    },
    {
      entries: [{
        id: 'entry-1',
        parentId: null,
        type: 'message',
        timestamp: 'now',
        message: { role: 'user', content: [{ type: 'audio', data: 'payload' }] }
      }],
      leafId: null
    },
    {
      entries: [{
        id: 'entry-1',
        parentId: null,
        type: 'message',
        timestamp: 'now',
        message: { role: 'user', content: [{ type: 'image', mimeType: 'image/png' }] }
      }],
      leafId: null
    }
  ]

  for (const data of invalidData) {
    assert.throws(() => data.entries.map(normalizePiRpcSessionEntry), /Invalid Pi RPC get_entries response/u)
  }
})

test('projects tree depth, node count, label, and timestamp exact bounds iteratively', () => {
  const exactDepth = normalizePiRpcTreeResult({
    tree: [deepTree(PI_RPC_TREE_MAX_DEPTH)],
    leafId: `entry-${PI_RPC_TREE_MAX_DEPTH - 1}`
  })
  let visited = 0
  const depthStack = [...exactDepth.tree]
  while (depthStack.length > 0) {
    const node = depthStack.pop()!
    visited += 1
    depthStack.push(...node.children)
  }
  assert.equal(visited, PI_RPC_TREE_MAX_DEPTH)

  const exactRoot: Record<string, unknown> = {
    entry: treeEntry('flat-0', null),
    children: Array.from({ length: PI_RPC_TREE_MAX_NODES - 1 }, (_, index) => ({
      entry: treeEntry(`flat-${index + 1}`, 'flat-0'),
      children: []
    })),
    label: 'l'.repeat(PI_RPC_TREE_MAX_LABEL_CHARS),
    labelTimestamp: 't'.repeat(PI_RPC_TREE_MAX_LABEL_TIMESTAMP_CHARS)
  }
  const exactCountResult = normalizePiRpcTreeResult({
    tree: [exactRoot],
    leafId: `flat-${PI_RPC_TREE_MAX_NODES - 1}`
  })
  assert.equal(1 + exactCountResult.tree[0]!.children.length, PI_RPC_TREE_MAX_NODES)
  assert.equal(exactCountResult.tree[0]?.label?.length, PI_RPC_TREE_MAX_LABEL_CHARS)
  assert.equal(
    exactCountResult.tree[0]?.labelTimestamp?.length,
    PI_RPC_TREE_MAX_LABEL_TIMESTAMP_CHARS
  )

  const rejectedTrees = [
    { tree: [deepTree(PI_RPC_TREE_MAX_DEPTH + 1)], leafId: null },
    {
      tree: [{
        entry: treeEntry('over-0', null),
        children: Array.from({ length: PI_RPC_TREE_MAX_NODES }, (_, index) => ({
          entry: treeEntry(`over-${index + 1}`, 'over-0'),
          children: []
        }))
      }],
      leafId: null
    },
    {
      tree: [{
        entry: treeEntry('root', null), children: [],
        label: 'l'.repeat(PI_RPC_TREE_MAX_LABEL_CHARS + 1)
      }],
      leafId: 'root'
    },
    {
      tree: [{
        entry: treeEntry('root', null), children: [],
        labelTimestamp: 't'.repeat(PI_RPC_TREE_MAX_LABEL_TIMESTAMP_CHARS + 1)
      }],
      leafId: 'root'
    }
  ]
  for (const data of rejectedTrees) {
    assert.throws(() => normalizePiRpcTreeResult(data), /Invalid Pi RPC get_tree response/u)
  }
})

test('rejects duplicate, cyclic, inconsistent, malformed, and missing-leaf tree data', () => {
  const invalidTrees = [
    {
      tree: [
        { entry: treeEntry('same', null), children: [] },
        { entry: treeEntry('same', null), children: [] }
      ],
      leafId: 'same'
    },
    {
      tree: [{
        entry: treeEntry('root', null),
        children: [{ entry: treeEntry('child', 'other-parent'), children: [] }]
      }],
      leafId: 'child'
    },
    {
      tree: [
        { entry: treeEntry('a', 'b'), children: [] },
        { entry: treeEntry('b', 'a'), children: [] }
      ],
      leafId: 'a'
    },
    {
      tree: [{ entry: treeEntry('self', 'self'), children: [] }],
      leafId: 'self'
    },
    {
      tree: [{ entry: treeEntry('root', null), children: [] }],
      leafId: 'missing'
    },
    {
      tree: [{ entry: treeEntry('root', null), children: [], raw: 'unexpected' }],
      leafId: 'root'
    },
    {
      tree: [{ entry: treeEntry(' bad ', null), children: [] }],
      leafId: null
    }
  ]

  for (const data of invalidTrees) {
    assert.throws(() => normalizePiRpcTreeResult(data), /Invalid Pi RPC get_tree response/u)
  }
})

test('accepts multiple canonical roots produced by branching from a root user entry', () => {
  const result = normalizePiRpcTreeResult({
    tree: [
      { entry: treeEntry('old-root', null), children: [] },
      { entry: treeEntry('continued-root', null), children: [] }
    ],
    leafId: 'continued-root'
  })
  assert.deepEqual((result).tree.map(({ entry }) => entry.id), [
    'old-root',
    'continued-root'
  ])
})

test('accepts documented orphan entries only as roots with a missing parent', () => {
  const result = normalizePiRpcTreeResult({
    tree: [
      { entry: treeEntry('root', null), children: [] },
      { entry: treeEntry('orphan', 'missing-parent'), children: [] }
    ],
    leafId: 'orphan'
  })

  assert.deepEqual(result, {
    tree: [
      {
        entry: {
          id: 'root', parentId: null, type: 'message',
          timestamp: '2026-07-29T00:00:00.000Z',
          message: { role: 'assistant' }
        },
        children: []
      },
      {
        entry: {
          id: 'orphan', parentId: 'missing-parent', type: 'message',
          timestamp: '2026-07-29T00:00:00.000Z',
          message: { role: 'assistant' }
        },
        children: []
      }
    ],
    leafId: 'orphan'
  })
})
