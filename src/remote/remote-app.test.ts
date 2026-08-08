import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const REMOTE_APP_PATH = new URL('./RemoteApp.tsx', import.meta.url)

test('RemoteApp keeps session/SSE flow and treats pair 401 as inline login error', async () => {
  const source = await readFile(REMOTE_APP_PATH, 'utf8')
  assert.match(source, /client\.getSession\(\)/u)
  assert.match(source, /client\.subscribe\(/u)
  assert.match(source, /client\.getState\(\)/u)
  assert.match(source, /client\.logout\(\)/u)
  assert.match(source, /退出失败，已配对手机可能仍然有效/u)
  assert.doesNotMatch(source, /本地会话已清除/u)
  assert.match(source, /onUnauthorized/u)
  assert.match(source, /setLoginError\(unknownErrorMessage\(error\)\)/u)
  assert.match(source, /pattern=\{`\[0-9\]\{\$\{REMOTE_PAIRING_CODE_LENGTH\}\}`\}/u)
  assert.doesNotMatch(source, /pattern=\{`\\d/u)
  assert.doesNotMatch(source, /\/api\/session\/login|login token|访问令牌/iu)
})
