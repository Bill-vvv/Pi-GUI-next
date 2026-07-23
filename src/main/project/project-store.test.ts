import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { ProjectStore } from './project-store.ts'

test('project registrations persist in XDG config and initialize non-sensitive XDG state', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-gui-project-store-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const configHome = join(root, 'config')
  const stateHome = join(root, 'state')
  const firstProjectPath = join(root, 'first-project')
  const secondProjectPath = join(root, 'second-project')
  await mkdir(firstProjectPath)
  await mkdir(secondProjectPath)
  const store = new ProjectStore({ configHome, stateHome })

  const firstCanonicalPath = await store.validateProjectPath(firstProjectPath)
  const secondCanonicalPath = await store.validateProjectPath(secondProjectPath)
  await store.addProject({ path: firstCanonicalPath })
  await store.addProject({ path: secondCanonicalPath })
  await store.activateProject(secondCanonicalPath)

  assert.deepEqual(await store.loadProjects(), {
    projects: [{ path: firstCanonicalPath }, { path: secondCanonicalPath }],
    activeProjectKey: secondCanonicalPath
  })
  assert.deepEqual(
    JSON.parse(await readFile(join(stateHome, 'pi-gui-next', 'state.json'), 'utf8')),
    { version: 4, sessions: [], activeSessionKeys: [], archivedSessionKeys: [] }
  )
})

test('invalid config and missing project paths fail fast', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-gui-project-store-invalid-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const configHome = join(root, 'config')
  const store = new ProjectStore({ configHome, stateHome: join(root, 'state') })
  await mkdir(join(configHome, 'pi-gui-next'), { recursive: true })
  await writeFile(join(configHome, 'pi-gui-next', 'config.json'), '{"version":2,"projects":[]}')

  await assert.rejects(store.loadProjects(), /Invalid Pi GUI project config/)
  await writeFile(
    join(configHome, 'pi-gui-next', 'config.json'),
    JSON.stringify({
      version: 2,
      projects: [{ path: join(root, 'project'), trust: 'untrusted' }],
      activeProjectKey: null
    })
  )
  await assert.rejects(store.loadProjects(), /Invalid Pi GUI project config/)
  await writeFile(
    join(configHome, 'pi-gui-next', 'config.json'),
    JSON.stringify({ version: 2, projects: [], activeProjectKey: null })
  )
  await assert.rejects(store.activateProject(join(root, 'unregistered')), /Project is not registered/)
  await assert.rejects(store.validateProjectPath(join(root, 'missing')), /ENOENT/)
})

test('concurrent project registrations complete in FIFO order without temporary files', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-gui-project-store-concurrent-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const configHome = join(root, 'config')
  const stateHome = join(root, 'state')
  const store = new ProjectStore({ configHome, stateHome })
  const firstProject = { path: join(root, 'first') }
  const secondProject = { path: join(root, 'second') }

  const results = await Promise.allSettled([
    store.addProject(firstProject),
    store.addProject(secondProject),
  ])
  await store.activateProject(secondProject.path)

  assert.deepEqual(results.map(({ status }) => status), ['fulfilled', 'fulfilled'])
  const configDirectory = join(configHome, 'pi-gui-next')
  const configText = await readFile(join(configDirectory, 'config.json'), 'utf8')
  assert.deepEqual(JSON.parse(configText), {
    version: 8,
    projects: [firstProject, secondProject],
    activeProjectKey: secondProject.path,
    sessionNaming: { mode: 'auto' },
    appearance: {
      theme: 'system',
      accentColor: 'amber',
      surfaceTransparency: 20,
      textSize: 'default',
      uiFontFamily: null,
      codeFontFamily: null
    },
    general: { startupWorkspaceRestore: 'restore' }
  })
  assert.equal((await readdir(configDirectory)).some((name) => name.includes('.tmp-')), false)
  assert.equal(
    (await readdir(join(stateHome, 'pi-gui-next'))).some((name) => name.includes('.tmp-')),
    false,
  )
})

