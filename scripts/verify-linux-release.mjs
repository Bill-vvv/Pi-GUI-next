#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import {
  access,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile
} from 'node:fs/promises'
import { createServer } from 'node:net'
import { arch, platform, release as kernelRelease, tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { spawn } from 'node:child_process'

const execFileAsync = promisify(execFile)
const SCRIPT_PATH = fileURLToPath(import.meta.url)
const REPO_ROOT = dirname(dirname(SCRIPT_PATH))
const PI_VERSION = '0.80.10'
const CWD_MARKER_NAME = '.pi-gui-s7-cwd-ok'
const CWD_MARKER_CONTENT = 'pi-gui-s7-tool-ok'
const TOOL_PROMPT =
  `Use the bash tool to run exactly \`printf ${CWD_MARKER_CONTENT} > ${CWD_MARKER_NAME}\`, then briefly confirm completion.`
const ABORT_PROMPT =
  'Use the bash tool to run exactly `for i in $(seq 1 60); do sleep 1; done`, and wait for it to finish.'
const CONTINUATION_PROMPT = 'Reply briefly that this recovered conversation can continue.'
const STARTED_AT = new Date().toISOString()
const RUN_STAMP = STARTED_AT.replaceAll(':', '-').replaceAll('.', '-')
const TIMEOUT = {
  page: 30_000,
  ready: 45_000,
  turn: 180_000,
  abort: 45_000,
  crash: 30_000,
  close: 30_000
}

let stage = 'preflight'
let reportDirectory = null
let temporaryRoot = null
let activeApp = null
let activeCdp = null
let headCommit = null
let packageJson = null
let artifactPath = null
let artifactMetadata = null
let piExecutable = null
let runtimeElectronVersion = null
const steps = []
const processTotals = { stdoutChars: 0, stderrChars: 0 }

class VerificationError extends Error {
  constructor(code) {
    super(code)
    this.name = 'VerificationError'
    this.code = code
  }
}

function fail(code) {
  throw new VerificationError(code)
}

async function main() {
  try {
    await preflight()
    await prepareRun()
    await exerciseUi()
    await writeReport('passed', null)
  } catch (error) {
    await cleanupActiveApp()
    await ensureReportDirectory().catch(() => undefined)
    await writeReport('failed', {
      stage,
      code: error instanceof VerificationError ? error.code : 'E_UNEXPECTED'
    }).catch(() => undefined)
    process.exitCode = 1
  } finally {
    if (temporaryRoot !== null) {
      await rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}

async function preflight() {
  stage = 'preflight.cwd'
  if (resolve(process.cwd()) !== REPO_ROOT) fail('E_CWD')
  if (Number(process.versions.node.split('.')[0]) !== 26) fail('E_NODE_VERSION')

  stage = 'preflight.git_clean'
  const { stdout: gitStatus } = await execFileAsync(
    'git',
    ['status', '--porcelain=v1', '--untracked-files=all'],
    { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 1024 * 1024 }
  )
  if (gitStatus.length !== 0) fail('E_GIT_DIRTY')

  stage = 'preflight.metadata'
  packageJson = JSON.parse(await readFile(join(REPO_ROOT, 'package.json'), 'utf8'))
  if (
    typeof packageJson?.version !== 'string' ||
    typeof packageJson?.engines?.node !== 'string' ||
    typeof packageJson?.devDependencies?.electron !== 'string'
  ) {
    fail('E_PACKAGE_METADATA')
  }
  if (process.version !== `v${packageJson.engines.node}`) fail('E_NODE_VERSION')
  const { stdout: head } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 4096
  })
  headCommit = head.trim()
  if (!/^[0-9a-f]{40}$/.test(headCommit)) fail('E_HEAD')
  await ensureReportDirectory()

  stage = 'preflight.artifact'
  const releaseDirectory = join(REPO_ROOT, 'release')
  const expectedName = `pi-gui-next-${packageJson.version}-x86_64.AppImage`
  const appImages = (await readdir(releaseDirectory)).filter((name) => name.endsWith('.AppImage'))
  if (appImages.length !== 1 || appImages[0] !== expectedName) fail('E_ARTIFACT_SET')
  artifactPath = join(releaseDirectory, expectedName)
  const artifactStat = await stat(artifactPath)
  if (!artifactStat.isFile()) fail('E_ARTIFACT_TYPE')
  await access(artifactPath, constants.X_OK).catch(() => fail('E_ARTIFACT_EXECUTABLE'))
  artifactMetadata = {
    format: 'AppImage',
    filename: expectedName,
    sha256: await sha256File(artifactPath),
    sizeBytes: artifactStat.size
  }

  stage = 'preflight.desktop'
  if (process.env.XDG_SESSION_TYPE !== 'wayland') fail('E_SESSION_TYPE')
  if (!(process.env.XDG_CURRENT_DESKTOP ?? '').toLowerCase().includes('niri')) {
    fail('E_DESKTOP')
  }
  if (!process.env.WAYLAND_DISPLAY) fail('E_WAYLAND_DISPLAY')

  stage = 'preflight.pi'
  piExecutable = await resolvePiExecutable()
  const { stdout: piVersion } = await execFileAsync(piExecutable, ['--version'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 5_000,
    maxBuffer: 4096
  })
  if (piVersion.trim() !== PI_VERSION) fail('E_PI_VERSION')
}

async function ensureReportDirectory() {
  if (reportDirectory !== null) return
  const shortCommit = headCommit?.slice(0, 12) ?? 'unknown'
  reportDirectory = join(REPO_ROOT, 'release', 'evidence', `${RUN_STAMP}-${shortCommit}`)
  await mkdir(reportDirectory, { recursive: true, mode: 0o700 })
}

async function prepareRun() {
  stage = 'prepare'
  temporaryRoot = await mkdtemp(join(tmpdir(), 'pi-gui-s7-'))
  const paths = {
    config: join(temporaryRoot, 'config'),
    state: join(temporaryRoot, 'state'),
    cache: join(temporaryRoot, 'cache'),
    project: join(temporaryRoot, 'project')
  }
  await Promise.all(Object.values(paths).map((path) => mkdir(path, { recursive: true, mode: 0o700 })))
  await mkdir(join(paths.config, 'pi-gui-next'), { recursive: true, mode: 0o700 })
  await writeFile(
    join(paths.config, 'pi-gui-next', 'config.json'),
    `${JSON.stringify({ version: 1, project: { path: paths.project } }, null, 2)}\n`,
    { mode: 0o600, flag: 'wx' }
  )
  temporaryRoot = resolve(temporaryRoot)
}

function xdgEnvironment() {
  return {
    ...process.env,
    XDG_CONFIG_HOME: join(temporaryRoot, 'config'),
    XDG_STATE_HOME: join(temporaryRoot, 'state'),
    XDG_CACHE_HOME: join(temporaryRoot, 'cache'),
    PI_GUI_PI_EXECUTABLE: piExecutable
  }
}

async function exerciseUi() {
  const projectPath = join(temporaryRoot, 'project')

  await runStep('launch', async () => {
    ;({ app: activeApp, cdp: activeCdp } = await launchApp())
    await waitForSelector(activeCdp, '.composer-start-action', TIMEOUT.page)
  })

  await runStep('runtime_identity', async () => {
    runtimeElectronVersion = await evaluateValue(
      activeCdp,
      `navigator.userAgent.match(/Electron\\/([^\\s]+)/)?.[1] ?? null`
    )
    if (runtimeElectronVersion !== packageJson.devDependencies.electron) {
      fail('E_ELECTRON_VERSION')
    }
  })

  await runStep('project_cwd', async () => {
    const displayedPath = await evaluateValue(
      activeCdp,
      `document.querySelector('.project-select small')?.textContent ?? null`
    )
    if (displayedPath !== projectPath) fail('E_PROJECT_PATH')
  })

  await runStep('pi_probe_ready', async () => {
    await clickSelector(activeCdp, '.composer-start-action')
    await waitForRuntime(activeCdp, 'ready', TIMEOUT.ready)
    await openDiagnostics(activeCdp)
    await waitForExpression(
      activeCdp,
      `Array.from(document.querySelectorAll('.runtime-diagnostics dd'))[1]?.textContent?.trim() === ${JSON.stringify(PI_VERSION)}`,
      TIMEOUT.ready,
      'E_PI_READY'
    )
  })

  await runStep('high_thinking', async () => {
    await clickSelector(activeCdp, '.model-picker-button')
    const available = await evaluateValue(
      activeCdp,
      `Array.from(document.querySelectorAll('.thinking-grid button')).some((button) => button.textContent?.trim() === '高' && !button.disabled)`
    )
    if (available) {
      await clickButtonText(activeCdp, '.thinking-grid button', '高')
      await waitForExpression(
        activeCdp,
        `Array.from(document.querySelectorAll('.thinking-grid button')).some((button) => button.textContent?.trim() === '高' && button.getAttribute('aria-selected') === 'true')`,
        10_000,
        'E_THINKING_LEVEL'
      )
    }
    await evaluateValue(activeCdp, `document.querySelector('.composer-model-controls')?.removeAttribute('open')`)
  })

  await runStep('tool_turn', async () => {
    const baseline = await conversationCounts(activeCdp)
    await submitPrompt(activeCdp, TOOL_PROMPT)
    await waitForCondition(
      async () => (
        await evaluateValue(activeCdp, `document.querySelector('.thinking-status[role="status"]') !== null`)
      ) || (await conversationCounts(activeCdp)).thinking > baseline.thinking,
      TIMEOUT.turn,
      'E_THINKING_ACTIVITY'
    )
    await waitForCondition(
      async () => (await conversationCounts(activeCdp)).toolsCompleted > baseline.toolsCompleted,
      TIMEOUT.turn,
      'E_TOOL_COMPLETED'
    )
    await waitForAssistantSettled(activeCdp, baseline.assistant, TIMEOUT.turn)
    const cwdMarker = await readFile(join(projectPath, CWD_MARKER_NAME), 'utf8').catch(() => null)
    if (cwdMarker !== CWD_MARKER_CONTENT) fail('E_RUNTIME_CWD')
    await captureScreenshot(activeCdp, 'ready-tool.png')
  })

  await runStep('abort_turn', async () => {
    const baseline = await conversationCounts(activeCdp)
    await submitPrompt(activeCdp, ABORT_PROMPT)
    await waitForExpression(
      activeCdp,
      `document.querySelector('.abort-action:not(:disabled)') !== null`,
      TIMEOUT.turn,
      'E_ABORT_ACTION'
    )
    await waitForCondition(
      async () => (await conversationCounts(activeCdp)).toolsRunning > baseline.toolsRunning,
      TIMEOUT.turn,
      'E_ABORT_RUNNING'
    )
    const abortAck = await evaluateValue(
      activeCdp,
      `window.piGui.abort().then((state) => ({ runtimeStatus: state.runtime.status }))`
    )
    if (
      abortAck === null ||
      typeof abortAck !== 'object' ||
      !['running', 'ready'].includes(abortAck.runtimeStatus)
    ) {
      fail('E_ABORT_RPC_ACK')
    }
    await waitForRuntime(activeCdp, 'ready', TIMEOUT.abort)
    await waitForCondition(
      async () => (await conversationCounts(activeCdp)).toolsRunning === 0,
      TIMEOUT.abort,
      'E_ABORT_SETTLED'
    )
    await captureScreenshot(activeCdp, 'abort-settled.png')
  })

  let messagesBeforeCrash = 0
  let sessionPointer = null
  await runStep('crash_detection', async () => {
    messagesBeforeCrash = (await conversationCounts(activeCdp)).messages
    sessionPointer = await readRecentSessionPointer(projectPath)
    const piPid = await findUniquePiRpcProcess(activeApp, projectPath)
    process.kill(piPid, 'SIGKILL')
    await waitForExpression(
      activeCdp,
      `document.querySelector('.status-dot.crashed') !== null && Array.from(document.querySelectorAll('.composer-start-action')).some((button) => button.textContent?.includes('重启并恢复'))`,
      TIMEOUT.crash,
      'E_CRASH_STATE'
    )
    await openDiagnostics(activeCdp)
    await waitForExpression(
      activeCdp,
      `(() => { const value = Array.from(document.querySelectorAll('.runtime-diagnostics dd'))[4]?.textContent?.trim(); return Boolean(value && value !== '—') })()`,
      TIMEOUT.crash,
      'E_CRASH_EXIT_DIAGNOSTIC'
    )
    await captureScreenshot(activeCdp, 'crashed.png')
  })

  await runStep('restart_resume', async () => {
    await clickButtonText(activeCdp, '.composer-start-action', '重启并恢复')
    await waitForRuntime(activeCdp, 'ready', TIMEOUT.ready)
    await waitForMessageCount(activeCdp, messagesBeforeCrash, TIMEOUT.ready)
    await assertSameSessionPointer(sessionPointer, projectPath)
  })

  let messagesBeforeReopen = 0
  await runStep('continuation', async () => {
    const baseline = await conversationCounts(activeCdp)
    await submitPrompt(activeCdp, CONTINUATION_PROMPT)
    await waitForAssistantSettled(activeCdp, baseline.assistant, TIMEOUT.turn)
    messagesBeforeReopen = (await conversationCounts(activeCdp)).messages
    await captureScreenshot(activeCdp, 'resumed.png')
  })

  await runStep('graceful_close', async () => {
    await closeApp(activeApp, activeCdp)
    activeApp = null
    activeCdp = null
  })

  await runStep('reopen', async () => {
    ;({ app: activeApp, cdp: activeCdp } = await launchApp())
    await waitForExpression(
      activeCdp,
      `Array.from(document.querySelectorAll('.composer-start-action')).some((button) => button.textContent?.includes('恢复对话'))`,
      TIMEOUT.page,
      'E_REOPEN_RESUME_AVAILABLE'
    )
  })

  await runStep('reopen_resume', async () => {
    await clickButtonText(activeCdp, '.composer-start-action', '恢复对话')
    await waitForRuntime(activeCdp, 'ready', TIMEOUT.ready)
    await waitForMessageCount(activeCdp, messagesBeforeReopen, TIMEOUT.ready)
    await assertSameSessionPointer(sessionPointer, projectPath)
    await captureScreenshot(activeCdp, 'reopened-resumed.png')
  })

  await runStep('final_close', async () => {
    await closeApp(activeApp, activeCdp)
    activeApp = null
    activeCdp = null
  })
}

async function runStep(name, operation) {
  stage = `ui.${name}`
  const started = Date.now()
  const timestamp = new Date().toISOString()
  try {
    await operation()
    steps.push({ name, pass: true, durationMs: Date.now() - started, timestamp })
  } catch (error) {
    steps.push({ name, pass: false, durationMs: Date.now() - started, timestamp })
    throw error
  }
}

async function launchApp() {
  const port = await reservePort()
  const child = spawn(artifactPath, [`--remote-debugging-port=${port}`], {
    cwd: REPO_ROOT,
    env: xdgEnvironment(),
    detached: true,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const app = {
    child,
    rootPid: child.pid,
    knownPids: new Set(child.pid === undefined ? [] : [child.pid]),
    stdoutChars: 0,
    stderrChars: 0,
    exited: false
  }
  child.stdout.on('data', (chunk) => {
    const count = chunk.toString('utf8').length
    app.stdoutChars += count
    processTotals.stdoutChars += count
  })
  child.stderr.on('data', (chunk) => {
    const count = chunk.toString('utf8').length
    app.stderrChars += count
    processTotals.stderrChars += count
  })
  child.once('close', () => {
    app.exited = true
  })
  child.once('error', () => {
    app.exited = true
  })

  try {
    const target = await waitForPageTarget(port, app, TIMEOUT.page)
    const cdp = await CdpClient.connect(target.webSocketDebuggerUrl)
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    return { app, cdp }
  } catch {
    await terminateApp(app)
    fail('E_APP_LAUNCH')
  }
}

class CdpClient {
  constructor(socket) {
    this.socket = socket
    this.nextId = 1
    this.pending = new Map()
    socket.addEventListener('message', (event) => {
      let message
      try {
        message = JSON.parse(String(event.data))
      } catch {
        return
      }
      if (typeof message.id !== 'number') return
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      if (message.error) pending.reject(new VerificationError('E_CDP_COMMAND'))
      else pending.resolve(message.result)
    })
    socket.addEventListener('close', () => {
      for (const pending of this.pending.values()) {
        pending.reject(new VerificationError('E_CDP_CLOSED'))
      }
      this.pending.clear()
    })
  }

  static connect(url) {
    return new Promise((resolveConnect, rejectConnect) => {
      const socket = new WebSocket(url)
      const timer = setTimeout(() => rejectConnect(new VerificationError('E_CDP_CONNECT')), 10_000)
      socket.addEventListener('open', () => {
        clearTimeout(timer)
        resolveConnect(new CdpClient(socket))
      }, { once: true })
      socket.addEventListener('error', () => {
        clearTimeout(timer)
        rejectConnect(new VerificationError('E_CDP_CONNECT'))
      }, { once: true })
    })
  }

  send(method, params = {}) {
    if (this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new VerificationError('E_CDP_CLOSED'))
    }
    const id = this.nextId++
    return new Promise((resolveRequest, rejectRequest) => {
      this.pending.set(id, { resolve: resolveRequest, reject: rejectRequest })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }
}

async function evaluateValue(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  })
  if (result.exceptionDetails) fail('E_DOM_EVALUATION')
  return result.result?.value
}

async function waitForExpression(cdp, expression, timeoutMs, code) {
  await waitForCondition(
    async () => Boolean(await evaluateValue(cdp, `Boolean(${expression})`)),
    timeoutMs,
    code
  )
}

async function waitForCondition(check, timeoutMs, code) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (activeApp) await observeTree(activeApp)
    if (await check()) return
    await delay(250)
  }
  fail(code)
}

