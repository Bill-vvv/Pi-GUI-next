import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

const timelineTurnsSource = await readFile(new URL('./TimelineTurns.tsx', import.meta.url), 'utf8')

test('message and ordinary tool images render inline outside collapsed process detail', () => {
  assert.match(timelineTurnsSource, /function ProcessToolImages\b/)
  assert.match(
    timelineTurnsSource,
    /<CompletedProcess[\s\S]*?<ProcessToolImages entries=\{processEntries\} \/>/
  )
  assert.match(
    timelineTurnsSource,
    /<LiveProcess[\s\S]*?<ProcessToolImages entries=\{chunk\.entries\} \/>/
  )
  assert.match(timelineTurnsSource, /data-inline-image-open="true"/)
  assert.match(timelineTurnsSource, /data-message-image-open=/)
  assert.match(timelineTurnsSource, /data-tool-image-open=/)
  assert.match(
    timelineTurnsSource,
    /getRendererHost\(\)\.getMessageImage\(sessionKey, messageId, index\)/
  )
  assert.match(
    timelineTurnsSource,
    /getRendererHost\(\)\.getToolImage\([\s\S]*?sessionKey,[\s\S]*?toolCallId,[\s\S]*?attachment\.contentIndex/
  )
  assert.doesNotMatch(
    timelineTurnsSource,
    /<ToolResultAttachments[\s\S]{0,300}attachments=\{attachments\}[\s\S]{0,300}<\/div>/
  )
})

test('inline images load near the viewport and share one accessible lightbox implementation', () => {
  assert.match(timelineTurnsSource, /new IntersectionObserver\(/)
  assert.match(timelineTurnsSource, /rootMargin: '320px 0px'/)
  assert.equal([...timelineTurnsSource.matchAll(/useModalDialog\(\{/g)].length, 1)
  assert.match(timelineTurnsSource, /initialFocus: \(\) => closeButtonRef\.current/)
  assert.match(timelineTurnsSource, /data-message-image-viewer=/)
  assert.match(timelineTurnsSource, /data-tool-image-viewer=/)
  assert.match(timelineTurnsSource, /const titleId = useId\(\)/)
  assert.match(timelineTurnsSource, /aria-labelledby=\{titleId\}/)
  assert.match(timelineTurnsSource, /<h2 id=\{titleId\}>/)
})

test('inline image requests reject stale identities and keep base64 out of kernel state', () => {
  assert.match(
    timelineTurnsSource,
    /useLayoutEffect\(\(\) => \{\s*requestSequenceRef\.current \+= 1\s*loadStatusRef\.current = 'idle'/
  )
  assert.equal(
    [...timelineTurnsSource.matchAll(/requestSequenceRef\.current !== requestId/g)].length,
    2
  )
  assert.match(timelineTurnsSource, /JSON\.stringify\(\[\s*'message',\s*sessionKey,\s*messageId,/)
  assert.match(timelineTurnsSource, /JSON\.stringify\(\[\s*'tool',\s*sessionKey,\s*toolCallId,/)
  assert.doesNotMatch(timelineTurnsSource, /KernelState[\s\S]{0,200}base64/)
})

test('tool image identity uses contentIndex and excludes subagent tools', () => {
  assert.match(timelineTurnsSource, /data-tool-image-content-index=/)
  assert.match(
    timelineTurnsSource,
    /key=\{`tool-image:\$\{toolCallId\}:\$\{attachment\.contentIndex\}`\}/
  )
  assert.match(
    timelineTurnsSource,
    /entry\.subagent === null[\s\S]{0,120}compactToolName\(entry\.name\) !== 'subagent'/
  )
  assert.doesNotMatch(timelineTurnsSource, /readFile\(|getPathForFile\(|file:\/\//)
  assert.doesNotMatch(timelineTurnsSource, /getMessageImage\(sessionKey, toolCallId/)
})