test('project order roundtrips while preserving the active project and rejects invalid permutations', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-gui-project-store-reorder-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const options = { configHome: join(root, 'config'), stateHome: join(root, 'state') }
  const firstProject = { path: join(root, 'first') }
  const secondProject = { path: join(root, 'second') }
  const thirdProject = { path: join(root, 'third') }
  const store = new ProjectStore(options)
  await store.addProject(firstProject)
  await store.addProject(secondProject)
  await store.addProject(thirdProject)
  await store.activateProject(secondProject.path)

  await store.reorderProjects([thirdProject.path, firstProject.path, secondProject.path])

  assert.deepEqual(await new ProjectStore(options).loadProjects(), {
    projects: [thirdProject, firstProject, secondProject],
    activeProjectKey: secondProject.path
  })
  await assert.rejects(
    store.reorderProjects([thirdProject.path, thirdProject.path, secondProject.path]),
    /Project keys must be a strict permutation/
  )
  await assert.rejects(
    store.reorderProjects([thirdProject.path, firstProject.path]),
    /Project keys must be a strict permutation/
  )
  await assert.rejects(
    store.reorderProjects([thirdProject.path, firstProject.path, join(root, 'unknown')]),
    /Project keys must be a strict permutation/
  )
  assert.deepEqual((await store.loadProjects()).projects, [thirdProject, firstProject, secondProject])
})

test('session naming settings migrate to the current config without storing OAuth credentials', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-gui-session-naming-settings-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const configHome = join(root, 'config')
  const configDirectory = join(configHome, 'pi-gui-next')
  const project = { path: join(root, 'project') }
  await mkdir(configDirectory, { recursive: true })
  await writeFile(
    join(configDirectory, 'config.json'),
    JSON.stringify({ version: 2, projects: [project], activeProjectKey: project.path })
  )
  const store = new ProjectStore({ configHome, stateHome: join(root, 'state') })

  assert.deepEqual(await store.loadSessionNaming(), { mode: 'auto' })
  await store.saveSessionNaming({
    mode: 'model',
    provider: 'openai-codex',
    modelId: 'gpt-5.4-mini'
  })

  assert.deepEqual(await store.loadSessionNaming(), {
    mode: 'model',
    provider: 'openai-codex',
    modelId: 'gpt-5.4-mini'
  })
  assert.deepEqual(JSON.parse(await readFile(join(configDirectory, 'config.json'), 'utf8')), {
    version: 8,
    projects: [project],
    activeProjectKey: project.path,
    sessionNaming: {
      mode: 'model',
      provider: 'openai-codex',
      modelId: 'gpt-5.4-mini'
    },
    appearance: {
      theme: 'system',
      accentColor: 'amber',
      surfaceTransparency: 20,
      textSize: 'default',
      uiFontFamily: null,
      codeFontFamily: null
    },
    general: { startupWorkspaceRestore: 'restore' }
  })
})

test('appearance settings migrate config v4 to v8 and persist theme, accent, transparency, and text size', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-gui-appearance-settings-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const configHome = join(root, 'config')
  const configDirectory = join(configHome, 'pi-gui-next')
  const project = { path: join(root, 'project') }
  await mkdir(configDirectory, { recursive: true })
  await writeFile(
    join(configDirectory, 'config.json'),
    JSON.stringify({
      version: 4,
      projects: [project],
      activeProjectKey: project.path,
      sessionNaming: { mode: 'auto' },
      appearance: { uiFontFamily: 'Noto Sans', codeFontFamily: 'JetBrains Mono' }
    })
  )
  const options = { configHome, stateHome: join(root, 'state') }
  const store = new ProjectStore(options)

  assert.deepEqual(await store.loadAppearance(), {
    theme: 'system',
    accentColor: 'amber',
    surfaceTransparency: 20,
    textSize: 'default',
    uiFontFamily: 'Noto Sans',
    codeFontFamily: 'JetBrains Mono'
  })
  for (const theme of ['system', 'dark', 'light'] as const) {
    await store.saveAppearance({
      theme,
      accentColor: 'purple',
      surfaceTransparency: 30,
      textSize: 'large',
      uiFontFamily: 'Noto Sans',
      codeFontFamily: 'JetBrains Mono'
    })
    assert.equal((await new ProjectStore(options).loadAppearance()).theme, theme)
  }
  assert.deepEqual(JSON.parse(await readFile(join(configDirectory, 'config.json'), 'utf8')), {
    version: 8,
    projects: [project],
    activeProjectKey: project.path,
    sessionNaming: { mode: 'auto' },
    appearance: {
      theme: 'light',
      accentColor: 'purple',
      surfaceTransparency: 30,
      textSize: 'large',
      uiFontFamily: 'Noto Sans',
      codeFontFamily: 'JetBrains Mono'
    },
    general: { startupWorkspaceRestore: 'restore' }
  })
})