async function waitForSelector(cdp, selector, timeoutMs) {
  await waitForExpression(
    cdp,
    `document.querySelector(${JSON.stringify(selector)}) !== null`,
    timeoutMs,
    'E_SELECTOR_TIMEOUT'
  )
}

async function clickSelector(cdp, selector) {
  const clicked = await evaluateValue(
    cdp,
    `(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (!(element instanceof HTMLElement) || element.matches(':disabled')) return false; element.click(); return true })()`
  )
  if (!clicked) fail('E_CLICK')
}

async function clickButtonText(cdp, selector, text) {
  const clicked = await evaluateValue(
    cdp,
    `(() => { const element = Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find((candidate) => candidate.textContent?.trim() === ${JSON.stringify(text)}); if (!(element instanceof HTMLElement) || element.matches(':disabled')) return false; element.click(); return true })()`
  )
  if (!clicked) fail('E_CLICK_TEXT')
}

async function openDiagnostics(cdp) {
  const opened = await evaluateValue(
    cdp,
    `(() => { const details = document.querySelector('.runtime-diagnostics'); if (!(details instanceof HTMLDetailsElement)) return false; details.open = true; return details.open })()`
  )
  if (!opened) fail('E_DIAGNOSTICS')
}

async function submitPrompt(cdp, prompt) {
  const submitted = await evaluateValue(
    cdp,
    `(() => { const input = document.querySelector('textarea[aria-label="发送给 Pi 的任务"]'); if (!(input instanceof HTMLTextAreaElement) || input.disabled) return false; const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; setter.call(input, ${JSON.stringify(prompt)}); input.dispatchEvent(new Event('input', { bubbles: true })); return true })()`
  )
  if (!submitted) fail('E_PROMPT_INPUT')
  await waitForExpression(
    cdp,
    `document.querySelector('.send-action:not(:disabled)') !== null`,
    5_000,
    'E_PROMPT_READY'
  )
  await clickSelector(cdp, '.send-action')
}

