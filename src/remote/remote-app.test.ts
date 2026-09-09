import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const REMOTE_APP_PATH = new URL('./RemoteApp.tsx', import.meta.url)
const REMOTE_SHELL_PATH = new URL('./RemoteShell.tsx', import.meta.url)
const REMOTE_CSS_PATH = new URL('./remote.css', import.meta.url)
const REMOTE_HTML_PATH = new URL('./index.html', import.meta.url)
const SELECT_PATH = new URL('../renderer/src/components/Select.tsx', import.meta.url)

test('RemoteApp keeps session/SSE flow and treats pair 401 as inline login error', async () => {
  const source = await readFile(REMOTE_APP_PATH, 'utf8')
  assert.match(source, /client\.getSession\(\)/u)
  assert.match(source, /client\.subscribe\(/u)
  assert.match(source, /client\.getState\(\)/u)
  assert.match(source, /void resyncSnapshot\(generation\)/u)
  assert.doesNotMatch(source, /client\.logout\(\)/u)
  assert.doesNotMatch(source, /退出失败，已配对手机可能仍然有效/u)
  assert.doesNotMatch(source, /本地会话已清除/u)
  assert.match(source, /onUnauthorized/u)
  assert.match(source, /setLoginError\(unknownErrorMessage\(error\)\)/u)
  assert.match(source, /pattern=\{`\[0-9\]\{\$\{REMOTE_PAIRING_CODE_LENGTH\}\}`\}/u)
  assert.doesNotMatch(source, /pattern=\{`\\d/u)
  assert.doesNotMatch(source, /\/api\/session\/login|login token|访问令牌/iu)
})

test('Remote navigation separates Project scope from rich Session status', async () => {
  const [shellSource, cssSource, selectSource] = await Promise.all([
    readFile(REMOTE_SHELL_PATH, 'utf8'),
    readFile(REMOTE_CSS_PATH, 'utf8'),
    readFile(SELECT_PATH, 'utf8')
  ])

  assert.match(shellSource, /remote-project-row/u)
  assert.match(shellSource, /remote-session-row/u)
  assert.match(shellSource, /busySessionCount/u)
  assert.match(shellSource, /需要处理/u)
  assert.match(shellSource, /进行中/u)
  assert.match(shellSource, /其他会话/u)
  assert.match(shellSource, /等待你回复/u)
  assert.match(shellSource, /正在处理/u)
  assert.match(shellSource, /connectionStatus === 'disconnected'/u)
  assert.doesNotMatch(shellSource, /remote-topbar-meta/u)
  assert.match(cssSource, /\.remote-project-row/u)
  assert.match(cssSource, /\.remote-session-row/u)
  assert.match(selectSource, /detailTone/u)
  assert.match(selectSource, /select-control-option-detail/u)
})

test('Remote viewport uses Chrome virtual keyboard geometry with a viewport fallback', async () => {
  const [appSource, cssSource, htmlSource] = await Promise.all([
    readFile(REMOTE_APP_PATH, 'utf8'),
    readFile(REMOTE_CSS_PATH, 'utf8'),
    readFile(REMOTE_HTML_PATH, 'utf8')
  ])

  assert.match(appSource, /virtualKeyboard/u)
  assert.match(appSource, /overlaysContent = true/u)
  assert.match(appSource, /boundingRect\.height/u)
  assert.match(appSource, /geometrychange/u)
  assert.match(appSource, /--remote-viewport-height/u)
  assert.match(appSource, /--remote-viewport-offset-top/u)
  assert.match(appSource, /current\?\.height/u)
  assert.match(appSource, /current\?\.offsetTop/u)
  assert.doesNotMatch(appSource, /window\.innerHeight - current\.height/u)
  assert.match(cssSource, /height: var\(--remote-viewport-height\)/u)
  assert.match(cssSource, /top: var\(--remote-viewport-offset-top\)/u)
  assert.doesNotMatch(cssSource, /--remote-keyboard-inset/u)
  assert.doesNotMatch(htmlSource, /interactive-widget=/u)
})
