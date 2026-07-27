import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const timelineSource = readFileSync(new URL('./Timeline.tsx', import.meta.url), 'utf8')
const composerSource = readFileSync(new URL('../composer/Composer.tsx', import.meta.url), 'utf8')
const workbenchSource = readFileSync(new URL('../../composition/Workbench.tsx', import.meta.url), 'utf8')

import {
  anchoredTimelineScrollTop,
  isTimelineViewportMeasurable,
  timelineScrollModeAfterScroll
} from './timeline-scroll-stability.ts'

test('any intentional upward scroll leaves following mode immediately', () => {
  assert.equal(timelineScrollModeAfterScroll({
    currentMode: 'following',
    previousScrollTop: 500,
    scrollTop: 492,
    outputEndScrollTop: 500,
    suppressUserIntent: false
  }), 'reading')
})

test('reading mode resumes only at the canonical output end', () => {
  assert.equal(timelineScrollModeAfterScroll({
    currentMode: 'reading',
    previousScrollTop: 300,
    scrollTop: 420,
    outputEndScrollTop: 500,
    suppressUserIntent: false
  }), 'reading')
  assert.equal(timelineScrollModeAfterScroll({
    currentMode: 'reading',
    previousScrollTop: 420,
    scrollTop: 499,
    outputEndScrollTop: 500,
    suppressUserIntent: false
  }), 'following')
})

test('programmatic anchor and output corrections do not change user intent', () => {
  assert.equal(timelineScrollModeAfterScroll({
    currentMode: 'reading',
    previousScrollTop: 300,
    scrollTop: 260,
    outputEndScrollTop: 260,
    suppressUserIntent: true
  }), 'reading')
  assert.equal(timelineScrollModeAfterScroll({
    currentMode: 'following',
    previousScrollTop: 300,
    scrollTop: 340,
    outputEndScrollTop: 340,
    suppressUserIntent: true
  }), 'following')
})

test('anchor correction offsets layout movement without fixed timing', () => {
  assert.equal(anchoredTimelineScrollTop({
    scrollTop: 640,
    previousAnchorViewportOffset: 180,
    currentAnchorViewportOffset: 236
  }), 696)
  assert.equal(anchoredTimelineScrollTop({
    scrollTop: 24,
    previousAnchorViewportOffset: 80,
    currentAnchorViewportOffset: 20
  }), 0)
})

test('hidden narrow-layout conversations are not measured until restored', () => {
  assert.equal(isTimelineViewportMeasurable({ width: 0, height: 720 }), false)
  assert.equal(isTimelineViewportMeasurable({ width: 840, height: 0 }), false)
  assert.equal(isTimelineViewportMeasurable({ width: 840, height: 720 }), true)
})

test('programmatic suppression derives from the synchronized scroll position without a stale marker', () => {
  assert.match(
    timelineSource,
    /const suppressUserIntent = Math\.abs\(scrollTop - previousScrollTop\) <= 0\.5/
  )
  assert.doesNotMatch(timelineSource, /programmaticScrollTopRef/)
})

test('Timeline stabilizes entries, resize, and measured Composer layout through one path', () => {
  const stabilization = timelineSource.slice(
    timelineSource.indexOf('const stabilizeTimelineLayout'),
    timelineSource.indexOf('const scrollToMountedPrompt')
  )
  assert.match(stabilization, /updateScrollTail\(\)/)
  assert.match(stabilization, /scrollModeRef\.current === 'following'/)
  assert.match(stabilization, /restoreReadingAnchor\(\)/)
  assert.doesNotMatch(stabilization, /setTimeout|requestAnimationFrame/)
  assert.match(timelineSource, /new ResizeObserver\(handleLayoutChange\)/)
  assert.match(timelineSource, /window\.addEventListener\('resize', handleLayoutChange\)/)
  assert.match(timelineSource, /TIMELINE_LAYOUT_CHANGE_EVENT/)
})

test('chrome changes refresh the reading line before stabilization', () => {
  const chromeUpdate = timelineSource.slice(
    timelineSource.indexOf('const updateChromeHeight'),
    timelineSource.indexOf('updateChromeHeight()')
  )
  assert.match(chromeUpdate, /getComputedStyle\(viewport\)\.paddingTop/)
  assert.ok(
    chromeUpdate.indexOf('readingLineOffsetRef.current') <
      chromeUpdate.indexOf('stabilizeTimelineLayout()')
  )
})

test('caret fallback keeps stable turn identity when Markdown descendants are replaced', () => {
  assert.match(
    timelineSource,
    /pointElement\.closest<HTMLElement>\('\[data-conversation-turn-id\]'\)/
  )
})

test('Workbench notifies Timeline after sidebar and detail layout commits', () => {
  const layoutEffect = workbenchSource.slice(
    workbenchSource.indexOf('useLayoutEffect(() => {', workbenchSource.indexOf('selectedSubagentTaskKey')),
    workbenchSource.indexOf('const openSubagentTaskDetail')
  )
  assert.match(layoutEffect, /TIMELINE_LAYOUT_CHANGE_EVENT/)
  assert.match(layoutEffect, /\[selectedSubagentTaskKey, sidebarCollapsed\]/)
  assert.doesNotMatch(layoutEffect, /setTimeout|requestAnimationFrame/)
})

test('Composer publishes measured clearance without scrolling into Timeline tail space', () => {
  const clearanceEffect = composerSource.slice(
    composerSource.indexOf('const notifyTimelineLayoutChange'),
    composerSource.indexOf('const handleKeyDown')
  )
  assert.match(clearanceEffect, /--composer-measured-clearance/)
  assert.match(clearanceEffect, /TIMELINE_LAYOUT_CHANGE_EVENT/)
  assert.doesNotMatch(clearanceEffect, /scrollHeight\s*-\s*conversation\.scrollTop/)
  assert.doesNotMatch(clearanceEffect, /conversation\.scrollTop\s*=/)
})
