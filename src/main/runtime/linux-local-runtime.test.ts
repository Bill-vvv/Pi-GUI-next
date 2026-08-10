import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { buildPiRpcArguments, LinuxLocalRuntime } from './linux-local-runtime.ts'

test('runtime leaves project resource trust to Pi defaults', () => {
  const arguments_ = buildPiRpcArguments()

  assert.deepEqual(arguments_.slice(0, 3), ['--mode', 'rpc', '--offline'])
  assert.equal(arguments_[3], '--append-system-prompt')
  assert.match(arguments_[4] ?? '', /commentary/)
  assert.match(arguments_[4] ?? '', /final_answer/)
  assert.equal(arguments_.includes('--approve'), false)
  assert.equal(arguments_.includes('--no-approve'), false)
})

test('runtime forwards all three project trust states as argv entries', () => {
  assert.equal(buildPiRpcArguments(undefined, false, undefined).includes('--approve'), false)
  assert.equal(buildPiRpcArguments(undefined, false, undefined).includes('--no-approve'), false)
  assert.equal(buildPiRpcArguments(undefined, false, true).at(-1), '--approve')
  assert.equal(buildPiRpcArguments(undefined, false, false).at(-1), '--no-approve')
})

test('runtime does not add legacy subagent arguments', () => {
  const arguments_ = buildPiRpcArguments()
  assert.equal(arguments_.includes('--subagent-max-depth'), false)
  assert.equal(arguments_.includes('--subagent-prevent-cycles'), false)
  assert.equal(arguments_.includes('--no-subagent-prevent-cycles'), false)
  assert.throws(
    () => new LinuxLocalRuntime({ cwd: '/tmp', subagent: { maxDepth: 4 as 1 } }),
    /Invalid subagent settings/u
  )
  assert.throws(
    () => new LinuxLocalRuntime({
      cwd: '/tmp',
      desktopNotification: { socketPath: 'relative.sock', token: 'x'.repeat(32) }
    }),
    /must be absolute/u
  )
  assert.throws(
    () => new LinuxLocalRuntime({
      cwd: '/tmp',
      desktopNotification: { socketPath: '/tmp/notify.sock', token: 'too-short' }
    }),
    /token is invalid/u
  )
})

test('runtime rejects a workspace that no longer resolves to its registered canonical path', {
  skip: process.platform !== 'linux'
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-runtime-workspace-drift-'))
  t.after(async () => rm(root, { recursive: true, force: true }))
  const workspace = join(root, 'workspace')
  const replacement = join(root, 'replacement')
  await mkdir(workspace)
  await mkdir(replacement)

  const runtime = new LinuxLocalRuntime({
    cwd: workspace,
    explicitExecutable: join(root, 'unused-pi')
  })
  await rm(workspace, { recursive: true })
  await symlink(replacement, workspace)

  await assert.rejects(
    runtime.start(),
    /Runtime workspace path no longer resolves canonically/u
  )
  assert.equal(runtime.getRpcPid(), null)
})

test('runtime revalidates the workspace after the version probe and before RPC spawn', {
  skip: process.platform !== 'linux'
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-runtime-workspace-version-drift-'))
  t.after(async () => rm(root, { recursive: true, force: true }))
  const workspace = join(root, 'workspace')
  const replacement = join(root, 'replacement')
  const executable = join(root, 'pi')
  const rpcMarker = join(root, 'rpc-started')
  await mkdir(workspace)
  await mkdir(replacement)
  await writeFile(
    executable,
    `#!/usr/bin/env node
const { rmSync, symlinkSync, writeFileSync } = require('node:fs')
const workspace = ${JSON.stringify(workspace)}
const replacement = ${JSON.stringify(replacement)}
const rpcMarker = ${JSON.stringify(rpcMarker)}
if (process.argv[2] === '--version') {
  rmSync(workspace, { recursive: true })
  symlinkSync(replacement, workspace, 'dir')
  process.stdout.write('0.83.0\\n')
  process.exit(0)
}
writeFileSync(rpcMarker, 'started')
`,
    { mode: 0o755 }
  )

  const runtime = new LinuxLocalRuntime({ cwd: workspace, explicitExecutable: executable })
  await assert.rejects(
    runtime.start(),
    /Runtime workspace path no longer resolves canonically/u
  )
  await assert.rejects(access(rpcMarker), (error: unknown) => {
    assert.equal((error as NodeJS.ErrnoException).code, 'ENOENT')
    return true
  })
  assert.equal(runtime.getRpcPid(), null)
})

