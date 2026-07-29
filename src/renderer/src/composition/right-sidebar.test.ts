import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { after, test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'

import {
  RIGHT_SIDEBAR_DEFAULT_WIDTH,
  RIGHT_SIDEBAR_MAX_WIDTH,
  RIGHT_SIDEBAR_MIN_WIDTH,
  RIGHT_SIDEBAR_WIDTH_STORAGE_KEY,
  clampRightSidebarWidth,
  readRightSidebarWidthPreference,
  rightSidebarDomIds,
  rightSidebarTabIdFromKey,
  rightSidebarWidthBounds,
  validateRightSidebarTabs,
  writeRightSidebarWidthPreference
} from './right-sidebar-model.ts'

const vite = await createServer({
  configFile: false,
  root: new URL('../../../../', import.meta.url).pathname,
  appType: 'custom',
  server: { middlewareMode: true, hmr: false }
})
after(() => vite.close())

const rightSidebarModule = await vite.ssrLoadModule(
  '/src/renderer/src/composition/RightSidebar.tsx'
) as typeof import('./RightSidebar.tsx')
const { RightSidebar } = rightSidebarModule

const rightSidebarSource = await readFile(new URL('./RightSidebar.tsx', import.meta.url), 'utf8')
const workbenchSource = await readFile(new URL('./Workbench.tsx', import.meta.url), 'utf8')
const workbenchStyles = await readFile(new URL('./workbench.css', import.meta.url), 'utf8')
const verifierSource = await readFile(
  new URL('../../../../scripts/verify-linux-release.mjs', import.meta.url),
  'utf8'
)

const sidebarProps = {
  activeTabId: 'subagent',
  onTabChange: () => undefined,
  onCollapse: () => undefined,
  onClose: () => undefined,
  onResizeCancelChange: () => undefined
}

test('right sidebar SSR keeps every tab IDREF valid without using hostile logical IDs as DOM IDs', () => {
  const hostileIds = ['../../subagent:<script>', 'git panel/"hostile"']
  const html = renderToStaticMarkup(createElement(RightSidebar, {
    ...sidebarProps,
    activeTabId: hostileIds[0],
    tabs: [
      { id: hostileIds[0], label: '子任务', content: createElement('p', null, 'active content') },
      { id: hostileIds[1], label: 'Git', content: createElement('p', null, 'inactive expensive content') }
    ]
  }))

  const controls = [...html.matchAll(/aria-controls="([^"]+)"/g)].map((match) => match[1]!)
  assert.equal(controls.length, 2)
  for (const panelId of controls) assert.match(html, new RegExp(`id="${panelId}"`))
  assert.equal(html.match(/role="tabpanel"/g)?.length, 2)
  assert.match(html, /role="tabpanel"[^>]*hidden=""/)
  assert.match(html, /active content/)
  assert.doesNotMatch(html, /inactive expensive content/)
  for (const hostileId of hostileIds) assert.doesNotMatch(html, new RegExp(escapeRegExp(hostileId)))
  assert.match(rightSidebarSource, /const generatedId = useId\(\)/)
  assert.match(rightSidebarSource, /rightSidebarDomIds\(componentId, index\)/)
})

test('right sidebar fails fast for empty, duplicate and missing active logical tab IDs', () => {
  assert.throws(
    () => validateRightSidebarTabs(['subagent', 'subagent'], 'subagent'),
    /must be unique/
  )
  assert.throws(() => validateRightSidebarTabs(['   '], '   '), /must be non-empty/)
  assert.throws(() => validateRightSidebarTabs(['subagent'], 'git'), /concrete active tab/)
  assert.throws(
    () => renderToStaticMarkup(createElement(RightSidebar, {
      ...sidebarProps,
      tabs: [
        { id: 'subagent', label: 'A', content: null },
        { id: 'subagent', label: 'B', content: null }
      ]
    })),
    /must be unique/
  )

  const firstIds = rightSidebarDomIds('R1', 0)
  const secondIds = rightSidebarDomIds('R1', 1)
  assert.notEqual(firstIds.tabId, secondIds.tabId)
  assert.notEqual(firstIds.panelId, secondIds.panelId)
})

test('tab keyboard navigation wraps and supports Home and End', () => {
  const tabs = ['subagent', 'review', 'history']
  assert.equal(rightSidebarTabIdFromKey(tabs, 0, 'ArrowLeft'), 'history')
  assert.equal(rightSidebarTabIdFromKey(tabs, 2, 'ArrowRight'), 'subagent')
  assert.equal(rightSidebarTabIdFromKey(tabs, 1, 'Home'), 'subagent')
  assert.equal(rightSidebarTabIdFromKey(tabs, 1, 'End'), 'history')
  assert.equal(rightSidebarTabIdFromKey(tabs, 1, 'Enter'), null)
})

test('right sidebar preference storage fails safe for throwing reads and writes', () => {
  const storage = (value: string | null): Pick<Storage, 'getItem'> => ({
    getItem: (key) => key === RIGHT_SIDEBAR_WIDTH_STORAGE_KEY ? value : null
  })

  assert.deepEqual(rightSidebarWidthBounds(1280), { min: 320, max: 480 })
  assert.deepEqual(rightSidebarWidthBounds(1600), { min: 320, max: 520 })
  assert.equal(clampRightSidebarWidth(200, 1600), RIGHT_SIDEBAR_MIN_WIDTH)
  assert.equal(clampRightSidebarWidth(900, 1600), RIGHT_SIDEBAR_MAX_WIDTH)
  assert.equal(readRightSidebarWidthPreference(storage('460')), 460)
  assert.equal(readRightSidebarWidthPreference(storage('900')), RIGHT_SIDEBAR_MAX_WIDTH)
  assert.equal(readRightSidebarWidthPreference(storage('invalid')), RIGHT_SIDEBAR_DEFAULT_WIDTH)
  assert.equal(readRightSidebarWidthPreference({
    getItem: () => { throw new Error('denied') }
  }), RIGHT_SIDEBAR_DEFAULT_WIDTH)
  assert.doesNotThrow(() => writeRightSidebarWidthPreference({
    setItem: () => { throw new Error('full') }
  }, 460))
})

test('cancel preserves an exact preferred width when its rendered width is viewport-clamped', () => {
  const preferredWidth = readRightSidebarWidthPreference({ getItem: () => '520' })
  const startRenderedWidth = clampRightSidebarWidth(preferredWidth, 1280)
  const startPreferredWidth = preferredWidth

  assert.equal(startPreferredWidth, 520)
  assert.equal(startRenderedWidth, 480)
  assert.equal(clampRightSidebarWidth(startPreferredWidth, 1600), 520)
  assert.match(rightSidebarSource, /startRenderedWidth: width/)
  assert.match(rightSidebarSource, /startPreferredWidth: preferredWidth/)
  assert.match(rightSidebarSource, /setPreferredWidth\(gesture\.startPreferredWidth\)/)
  assert.match(rightSidebarSource, /if \(gesture\.changed\) persistPreferredWidth/)
  assert.doesNotMatch(
    rightSidebarSource.slice(
      rightSidebarSource.indexOf('onPointerMove='),
      rightSidebarSource.indexOf('onPointerUp=')
    ),
    /persistPreferredWidth|writeRightSidebarWidthPreference/
  )
})

test('separator owns complete pointer cleanup and Workbench capture owns resize Escape', () => {
  assert.match(rightSidebarSource, /role="separator"/)
  assert.match(rightSidebarSource, /aria-orientation="vertical"/)
  assert.match(rightSidebarSource, /setPointerCapture\(event\.pointerId\)/)
  assert.match(rightSidebarSource, /releasePointerCapture\(gesture\.pointerId\)/)
  assert.match(rightSidebarSource, /onPointerCancel=/)
  assert.match(rightSidebarSource, /onLostPointerCapture=/)
  assert.match(rightSidebarSource, /delete separator\.dataset\.rightSidebarResizing/)
  assert.match(rightSidebarSource, /onResizeCancelChange\(null\)/)
  assert.match(rightSidebarSource, /useEffect\(\(\) => \(\) => \{/)
  assert.match(workbenchSource, /const rightSidebarResizeCancelRef = useRef<\(\(\) => void\) \| null>/)
  assert.match(
    workbenchSource,
    /event\.key === 'Escape' && rightSidebarResizeCancelRef\.current !== null[\s\S]*?rightSidebarResizeCancelRef\.current\(\)[\s\S]*?event\.preventDefault\(\)[\s\S]*?event\.stopPropagation\(\)/
  )
  assert.doesNotMatch(workbenchSource, /hasActiveRightSidebarResize|data-right-sidebar-resizing/)
  assert.match(workbenchSource, /globalEscapeAbortEnabled=\{!rightSidebarOpen\}/)
})

test('Workbench fences deferred focus restoration while preserving close, collapse and invalid-target fallback', () => {
  assert.match(workbenchSource, /const focusRestorationRevisionRef = useRef\(0\)/)
  assert.match(workbenchSource, /const requestRevision = \+\+focusRestorationRevisionRef\.current/)
  assert.match(workbenchSource, /requestRevision !== focusRestorationRevisionRef\.current/)
  assert.match(workbenchSource, /hasConnectedMeaningfulFocus\(mainChat\)/)
  assert.match(workbenchSource, /active\.isConnected/)
  assert.match(workbenchSource, /invalidateRightSidebarFocusRestoration\(\)[\s\S]*?setRightSidebarCollapsed\(false\)[\s\S]*?setSubagentTaskSelection/)
  assert.match(workbenchSource, /\[displayedConversationIdentity, invalidateRightSidebarFocusRestoration, settingsOpen\]/)
  assert.match(workbenchSource, /setSubagentTaskSelection\(null\)[\s\S]*?restoreSubagentTaskTriggerFocus\(subagentTaskSelection\)/)
  assert.match(workbenchSource, /findSubagentTaskTrigger\(mainChat, selection\)/)
  assert.match(workbenchSource, /className="right-sidebar-reopen-trigger"/)
})

test('generic right sidebar layout and official verifier share the current contract', () => {
  assert.match(workbenchStyles, /\.app-shell\.right-sidebar-open \.main-chat \{\s*display: none;/)
  assert.match(workbenchStyles, /@media \(min-width: 1280px\)[\s\S]*?\.app-shell\.right-sidebar-open \.main-chat \{\s*display: grid;/)
  assert.match(workbenchStyles, /@media \(max-width: 1279px\)[\s\S]*?\.workbench-right-sidebar \{\s*width: 100%;/)
  assert.match(workbenchStyles, /@media \(max-width: 1279px\)[\s\S]*?\.right-sidebar-separator,[\s\S]*?display: none;/)
  assert.match(workbenchStyles, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.right-sidebar-separator::before \{[\s\S]*?transition: none;/)
  assert.doesNotMatch(workbenchStyles, /transition\s*:[^;]*width/)

  assert.match(verifierSource, /classList\.contains\('right-sidebar-open'\)/)
  assert.match(verifierSource, /\.workbench-right-sidebar/)
  assert.match(verifierSource, /clickSelector\(activeCdp, '\.right-sidebar-collapse'\)/)
  assert.match(verifierSource, /\.right-sidebar-close/)
  assert.match(verifierSource, /\.right-sidebar-back/)
  assert.match(verifierSource, /\.right-sidebar-reopen-trigger/)
  assert.match(verifierSource, /separatorTransitionDuration/)
  assert.doesNotMatch(verifierSource, /subagent-detail-open/)
  assert.doesNotMatch(verifierSource, /subagent-task-detail-(?:close|back)/)
})

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
