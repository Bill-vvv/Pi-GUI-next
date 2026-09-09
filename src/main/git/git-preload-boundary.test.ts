import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const PRELOAD_PATH = new URL('../../preload/index.ts', import.meta.url)

test('preload exposes a separate narrow piGit bridge without raw Node or Git primitives', async () => {
  const source = await readFile(PRELOAD_PATH, 'utf8')
  const start = source.indexOf('const gitApi: GitApi = {')
  const end = source.indexOf('\n\nconst kernelApi:', start)
  assert.notEqual(start, -1)
  assert.notEqual(end, -1)
  const bridge = source.slice(start, end)

  assert.match(source, /contextBridge\.exposeInMainWorld\('piGit', gitApi\)/u)
  assert.match(bridge, /GIT_COMMAND_CHANNEL/u)
  assert.match(bridge, /type: 'git\.prepare-commit'/u)
  assert.match(bridge, /type: 'git\.execute-commit'/u)
  assert.match(bridge, /type: 'git\.execute-commit', projectKey, request/u)
  assert.match(bridge, /type: 'git\.list-history'/u)
  assert.match(bridge, /type: 'git\.get-history-detail'/u)
  assert.match(bridge, /type: 'git\.get-history-file-diff'/u)
  assert.match(bridge, /type: 'git\.prepare-branch-sync'/u)
  assert.match(bridge, /type: 'git\.execute-branch-sync'/u)
  assert.match(bridge, /type: 'git\.execute-branch-sync', projectKey, request/u)
  assert.equal(bridge.match(/ipcRenderer\.invoke\(GIT_COMMAND_CHANNEL/g)?.length, 12)
  assert.doesNotMatch(bridge, /child_process|node:fs|simple-git|spawn\s*\(|exec\s*\(|\.raw\s*\(|args\s*:/u)
  assert.doesNotMatch(source, /exposeInMainWorld\('piGit',\s*(?:ipcRenderer|webUtils|process|Buffer)/u)
})