test('config v7 gains the default text size and roundtrips startup workspace restore', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-gui-general-settings-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const configHome = join(root, 'config')
  const configDirectory = join(configHome, 'pi-gui-next')
  const project = { path: join(root, 'project') }
  await mkdir(configDirectory, { recursive: true })
  await writeFile(
    join(configDirectory, 'config.json'),
    JSON.stringify({
      version: 7,
      projects: [project],
      activeProjectKey: project.path,
      sessionNaming: { mode: 'auto' },
      appearance: {
        theme: 'dark',
        accentColor: 'green',
        surfaceTransparency: 10,
        uiFontFamily: null,
        codeFontFamily: null
      },
      general: { startupWorkspaceRestore: 'restore' }
    })
  )
  const options = { configHome, stateHome: join(root, 'state') }
  const store = new ProjectStore(options)

  assert.deepEqual(await store.loadAppearance(), {
    theme: 'dark',
    accentColor: 'green',
    surfaceTransparency: 10,
    textSize: 'default',
    uiFontFamily: null,
    codeFontFamily: null
  })
  assert.deepEqual(await store.loadGeneral(), { startupWorkspaceRestore: 'restore' })
  await store.saveGeneral({ startupWorkspaceRestore: 'none' })

  assert.deepEqual(await new ProjectStore(options).loadGeneral(), {
    startupWorkspaceRestore: 'none'
  })
  assert.deepEqual(JSON.parse(await readFile(join(configDirectory, 'config.json'), 'utf8')), {
    version: 8,
    projects: [project],
    activeProjectKey: project.path,
    sessionNaming: { mode: 'auto' },
    appearance: {
      theme: 'dark',
      accentColor: 'green',
      surfaceTransparency: 10,
      textSize: 'default',
      uiFontFamily: null,
      codeFontFamily: null
    },
    general: { startupWorkspaceRestore: 'none' }
  })
})

test('session pointers roundtrip as a per-project index with an active selection', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-gui-project-store-session-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new ProjectStore({ configHome: join(root, 'config'), stateHome: join(root, 'state') })
  const firstPointer = {
    projectPath: join(root, 'project'),
    sessionFile: join(root, 'sessions', 'session.jsonl'),
    sessionId: 'session-1',
    sessionName: null
  }
  const secondPointer = {
    projectPath: join(root, 'other-project'),
    sessionFile: join(root, 'sessions', 'session-2.jsonl'),
    sessionId: 'session-2',
    sessionName: 'Second session'
  }
  const thirdPointer = {
    projectPath: firstPointer.projectPath,
    sessionFile: join(root, 'sessions', 'session-3.jsonl'),
    sessionId: 'session-3',
    sessionName: 'Third session'
  }
  await mkdir(join(root, 'sessions'), { recursive: true })
  await writeFile(firstPointer.sessionFile, '{}\n')
  await writeFile(secondPointer.sessionFile, '{}\n')
  await writeFile(thirdPointer.sessionFile, '{}\n')
  await store.addProject({ path: firstPointer.projectPath })
  await store.addProject({ path: secondPointer.projectPath })

  assert.deepEqual(await store.loadSessionRegistry(firstPointer.projectPath), {
    sessions: [],
    activeSessionKey: null
  })
  await store.saveSession(firstPointer)
  await store.saveSession(secondPointer)
  await store.saveSession(thirdPointer)
  assert.deepEqual(await store.loadSessionRegistry(firstPointer.projectPath), {
    sessions: [firstPointer, thirdPointer],
    activeSessionKey: thirdPointer.sessionFile
  })
  assert.deepEqual(await store.loadSessionRegistry(secondPointer.projectPath), {
    sessions: [secondPointer],
    activeSessionKey: secondPointer.sessionFile
  })
})