async function conversationCounts(cdp) {
  return evaluateValue(
    cdp,
    `window.piGui.getState().then((state) => ({
      messages: state.conversation.entries.filter((entry) => entry.kind === 'message').length,
      assistant: state.conversation.entries.filter((entry) => entry.kind === 'message' && entry.role === 'assistant' && !entry.streaming).length,
      thinking: state.conversation.entries.filter((entry) => entry.kind === 'thinking').length,
      toolsCompleted: state.conversation.entries.filter((entry) => entry.kind === 'tool' && entry.status === 'success').length,
      toolsRunning: state.conversation.entries.filter((entry) => entry.kind === 'tool' && (entry.status === 'pending' || entry.status === 'running')).length,
      toolsFailed: state.conversation.entries.filter((entry) => entry.kind === 'tool' && entry.status === 'error').length,
      abortedMessages: state.conversation.entries.filter((entry) => entry.kind === 'message' && entry.stopReason === 'aborted').length
    }))`
  )
}

async function waitForRuntime(cdp, status, timeoutMs) {
  const selector = status === 'ready' ? '.status-dot.task-idle' : `.status-dot.${status}`
  await waitForExpression(
    cdp,
    `document.querySelector(${JSON.stringify(selector)}) !== null`,
    timeoutMs,
    'E_RUNTIME_STATUS'
  )
}

