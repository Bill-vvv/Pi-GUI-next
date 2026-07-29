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
  assert.doesNotMatch(bridge, /child_process|node:fs|simple-git|spawn\s*\(|exec\s*\(|\.raw\s*\(|args\s*:/u)
  assert.doesNotMatch(source, /exposeInMainWorld\('piGit',\s*(?:ipcRenderer|webUtils|process|Buffer)/u)
})
