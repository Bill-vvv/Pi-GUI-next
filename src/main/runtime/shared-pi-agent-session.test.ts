import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import test from 'node:test'

import { SharedPiAgentSession } from './shared-pi-agent-session.ts'
import { SharedPiHost } from './shared-pi-host.ts'

test('SharedPiAgentSession cleans up a real SDK runtime when late startup binding fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-shared-sdk-startup-failure-'))
  const agentDir = join(root, 'agent')
  const project = join(root, 'project')
  const marker = join(root, 'shutdown-marker.txt')
  const extensionPath = join(root, 'shutdown-extension.ts')
  await Promise.all([
    mkdir(agentDir, { recursive: true }),
    mkdir(project, { recursive: true }),
    writeFile(
      extensionPath,
      `import { appendFile } from 'node:fs/promises'
export default function extension(pi) {
  pi.on('session_shutdown', async () => {
    await appendFile(${JSON.stringify(marker)}, 'closed\\n', 'utf8')
  })
}\n`,
      'utf8'
    )
  ])
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = agentDir
  const host = new SharedPiHost({
    createSession: async (environment, options, callbacks) =>
      SharedPiAgentSession.create(environment, options, {
        ...callbacks,
        onIdentityChange: async () => {
          throw new Error('forced late startup binding failure')
        }
      })
  })
  const runtime = host.createRuntime({
    cwd: project,
    projectTrust: true,
    extensionPaths: [extensionPath]
  })

  try {
    await assert.rejects(runtime.start(), /forced late startup binding failure/u)
    await host.dispose()
    assert.equal(await readFile(marker, 'utf8'), 'closed\n')
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir
    await rm(root, { recursive: true, force: true })
  }
})

test('SharedPiHost runs two real Pi SDK Sessions in one process and drains both', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-shared-sdk-'))
  const agentDir = join(root, 'agent')
  const firstProject = join(root, 'first-project')
  const secondProject = join(root, 'second-project')
  const extensionPath = join(root, 'session-scope-extension.ts')
  await Promise.all([
    mkdir(agentDir, { recursive: true }),
    mkdir(firstProject, { recursive: true }),
    mkdir(secondProject, { recursive: true }),
    writeFile(
      extensionPath,
      `export default function extension(pi) {
  pi.registerCommand('session-scope', {
    description: 'Read the Session-scoped environment after an async boundary.',
    handler: async (_args, ctx) => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      ctx.ui.setStatus('session-scope-test', process.env.PI_GUI_NOTIFICATION_TOKEN)
    }
  })
}\n`,
      'utf8'
    )
  ])
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = agentDir
  const host = new SharedPiHost()
  const first = host.createRuntime({
    cwd: firstProject,
    projectTrust: true,
    extensionPaths: [extensionPath],
    desktopNotification: { socketPath: '/tmp/first.sock', token: 'first-token' }
  })
  const second = host.createRuntime({
    cwd: secondProject,
    projectTrust: true,
    extensionPaths: [extensionPath],
    desktopNotification: { socketPath: '/tmp/second.sock', token: 'second-token' }
  })
  const waitForScopedStatus = (runtime: typeof first): Promise<string | undefined> =>
    new Promise((resolve) => {
      const unsubscribe = runtime.subscribe((event) => {
        if (
          event.type !== 'pi-event' || event.event.type !== 'extension_ui_request' ||
          event.event.method !== 'setStatus' ||
          event.event.statusKey !== 'session-scope-test'
        ) return
        unsubscribe()
        resolve(typeof event.event.statusText === 'string' ? event.event.statusText : undefined)
      })
    })

  try {
    await Promise.all([first.start(), second.start()])
    const [firstState, secondState] = await Promise.all([
      first.send({ type: 'get_state' }),
      second.send({ type: 'get_state' })
    ])
    assert.equal(firstState.type, 'state')
    assert.equal(secondState.type, 'state')
    const firstSessionFile = firstState.type === 'state' ? firstState.state.sessionFile : undefined
    const secondSessionFile = secondState.type === 'state' ? secondState.state.sessionFile : undefined
    assert.equal(typeof firstSessionFile, 'string')
    assert.equal(typeof secondSessionFile, 'string')
    assert.ok(firstSessionFile !== undefined && isAbsolute(firstSessionFile))
    assert.ok(secondSessionFile !== undefined && isAbsolute(secondSessionFile))
    assert.notEqual(firstSessionFile, secondSessionFile)
    assert.equal(first.getRpcPid(), null)
    assert.equal(second.getRpcPid(), null)

    const firstStatus = waitForScopedStatus(first)
    const secondStatus = waitForScopedStatus(second)
    await Promise.all([
      first.send({ type: 'invoke_extension_command', name: 'session-scope' }),
      second.send({ type: 'invoke_extension_command', name: 'session-scope' })
    ])
    assert.deepEqual(await Promise.all([firstStatus, secondStatus]), [
      'first-token',
      'second-token'
    ])
  } finally {
    await host.dispose()
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir
    await rm(root, { recursive: true, force: true })
  }
})

