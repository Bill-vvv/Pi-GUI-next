#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(process.argv[2] ?? process.cwd())

async function replaceOnce(path, original, replacement, marker = replacement) {
  const source = await readFile(path, 'utf8')
  if (source.includes(marker)) {
    return false
  }
  const occurrences = source.split(original).length - 1
  if (occurrences !== 1) {
    throw new Error(`${path} expected one adaptation target; found ${occurrences}`)
  }
  await writeFile(path, source.replace(original, replacement), 'utf8')
  return true
}

const sessionPath = resolve(root, 'src/main/runtime/shared-pi-agent-session.ts')
const hostPath = resolve(root, 'src/main/runtime/shared-pi-host.ts')
const indexPath = resolve(root, 'src/main/index.ts')
const testPath = resolve(root, 'src/main/runtime/shared-pi-agent-session.test.ts')

const changes = []
changes.push(await replaceOnce(
  sessionPath,
  `  fastExtensionLoading?: boolean
  extensionPaths: string[]`,
  `  fastExtensionLoading?: boolean
  piExecutable?: string
  extensionPaths: string[]`
))
changes.push(await replaceOnce(
  sessionPath,
  `    JITI_TRY_NATIVE: fastExtensionLoading ? '0' : '1',
    PI_SUBAGENT_MAX_DEPTH: options.subagentMaxDepth === undefined`,
  `    JITI_TRY_NATIVE: fastExtensionLoading ? '0' : '1',
    MAGIC_CONTEXT_PI_BINARY: options.piExecutable,
    PI_SUBAGENT_MAX_DEPTH: options.subagentMaxDepth === undefined`
))
changes.push(await replaceOnce(
  hostPath,
  `  fastExtensionLoading?: boolean
  quiescenceExtensionPath?: string`,
  `  fastExtensionLoading?: boolean
  piExecutable?: string
  quiescenceExtensionPath?: string`
))
changes.push(await replaceOnce(
  hostPath,
  `        fastExtensionLoading: this.options.fastExtensionLoading,
        extensionPaths: [...this.options.extensionPaths],`,
  `        fastExtensionLoading: this.options.fastExtensionLoading,
        piExecutable: this.options.piExecutable,
        extensionPaths: [...this.options.extensionPaths],`
))
changes.push(await replaceOnce(
  indexPath,
  `        fastExtensionLoading: launchOptions.fastExtensionLoading,
        quiescenceExtensionPath,`,
  `        fastExtensionLoading: launchOptions.fastExtensionLoading,
        piExecutable,
        quiescenceExtensionPath,`
))
changes.push(await replaceOnce(
  testPath,
  `})

test('SharedPiHost activates extension tools and fails when an extension cannot load', async () => {`,
  `})

test('SharedPiHost scopes the Magic Context Pi binary for embedded Sessions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-shared-sdk-magic-context-cli-'))
  const agentDir = join(root, 'agent')
  const project = join(root, 'project')
  const extensionPath = join(root, 'magic-context-cli-extension.ts')
  const piExecutable = '/opt/pi/bin/pi'
  await Promise.all([
    mkdir(agentDir, { recursive: true }),
    mkdir(project, { recursive: true }),
    writeFile(
      extensionPath,
      \`export default function extension(pi) {
  pi.on('session_start', (_event, ctx) => {
    ctx.ui.setStatus('magic-context-pi-binary', process.env.MAGIC_CONTEXT_PI_BINARY)
  })
}\\n\`,
      'utf8'
    )
  ])
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = agentDir
  const host = new SharedPiHost()
  const runtime = host.createRuntime({
    cwd: project,
    projectTrust: true,
    piExecutable,
    extensionPaths: [extensionPath]
  })

  try {
    const reported = new Promise<string | undefined>((resolve) => {
      const unsubscribe = runtime.subscribe((event) => {
        if (
          event.type !== 'pi-event' || event.event.type !== 'extension_ui_request' ||
          event.event.method !== 'setStatus' ||
          event.event.statusKey !== 'magic-context-pi-binary'
        ) return
        unsubscribe()
        resolve(typeof event.event.statusText === 'string' ? event.event.statusText : undefined)
      })
    })
    await runtime.start()
    assert.equal(await reported, piExecutable)
  } finally {
    await host.dispose()
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir
    await rm(root, { recursive: true, force: true })
  }
})

test('SharedPiHost activates extension tools and fails when an extension cannot load', async () => {`,
  "test('SharedPiHost scopes the Magic Context Pi binary for embedded Sessions'"
))

process.stdout.write(`Magic Context GUI adapter ${changes.some(Boolean) ? 'applied' : 'already present'}\n`)
