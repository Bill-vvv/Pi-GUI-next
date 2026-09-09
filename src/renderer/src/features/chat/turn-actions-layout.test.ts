import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

const appSource = await readFile(new URL('../../App.tsx', import.meta.url), 'utf8')
const timelineSource = await readFile(new URL('./Timeline.tsx', import.meta.url), 'utf8')
const workbenchSource = await readFile(new URL('../../composition/Workbench.tsx', import.meta.url), 'utf8')
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

test('static history previews keep completed-turn actions and bind stateful actions to the viewed Session', () => {
  assert.match(
    workbenchSource,
    /const canUseStaticPreviewActions =\s*!viewingArchivedSession &&\s*viewingInactiveSession &&\s*sessionPreview !== null &&\s*!sessionPreviewPending/
  )
  assert.match(
    workbenchSource,
    /const canUseCompletedTurnActions =\s*canUseSettledSessionActions \|\| canUseStaticPreviewActions/
  )
  assert.match(
    appSource,
    /async function openForkDialog[\s\S]*?viewTarget\?\.kind === 'session'[\s\S]*?await ensureSessionRuntime\(viewTarget\.sessionKey, 'immediate'\)[\s\S]*?setForkDialogOpen\(true\)/
  )
  assert.match(
    appSource,
    /async function exportSession[\s\S]*?const targetSessionKey[\s\S]*?await ensureSessionRuntime\(viewTarget\.sessionKey, 'immediate'\)[\s\S]*?activeSessionKey !== targetSessionKey[\s\S]*?window\.piGui\.exportSession\(\)/
  )
  assert.match(
    timelineSource,
    /onForkTurn\(forkUserText\)\.catch\(\(\) => undefined\)/
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

test('historical prompt editing stays in place and retries only the native prompt after navigation', () => {
  assert.match(timelineSource, /visibleCompletedTurns\.slice\(0, editingTurnIndex \+ 1\)/)
  assert.match(
    timelineSource,
    /if \(!readyToSend\) \{[\s\S]*?await onNavigateHistoryPrompt\(historyPromptEdit\.messageId\)[\s\S]*?readyToSend = true[\s\S]*?\}[\s\S]*?await onSendHistoryPrompt\(message\)/
  )
  assert.match(
    timelineSource,
    /error: unknownErrorMessage\(error\), readyToSend/
  )
  assert.match(timelineSource, /data-history-prompt-edit-id=\{historyPrompt\.messageId\}/)
  assert.match(timelineSource, /querySelectorAll<HTMLButtonElement>[\s\S]*?data-history-prompt-edit-id[\s\S]*?trigger\?\.focus\(\)/)
  assert.match(timelineSource, /requestAnimationFrame\(\(\) => historyPromptTextareaRef\.current\?\.focus\(\)\)/)
  assert.match(timelineSource, /readOnly=\{busy\}/)
  assert.match(timelineSource, /aria-busy=\{busy\}/)
  assert.match(timelineSource, /event\.nativeEvent\.keyCode === 229/)
  assert.match(timelineSource, /event\.nativeEvent\.isComposing/)
  assert.match(timelineSource, /event\.key === 'Escape'/)
  assert.match(timelineSource, /event\.metaKey \|\| event\.ctrlKey/)
  assert.match(workbenchSource, /onNavigateHistoryPrompt\(activeSessionKey, messageId\)/)
  assert.match(workbenchSource, /onPrompt\(message, undefined, activeSessionKey\)/)
  assert.match(workbenchSource, /conversationActionBusy=\{busy\}/)
  assert.match(workbenchSource, /<Composer[\s\S]*?busy=\{interactionBusy\}/)
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