test('session order roundtrips in global slots while preserving pointers and active selections', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-gui-project-store-session-reorder-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const options = { configHome: join(root, 'config'), stateHome: join(root, 'state') }
  const store = new ProjectStore(options)
  const projectPath = join(root, 'project')
  const otherProjectPath = join(root, 'other-project')
  const firstPointer = {
    projectPath,
    sessionFile: join(root, 'sessions', 'first.jsonl'),
    sessionId: 'first-session',
    sessionName: 'First session'
  }
  const otherPointer = {
    projectPath: otherProjectPath,
    sessionFile: join(root, 'sessions', 'other.jsonl'),
    sessionId: 'other-session',
    sessionName: null
  }
  const secondPointer = {
    projectPath,
    sessionFile: join(root, 'sessions', 'second.jsonl'),
    sessionId: 'second-session',
    sessionName: 'Second session'
  }
  await mkdir(join(root, 'sessions'), { recursive: true })
  await Promise.all([
    writeFile(firstPointer.sessionFile, '{}\n'),
    writeFile(otherPointer.sessionFile, '{}\n'),
    writeFile(secondPointer.sessionFile, '{}\n')
  ])
  await store.addProject({ path: projectPath })
  await store.addProject({ path: otherProjectPath })
  await store.saveSession(firstPointer)
  await store.saveSession(otherPointer)
  await store.saveSession(secondPointer)

  await store.reorderSessions(projectPath, [secondPointer.sessionFile, firstPointer.sessionFile])

  assert.deepEqual(await new ProjectStore(options).loadSessionRegistry(projectPath), {
    sessions: [secondPointer, firstPointer],
    activeSessionKey: secondPointer.sessionFile
  })
  assert.deepEqual(await new ProjectStore(options).loadSessionRegistry(otherProjectPath), {
    sessions: [otherPointer],
    activeSessionKey: otherPointer.sessionFile
  })
  const persistedState = JSON.parse(
    await readFile(join(options.stateHome, 'pi-gui-next', 'state.json'), 'utf8')
  ) as { sessions: typeof firstPointer[] }
  assert.deepEqual(persistedState.sessions, [secondPointer, otherPointer, firstPointer])

  await assert.rejects(
    store.reorderSessions(projectPath, [secondPointer.sessionFile, secondPointer.sessionFile]),
    /Session keys must be a strict permutation/
  )
  await assert.rejects(
    store.reorderSessions(projectPath, [secondPointer.sessionFile]),
    /Session keys must be a strict permutation/
  )
  await assert.rejects(
    store.reorderSessions(projectPath, [secondPointer.sessionFile, join(root, 'unknown.jsonl')]),
    /Session keys must be a strict permutation/
  )
  assert.deepEqual((await store.loadSessionRegistry(projectPath)).sessions, [secondPointer, firstPointer])
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
      version: 2,
      recentSessions: [{
        projectPath: join(root, 'project'),
        sessionFile: 'relative.jsonl',
        sessionId: 'session-1',
        sessionName: null
      }]
    })
  )
  const store = new ProjectStore({ configHome: join(root, 'config'), stateHome })

  await assert.rejects(store.loadSessionRegistry(join(root, 'project')), /Invalid Pi GUI project state/)
})

test('version 1 project and session files migrate on the next write', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-gui-project-store-migration-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const configHome = join(root, 'config')
  const stateHome = join(root, 'state')
  const configDirectory = join(configHome, 'pi-gui-next')
  const stateDirectory = join(stateHome, 'pi-gui-next')
  const oldProject = { path: join(root, 'old-project') }
  const newProject = { path: join(root, 'new-project') }
  const oldPointer = {
    projectPath: oldProject.path,
    sessionFile: join(root, 'sessions', 'old.jsonl'),
    sessionId: 'old-session',
    sessionName: null
  }
  await mkdir(join(root, 'sessions'), { recursive: true })
  await writeFile(oldPointer.sessionFile, '{}\n')
  await writeFile(join(root, 'sessions', 'new.jsonl'), '{}\n')
  await mkdir(configDirectory, { recursive: true })
  await mkdir(stateDirectory, { recursive: true })
  await writeFile(
    join(configDirectory, 'config.json'),
    JSON.stringify({ version: 1, project: oldProject })
  )
  await writeFile(
    join(stateDirectory, 'state.json'),
    JSON.stringify({ version: 1, recentSession: oldPointer })
  )
  const store = new ProjectStore({ configHome, stateHome })

  assert.deepEqual(await store.loadProjects(), {
    projects: [oldProject],
    activeProjectKey: oldProject.path
  })
  assert.deepEqual(await store.loadSessionRegistry(oldProject.path), {
    sessions: [oldPointer],
    activeSessionKey: oldPointer.sessionFile
  })

  await store.addProject(newProject)
  await store.activateProject(newProject.path)
  await store.saveSession({
    projectPath: newProject.path,
    sessionFile: join(root, 'sessions', 'new.jsonl'),
    sessionId: 'new-session',
    sessionName: null
  })

  assert.deepEqual(JSON.parse(await readFile(join(configDirectory, 'config.json'), 'utf8')), {
    version: 8,
    projects: [oldProject, newProject],
    activeProjectKey: newProject.path,
    sessionNaming: { mode: 'auto' },
    appearance: {
      theme: 'system',
      accentColor: 'amber',
      surfaceTransparency: 20,
      textSize: 'default',
      uiFontFamily: null,
      codeFontFamily: null
    },
    general: { startupWorkspaceRestore: 'restore' }
  })
  const state = JSON.parse(await readFile(join(stateDirectory, 'state.json'), 'utf8')) as {
    version: number
    sessions: Array<{ projectPath: string }>
    activeSessionKeys: Array<{ projectPath: string; sessionKey: string }>
  }
  assert.equal(state.version, 4)
  assert.deepEqual(state.sessions.map(({ projectPath }) => projectPath), [
    oldProject.path,
    newProject.path
  ])
  assert.deepEqual(state.activeSessionKeys.map(({ projectPath }) => projectPath), [
    oldProject.path,
    newProject.path
  ])
})

