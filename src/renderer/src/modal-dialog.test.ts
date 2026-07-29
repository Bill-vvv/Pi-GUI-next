import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

import { modalTabTargetIndex } from './components/useModalDialog.ts'

const hookSource = await readFile(new URL('./components/useModalDialog.ts', import.meta.url), 'utf8')
const sessionForkSource = await readFile(
  new URL('./features/session/SessionForkDialog.tsx', import.meta.url),
  'utf8'
)
const projectTrustSource = await readFile(
  new URL('./features/trust/ProjectTrustDialog.tsx', import.meta.url),
  'utf8'
)
const credentialsSource = await readFile(
  new URL('./features/settings/CredentialsPanel.tsx', import.meta.url),
  'utf8'
)
const timelineTurnsSource = await readFile(
  new URL('./features/chat/TimelineTurns.tsx', import.meta.url),
  'utf8'
)
const tooltipProviderSource = await readFile(
  new URL('./components/TooltipProvider.tsx', import.meta.url),
  'utf8'
)

test('modal tab navigation wraps only at the focus boundary', () => {
  assert.equal(modalTabTargetIndex(0, -1, false), -1)
  assert.equal(modalTabTargetIndex(3, -1, false), 0)
  assert.equal(modalTabTargetIndex(3, -1, true), 2)
  assert.equal(modalTabTargetIndex(3, 0, true), 2)
  assert.equal(modalTabTargetIndex(3, 2, false), 0)
  assert.equal(modalTabTargetIndex(3, 1, false), null)
  assert.equal(modalTabTargetIndex(3, 1, true), null)
})

test('shared modal hook owns top-layer Escape, busy blocking and focus restoration', () => {
  assert.match(hookSource, /openModalStack\.at\(-1\) !== instanceId/)
  assert.match(hookSource, /if \(!dismissDisabledRef\.current\) onDismissRef\.current\(\)/)
  assert.match(hookSource, /previousFocus !== null && previousFocus\.isConnected/)
  assert.match(hookSource, /document\.addEventListener\('keydown', handleKeyDown\)/)
  assert.match(tooltipProviderSource, /event\.preventDefault\(\)[\s\S]*?event\.stopPropagation\(\)[\s\S]*?hideTooltip\(\)/)
})

test('all current modal surfaces use the shared behavior hook without local key listeners', () => {
  assert.match(sessionForkSource, /useModalDialog\(\{/)
  assert.match(projectTrustSource, /useModalDialog\(\{/)
  assert.match(credentialsSource, /useModalDialog\(\{/)
  assert.equal([...timelineTurnsSource.matchAll(/useModalDialog\(\{/g)].length, 2)

  for (const source of [
    sessionForkSource,
    projectTrustSource,
    credentialsSource,
    timelineTurnsSource
  ]) {
    assert.doesNotMatch(source, /document\.addEventListener\('keydown'/)
    assert.doesNotMatch(source, /previousFocusRef/)
  }
})
