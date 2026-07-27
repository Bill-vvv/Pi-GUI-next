import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

const appSource = await readFile(new URL('../../App.tsx', import.meta.url), 'utf8')
const timelineSource = await readFile(new URL('./Timeline.tsx', import.meta.url), 'utf8')
const chatStyles = await readFile(new URL('./chat.css', import.meta.url), 'utf8')

test('completed turn action slots reserve layout space while icons are hidden', () => {
  assert.match(
    timelineSource,
    /\{canShowTurnActions \? \(\s*<div[\s\S]*?className=\{`conversation-turn-actions\$\{showTurnActionSurface \? ' is-visible' : ''\}`\}/
  )
  assert.doesNotMatch(
    timelineSource,
    /\{showTurnActions \? \(\s*<div[^>]+className="conversation-turn-actions"/
  )
  assert.match(
    chatStyles,
    /\.conversation-turn-actions \{[\s\S]*?min-height: 1\.75rem;[\s\S]*?flex-wrap: nowrap;[\s\S]*?opacity: 0;[\s\S]*?pointer-events: none;/
  )
  assert.match(
    chatStyles,
    /\.conversation-turn-actions\.is-visible,\s*\.conversation-turn-actions:focus-within \{[\s\S]*?opacity: 1;[\s\S]*?pointer-events: auto;/
  )
})

test('a new copy, export or fork action clears stale completion feedback', () => {
  for (const action of ['forkSession', 'exportSession', 'copyAnswer']) {
    assert.match(
      appSource,
      new RegExp(`async function ${action}\\([\\s\\S]*?setCompletedAction\\(null\\)[\\s\\S]*?setPendingAction\\(`)
    )
  }
})

test('conversation action feedback stays with its initiating turn without growing the slot', () => {
  assert.match(timelineSource, /const \[actionFeedbackTurnId, setActionFeedbackTurnId\]/)
  assert.match(timelineSource, /setActionFeedbackTurnId\(turn\.id\)[\s\S]*?onCopyAnswer\(answerText\)/)
  assert.match(timelineSource, /setActionFeedbackTurnId\(turn\.id\)[\s\S]*?onExportSession\(\)/)
  assert.match(
    timelineSource,
    /const showTurnFeedback = actionFeedbackTurnId === turn\.id[\s\S]*?\{showTurnFeedback && conversationActionStatus/
  )
  assert.match(
    timelineSource,
    /\{actionFeedbackTurnId === null &&\s*\(conversationActionStatus !== null \|\| conversationActionError !== null\)/
  )
  assert.match(
    chatStyles,
    /\.conversation-turn-actions \.conversation-action-feedback \{[\s\S]*?overflow: hidden;[\s\S]*?text-overflow: ellipsis;[\s\S]*?white-space: nowrap;/
  )
})