async function waitForAssistantSettled(cdp, baseline, timeoutMs) {
  await waitForCondition(
    async () => (
      await evaluateValue(cdp, `document.querySelector('.status-dot.task-idle') !== null`)
    ) && (await conversationCounts(cdp)).assistant > baseline,
    timeoutMs,
    'E_ASSISTANT_SETTLED'
  )
}

async function waitForMessageCount(cdp, minimum, timeoutMs) {
  await waitForCondition(
    async () => (await conversationCounts(cdp)).messages >= minimum,
    timeoutMs,
    'E_MESSAGES_NOT_RESTORED'
  )
}

async function captureScreenshot(cdp, filename) {
  const redactionId = 'pi-gui-s7-evidence-redaction'
  const redacted = await evaluateValue(
    cdp,
    `(() => {
      if (document.getElementById(${JSON.stringify(redactionId)})) return false
      const style = document.createElement('style')
      style.id = ${JSON.stringify(redactionId)}
      style.textContent = ${JSON.stringify(`
        .chat-message.user > *,
        .chat-message.assistant > *,
        .chat-message.error > *,
        .chat-message.aborted > *,
        .chronological-thinking-detail,
        .process-thinking-detail,
        .process-tool-detail,
        .tool-file-tooltip,
        .connection-status-warning {
          visibility: hidden !important;
        }
        .chat-message.user::after,
        .chat-message.assistant::after,
        .chat-message.error::after,
        .chat-message.aborted::after {
          content: '内容已脱敏';
          visibility: visible;
        }
        .chronological-activity-text,
        .process-step-text {
          font-size: 0 !important;
        }
        .chronological-activity-text::after,
        .process-step-text::after {
          content: '步骤内容已脱敏';
          font-size: 12px;
        }
        .session-title,
        .conversation-header > strong {
          font-size: 0 !important;
        }
        .session-title::after,
        .conversation-header > strong::after {
          content: '验证会话';
          font-size: 12px;
        }
      `)}
      document.head.append(style)
      return true
    })()`
  )
  if (!redacted) fail('E_SCREENSHOT_REDACTION')

  try {
    const result = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
      fromSurface: true
    })
    if (typeof result.data !== 'string' || result.data.length === 0) fail('E_SCREENSHOT')
    await writeFile(join(reportDirectory, filename), Buffer.from(result.data, 'base64'), {
      mode: 0o600,
      flag: 'wx'
    })
  } finally {
    await evaluateValue(
      cdp,
      `document.getElementById(${JSON.stringify(redactionId)})?.remove()`
    ).catch(() => undefined)
  }
}