test('version 2 recent sessions migrate to a multi-session index on the next write', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-gui-project-store-v2-migration-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const configHome = join(root, 'config')
  const stateHome = join(root, 'state')
  const configDirectory = join(configHome, 'pi-gui-next')
  const stateDirectory = join(stateHome, 'pi-gui-next')
  const projectPath = join(root, 'project')
  const firstPointer = {
    projectPath,
    sessionFile: join(root, 'sessions', 'first.jsonl'),
    sessionId: 'first-session',
    sessionName: 'First session'
  }
  const secondPointer = {
    projectPath,
    sessionFile: join(root, 'sessions', 'second.jsonl'),
    sessionId: 'second-session',
    sessionName: 'Second session'
  }
  await mkdir(configDirectory, { recursive: true })
  await mkdir(stateDirectory, { recursive: true })
  await mkdir(join(root, 'sessions'), { recursive: true })
  await writeFile(firstPointer.sessionFile, '{}\n')
  await writeFile(secondPointer.sessionFile, '{}\n')
  await writeFile(
    join(configDirectory, 'config.json'),
    JSON.stringify({
      version: 2,
      projects: [{ path: projectPath }],
      activeProjectKey: projectPath
    })
  )
  await writeFile(
    join(stateDirectory, 'state.json'),
    JSON.stringify({ version: 2, recentSessions: [firstPointer] })
  )
  const store = new ProjectStore({ configHome, stateHome })

  assert.deepEqual(await store.loadSessionRegistry(projectPath), {
    sessions: [firstPointer],
    activeSessionKey: firstPointer.sessionFile
  })
  await store.saveSession(secondPointer)

  assert.deepEqual(await store.loadSessionRegistry(projectPath), {
    sessions: [firstPointer, secondPointer],
    activeSessionKey: secondPointer.sessionFile
  })
  const state = JSON.parse(await readFile(join(stateDirectory, 'state.json'), 'utf8')) as {
    version: number
    sessions: unknown[]
  }
  assert.equal(state.version, 4)
  assert.equal(state.sessions.length, 2)
})

test('version 3 session state migrates to version 4 on the next write', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-gui-project-store-v3-migration-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const stateHome = join(root, 'state')
  const stateDirectory = join(stateHome, 'pi-gui-next')
  const pointer = {
    projectPath: join(root, 'project'),
    sessionFile: join(root, 'sessions', 'session.jsonl'),
    sessionId: 'session-1',
    sessionName: null
  }
  await mkdir(stateDirectory, { recursive: true })
  await writeFile(join(stateDirectory, 'state.json'), JSON.stringify({
    version: 3,
    sessions: [pointer],
    activeSessionKeys: [{ projectPath: pointer.projectPath, sessionKey: pointer.sessionFile }]
  }))
  const store = new ProjectStore({ configHome: join(root, 'config'), stateHome })

  await store.reorderSessions(pointer.projectPath, [pointer.sessionFile])

  assert.deepEqual(JSON.parse(await readFile(join(stateDirectory, 'state.json'), 'utf8')), {
    version: 4,
    sessions: [pointer],
    activeSessionKeys: [{ projectPath: pointer.projectPath, sessionKey: pointer.sessionFile }],
    archivedSessionKeys: []
  })
})