test('SharedPiHost activates extension tools and fails when an extension cannot load', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-shared-sdk-tools-'))
  const agentDir = join(root, 'agent')
  const project = join(root, 'project')
  const toolExtensionPath = join(root, 'tool-extension.ts')
  const brokenExtensionPath = join(root, 'broken-extension.ts')
  await Promise.all([
    mkdir(agentDir, { recursive: true }),
    mkdir(project, { recursive: true }),
    writeFile(
      toolExtensionPath,
      `import { Type } from 'typebox'
export default function extension(pi) {
  pi.registerTool({
    name: 'diag-tool',
    label: 'Diag',
    description: 'Diagnostic extension tool',
    parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: 'text', text: 'ok' }] })
  })
  pi.on('session_start', (_event, ctx) => {
    ctx.ui.setStatus('diag-tools', JSON.stringify(pi.getActiveTools()))
  })
}\n`,
      'utf8'
    ),
    writeFile(brokenExtensionPath, 'export default 1\n', 'utf8')
  ])
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = agentDir

  try {
    const host = new SharedPiHost()
    const runtime = host.createRuntime({
      cwd: project,
      projectTrust: true,
      extensionPaths: [toolExtensionPath]
    })
    const started = new Promise<string | undefined>((resolve) => {
      const unsubscribe = runtime.subscribe((event) => {
        if (
          event.type !== 'pi-event' || event.event.type !== 'extension_ui_request' ||
          event.event.method !== 'setStatus' ||
          event.event.statusKey !== 'diag-tools'
        ) return
        unsubscribe()
        resolve(typeof event.event.statusText === 'string' ? event.event.statusText : undefined)
      })
    })
    await runtime.start()
    const activeTools = JSON.parse(await started ?? '[]') as string[]
    assert.equal(activeTools.includes('diag-tool'), true)
    await host.dispose()

    const failingHost = new SharedPiHost()
    const failingRuntime = failingHost.createRuntime({
      cwd: project,
      projectTrust: true,
      extensionPaths: [brokenExtensionPath]
    })
    await assert.rejects(failingRuntime.start(), /extension load error/u)
    await failingHost.dispose()
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir
    await rm(root, { recursive: true, force: true })
  }
})

test('SharedPiHost initializes the Pi theme before session_start uses ui.theme', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-shared-sdk-theme-'))
  const agentDir = join(root, 'agent')
  const project = join(root, 'project')
  const extensionPath = join(root, 'theme-extension.ts')
  await Promise.all([
    mkdir(agentDir, { recursive: true }),
    mkdir(project, { recursive: true }),
    writeFile(
      extensionPath,
      `export default function extension(pi) {
  pi.on('session_start', (_event, ctx) => {
    const styled = ctx.ui.theme.fg('accent', 'theme-ok')
    ctx.ui.setStatus('theme-init', styled.includes('theme-ok') ? 'ok' : 'bad')
  })
}\n`,
      'utf8'
    )
  ])
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = agentDir
  const host = new SharedPiHost()
  const runtime = host.createRuntime({
    cwd: project,
    projectTrust: true,
    extensionPaths: [extensionPath]
  })

  try {
    const started = new Promise<string | undefined>((resolve, reject) => {
      const unsubscribe = runtime.subscribe((event) => {
        if (event.type === 'pi-event' && event.event.type === 'extension_error') {
          unsubscribe()
          reject(new Error(typeof event.event.error === 'string' ? event.event.error : 'extension_error'))
          return
        }
        if (
          event.type !== 'pi-event' || event.event.type !== 'extension_ui_request' ||
          event.event.method !== 'setStatus' ||
          event.event.statusKey !== 'theme-init'
        ) return
        unsubscribe()
        resolve(typeof event.event.statusText === 'string' ? event.event.statusText : undefined)
      })
    })
    await runtime.start()
    assert.equal(await started, 'ok')
  } finally {
    await host.dispose()
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir
    await rm(root, { recursive: true, force: true })
  }
})