async function reservePort() {
  const server = createServer()
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') fail('E_DEBUG_PORT')
  await new Promise((resolveClose, rejectClose) =>
    server.close((error) => error ? rejectClose(error) : resolveClose())
  )
  return address.port
}

async function waitForPageTarget(port, app, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await observeTree(app)
    if (app.exited) fail('E_APP_EARLY_EXIT')
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json`, {
        signal: AbortSignal.timeout(1_000)
      })
      if (response.ok) {
        const targets = await response.json()
        const page = targets.find(
          (target) => target.type === 'page' && typeof target.webSocketDebuggerUrl === 'string'
        )
        if (page) return page
      }
    } catch {
      // DevTools HTTP is expected to refuse connections while Electron starts.
    }
    await delay(200)
  }
  fail('E_PAGE_TARGET')
}

async function observeTree(app) {
  if (app.rootPid === undefined) return
  for (const pid of await descendantPids(app.rootPid)) app.knownPids.add(pid)
}

async function descendantPids(rootPid) {
  const entries = await readdir('/proc', { withFileTypes: true })
  const children = new Map()
  await Promise.all(entries.filter((entry) => /^\d+$/.test(entry.name)).map(async (entry) => {
    const pid = Number(entry.name)
    try {
      const statusText = await readFile(`/proc/${pid}/status`, 'utf8')
      const match = /^PPid:\s+(\d+)$/m.exec(statusText)
      if (!match) return
      const ppid = Number(match[1])
      const list = children.get(ppid) ?? []
      list.push(pid)
      children.set(ppid, list)
    } catch {
      // Processes may exit during the /proc snapshot.
    }
  }))
  const descendants = []
  const queue = [...(children.get(rootPid) ?? [])]
  while (queue.length > 0) {
    const pid = queue.shift()
    descendants.push(pid)
    queue.push(...(children.get(pid) ?? []))
  }
  return descendants
}

async function findUniquePiRpcProcess(app, projectPath) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    await observeTree(app)
    const entries = await readdir('/proc', { withFileTypes: true })
    const matches = (await Promise.all(
      entries
        .filter((entry) => /^\d+$/.test(entry.name))
        .map(async (entry) => {
          const pid = Number(entry.name)
          try {
            const [commandLine, cwd] = await Promise.all([
              readFile(`/proc/${pid}/cmdline`),
              realpath(`/proc/${pid}/cwd`)
            ])
            const args = commandLine.toString('utf8').split('\0').filter(Boolean)
            const modeIndex = args.indexOf('--mode')
            return cwd === projectPath &&
              modeIndex >= 0 &&
              args[modeIndex + 1] === 'rpc' &&
              args.includes('--offline')
              ? pid
              : null
          } catch {
            return null
          }
        })
    )).filter((pid) => pid !== null)
    if (matches.length === 1) {
      app.knownPids.add(matches[0])
      return matches[0]
    }
    if (matches.length > 1) fail('E_PI_PROCESS_AMBIGUOUS')
    await delay(250)
  }
  fail('E_PI_PROCESS_MISSING')
}

async function readRecentSessionPointer(projectPath) {
  let value
  try {
    value = JSON.parse(
      await readFile(join(temporaryRoot, 'state', 'pi-gui-next', 'state.json'), 'utf8')
    )?.recentSession
  } catch {
    fail('E_SESSION_POINTER')
  }
  if (
    typeof value !== 'object' ||
    value === null ||
    value.projectPath !== projectPath ||
    typeof value.sessionFile !== 'string' ||
    typeof value.sessionId !== 'string' ||
    value.sessionId.length === 0
  ) {
    fail('E_SESSION_POINTER')
  }
  return value
}

async function assertSameSessionPointer(expected, projectPath) {
  const actual = await readRecentSessionPointer(projectPath)
  if (
    expected === null ||
    actual.sessionFile !== expected.sessionFile ||
    actual.sessionId !== expected.sessionId
  ) {
    fail('E_SESSION_CHANGED')
  }
}

async function closeApp(app, cdp) {
  await observeTree(app)
  try {
    await Promise.race([cdp.send('Browser.close'), delay(2_000)])
  } catch {
    // Closing the browser can close CDP before its response arrives.
  }
  const deadline = Date.now() + TIMEOUT.close
  while (Date.now() < deadline) {
    await observeTree(app).catch(() => undefined)
    const livePids = [...app.knownPids].filter(isPidAlive)
    if (app.exited && livePids.length === 0) return
    await delay(250)
  }
  await terminateApp(app)
  fail('E_APP_CLOSE')
}

async function cleanupActiveApp() {
  if (activeApp === null) return
  await terminateApp(activeApp).catch(() => undefined)
  activeApp = null
  activeCdp = null
}

async function terminateApp(app) {
  await observeTree(app).catch(() => undefined)
  if (app.rootPid !== undefined) {
    try {
      process.kill(-app.rootPid, 'SIGTERM')
    } catch {
      // Process group may already be gone.
    }
  }
  await delay(1_000)
  if (app.rootPid !== undefined && isPidAlive(app.rootPid)) {
    try {
      process.kill(-app.rootPid, 'SIGKILL')
    } catch {
      // Process group may already be gone.
    }
  }
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function resolvePiExecutable() {
  const explicit = process.env.PI_GUI_PI_EXECUTABLE
  if (explicit !== undefined) {
    if (explicit.trim().length === 0) fail('E_PI_EXECUTABLE')
    const candidate = resolve(explicit)
    if (await isExecutableFile(candidate)) return candidate
    fail('E_PI_EXECUTABLE')
  }
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (!directory) continue
    const candidate = resolve(directory, 'pi')
    if (await isExecutableFile(candidate)) return candidate
  }
  fail('E_PI_EXECUTABLE')
}

async function isExecutableFile(path) {
  try {
    return (await stat(path)).isFile() && (await access(path, constants.X_OK), true)
  } catch {
    return false
  }
}

async function sha256File(path) {
  const hash = createHash('sha256')
  const handle = await open(path, 'r')
  try {
    for await (const chunk of handle.createReadStream()) hash.update(chunk)
  } finally {
    await handle.close().catch(() => undefined)
  }
  return hash.digest('hex')
}

async function osIdentity() {
  let distro = null
  try {
    const text = await readFile('/etc/os-release', 'utf8')
    const match = /^(?:PRETTY_NAME|NAME)=(.*)$/m.exec(text)
    distro = match?.[1]?.replace(/^['"]|['"]$/g, '') ?? null
  } catch {
    // The kernel identity below is sufficient when os-release is absent.
  }
  return {
    platform: platform(),
    distro,
    kernel: kernelRelease(),
    arch: arch(),
    sessionType: 'wayland',
    desktop: 'niri'
  }
}

async function writeReport(status, error) {
  if (reportDirectory === null) return
  const report = {
    schemaVersion: 1,
    verification: 'S7 AppImage real UI',
    status,
    timestamps: {
      startedAt: STARTED_AT,
      finishedAt: new Date().toISOString()
    },
    source: { headCommit },
    artifact: artifactMetadata,
    targets: {
      app: packageJson?.version ?? null,
      node: packageJson?.engines?.node ?? null,
      electron: runtimeElectronVersion ?? packageJson?.devDependencies?.electron ?? null,
      pi: PI_VERSION
    },
    system: await osIdentity(),
    processOutputCounts: { ...processTotals },
    evidence: {
      screenshotTextRedacted: true,
      screenshots: [
        'ready-tool.png',
        'abort-settled.png',
        'crashed.png',
        'resumed.png',
        'reopened-resumed.png'
      ]
    },
    steps,
    error
  }
  const finalPath = join(reportDirectory, 'report.json')
  const temporaryPath = join(reportDirectory, `.report-${randomUUID()}.tmp`)
  await writeFile(temporaryPath, `${JSON.stringify(report, null, 2)}\n`, {
    mode: 0o600,
    flag: 'wx'
  })
  await rename(temporaryPath, finalPath)
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
}

await main()