test('archiving hides a session and clears its active selection without deleting its pointer or file', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-gui-project-store-archive-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const stateHome = join(root, 'state')
  const store = new ProjectStore({ configHome: join(root, 'config'), stateHome })
  const pointer = {
    projectPath: join(root, 'project'),
    sessionFile: join(root, 'sessions', 'session.jsonl'),
    sessionId: 'session-1',
    sessionName: 'Archived session'
  }
  await mkdir(join(root, 'sessions'), { recursive: true })
  await writeFile(pointer.sessionFile, '{"kept":true}\n')
  await store.addProject({ path: pointer.projectPath })
  await store.saveSession(pointer)

  await store.archiveSession(pointer.projectPath, pointer.sessionFile)

  assert.deepEqual(await store.loadSessionRegistry(pointer.projectPath), {
    sessions: [],
    activeSessionKey: null
  })
  const state = JSON.parse(
    await readFile(join(stateHome, 'pi-gui-next', 'state.json'), 'utf8')
  )
  assert.deepEqual(state.sessions, [pointer])
  assert.deepEqual(state.activeSessionKeys, [])
  assert.deepEqual(state.archivedSessionKeys, [{
    projectPath: pointer.projectPath,
    sessionKey: pointer.sessionFile
  }])
  assert.equal(await readFile(pointer.sessionFile, 'utf8'), '{"kept":true}\n')
})

test('visible session reorder preserves an archived pointer in its original slot', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-gui-project-store-archive-reorder-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const stateHome = join(root, 'state')
  const store = new ProjectStore({ configHome: join(root, 'config'), stateHome })
  const projectPath = join(root, 'project')
  const pointers = ['first', 'archived', 'third'].map((name) => ({
    projectPath,
    sessionFile: join(root, 'sessions', `${name}.jsonl`),
    sessionId: `${name}-session`,
    sessionName: name
  }))
  await mkdir(join(root, 'sessions'), { recursive: true })
  await store.addProject({ path: projectPath })
  for (const pointer of pointers) {
    await writeFile(pointer.sessionFile, '{}\n')
    await store.saveSession(pointer)
  }
  const [firstPointer, archivedPointer, thirdPointer] = pointers
  assert.ok(firstPointer && archivedPointer && thirdPointer)
  await store.archiveSession(projectPath, archivedPointer.sessionFile)

  await store.reorderSessions(projectPath, [thirdPointer.sessionFile, firstPointer.sessionFile])

  assert.deepEqual((await store.loadSessionRegistry(projectPath)).sessions, [
    thirdPointer,
    firstPointer
  ])
  const state = JSON.parse(
    await readFile(join(stateHome, 'pi-gui-next', 'state.json'), 'utf8')
  )
  assert.deepEqual(state.sessions, [thirdPointer, archivedPointer, firstPointer])
})

test('session validation requires an existing regular file', async (t) => {
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
  await store.addProject({ path: pointer.projectPath })

  await assert.rejects(store.validateSession(pointer), /ENOENT/)
  await mkdir(sessionFile, { recursive: true })
  await assert.rejects(store.validateSession(pointer), /not a regular file/)
  await rm(sessionFile, { recursive: true })
  await writeFile(sessionFile, '{}\n')
  assert.deepEqual(await store.validateSession(pointer), pointer)
  assert.equal(typeof await store.sessionActivityAt(sessionFile), 'number')
  assert.equal(await store.sessionActivityAt(join(root, 'missing-session.jsonl')), null)
  await assert.rejects(
    store.validateSession({ ...pointer, extra: true } as typeof pointer),
    /Invalid Pi GUI session pointer/
  )
})

test('session pointers require a registered project and persist a canonical session file', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-gui-project-store-session-identity-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new ProjectStore({ configHome: join(root, 'config'), stateHome: join(root, 'state') })
  const projectPath = join(root, 'project')
  const sessionDirectory = join(root, 'pi-state', 'sessions')
  const canonicalSessionFile = join(sessionDirectory, 'session.jsonl')
  const linkedSessionFile = join(root, 'linked-session.jsonl')
  await mkdir(projectPath)
  await mkdir(sessionDirectory, { recursive: true })
  await writeFile(canonicalSessionFile, '{}\n')
  await symlink(canonicalSessionFile, linkedSessionFile)
  const pointer = {
    projectPath,
    sessionFile: linkedSessionFile,
    sessionId: 'session-1',
    sessionName: null
  }

  await assert.rejects(store.validateSession(pointer), /Project is not registered/)
  await store.addProject({ path: projectPath })
  const canonicalPointer = await store.validateSession(pointer)
  assert.deepEqual(canonicalPointer, { ...pointer, sessionFile: await realpath(canonicalSessionFile) })

  await store.saveSession(pointer)
  assert.deepEqual(await store.loadSessionRegistry(projectPath), {
    sessions: [canonicalPointer],
    activeSessionKey: canonicalPointer.sessionFile
  })
})
