import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

import { sameToolImageRequest } from './tool-image-request.ts'

const timelineTurnsSource = await readFile(new URL('./TimelineTurns.tsx', import.meta.url), 'utf8')

test('ordinary tool detail shows image attachment entry without waiting-only empty text', () => {
  assert.match(timelineTurnsSource, /function ToolResultAttachments\b/)
  assert.match(timelineTurnsSource, /data-tool-image-open="true"/)
  assert.match(timelineTurnsSource, /window\.piGui\.getToolImage\(sessionKey, toolCallId, contentIndex\)/)
  assert.match(
    timelineTurnsSource,
    /const hasOutput = detail\.length > 0 \|\| attachments\.length > 0/
  )
  assert.match(
    timelineTurnsSource,
    /\{!hasOutput \? <p>等待工具输出<\/p> : null\}/
  )
  assert.doesNotMatch(
    timelineTurnsSource,
    /\{detail \? \([\s\S]*?\) : <p>等待工具输出<\/p>\}/
  )
})

test('tool image UI reuses the message lightbox contract and excludes subagent tools', () => {
  assert.match(timelineTurnsSource, /data-tool-image-viewer="true"/)
  assert.match(timelineTurnsSource, /message-image-viewer-backdrop/)
  assert.match(timelineTurnsSource, /role="dialog"/)
  assert.match(timelineTurnsSource, /aria-modal="true"/)
  assert.equal([...timelineTurnsSource.matchAll(/useModalDialog\(\{/g)].length, 2)
  assert.match(timelineTurnsSource, /initialFocus: \(\) => closeButtonRef\.current/)
  // Subagent tools short-circuit before ordinary ToolDetailContent.
  assert.match(
    timelineTurnsSource,
    /if \(entry\.subagent !== null\) \{\s*return \(\s*<SubagentToolStep/
  )
  assert.doesNotMatch(timelineTurnsSource, /SubagentToolStep[\s\S]{0,400}ToolResultAttachments/)
  assert.match(timelineTurnsSource, /compactToolName\(entry\.name\) === 'subagent'/)
})

test('tool image requests reject stale session, tool, index and request identities', () => {
  const current = {
    requestId: 4,
    sessionKey: '/tmp/a.jsonl',
    toolCallId: 'tool-a',
    contentIndex: 2
  }
  assert.equal(sameToolImageRequest(current, { ...current }), true)
  assert.equal(sameToolImageRequest(current, { ...current, requestId: 3 }), false)
  assert.equal(sameToolImageRequest(current, { ...current, sessionKey: '/tmp/b.jsonl' }), false)
  assert.equal(sameToolImageRequest(current, { ...current, toolCallId: 'tool-b' }), false)
  assert.equal(sameToolImageRequest(current, { ...current, contentIndex: 1 }), false)
  assert.match(
    timelineTurnsSource,
    /useLayoutEffect\(\(\) => \{\s*requestSequenceRef\.current \+= 1\s*setViewer\(null\)/
  )
  assert.match(timelineTurnsSource, /sameToolImageRequest\(current\.request, request\)/)
  assert.match(timelineTurnsSource, /const titleId = useId\(\)/)
  assert.match(timelineTurnsSource, /aria-labelledby=\{titleId\}/)
  assert.match(timelineTurnsSource, /<h2 id=\{titleId\}>/)
})

test('tool image open uses contentIndex identity rather than ordinal path reads', () => {
  assert.match(timelineTurnsSource, /data-tool-image-content-index=\{attachment\.contentIndex\}/)
  assert.match(timelineTurnsSource, /key=\{`tool-image:\$\{toolCallId\}:\$\{attachment\.contentIndex\}`\}/)
  assert.doesNotMatch(timelineTurnsSource, /readFile\(|getPathForFile\(|file:\/\//)
  assert.doesNotMatch(timelineTurnsSource, /getMessageImage\(sessionKey, toolCallId/)
})