test('runtime controls fast extension loading and merges it with subagent depth', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-runtime-subagent-env-'))
  t.after(async () => rm(directory, { recursive: true, force: true }))
  const executable = join(directory, 'pi')
  const environmentLog = join(directory, 'environment.jsonl')
  await writeFile(
    executable,
    `#!/usr/bin/env node
const { appendFileSync } = require('node:fs')
if (process.argv[2] === '--version') {
  process.stdout.write('0.83.0\\n')
  process.exit(0)
}
appendFileSync(${JSON.stringify(environmentLog)}, JSON.stringify({
  depth: process.env.PI_SUBAGENT_MAX_DEPTH,
  parallel: process.env.PI_PARALLEL_EXTENSION_IMPORTS,
  nativeCompiled: process.env.PI_NATIVE_COMPILED_EXTENSION_IMPORTS,
  jitiTryNative: process.env.JITI_TRY_NATIVE,
  nodeOptions: process.env.NODE_OPTIONS,
  notificationSocket: process.env.PI_GUI_NOTIFICATION_SOCKET,
  notificationToken: process.env.PI_GUI_NOTIFICATION_TOKEN,
  openAiFastMode: process.env.PI_GUI_OPENAI_FAST_MODE,
  argv: process.argv.slice(2)
}) + '\\n')
let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  input += chunk
  let newline
  while ((newline = input.indexOf('\\n')) >= 0) {
    const request = JSON.parse(input.slice(0, newline))
    input = input.slice(newline + 1)
    process.stdout.write(JSON.stringify({
      type: 'response',
      id: request.id,
      success: true,
      ...(request.type === 'get_state' ? { data: {} } : {})
    }) + '\\n')
  }
})
`,
    { mode: 0o755 }
  )
  const inheritedDepth = process.env.PI_SUBAGENT_MAX_DEPTH
  const inheritedParallelImports = process.env.PI_PARALLEL_EXTENSION_IMPORTS
  const inheritedNativeCompiledImports = process.env.PI_NATIVE_COMPILED_EXTENSION_IMPORTS
  const inheritedJitiTryNative = process.env.JITI_TRY_NATIVE
  const inheritedNotificationSocket = process.env.PI_GUI_NOTIFICATION_SOCKET
  const inheritedNotificationToken = process.env.PI_GUI_NOTIFICATION_TOKEN
  const inheritedOpenAiFastMode = process.env.PI_GUI_OPENAI_FAST_MODE
  process.env.PI_SUBAGENT_MAX_DEPTH = '9'
  process.env.PI_PARALLEL_EXTENSION_IMPORTS = '1'
  process.env.PI_NATIVE_COMPILED_EXTENSION_IMPORTS = '1'
  process.env.JITI_TRY_NATIVE = '0'
  process.env.PI_GUI_NOTIFICATION_SOCKET = '/tmp/inherited-notification.sock'
  process.env.PI_GUI_NOTIFICATION_TOKEN = 'inherited-notification-token-that-must-be-removed'
  process.env.PI_GUI_OPENAI_FAST_MODE = '1'
  t.after(() => {
    if (inheritedDepth === undefined) delete process.env.PI_SUBAGENT_MAX_DEPTH
    else process.env.PI_SUBAGENT_MAX_DEPTH = inheritedDepth
    if (inheritedParallelImports === undefined) delete process.env.PI_PARALLEL_EXTENSION_IMPORTS
    else process.env.PI_PARALLEL_EXTENSION_IMPORTS = inheritedParallelImports
    if (inheritedNativeCompiledImports === undefined) {
      delete process.env.PI_NATIVE_COMPILED_EXTENSION_IMPORTS
    } else {
      process.env.PI_NATIVE_COMPILED_EXTENSION_IMPORTS = inheritedNativeCompiledImports
    }
    if (inheritedJitiTryNative === undefined) delete process.env.JITI_TRY_NATIVE
    else process.env.JITI_TRY_NATIVE = inheritedJitiTryNative
    if (inheritedNotificationSocket === undefined) delete process.env.PI_GUI_NOTIFICATION_SOCKET
    else process.env.PI_GUI_NOTIFICATION_SOCKET = inheritedNotificationSocket
    if (inheritedNotificationToken === undefined) delete process.env.PI_GUI_NOTIFICATION_TOKEN
    else process.env.PI_GUI_NOTIFICATION_TOKEN = inheritedNotificationToken
    if (inheritedOpenAiFastMode === undefined) delete process.env.PI_GUI_OPENAI_FAST_MODE
    else process.env.PI_GUI_OPENAI_FAST_MODE = inheritedOpenAiFastMode
  })

  const inheritedRuntime = new LinuxLocalRuntime({
    cwd: directory,
    explicitExecutable: executable
  })
  await inheritedRuntime.start()
  await inheritedRuntime.stop()
  const notificationToken = 'configured-notification-token-that-is-long-enough'
  const configuredRuntime = new LinuxLocalRuntime({
    cwd: directory,
    explicitExecutable: executable,
    subagent: { maxDepth: 2 },
    fastExtensionLoading: true,
    desktopNotification: {
      socketPath: '/tmp/pi-gui-notification.sock',
      token: notificationToken
    }
  })
  await configuredRuntime.start()
  await configuredRuntime.stop()

  const launches = (await readFile(environmentLog, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as {
      depth: string
      parallel?: string
      nativeCompiled?: string
      jitiTryNative?: string
      nodeOptions?: string
      notificationSocket?: string
      notificationToken?: string
      openAiFastMode?: string
      argv: string[]
    })
  assert.deepEqual(launches.map(({ depth }) => depth), ['9', '2'])
  assert.deepEqual(launches.map(({ parallel }) => parallel), [undefined, '1'])
  assert.deepEqual(launches.map(({ nativeCompiled }) => nativeCompiled), [undefined, '1'])
  assert.deepEqual(launches.map(({ jitiTryNative }) => jitiTryNative), [undefined, '1'])
  assert.equal(launches[1]?.nodeOptions?.includes('--import=data:text/javascript,'), true)
  assert.deepEqual(
    launches.map(({ notificationSocket }) => notificationSocket),
    [undefined, '/tmp/pi-gui-notification.sock']
  )
  assert.deepEqual(
    launches.map(({ notificationToken }) => notificationToken),
    [undefined, notificationToken]
  )
  assert.deepEqual(
    launches.map(({ openAiFastMode }) => openAiFastMode),
    [undefined, undefined]
  )
  assert.equal(launches.some(({ argv }) => argv.some((argument) => argument.includes('subagent'))), false)
})

