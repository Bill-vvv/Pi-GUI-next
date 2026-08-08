import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const PANEL_PATH = new URL('./RemoteAccessPanel.tsx', import.meta.url)
const APP_PATH = new URL('../../App.tsx', import.meta.url)
const PRELOAD_PATH = new URL('../../../../preload/index.ts', import.meta.url)
const REMOTE_APP_PATH = new URL('../../../../remote/RemoteApp.tsx', import.meta.url)
const TRANSPORT_PATH = new URL('../../../../remote/transport.ts', import.meta.url)
const NAV_PATH = new URL('./SettingsNavigation.tsx', import.meta.url)

test('RemoteAccessPanel uses typed remote admin callbacks and modal revoke confirmation', async () => {
  const source = await readFile(PANEL_PATH, 'utf8')
  assert.match(source, /onGetStatus:\s*\(\)\s*=>\s*Promise<RemoteAccessStatus>/u)
  assert.match(source, /onCreatePairingCode:\s*\(\)\s*=>\s*Promise<RemotePairingCode>/u)
  assert.match(source, /onRevokeDevice:\s*\(\)\s*=>\s*Promise<RemoteAccessStatus>/u)
  assert.match(source, /生成配对码/u)
  assert.match(source, /5 分钟内一次有效/u)
  assert.match(source, /撤销已配对手机/u)
  assert.match(source, /role="status"/u)
  assert.match(source, /aria-live="polite"/u)
  assert.match(source, /useModalDialog/u)
  assert.doesNotMatch(source, /window\.confirm/u)
  assert.doesNotMatch(source, /tokenFile|TOKEN_FILE|localStorage|sessionStorage/u)
  assert.doesNotMatch(source, /ipcRenderer|electron/iu)
})

test('App passes stable remote admin method references so pairing codes survive parent renders', async () => {
  const source = await readFile(APP_PATH, 'utf8')
  assert.match(source, /onGetRemoteAccessStatus=\{window\.piRemote\.getStatus\}/u)
  assert.match(source, /onCreateRemotePairingCode=\{window\.piRemote\.createPairingCode\}/u)
  assert.match(source, /onRevokeRemoteDevice=\{window\.piRemote\.revokeDevice\}/u)
  assert.doesNotMatch(source, /onGetRemoteAccessStatus=\{\(\) =>/u)
})

test('Settings navigation exposes a dedicated remote access section', async () => {
  const source = await readFile(NAV_PATH, 'utf8')
  assert.match(source, /section:\s*'remote'/u)
  assert.match(source, /label:\s*'远程访问'/u)
  assert.match(source, /icon:\s*'remote'/u)
})

test('preload exposes a narrow piRemote admin bridge', async () => {
  const source = await readFile(PRELOAD_PATH, 'utf8')
  const start = source.indexOf('const remoteAdminApi: RemoteAdminApi = {')
  const end = source.indexOf('\n\nconst gitApi:', start)
  assert.notEqual(start, -1)
  assert.notEqual(end, -1)
  const bridge = source.slice(start, end)
  assert.match(source, /contextBridge\.exposeInMainWorld\('piRemote', remoteAdminApi\)/u)
  assert.match(bridge, /REMOTE_ADMIN_COMMAND_CHANNEL/u)
  assert.match(bridge, /remote-admin\.get-status/u)
  assert.match(bridge, /remote-admin\.create-pairing-code/u)
  assert.match(bridge, /remote-admin\.revoke-device/u)
  assert.doesNotMatch(bridge, /child_process|node:fs|tokenFile|TOKEN_FILE|process\.env/u)
  assert.doesNotMatch(source, /exposeInMainWorld\('piRemote',\s*(?:ipcRenderer|webUtils|process|Buffer)/u)
})

test('Remote Web login uses pairing code transport without token persistence', async () => {
  const [remoteApp, transport] = await Promise.all([
    readFile(REMOTE_APP_PATH, 'utf8'),
    readFile(TRANSPORT_PATH, 'utf8')
  ])
  assert.match(remoteApp, /client\.pair\(code\)/u)
  assert.match(remoteApp, /inputMode="numeric"/u)
  assert.match(remoteApp, /autoComplete="one-time-code"/u)
  assert.match(remoteApp, /maxLength=\{REMOTE_PAIRING_CODE_LENGTH\}/u)
  assert.match(remoteApp, /normalizePairingCodeInput/u)
  assert.doesNotMatch(remoteApp, /loginToken|current-password|访问令牌|client\.login\(/u)
  assert.doesNotMatch(remoteApp, /localStorage|sessionStorage/u)
  assert.match(transport, /async pair\(code: string\)/u)
  assert.match(transport, /REMOTE_API_PATHS\.pair/u)
  assert.doesNotMatch(transport, /REMOTE_API_PATHS\.login|async login\(/u)
  assert.doesNotMatch(transport, /localStorage|sessionStorage|tokenFile/u)
})
