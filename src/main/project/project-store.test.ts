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
  await store.saveProject({ path: canonicalPath, trust: 'trusted' })

  assert.deepEqual(await store.loadProject(), { path: canonicalPath, trust: 'trusted' })
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
  await assert.rejects(store.validateProjectPath(join(root, 'missing')), /ENOENT/)
})

test('concurrent project saves complete in FIFO order without temporary files', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-gui-project-store-concurrent-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const configHome = join(root, 'config')
  const stateHome = join(root, 'state')
  const store = new ProjectStore({ configHome, stateHome })
  const firstProject = { path: join(root, 'first'), trust: 'trusted' as const }
  const secondProject = { path: join(root, 'second'), trust: 'untrusted' as const }

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