test('runtime resumes an absolute session file', () => {
  const sessionFile = '/tmp/pi-session.jsonl'

  assert.deepEqual(buildPiRpcArguments(sessionFile), [
    '--mode',
    'rpc',
    '--offline',
    '--append-system-prompt',
    buildPiRpcArguments()[4]!,
    '--session',
    sessionFile
  ])
  assert.throws(
    () => new LinuxLocalRuntime({ cwd: '/tmp', sessionFile: 'relative-session.jsonl' }),
    /Session file must be an absolute path/
  )
})

test('runtime supports stateless probes and rejects conflicting session modes', () => {
  assert.deepEqual(buildPiRpcArguments(undefined, true), [
    '--mode',
    'rpc',
    '--offline',
    '--append-system-prompt',
    buildPiRpcArguments()[4]!,
    '--no-session'
  ])
  assert.throws(
    () => buildPiRpcArguments('/tmp/pi-session.jsonl', true),
    /cannot be used together/
  )
  assert.throws(
    () => new LinuxLocalRuntime({ cwd: '/tmp', sessionFile: '/tmp/pi-session.jsonl', noSession: true }),
    /cannot be used together/
  )
})

test('runtime forwards native images for prompt, steer, and follow-up', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-runtime-images-'))
  t.after(async () => rm(directory, { recursive: true, force: true }))
  const executable = join(directory, 'pi')
  const requestLog = join(directory, 'requests.jsonl')
  await writeFile(
    executable,
    `#!/usr/bin/env node
const { appendFileSync } = require('node:fs')
if (process.argv[2] === '--version') {
  process.stdout.write('0.83.0\\n')
  process.exit(0)
}
let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  input += chunk
  let newline
  while ((newline = input.indexOf('\\n')) >= 0) {
    const request = JSON.parse(input.slice(0, newline))
    input = input.slice(newline + 1)
    appendFileSync(${JSON.stringify(requestLog)}, JSON.stringify(request) + '\\n')
    process.stdout.write(JSON.stringify({
      type: 'response',
      id: request.id,
      success: true,
      ...(request.type === 'get_state' ? { data: {} } : {})
    }) + '\\n')
  }
})
`,
    { mode: 0o755 }
  )
  const runtime = new LinuxLocalRuntime({ cwd: directory, explicitExecutable: executable })
  const image = { type: 'image' as const, mimeType: 'image/png', data: 'aGVsbG8=' }

  await runtime.start()
  await runtime.send({ type: 'prompt', message: 'Prompt', images: [image] })
  await runtime.send({ type: 'steer', message: 'Steer', images: [image] })
  await runtime.send({ type: 'follow_up', message: 'Follow up', images: [image] })
  await runtime.stop()

  const requests = (await readFile(requestLog, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .map(({ id: _id, ...request }) => request)
  assert.deepEqual(requests.slice(-3), [
    { type: 'prompt', message: 'Prompt', images: [image] },
    { type: 'steer', message: 'Steer', images: [image] },
    { type: 'follow_up', message: 'Follow up', images: [image] }
  ])
})

test('runtime forwards get_entries and fork through the Pi RPC client', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-runtime-fork-'))
  t.after(async () => rm(directory, { recursive: true, force: true }))
  const executable = join(directory, 'pi')
  const requestLog = join(directory, 'requests.jsonl')
  await writeFile(
    executable,
    `#!/usr/bin/env node
const { appendFileSync } = require('node:fs')
if (process.argv[2] === '--version') {
  process.stdout.write('0.83.0\\n')
  process.exit(0)
}
let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  input += chunk
  let newline
  while ((newline = input.indexOf('\\n')) >= 0) {
    const request = JSON.parse(input.slice(0, newline))
    input = input.slice(newline + 1)
    appendFileSync(${JSON.stringify(requestLog)}, JSON.stringify(request) + '\\n')
    const data = request.type === 'get_state'
      ? {}
      : request.type === 'get_entries'
        ? {
            entries: [{
              id: 'entry-1',
              parentId: null,
              type: 'message',
              timestamp: '2026-07-24T01:00:00.000Z',
              message: { role: 'user', content: 'Original prompt' }
            }],
            leafId: 'entry-1'
          }
        : request.type === 'fork'
          ? { text: 'Original prompt', cancelled: false }
          : undefined
    process.stdout.write(JSON.stringify({
      type: 'response',
      id: request.id,
      success: true,
      ...(data === undefined ? {} : { data })
    }) + '\\n')
  }
})
`,
    { mode: 0o755 }
  )
  const runtime = new LinuxLocalRuntime({ cwd: directory, explicitExecutable: executable })

  await runtime.start()
  const entries = await runtime.send({ type: 'get_entries' })
  const fork = await runtime.send({ type: 'fork', entryId: 'entry-1' })
  await runtime.stop()

  assert.deepEqual(entries, {
    type: 'entries',
    entries: [{
      id: 'entry-1',
      parentId: null,
      type: 'message',
      timestamp: '2026-07-24T01:00:00.000Z',
      message: {
        role: 'user',
        content: { text: 'Original prompt', hasImage: false }
      }
    }],
    leafId: 'entry-1'
  })
  assert.deepEqual(fork, { type: 'forked', text: 'Original prompt', cancelled: false })

  const requests = (await readFile(requestLog, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .map(({ id: _id, ...request }) => request)
  assert.deepEqual(requests.slice(-2), [
    { type: 'get_entries' },
    { type: 'fork', entryId: 'entry-1' }
  ])
})

test('runtime maps app Extension commands to Pi prompt and isolates extension events', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-runtime-tree-extension-'))
  t.after(async () => rm(directory, { recursive: true, force: true }))
  const executable = join(directory, 'pi')
  const requestLog = join(directory, 'requests.jsonl')
  await writeFile(
    executable,
    `#!/usr/bin/env node
const { appendFileSync } = require('node:fs')
if (process.argv[2] === '--version') {
  process.stdout.write('0.83.0\\n')
  process.exit(0)
}
let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  input += chunk
  let newline
  while ((newline = input.indexOf('\\n')) >= 0) {
    const request = JSON.parse(input.slice(0, newline))
    input = input.slice(newline + 1)
    appendFileSync(${JSON.stringify(requestLog)}, JSON.stringify(request) + '\\n')
    const data = request.type === 'get_state'
      ? {}
      : request.type === 'get_tree'
        ? {
            tree: [{
              entry: {
                id: 'root', parentId: null, type: 'message',
                timestamp: '2026-07-29T00:00:00.000Z',
                message: { role: 'user', content: 'Original prompt' }
              },
              children: []
            }],
            leafId: 'root'
          }
        : request.type === 'get_commands'
          ? {
              commands: [{
                name: 'pi-gui-history-navigation',
                description: 'Internal Pi GUI history prompt navigation. Not a user command.',
                source: 'extension',
                sourceInfo: { source: 'cli', scope: 'temporary', origin: 'top-level' }
              }]
            }
          : request.type === 'get_entries'
            ? {
                entries: [
                {
                  id: 'base', parentId: null, type: 'model_change',
                  timestamp: '2026-07-29T00:00:00.000Z'
                },
                {
                  id: 'prompt', parentId: 'base', type: 'message',
                  timestamp: '2026-07-29T00:00:01.000Z',
                  message: { role: 'user', content: 'Original prompt' }
                }
                ],
                leafId: 'base'
              }
          : request.type === 'subscribe_extension_events'
            ? { channels: request.channels }
            : undefined
    let output = JSON.stringify({
      type: 'response',
      id: request.id,
      command: request.type,
      success: true,
      ...(data === undefined ? {} : { data })
    }) + '\\n'
    if (request.type === 'subscribe_extension_events') {
      output += JSON.stringify({ type: 'agent_start' }) + '\\n'
      output += JSON.stringify({
        type: 'extension_event', channel: request.channels[0], data: { ready: true }
      }) + '\\n'
      output += JSON.stringify({
        type: 'extension_event_diagnostic', reason: 'record_too_large'
      }) + '\\n'
    }
    process.stdout.write(output)
  }
})
`,
    { mode: 0o755 }
  )
  const runtime = new LinuxLocalRuntime({ cwd: directory, explicitExecutable: executable })
  const ordinaryEvents: Array<Record<string, unknown>> = []
  const extensionEvents: Array<Record<string, unknown>> = []
  runtime.subscribe((event) => {
    if (event.type === 'pi-event') ordinaryEvents.push(event.event)
  })
  runtime.subscribeExtensionEvents((event) => extensionEvents.push(event))

  await runtime.start()
  const tree = await runtime.send({ type: 'get_tree' })
  const navigation = await runtime.send({ type: 'navigate_tree', targetEntryId: 'prompt' })
  const invoked = await runtime.send({
    type: 'invoke_extension_command',
    name: 'status',
    args: 'server-a'
  })
  const subscription = await runtime.send({
    type: 'subscribe_extension_events',
    channels: ['status/v1']
  })
  await runtime.stop()

  assert.deepEqual(tree, {
    type: 'tree',
    tree: [{
      entry: {
        id: 'root', parentId: null, type: 'message',
        timestamp: '2026-07-29T00:00:00.000Z',
        message: { role: 'user', content: { text: 'Original prompt', hasImage: false } }
      },
      children: []
    }],
    leafId: 'root'
  })
  assert.deepEqual(navigation, {
    type: 'tree-navigation',
    targetEntryId: 'prompt',
    cancelled: false,
    leafId: 'base',
    editorText: 'Original prompt'
  })
  assert.deepEqual(invoked, { type: 'accepted' })
  assert.deepEqual(subscription, {
    type: 'extension-event-subscription',
    channels: ['status/v1']
  })
  assert.deepEqual(ordinaryEvents, [{ type: 'agent_start' }])
  assert.deepEqual(extensionEvents, [
    { type: 'extension_event', channel: 'status/v1', data: { ready: true } },
    { type: 'extension_event_diagnostic', reason: 'record_too_large' }
  ])

  const requests = (await readFile(requestLog, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .map(({ id: _id, ...request }) => request)
  assert.deepEqual(requests.slice(-7), [
    { type: 'get_tree' },
    { type: 'get_entries' },
    { type: 'get_commands' },
    { type: 'prompt', message: '/pi-gui-history-navigation prompt' },
    { type: 'get_entries' },
    { type: 'prompt', message: '/status server-a' },
    { type: 'subscribe_extension_events', channels: ['status/v1'] }
  ])
})

test('history navigation fails before prompt when the app Extension command is unavailable', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-runtime-history-command-missing-'))
  t.after(async () => rm(directory, { recursive: true, force: true }))
  const executable = join(directory, 'pi')
  const requestLog = join(directory, 'requests.jsonl')
  await writeFile(
    executable,
    `#!/usr/bin/env node
const { appendFileSync } = require('node:fs')
if (process.argv[2] === '--version') {
  process.stdout.write('0.83.0\\n')
  process.exit(0)
}
let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  input += chunk
  let newline
  while ((newline = input.indexOf('\\n')) >= 0) {
    const request = JSON.parse(input.slice(0, newline))
    input = input.slice(newline + 1)
    appendFileSync(${JSON.stringify(requestLog)}, JSON.stringify(request) + '\\n')
    const data = request.type === 'get_state'
      ? {}
      : request.type === 'get_entries'
        ? {
            entries: [{
              id: 'prompt', parentId: null, type: 'message',
              timestamp: '2026-07-29T00:00:00.000Z',
              message: { role: 'user', content: 'Original prompt' }
            }],
            leafId: 'answer'
          }
        : request.type === 'get_commands'
          ? { commands: [] }
          : undefined
    process.stdout.write(JSON.stringify({
      type: 'response', id: request.id, command: request.type, success: true,
      ...(data === undefined ? {} : { data })
    }) + '\\n')
  }
})
`,
    { mode: 0o755 }
  )
  const runtime = new LinuxLocalRuntime({ cwd: directory, explicitExecutable: executable })

  await runtime.start()
  await assert.rejects(
    runtime.send({ type: 'navigate_tree', targetEntryId: 'prompt' }),
    /history navigation Extension command is unavailable/u
  )
  await runtime.stop()

  const requests = (await readFile(requestLog, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { type: string })
  assert.deepEqual(requests.slice(-2).map(({ type }) => type), ['get_entries', 'get_commands'])
  assert.equal(requests.some(({ type }) => type === 'prompt'), false)
})

test('runtime drops extension events emitted after stop begins', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-runtime-extension-stop-'))
  t.after(async () => rm(directory, { recursive: true, force: true }))
  const executable = join(directory, 'pi')
  await writeFile(
    executable,
    `#!/usr/bin/env node
if (process.argv[2] === '--version') {
  process.stdout.write('0.83.0\\n')
  process.exit(0)
}
let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  input += chunk
  let newline
  while ((newline = input.indexOf('\\n')) >= 0) {
    const request = JSON.parse(input.slice(0, newline))
    input = input.slice(newline + 1)
    const data = request.type === 'get_state'
      ? {}
      : request.type === 'subscribe_extension_events'
        ? { channels: request.channels }
        : undefined
    process.stdout.write(JSON.stringify({
      type: 'response', id: request.id, command: request.type, success: true,
      ...(data === undefined ? {} : { data })
    }) + '\\n')
  }
})
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({
    type: 'extension_event', channel: 'status', data: { duringStop: true }
  }) + '\\n')
  setTimeout(() => process.exit(0), 20)
})
`,
    { mode: 0o755 }
  )
  const runtime = new LinuxLocalRuntime({ cwd: directory, explicitExecutable: executable })
  const extensionEvents: Array<Record<string, unknown>> = []
  runtime.subscribeExtensionEvents((event) => extensionEvents.push(event))

  await runtime.start()
  await runtime.send({ type: 'subscribe_extension_events', channels: ['status'] })
  await runtime.stop()

  assert.deepEqual(extensionEvents, [])
})

test('old Pi unknown P3 commands reject without fallback or runtime restart', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-runtime-p3-unsupported-'))
  t.after(async () => rm(directory, { recursive: true, force: true }))
  const executable = join(directory, 'pi')
  const requestLog = join(directory, 'requests.jsonl')
  const launchLog = join(directory, 'launches.log')
  await writeFile(
    executable,
    `#!/usr/bin/env node
const { appendFileSync } = require('node:fs')
if (process.argv[2] === '--version') {
  process.stdout.write('0.83.0\\n')
  process.exit(0)
}
appendFileSync(${JSON.stringify(launchLog)}, String(process.pid) + '\\n')
const unsupported = new Set([
  'get_tree',
  'navigate_tree',
  'subscribe_extension_events'
])
let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  input += chunk
  let newline
  while ((newline = input.indexOf('\\n')) >= 0) {
    const request = JSON.parse(input.slice(0, newline))
    input = input.slice(newline + 1)
    appendFileSync(${JSON.stringify(requestLog)}, JSON.stringify(request) + '\\n')
    if (unsupported.has(request.type)) {
      process.stdout.write(JSON.stringify({
        type: 'response', id: request.id, command: request.type,
        success: false, error: 'Unknown command: ' + request.type
      }) + '\\n')
      continue
    }
    const data = request.type === 'get_state'
      ? { sessionId: 'still-running' }
      : request.type === 'get_messages'
        ? { messages: [] }
        : undefined
    process.stdout.write(JSON.stringify({
      type: 'response', id: request.id, command: request.type, success: true,
      ...(data === undefined ? {} : { data })
    }) + '\\n')
  }
})
`,
    { mode: 0o755 }
  )
  const runtime = new LinuxLocalRuntime({ cwd: directory, explicitExecutable: executable })

  await runtime.start()
  const pidBefore = runtime.getRpcPid()
  const commands = [
    { type: 'get_tree' as const },
    { type: 'subscribe_extension_events' as const, channels: ['status/v1'] }
  ]
  for (const command of commands) {
    await assert.rejects(
      runtime.send(command),
      new RegExp(`Pi RPC ${command.type} failed: Unknown command: ${command.type}`, 'u')
    )
    assert.equal(runtime.getRpcPid(), pidBefore)
    assert.equal(runtime.getState().lastError, null)
  }
  assert.deepEqual(
    await runtime.send({ type: 'invoke_extension_command', name: 'status' }),
    { type: 'accepted' }
  )
  assert.deepEqual(await runtime.send({ type: 'get_messages' }), {
    type: 'messages',
    messages: []
  })
  assert.equal(runtime.getRpcPid(), pidBefore)
  await runtime.stop()

  assert.equal((await readFile(launchLog, 'utf8')).trim().split('\n').length, 1)
  const requests = (await readFile(requestLog, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .map(({ id: _id, ...request }) => request)
  assert.deepEqual(requests, [
    { type: 'get_state' },
    { type: 'get_tree' },
    { type: 'subscribe_extension_events', channels: ['status/v1'] },
    { type: 'prompt', message: '/status' },
    { type: 'get_messages' }
  ])
})

test('runtime exposes the strict loaded-Extension inventory without routing through Kernel commands', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-runtime-extensions-'))
  t.after(async () => rm(directory, { recursive: true, force: true }))
  const executable = join(directory, 'pi')
  const requestLog = join(directory, 'requests.jsonl')
  await writeFile(
    executable,
    `#!/usr/bin/env node
const { appendFileSync } = require('node:fs')
if (process.argv[2] === '--version') {
  process.stdout.write('0.83.0\\n')
  process.exit(0)
}
let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  input += chunk
  let newline
  while ((newline = input.indexOf('\\n')) >= 0) {
    const request = JSON.parse(input.slice(0, newline))
    input = input.slice(newline + 1)
    appendFileSync(${JSON.stringify(requestLog)}, JSON.stringify(request) + '\\n')
    const data = request.type === 'get_state'
      ? {}
      : request.type === 'get_extensions'
        ? {
            protocolVersion: 1,
            complete: true,
            loading: 'eager_complete',
            extensions: [{ id: 'pi-subagents', capabilities: ['tool', 'event'] }],
            loadErrorCount: 0
          }
        : undefined
    process.stdout.write(JSON.stringify({
      type: 'response',
      id: request.id,
      success: true,
      ...(data === undefined ? {} : { data })
    }) + '\\n')
  }
})
`,
    { mode: 0o755 }
  )
  const runtime = new LinuxLocalRuntime({ cwd: directory, explicitExecutable: executable })

  await runtime.start()
  const inventory = await runtime.getLoadedExtensions()
  await runtime.stop()

  assert.deepEqual(inventory, {
    protocolVersion: 1,
    complete: true,
    loading: 'eager_complete',
    extensions: [{ id: 'pi-subagents', capabilities: ['event', 'tool'] }],
    loadErrorCount: 0
  })
  const requests = (await readFile(requestLog, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .map(({ id: _id, ...request }) => request)
  assert.deepEqual(requests.filter(({ type }) => type === 'get_extensions'), [
    { type: 'get_extensions' }
  ])
})

test('current Pi rejects get_extensions without fallback or restarting the usable runtime', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-runtime-extensions-unsupported-'))
  t.after(async () => rm(directory, { recursive: true, force: true }))
  const executable = join(directory, 'pi')
  const requestLog = join(directory, 'requests.jsonl')
  const launchLog = join(directory, 'launches.log')
  await writeFile(
    executable,
    `#!/usr/bin/env node
const { appendFileSync } = require('node:fs')
if (process.argv[2] === '--version') {
  process.stdout.write('0.83.0\\n')
  process.exit(0)
}
appendFileSync(${JSON.stringify(launchLog)}, String(process.pid) + '\\n')
let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  input += chunk
  let newline
  while ((newline = input.indexOf('\\n')) >= 0) {
    const request = JSON.parse(input.slice(0, newline))
    input = input.slice(newline + 1)
    appendFileSync(${JSON.stringify(requestLog)}, JSON.stringify(request) + '\\n')
    if (request.type === 'get_extensions') {
      process.stdout.write(JSON.stringify({
        type: 'response',
        id: request.id,
        success: false,
        error: 'Unknown command: get_extensions'
      }) + '\\n')
      continue
    }
    const data = request.type === 'get_state'
      ? { sessionId: 'still-running' }
      : request.type === 'get_messages'
        ? { messages: [] }
        : undefined
    process.stdout.write(JSON.stringify({
      type: 'response',
      id: request.id,
      success: true,
      ...(data === undefined ? {} : { data })
    }) + '\\n')
  }
})
`,
    { mode: 0o755 }
  )
  const runtime = new LinuxLocalRuntime({ cwd: directory, explicitExecutable: executable })

  await runtime.start()
  const pidBefore = runtime.getRpcPid()
  await assert.rejects(
    runtime.getLoadedExtensions(),
    /Pi RPC get_extensions failed: Unknown command: get_extensions/u
  )
  assert.equal(runtime.getRpcPid(), pidBefore)
  assert.equal(runtime.getState().lastError, null)
  assert.deepEqual(await runtime.send({ type: 'get_messages' }), { type: 'messages', messages: [] })
  assert.equal(runtime.getRpcPid(), pidBefore)
  await runtime.stop()

  assert.equal((await readFile(launchLog, 'utf8')).trim().split('\n').length, 1)
  const requests = (await readFile(requestLog, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .map(({ id: _id, ...request }) => request)
  assert.deepEqual(requests, [
    { type: 'get_state' },
    { type: 'get_extensions' },
    { type: 'get_messages' }
  ])
})

test('runtime forwards get_session_stats through the Pi RPC client', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-runtime-stats-'))
  t.after(async () => rm(directory, { recursive: true, force: true }))
  const executable = join(directory, 'pi')
  const requestLog = join(directory, 'requests.jsonl')
  const statistics = {
    sessionFile: '/tmp/session.jsonl',
    sessionId: 'session-1',
    userMessages: 2,
    assistantMessages: 1,
    toolCalls: 3,
    toolResults: 3,
    totalMessages: 6,
    tokens: {
      input: 100,
      output: 50,
      cacheRead: 25,
      cacheWrite: 10,
      total: 185
    },
    cost: 0.0125,
    contextUsage: {
      tokens: 185,
      contextWindow: 200_000,
      percent: 0.0925
    }
  }
  await writeFile(
    executable,
    `#!/usr/bin/env node
const { appendFileSync } = require('node:fs')
if (process.argv[2] === '--version') {
  process.stdout.write('0.83.0\\n')
  process.exit(0)
}
let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  input += chunk
  let newline
  while ((newline = input.indexOf('\\n')) >= 0) {
    const request = JSON.parse(input.slice(0, newline))
    input = input.slice(newline + 1)
    appendFileSync(${JSON.stringify(requestLog)}, JSON.stringify(request) + '\\n')
    const data = request.type === 'get_state'
      ? {}
      : request.type === 'get_session_stats'
        ? ${JSON.stringify(statistics)}
        : undefined
    process.stdout.write(JSON.stringify({
      type: 'response',
      id: request.id,
      success: true,
      ...(data === undefined ? {} : { data })
    }) + '\\n')
  }
})
`,
    { mode: 0o755 }
  )
  const runtime = new LinuxLocalRuntime({ cwd: directory, explicitExecutable: executable })

  await runtime.start()
  const result = await runtime.send({ type: 'get_session_stats' })
  await runtime.stop()

  assert.deepEqual(result, {
    type: 'session-statistics',
    statistics
  })
  const requests = (await readFile(requestLog, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .map(({ id: _id, ...request }) => request)
  assert.deepEqual(requests.at(-1), { type: 'get_session_stats' })
})

test('stale get_state snapshots cannot revive a settled activity', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-runtime-stale-state-'))
  t.after(async () => rm(directory, { recursive: true, force: true }))
  const executable = join(directory, 'pi')
  await writeFile(
    executable,
    `#!/usr/bin/env node
if (process.argv[2] === '--version') {
  process.stdout.write('0.83.0\\n')
  process.exit(0)
}
let input = ''
let stateRequests = 0
const respond = (request, data) => {
  process.stdout.write(JSON.stringify({ type: 'response', id: request.id, success: true, data }) + '\\n')
}
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  input += chunk
  let newline
  while ((newline = input.indexOf('\\n')) >= 0) {
    const request = JSON.parse(input.slice(0, newline))
    input = input.slice(newline + 1)
    if (request.type === 'get_state') {
      stateRequests += 1
      if (stateRequests === 1) {
        respond(request, { isStreaming: false })
      } else {
        process.stdout.write(JSON.stringify({ type: 'agent_settled' }) + '\\n')
        setTimeout(() => respond(request, { isStreaming: true }), 20)
      }
      continue
    }
    if (request.type === 'prompt') {
      process.stdout.write(JSON.stringify({ type: 'agent_start' }) + '\\n')
      respond(request)
      continue
    }
    respond(request, {})
  }
})
`,
    { mode: 0o755 }
  )
  const runtime = new LinuxLocalRuntime({ cwd: directory, explicitExecutable: executable })
  const events: string[] = []
  runtime.subscribe((event) => events.push(event.type))

  await runtime.start()
  await runtime.send({ type: 'prompt', message: 'Run once' })
  await runtime.send({ type: 'get_state' })
  await runtime.stop()

  assert.deepEqual(events.filter((type) => type.startsWith('activity-')), [])
  assert.deepEqual(events.filter((type) => type === 'pi-event'), ['pi-event', 'pi-event'])
})

test('runtime state summarizes stderr without retaining secret text', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-runtime-stderr-'))
  t.after(async () => rm(directory, { recursive: true, force: true }))
  const executable = join(directory, 'pi')
  const secret = 'SECRET token=super-sensitive-value'
  await writeFile(
    executable,
    `#!/usr/bin/env node
if (process.argv[2] === '--version') {
  process.stdout.write('0.83.0\\n')
  process.exit(0)
}
process.stderr.write(${JSON.stringify(secret)})
let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  input += chunk
  let newline
  while ((newline = input.indexOf('\\n')) >= 0) {
    const request = JSON.parse(input.slice(0, newline))
    input = input.slice(newline + 1)
    process.stdout.write(JSON.stringify({ type: 'response', id: request.id, success: true, data: {} }) + '\\n')
  }
})
`,
    { mode: 0o755 }
  )
  const runtime = new LinuxLocalRuntime({ cwd: directory, explicitExecutable: executable })

  await runtime.start()
  const state = runtime.getState()
  await runtime.stop()

  assert.equal(state.stderrChars, secret.length)
  assert.equal(state.stderrSummary, `Pi stderr captured ${secret.length} characters.`)
  assert.equal(JSON.stringify(state).includes('SECRET'), false)
  assert.equal(JSON.stringify(state).includes('super-sensitive-value'), false)
})

test('getRpcPid exposes the live root Pi RPC pid and clears after stop', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-runtime-pid-'))
  t.after(async () => rm(directory, { recursive: true, force: true }))
  const executable = join(directory, 'pi')
  await writeFile(
    executable,
    `#!/usr/bin/env node
if (process.argv[2] === '--version') {
  process.stdout.write('0.83.0\\n')
  process.exit(0)
}
let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  input += chunk
  let newline
  while ((newline = input.indexOf('\\n')) >= 0) {
    const request = JSON.parse(input.slice(0, newline))
    input = input.slice(newline + 1)
    process.stdout.write(JSON.stringify({
      type: 'response',
      id: request.id,
      success: true,
      ...(request.type === 'get_state' ? { data: {} } : {})
    }) + '\\n')
  }
})
`,
    { mode: 0o755 }
  )
  const runtime = new LinuxLocalRuntime({ cwd: directory, explicitExecutable: executable })

  assert.equal(runtime.getRpcPid(), null)
  await runtime.start()
  const pid = runtime.getRpcPid()
  assert.equal(typeof pid, 'number')
  assert.ok(pid !== null && pid > 0)
  await runtime.stop()
  assert.equal(runtime.getRpcPid(), null)
})

test('Runtime starts and gracefully stops a Windows Pi command shim', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-runtime-windows-shim-'))
  t.after(async () => rm(directory, { recursive: true, force: true }))
  const cli = join(directory, 'cli.js')
  const executable = join(directory, 'pi.cmd')
  await writeFile(
    cli,
    `if (process.argv[2] === '--version') {
  process.stdout.write('0.83.0\\n')
  process.exit(0)
}
let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  input += chunk
  let newline
  while ((newline = input.indexOf('\\n')) >= 0) {
    const request = JSON.parse(input.slice(0, newline))
    input = input.slice(newline + 1)
    process.stdout.write(JSON.stringify({
      type: 'response',
      id: request.id,
      success: true,
      ...(request.type === 'get_state' ? { data: {} } : {})
    }) + '\\n')
  }
})
`
  )
  await writeFile(
    executable,
    `#!/bin/sh\nexec "${process.execPath}" "${cli}" "$@"\n`,
    { mode: 0o755 }
  )
  const runtime = new LinuxLocalRuntime({
    cwd: directory,
    explicitExecutable: executable,
    platform: 'win32'
  })
  t.after(() => runtime.stop())

  await runtime.start()
  assert.ok((runtime.getRpcPid() ?? 0) > 0)
  assert.deepEqual(await runtime.send({ type: 'get_state' }), {
    type: 'state',
    state: {}
  })
  await runtime.stop()

  assert.equal(runtime.getRpcPid(), null)
  assert.equal(runtime.getState().exitCode, 0)
})

test('stop during the version check cancels start before spawning RPC', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-runtime-stop-'))
  t.after(async () => rm(directory, { recursive: true, force: true }))
  const executable = join(directory, 'pi')
  const rpcMarker = join(directory, 'rpc-started')
  await writeFile(
    executable,
    '#!/bin/sh\nif [ "$1" = "--version" ]; then\n  sleep 0.1\n  printf "0.83.0\\n"\n  exit 0\nfi\nprintf "started" > rpc-started\n',
    { mode: 0o755 }
  )
  const runtime = new LinuxLocalRuntime({
    cwd: directory,
    explicitExecutable: executable,
    versionTimeoutMs: 1_000
  })

  const startPromise = runtime.start()
  const stopPromise = runtime.stop()

  await assert.rejects(startPromise, /cancelled/i)
  await stopPromise
  await assert.rejects(access(rpcMarker))
})
