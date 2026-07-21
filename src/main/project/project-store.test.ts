import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { ProjectStore } from './project-store.ts'

test('project settings persist in XDG config and initialize non-sensitive XDG state', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-gui-project-store-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const configHome = join(root, 'config')
  const stateHome = join(root, 'state')
  const projectPath = join(root, 'project')
  await mkdir(projectPath)
  const store = new ProjectStore({ configHome, stateHome })

  const canonicalPath = await store.validateProjectPath(projectPath)
  await store.saveProject({ path: canonicalPath })

  assert.deepEqual(await store.loadProject(), { path: canonicalPath })
  assert.deepEqual(
    JSON.parse(await readFile(join(stateHome, 'pi-gui-next', 'state.json'), 'utf8')),
    { version: 1, recentSession: null }
  )
})

test('invalid config and missing project paths fail fast', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-gui-project-store-invalid-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const configHome = join(root, 'config')
  const store = new ProjectStore({ configHome, stateHome: join(root, 'state') })
  await mkdir(join(configHome, 'pi-gui-next'), { recursive: true })
  await writeFile(join(configHome, 'pi-gui-next', 'config.json'), '{"version":1,"project":{}}')

  await assert.rejects(store.loadProject(), /Invalid Pi GUI project config/)
  await writeFile(
    join(configHome, 'pi-gui-next', 'config.json'),
    JSON.stringify({ version: 1, project: { path: join(root, 'project'), trust: 'untrusted' } })
  )
  await assert.rejects(store.loadProject(), /Invalid Pi GUI project config/)
  await assert.rejects(store.validateProjectPath(join(root, 'missing')), /ENOENT/)
})

test('concurrent project saves complete in FIFO order without temporary files', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-gui-project-store-concurrent-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const configHome = join(root, 'config')
  const stateHome = join(root, 'state')
  const store = new ProjectStore({ configHome, stateHome })
  const firstProject = { path: join(root, 'first') }
  const secondProject = { path: join(root, 'second') }

  const results = await Promise.allSettled([
    store.saveProject(firstProject),
    store.saveProject(secondProject),
  ])

  assert.deepEqual(results.map(({ status }) => status), ['fulfilled', 'fulfilled'])
  const configDirectory = join(configHome, 'pi-gui-next')
  const configText = await readFile(join(configDirectory, 'config.json'), 'utf8')
  assert.deepEqual(JSON.parse(configText), { version: 1, project: secondProject })
  assert.equal((await readdir(configDirectory)).some((name) => name.includes('.tmp-')), false)
  assert.equal(
    (await readdir(join(stateHome, 'pi-gui-next'))).some((name) => name.includes('.tmp-')),
    false,
  )
})

test('recent session pointer roundtrips and is scoped to its project', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-gui-project-store-session-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new ProjectStore({ configHome: join(root, 'config'), stateHome: join(root, 'state') })
  const pointer = {
    projectPath: join(root, 'project'),
    sessionFile: join(root, 'sessions', 'session.jsonl'),
    sessionId: 'session-1',
    sessionName: null
  }

  assert.equal(await store.loadRecentSession(pointer.projectPath), null)
  await store.saveRecentSession(pointer)
  assert.deepEqual(await store.loadRecentSession(pointer.projectPath), pointer)
  assert.equal(await store.loadRecentSession(join(root, 'other-project')), null)
})

test('malformed recent session state fails fast', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-gui-project-store-state-invalid-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const stateHome = join(root, 'state')
  const stateDirectory = join(stateHome, 'pi-gui-next')
  await mkdir(stateDirectory, { recursive: true })
  await writeFile(
    join(stateDirectory, 'state.json'),
    JSON.stringify({
      version: 1,
      recentSession: {
        projectPath: join(root, 'project'),
        sessionFile: 'relative.jsonl',
        sessionId: 'session-1',
        sessionName: null
      }
    })
  )
  const store = new ProjectStore({ configHome: join(root, 'config'), stateHome })

  await assert.rejects(store.loadRecentSession(join(root, 'project')), /Invalid Pi GUI project state/)
})

test('recent session validation requires an existing regular file', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-gui-project-store-session-validation-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new ProjectStore({ configHome: join(root, 'config'), stateHome: join(root, 'state') })
  const sessionFile = join(root, 'external-sessions', 'session.jsonl')
  const pointer = {
    projectPath: join(root, 'project'),
    sessionFile,
    sessionId: 'session-1',
    sessionName: null
  }

  await assert.rejects(store.validateRecentSession(pointer), /ENOENT/)
  await mkdir(sessionFile, { recursive: true })
  await assert.rejects(store.validateRecentSession(pointer), /not a regular file/)
  await rm(sessionFile, { recursive: true })
  await writeFile(sessionFile, '{}\n')
  await store.validateRecentSession(pointer)
  await assert.rejects(
    store.validateRecentSession({ ...pointer, extra: true } as typeof pointer),
    /Invalid Pi GUI recent session pointer/
  )
})
