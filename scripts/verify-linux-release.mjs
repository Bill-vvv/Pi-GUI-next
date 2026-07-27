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
const VERIFY_LOCK_DIRECTORY = join(
  tmpdir(),
  `pi-gui-next-verify-linux-${typeof process.getuid === 'function' ? process.getuid() : 'user'}.lock`
)
const VERIFY_LOCK_OWNER_PATH = join(VERIFY_LOCK_DIRECTORY, 'owner.json')
const VERIFY_ACTIVE_DEV_OVERRIDE = 'PI_GUI_VERIFY_ALLOW_ACTIVE_DEV'
const MEMORY_DIAGNOSTICS_ENABLED = process.argv.includes('--memory-diagnostics') ||
  process.env.PI_GUI_VERIFY_MEMORY_DIAGNOSTICS === '1'
const MEMORY_DIAGNOSTICS_SAMPLE_LIMIT = 12
const NON_RUN_GUARD_CODES = new Set(['E_VERIFY_ALREADY_RUNNING', 'E_DEV_GUI_RUNNING'])
const PI_VERSION = '0.80.10'
const CWD_MARKER_NAME = '.pi-gui-s7-cwd-ok'
const CWD_MARKER_CONTENT = 'pi-gui-s7-tool-ok'
const TOOL_PROMPT =
  `Use the bash tool to run exactly \`printf ${CWD_MARKER_CONTENT} > ${CWD_MARKER_NAME}\`, then briefly confirm completion.`
const ABORT_PROMPT =
  'Use the bash tool to run exactly `for i in $(seq 1 60); do sleep 1; done`, and wait for it to finish.'
const CONTINUATION_PROMPT = 'Reply briefly that this recovered conversation can continue.'
const SECOND_SESSION_PROMPT = 'Reply briefly that this second release-verification conversation is ready.'
const S19_MARKERS = [
  ['s19-alpha.txt', 'alpha'],
  ['s19-beta.txt', 'beta'],
  ['s19-gamma.txt', 'gamma']
]
const S19_PROMPT = [
  'Use the subagent tool exactly once with one parallel invocation containing exactly three independent tasks.',
  'Every task must use agent "worker"; do not use Oracle, Advisor, planner, scout, reviewer, or explorer. The workers must not edit any file.',
  'Task 1: MUST first call bash with the exact command sleep 45; do not skip it. Then read s19-alpha.txt and return only its one-word value.',
  'Task 2: MUST first call bash with the exact command sleep 45; do not skip it. Then read s19-beta.txt and return only its one-word value.',
  'Task 3: MUST first call bash with the exact command sleep 45; do not skip it. Then read s19-gamma.txt and return only its one-word value.',
  'Set concurrency to 3 and wait for all three tasks before replying. Do not perform the tasks yourself.'
].join('\n')
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
const THINKING_LEVEL_LABELS = {
  off: 'Off',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra High',
  max: 'Max'
}

let stage = 'preflight'
let verifierLockHeld = false
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
let projectPaths = []
const steps = []
const screenshotFiles = []
const processTotals = { stdoutChars: 0, stderrChars: 0 }
const memoryDiagnostics = {
  enabled: MEMORY_DIAGNOSTICS_ENABLED,
  samples: []
}
const p2Summary = {
  projects: { configured: 0, discovered: 0, switched: false },
  sessions: { materialized: 0, listed: 0, switched: false, restored: false },
  commands: {
    discovered: 0,
    sources: 0,
    completed: false,
    completionSideEffectFree: false,
    requiredArgumentRejected: false,
    unknownRejected: false
  },
  interaction: {
    composerFocusRestored: false,
    emptyConversationVisible: false,
    switchFeedbackObserved: false,
    parallelRuntimes: false
  }
}
const s19Summary = {
  parallelParticipants: 0,
  agents: [],
  observedLive: false,
  escapePriority: false,
  liveToCompleted: false,
  wideLayout: false,
  narrowLayout: false,
  focusRestoration: { close: false, back: false, escape: false },
  reducedMotion: false
}

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
    await acquireVerifierLock()
    await assertNoCanonicalDevelopmentGui()
    await preflight()
    await prepareRun()
    await exerciseUi()
    await writeReport('passed', null)
  } catch (error) {
    const code = error instanceof VerificationError ? error.code : 'E_UNEXPECTED'
    await cleanupActiveApp()
    if (!NON_RUN_GUARD_CODES.has(code)) {
      await ensureReportDirectory().catch(() => undefined)
      await writeReport('failed', { stage, code }).catch(() => undefined)
    }
    process.stderr.write(`[verify:linux] ${stage}: ${code}${failureHint(code)}\n`)
    process.exitCode = 1
  } finally {
    if (temporaryRoot !== null) {
      await rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined)
    }
    await releaseVerifierLock()
  }
}

async function acquireVerifierLock() {
  stage = 'preflight.verifier_lock'
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await mkdir(VERIFY_LOCK_DIRECTORY, { mode: 0o700 })
      verifierLockHeld = true
      await writeFile(
        VERIFY_LOCK_OWNER_PATH,
        `${JSON.stringify({ pid: process.pid, startedAt: STARTED_AT, script: SCRIPT_PATH })}\n`,
        { mode: 0o600, flag: 'wx' }
      )
      return
    } catch (error) {
      if (verifierLockHeld) {
        await releaseVerifierLock()
        throw error
      }
      if (error?.code !== 'EEXIST') throw error
      const owner = await readVerifierLockOwner()
      if (owner !== null && await isVerifierProcess(owner.pid)) {
        fail('E_VERIFY_ALREADY_RUNNING')
      }
      const lockAgeMs = await stat(VERIFY_LOCK_DIRECTORY)
        .then((lockStat) => Date.now() - lockStat.mtimeMs)
        .catch((statError) => statError?.code === 'ENOENT' ? null : Promise.reject(statError))
      if (lockAgeMs === null) continue
      if (owner === null && lockAgeMs < 30_000) fail('E_VERIFY_ALREADY_RUNNING')
      await rm(VERIFY_LOCK_DIRECTORY, { recursive: true, force: true })
    }
  }
  fail('E_VERIFY_ALREADY_RUNNING')
}

async function releaseVerifierLock() {
  if (!verifierLockHeld) return
  verifierLockHeld = false
  await rm(VERIFY_LOCK_DIRECTORY, { recursive: true, force: true }).catch(() => undefined)
}

async function readVerifierLockOwner() {
  try {
    const owner = JSON.parse(await readFile(VERIFY_LOCK_OWNER_PATH, 'utf8'))
    return Number.isSafeInteger(owner?.pid) && owner.pid > 0 ? owner : null
  } catch {
    return null
  }
}

async function isVerifierProcess(pid) {
  const args = await processArguments(pid)
  return args.some((argument) =>
    argument === SCRIPT_PATH ||
    argument === 'scripts/verify-linux-release.mjs' ||
    argument.endsWith('/scripts/verify-linux-release.mjs')
  )
}

async function assertNoCanonicalDevelopmentGui() {
  stage = 'preflight.dev_gui'
  if (process.env[VERIFY_ACTIVE_DEV_OVERRIDE] === '1') return
  const procEntries = await readdir('/proc', { withFileTypes: true })
  for (const entry of procEntries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue
    const args = await processArguments(Number(entry.name))
    if (
      !args.includes('dev') ||
      !args.some((argument) => argument.includes('electron-vite'))
    ) {
      continue
    }
    const cwd = await realpath(join('/proc', entry.name, 'cwd')).catch(() => null)
    if (cwd === REPO_ROOT) fail('E_DEV_GUI_RUNNING')
  }
}

async function processArguments(pid) {
  try {
    const commandLine = await readFile(join('/proc', String(pid), 'cmdline'))
    return commandLine.toString('utf8').split('\0').filter(Boolean)
  } catch {
    return []
  }
}

function failureHint(code) {
  if (code === 'E_VERIFY_ALREADY_RUNNING') {
    return '; another pnpm verify:linux process owns the workstation UI gate'
  }
  if (code === 'E_DEV_GUI_RUNNING') {
    return `; stop pnpm dev first, or explicitly set ${VERIFY_ACTIVE_DEV_OVERRIDE}=1 for a supervised run`
  }
  return ''
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
    typeof packageJson?.devDependencies?.electron !== 'string' ||
    typeof packageJson?.build?.appId !== 'string'
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
    project: join(temporaryRoot, 'project'),
    secondProject: join(temporaryRoot, 'project-secondary')
  }
  await Promise.all(Object.values(paths).map((path) => mkdir(path, { recursive: true, mode: 0o700 })))
  await mkdir(join(paths.config, 'pi-gui-next'), { recursive: true, mode: 0o700 })
  await writeFile(
    join(paths.config, 'pi-gui-next', 'config.json'),
    `${JSON.stringify({
      version: 3,
      projects: [{ path: paths.project }, { path: paths.secondProject }],
      activeProjectKey: paths.project,
      sessionNaming: { mode: 'off' }
    }, null, 2)}\n`,
    { mode: 0o600, flag: 'wx' }
  )
  temporaryRoot = resolve(temporaryRoot)
  projectPaths = [join(temporaryRoot, 'project'), join(temporaryRoot, 'project-secondary')]
  await Promise.all(S19_MARKERS.map(([name, value]) =>
    writeFile(join(projectPaths[0], name), `${value}\n`, { mode: 0o600, flag: 'wx' })
  ))
  p2Summary.projects.configured = projectPaths.length
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
    await waitForExpression(
      activeCdp,
      `window.piGui.getState().then((state) =>
        state.runtime.status !== 'stopped' || document.querySelector('.composer-start-action') !== null
      )`,
      TIMEOUT.page,
      'E_LAUNCH_SURFACE'
    )
    await installMemoryEventProbe(activeCdp)
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
    const projectState = await evaluateValue(
      activeCdp,
      `window.piGui.getState().then((state) => ({
        activeProjectKey: state.activeProjectKey,
        projects: state.projects.map((project) => project.path)
      }))`
    )
    if (
      projectState === null ||
      typeof projectState !== 'object' ||
      projectState.activeProjectKey !== projectPath ||
      !Array.isArray(projectState.projects) ||
      !projectState.projects.includes(projectPath)
    ) {
      fail('E_PROJECT_PATH')
    }
  })

  await runStep('pi_probe_ready', async () => {
    const startRequired = await evaluateValue(
      activeCdp,
      `document.querySelector('.composer-start-action') !== null`
    )
    if (startRequired) await clickSelector(activeCdp, '.composer-start-action')
    await waitForRuntime(activeCdp, 'ready', TIMEOUT.ready)
    const runtimeIdentity = await evaluateValue(
      activeCdp,
      `window.piGui.getState().then((state) => ({
        status: state.runtime.status,
        executable: state.runtime.executable,
        version: state.runtime.version
      }))`
    )
    if (
      runtimeIdentity === null ||
      typeof runtimeIdentity !== 'object' ||
      runtimeIdentity.status !== 'ready'
    ) {
      const observedStatus = typeof runtimeIdentity?.status === 'string' &&
        ['stopped', 'starting', 'running', 'stopping', 'crashed'].includes(runtimeIdentity.status)
        ? runtimeIdentity.status.toUpperCase()
        : 'INVALID'
      fail(`E_PI_RUNTIME_STATUS_${observedStatus}`)
    }
    if (runtimeIdentity.version !== PI_VERSION) fail('E_PI_VERSION')
    if (typeof runtimeIdentity.executable !== 'string') fail('E_PI_EXECUTABLE')
    const [actualExecutable, expectedExecutable] = await Promise.all([
      realpath(runtimeIdentity.executable).catch(() => null),
      realpath(piExecutable).catch(() => null)
    ])
    if (actualExecutable === null || actualExecutable !== expectedExecutable) {
      fail('E_PI_EXECUTABLE')
    }
    await captureMemorySample('single-runtime-ready')
  })

  await runStep('high_thinking', async () => {
    await selectThinkingLevelFromGui(activeCdp, 'high')
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
    await captureMemorySample('tool-turn-settled')
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
      `window.piGui.getState().then((state) =>
        state.runtime.status === 'crashed' &&
        Array.from(document.querySelectorAll('.composer-start-action')).some((button) => button.textContent?.includes('重启并恢复'))
      )`,
      TIMEOUT.crash,
      'E_CRASH_STATE'
    )
    const crashDiagnostic = await evaluateValue(
      activeCdp,
      `window.piGui.getState().then((state) => ({
        status: state.runtime.status,
        exitCode: state.runtime.exitCode,
        exitSignal: state.runtime.exitSignal
      }))`
    )
    if (
      crashDiagnostic === null ||
      typeof crashDiagnostic !== 'object' ||
      crashDiagnostic.status !== 'crashed' ||
      (crashDiagnostic.exitCode === null && crashDiagnostic.exitSignal === null)
    ) {
      fail('E_CRASH_EXIT_DIAGNOSTIC')
    }
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
    await installMemoryEventProbe(activeCdp)
  })

  await runStep('reopen_resume', async () => {
    await clickButtonText(activeCdp, '.composer-start-action', '恢复对话')
    await waitForRuntime(activeCdp, 'ready', TIMEOUT.ready)
    await waitForMessageCount(activeCdp, messagesBeforeReopen, TIMEOUT.ready)
    await assertSameSessionPointer(sessionPointer, projectPath)
    await captureScreenshot(activeCdp, 'reopened-resumed.png')
    await captureMemorySample('reopened-runtime-ready')
  })

  await runStep('p2_projects', async () => {
    const [primaryProjectPath, secondaryProjectPath] = projectPaths
    const discovered = await evaluateValue(
      activeCdp,
      `document.querySelectorAll('.project-select').length`
    )
    if (discovered !== projectPaths.length) fail('E_P2_PROJECT_DISCOVERY')
    p2Summary.projects.discovered = discovered

    await assertConfiguredProjectRuntimeCounts(new Map([
      [primaryProjectPath, 1],
      [secondaryProjectPath, 0]
    ]))
    const feedbackObserved = await clickTitledButtonWithFeedback(
      activeCdp,
      '.project-select',
      secondaryProjectPath
    )
    if (!feedbackObserved) fail('E_P2_PROJECT_SWITCH_FEEDBACK')
    p2Summary.interaction.switchFeedbackObserved = true
    await waitForTitledSelection(
      activeCdp,
      '.project-select',
      secondaryProjectPath,
      TIMEOUT.ready,
      'E_P2_PROJECT_SWITCH'
    )
    await waitForExpression(
      activeCdp,
      `document.querySelector('.conversation-empty-state[role="status"]') !== null`,
      TIMEOUT.page,
      'E_P2_EMPTY_CONVERSATION'
    )
    p2Summary.interaction.emptyConversationVisible = true

    await clickButtonText(activeCdp, '.composer-start-action', '启动 Pi')
    await waitForRuntime(activeCdp, 'ready', TIMEOUT.ready)
    await assertConfiguredProjectRuntimeCounts(new Map([
      [primaryProjectPath, 1],
      [secondaryProjectPath, 1]
    ]))
    await waitForComposerFocus(activeCdp)

    await clickTitledButton(activeCdp, '.project-select', primaryProjectPath)
    await waitForTitledSelection(
      activeCdp,
      '.project-select',
      primaryProjectPath,
      TIMEOUT.ready,
      'E_P2_PROJECT_RESTORE'
    )
    const primaryReady = await evaluateValue(
      activeCdp,
      `window.piGui.getState().then((state) => state.runtime.status === 'ready')`
    )
    if (!primaryReady) {
      await clickButtonText(activeCdp, '.composer-start-action', '恢复对话')
      await waitForRuntime(activeCdp, 'ready', TIMEOUT.ready)
    }
    await waitForMessageCount(activeCdp, messagesBeforeReopen, TIMEOUT.ready)
    await assertSameSessionPointer(sessionPointer, primaryProjectPath)
    await assertConfiguredProjectRuntimeCounts(new Map([
      [primaryProjectPath, 1],
      [secondaryProjectPath, 1]
    ]))
    await waitForComposerFocus(activeCdp)
    p2Summary.projects.switched = true
    p2Summary.interaction.composerFocusRestored = true
    p2Summary.interaction.parallelRuntimes = true
    await captureMemorySample('two-project-runtimes-ready')
  })

  await runStep('p2_sessions', async () => {
    const [primaryProjectPath, secondaryProjectPath] = projectPaths
    const originalSessionKey = await selectedTitledButton(activeCdp, '.session-item')
    if (originalSessionKey === null) fail('E_P2_SESSION_ORIGINAL')

    await clickSelector(activeCdp, '.project-new-chat')
    await waitForRuntime(activeCdp, 'ready', TIMEOUT.ready)
    await assertConfiguredProjectRuntimeCounts(new Map([
      [primaryProjectPath, 2],
      [secondaryProjectPath, 1]
    ]))
    await waitForExpression(
      activeCdp,
      `document.querySelector('.conversation-empty-state[role="status"]') !== null`,
      TIMEOUT.page,
      'E_P2_NEW_SESSION_EMPTY'
    )
    await waitForComposerFocus(activeCdp)
    const baseline = await conversationCounts(activeCdp)
    await submitPrompt(activeCdp, SECOND_SESSION_PROMPT)
    await waitForAssistantSettled(activeCdp, baseline.assistant, TIMEOUT.turn)
    await waitForCondition(
      async () => Number(await evaluateValue(
        activeCdp,
        `document.querySelectorAll('.session-item').length`
      )) >= 2,
      TIMEOUT.ready,
      'E_P2_SESSION_LIST'
    )
    const listed = await evaluateValue(
      activeCdp,
      `document.querySelectorAll('.session-item').length`
    )
    const secondSessionKey = await selectedTitledButton(activeCdp, '.session-item')
    if (
      typeof listed !== 'number' ||
      listed < 2 ||
      secondSessionKey === null ||
      secondSessionKey === originalSessionKey
    ) {
      fail('E_P2_SESSION_MATERIALIZATION')
    }
    p2Summary.sessions.materialized = 2
    p2Summary.sessions.listed = listed

    await clickTitledButton(activeCdp, '.session-item', originalSessionKey)
    await waitForTitledSelection(
      activeCdp,
      '.session-item',
      originalSessionKey,
      TIMEOUT.ready,
      'E_P2_SESSION_SWITCH'
    )
    await waitForRuntime(activeCdp, 'ready', TIMEOUT.ready)
    await waitForMessageCount(activeCdp, messagesBeforeReopen, TIMEOUT.ready)
    await assertSameSessionPointer(sessionPointer, projectPath)
    await assertConfiguredProjectRuntimeCounts(new Map([
      [primaryProjectPath, 2],
      [secondaryProjectPath, 1]
    ]))
    await waitForComposerFocus(activeCdp)
    p2Summary.sessions.switched = true
    p2Summary.sessions.restored = true
    await captureMemorySample('three-session-runtimes-ready')
  })

  await runStep('p2_slash_commands', async () => {
    await focusComposer(activeCdp)
    await insertText(activeCdp, '/')
    await waitForSelector(activeCdp, '.slash-command-surface[aria-label="Slash 命令"]', TIMEOUT.page)
    const catalogSummary = await evaluateValue(
      activeCdp,
      `(() => {
        const options = Array.from(document.querySelectorAll('.slash-command-option'))
        return {
          commands: options.length,
          sources: new Set(options.map((option) => option.querySelector('.slash-command-source')?.textContent?.trim()).filter(Boolean)).size
        }
      })()`
    )
    if (
      catalogSummary === null ||
      typeof catalogSummary !== 'object' ||
      !Number.isInteger(catalogSummary.commands) ||
      catalogSummary.commands < 5 ||
      !Number.isInteger(catalogSummary.sources) ||
      catalogSummary.sources < 2
    ) {
      fail('E_P2_COMMAND_DISCOVERY')
    }
    p2Summary.commands.discovered = catalogSummary.commands
    p2Summary.commands.sources = catalogSummary.sources

    const completionBaseline = await evaluateValue(
      activeCdp,
      `window.piGui.getState().then((state) => ({
        activeSessionKey: state.activeSessionKey,
        sessionKeys: state.sessions.map((session) => session.key),
        conversationEntries: state.conversation.entries.length,
        runtimeStatus: state.runtime.status
      }))`
    )
    await dispatchKey(activeCdp, 'Tab', 'Tab')
    await waitForExpression(
      activeCdp,
      `(() => {
        const input = document.querySelector('textarea[aria-label="发送给 Pi 的任务"]')
        return input?.value === '/new' && document.activeElement === input
      })()`,
      TIMEOUT.page,
      'E_P2_TAB_COMPLETION'
    )
    const afterTabCompletion = await evaluateValue(
      activeCdp,
      `window.piGui.getState().then((state) => ({
        activeSessionKey: state.activeSessionKey,
        sessionKeys: state.sessions.map((session) => session.key),
        conversationEntries: state.conversation.entries.length,
        runtimeStatus: state.runtime.status
      }))`
    )
    if (JSON.stringify(afterTabCompletion) !== JSON.stringify(completionBaseline)) {
      fail('E_P2_TAB_SIDE_EFFECT')
    }

    await clearComposer(activeCdp)
    await insertText(activeCdp, '/')
    await dispatchKey(activeCdp, 'Enter', 'Enter')
    await waitForExpression(
      activeCdp,
      `(() => {
        const input = document.querySelector('textarea[aria-label="发送给 Pi 的任务"]')
        return input?.value === '/new' && document.activeElement === input
      })()`,
      TIMEOUT.page,
      'E_P2_ENTER_COMPLETION'
    )
    const afterEnterCompletion = await evaluateValue(
      activeCdp,
      `window.piGui.getState().then((state) => ({
        activeSessionKey: state.activeSessionKey,
        sessionKeys: state.sessions.map((session) => session.key),
        conversationEntries: state.conversation.entries.length,
        runtimeStatus: state.runtime.status
      }))`
    )
    if (JSON.stringify(afterEnterCompletion) !== JSON.stringify(completionBaseline)) {
      fail('E_P2_ENTER_SIDE_EFFECT')
    }
    p2Summary.commands.completionSideEffectFree = true

    await clearComposer(activeCdp)
    await insertText(activeCdp, '/thinking')
    await waitForExpression(
      activeCdp,
      `(() => {
        const option = document.getElementById('slash-command-pi-rpc.set-thinking-level')
        return option?.getAttribute('aria-selected') === 'true' &&
          option.querySelector('.slash-command-source')?.textContent?.trim() === 'Pi RPC'
      })()`,
      TIMEOUT.page,
      'E_P2_COMMAND_SOURCE'
    )
    await dispatchKey(activeCdp, 'Tab', 'Tab')
    await waitForExpression(
      activeCdp,
      `document.querySelector('textarea[aria-label="发送给 Pi 的任务"]')?.value === '/thinking '`,
      TIMEOUT.page,
      'E_P2_COMMAND_COMPLETION'
    )
    await dispatchKey(activeCdp, 'Enter', 'Enter')
    await waitForExpression(
      activeCdp,
      `(() => {
        const input = document.querySelector('textarea[aria-label="发送给 Pi 的任务"]')
        const error = document.querySelector('.composer-command-error[role="alert"]')
        return input?.value === '/thinking ' && error?.textContent?.startsWith('/thinking 需要参数：') === true
      })()`,
      TIMEOUT.page,
      'E_P2_REQUIRED_ARGUMENT'
    )
    const afterRequiredArgumentRejection = await evaluateValue(
      activeCdp,
      `window.piGui.getState().then((state) => ({
        activeSessionKey: state.activeSessionKey,
        sessionKeys: state.sessions.map((session) => session.key),
        conversationEntries: state.conversation.entries.length,
        runtimeStatus: state.runtime.status
      }))`
    )
    if (JSON.stringify(afterRequiredArgumentRejection) !== JSON.stringify(completionBaseline)) {
      fail('E_P2_REQUIRED_ARGUMENT_SIDE_EFFECT')
    }
    p2Summary.commands.requiredArgumentRejected = true

    const availableThinkingLevel = await availableThinkingLevelFromGui(activeCdp)
    await focusComposer(activeCdp)
    await insertText(activeCdp, availableThinkingLevel)
    await dispatchKey(activeCdp, 'Enter', 'Enter')
    await waitForExpression(
      activeCdp,
      `(() => {
        const input = document.querySelector('textarea[aria-label="发送给 Pi 的任务"]')
        return input?.value === '' && document.querySelector('.composer-command-error[role="alert"]') === null
      })()`,
      TIMEOUT.ready,
      'E_P2_TYPED_COMMAND'
    )
    await waitForExpression(
      activeCdp,
      `window.piGui.getState().then((state) => state.session.thinkingLevel === ${JSON.stringify(availableThinkingLevel)})`,
      TIMEOUT.ready,
      'E_P2_TYPED_COMMAND_RESULT'
    )
    p2Summary.commands.completed = true

    await insertText(activeCdp, '/__p2_unknown__')
    await dispatchKey(activeCdp, 'Enter', 'Enter')
    await waitForExpression(
      activeCdp,
      `document.querySelector('.composer-command-error[role="alert"]')?.textContent?.startsWith('未知命令：') === true`,
      TIMEOUT.page,
      'E_P2_UNKNOWN_COMMAND'
    )
    p2Summary.commands.unknownRejected = true
    await clearComposer(activeCdp)
    await waitForExpression(
      activeCdp,
      `document.querySelector('.composer-command-error[role="alert"]') === null`,
      TIMEOUT.page,
      'E_P2_UNKNOWN_COMMAND_CLEAR'
    )
    await captureScreenshot(activeCdp, 'p2-workbench.png')
  })

  await runStep('s19_subagent_detail', async () => {
    await setAppWindowSize(activeApp, activeCdp, 1600, 1000)
    await submitPrompt(activeCdp, S19_PROMPT)

    let liveRun = null
    await waitForCondition(async () => {
      liveRun = await latestParallelSubagentRun(activeCdp)
      return liveRun?.runtime === 'running' && liveRun.toolStatus === 'running' &&
        liveRun.participants.length === 3 &&
        liveRun.participants.every((participant) =>
          participant.agent === 'worker' && participant.status === 'running'
        )
    }, TIMEOUT.turn, 'E_S19_PARALLEL_LIVE')
    s19Summary.parallelParticipants = liveRun.participants.length
    s19Summary.agents = [...new Set(liveRun.participants.map((participant) => participant.agent))]
    s19Summary.observedLive = true
    await captureMemorySample('three-subagents-running')

    const capsulesAlreadyVisible = await evaluateValue(
      activeCdp,
      `document.querySelectorAll('button.subagent-run-chip').length >= 3`
    )
    if (!capsulesAlreadyVisible) {
      const hasLiveProcessDisclosure = await evaluateValue(
        activeCdp,
        `document.querySelector('.live-process-status-summary') !== null`
      )
      if (hasLiveProcessDisclosure) {
        await clickSelector(activeCdp, '.live-process-status-summary')
        await waitForExpression(
          activeCdp,
          `document.querySelector('.live-process-status[open]') !== null`,
          TIMEOUT.page,
          'E_S19_LIVE_PROCESS_EXPAND'
        )
      }
      const compactToolGroup = await evaluateValue(
        activeCdp,
        `document.querySelector('.tool-group-summary-row') !== null && document.querySelectorAll('button.subagent-run-chip').length < 3`
      )
      if (compactToolGroup) {
        await clickSelector(activeCdp, '.tool-group-summary-row')
        await waitForExpression(
          activeCdp,
          `document.querySelector('.tool-group-details[open]') !== null`,
          TIMEOUT.page,
          'E_S19_TOOL_GROUP_EXPAND'
        )
      }
    }
    await waitForExpression(
      activeCdp,
      `document.querySelectorAll('button.subagent-run-chip').length >= 3`,
      TIMEOUT.page,
      'E_S19_CAPSULES'
    )

    const first = {
      toolCallId: liveRun.toolCallId,
      participantIndex: liveRun.participants[0].index
    }
    const second = {
      toolCallId: liveRun.toolCallId,
      participantIndex: liveRun.participants[1].index
    }
    const third = {
      toolCallId: liveRun.toolCallId,
      participantIndex: liveRun.participants[2].index
    }

    await openSubagentParticipant(activeCdp, first)
    const wideLayout = await evaluateValue(
      activeCdp,
      `(() => {
        const shell = document.querySelector('.app-shell')
        const main = document.querySelector('.main-chat')
        const detail = document.querySelector('.subagent-task-detail')
        const sidebar = document.querySelector('.left-sidebar')
        if (!(shell instanceof HTMLElement) || !(main instanceof HTMLElement) ||
            !(detail instanceof HTMLElement) || !(sidebar instanceof HTMLElement)) return null
        const mainRect = main.getBoundingClientRect()
        const detailRect = detail.getBoundingClientRect()
        return {
          width: window.innerWidth,
          shellOpen: shell.classList.contains('subagent-detail-open'),
          mainDisplay: getComputedStyle(main).display,
          mainWidth: Math.round(mainRect.width),
          detailWidth: Math.round(detailRect.width),
          detailAfterMain: detailRect.left >= mainRect.right - 1,
          selectedCount: document.querySelectorAll('.subagent-run-chip[aria-pressed="true"]').length
        }
      })()`
    )
    if (!wideLayout || wideLayout.width < 1280 || !wideLayout.shellOpen ||
        wideLayout.mainDisplay !== 'grid' || wideLayout.mainWidth < 640 ||
        wideLayout.detailWidth < 320 || !wideLayout.detailAfterMain ||
        wideLayout.selectedCount !== 1) {
      fail('E_S19_WIDE_LAYOUT')
    }
    s19Summary.wideLayout = true
    await captureScreenshot(activeCdp, 's19-wide-live.png')

    const abortBeforeEscape = (await conversationCounts(activeCdp)).abortedMessages
    await dispatchKey(activeCdp, 'Escape', 'Escape')
    await waitForExpression(
      activeCdp,
      `document.querySelector('.subagent-task-detail') === null`,
      TIMEOUT.page,
      'E_S19_ESCAPE_CLOSE'
    )
    await waitForSubagentFocus(activeCdp, first, 'E_S19_ESCAPE_FOCUS')
    const afterEscape = await evaluateValue(
      activeCdp,
      `window.piGui.getState().then((state) => ({
        runtime: state.runtime.status,
        aborted: state.conversation.entries.filter((entry) =>
          entry.kind === 'message' && entry.stopReason === 'aborted'
        ).length
      }))`
    )
    if (!afterEscape || afterEscape.runtime !== 'running' || afterEscape.aborted !== abortBeforeEscape) {
      fail('E_S19_ESCAPE_ABORTED')
    }
    s19Summary.escapePriority = true

    await openSubagentParticipant(activeCdp, first)
    let completedRun = null
    await waitForCondition(async () => {
      completedRun = await latestParallelSubagentRun(activeCdp)
      return completedRun?.toolCallId === first.toolCallId && completedRun.runtime === 'ready' &&
        completedRun.participants.length === 3 &&
        completedRun.participants.every((participant) =>
          participant.status === 'completed' && participant.hasFinalOutput
        )
    }, TIMEOUT.turn, 'E_S19_COMPLETION')
    const completedFirstLookup = subagentParticipantLookupExpression(first)
    await waitForExpression(
      activeCdp,
      `document.querySelector('.subagent-task-detail') !== null &&
       document.querySelectorAll('.subagent-run-chip[aria-pressed="true"]').length === 1 &&
       (${completedFirstLookup})?.getAttribute('aria-pressed') === 'true'`,
      TIMEOUT.page,
      'E_S19_COMPLETED_DETAIL'
    )
    s19Summary.liveToCompleted = true
    await captureScreenshot(activeCdp, 's19-wide-completed.png')
    await captureMemorySample('three-subagents-completed')

    await clickSelector(activeCdp, '.subagent-task-detail-close')
    await waitForExpression(
      activeCdp,
      `document.querySelector('.subagent-task-detail') === null`,
      TIMEOUT.page,
      'E_S19_CLOSE'
    )
    await waitForSubagentFocus(activeCdp, first, 'E_S19_CLOSE_FOCUS')
    s19Summary.focusRestoration.close = true

    await setAppWindowSize(activeApp, activeCdp, 1100, 900)
    await openSubagentParticipant(activeCdp, second)
    const narrowLayout = await evaluateValue(
      activeCdp,
      `(() => {
        const main = document.querySelector('.main-chat')
        const detail = document.querySelector('.subagent-task-detail')
        const sidebar = document.querySelector('.left-sidebar')
        const back = document.querySelector('.subagent-task-detail-back')
        const close = document.querySelector('.subagent-task-detail-close')
        if (!(main instanceof HTMLElement) || !(detail instanceof HTMLElement) ||
            !(sidebar instanceof HTMLElement) || !(back instanceof HTMLElement) ||
            !(close instanceof HTMLElement)) return null
        return {
          width: window.innerWidth,
          mainDisplay: getComputedStyle(main).display,
          detailWidth: Math.round(detail.getBoundingClientRect().width),
          sidebarWidth: Math.round(sidebar.getBoundingClientRect().width),
          backDisplay: getComputedStyle(back).display,
          closeDisplay: getComputedStyle(close).display
        }
      })()`
    )
    if (!narrowLayout || narrowLayout.width >= 1280 || narrowLayout.mainDisplay !== 'none' ||
        narrowLayout.detailWidth < 600 || narrowLayout.sidebarWidth < 280 ||
        narrowLayout.backDisplay === 'none' || narrowLayout.closeDisplay !== 'none') {
      fail('E_S19_NARROW_LAYOUT')
    }
    s19Summary.narrowLayout = true
    await captureScreenshot(activeCdp, 's19-narrow-completed.png')

    await clickSelector(activeCdp, '.subagent-task-detail-back')
    await waitForExpression(
      activeCdp,
      `document.querySelector('.subagent-task-detail') === null`,
      TIMEOUT.page,
      'E_S19_BACK'
    )
    await waitForSubagentFocus(activeCdp, second, 'E_S19_BACK_FOCUS')
    s19Summary.focusRestoration.back = true

    await openSubagentParticipant(activeCdp, third)
    await dispatchKey(activeCdp, 'Escape', 'Escape')
    await waitForExpression(
      activeCdp,
      `document.querySelector('.subagent-task-detail') === null`,
      TIMEOUT.page,
      'E_S19_NARROW_ESCAPE'
    )
    await waitForSubagentFocus(activeCdp, third, 'E_S19_NARROW_ESCAPE_FOCUS')
    s19Summary.focusRestoration.escape = true

    await setAppWindowSize(activeApp, activeCdp, 1600, 1000)
    await openSubagentParticipant(activeCdp, first)
    await activeCdp.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }]
    })
    const reducedMotion = await evaluateValue(
      activeCdp,
      `(() => {
        const shell = document.querySelector('.app-shell')
        const chip = document.querySelector('.subagent-run-chip[aria-pressed="true"]')
        if (!(shell instanceof HTMLElement) || !(chip instanceof HTMLElement)) return null
        return {
          matches: matchMedia('(prefers-reduced-motion: reduce)').matches,
          shellTransitionDuration: getComputedStyle(shell).transitionDuration,
          chipTransitionDuration: getComputedStyle(chip).transitionDuration,
          chipAnimationDuration: getComputedStyle(chip).animationDuration,
          scrollBehavior: getComputedStyle(document.documentElement).scrollBehavior
        }
      })()`
    )
    const nearZeroDuration = (value) => typeof value === 'string' &&
      value.split(',').every((part) => Number.parseFloat(part) <= 0.001)
    if (!reducedMotion || !reducedMotion.matches ||
        !nearZeroDuration(reducedMotion.shellTransitionDuration) ||
        !nearZeroDuration(reducedMotion.chipTransitionDuration) ||
        !nearZeroDuration(reducedMotion.chipAnimationDuration) ||
        reducedMotion.scrollBehavior !== 'auto') {
      fail('E_S19_REDUCED_MOTION')
    }
    s19Summary.reducedMotion = true
    await clickSelector(activeCdp, '.subagent-task-detail-close')
    await activeCdp.send('Emulation.setEmulatedMedia', { features: [] })
  })

  await runStep('final_close', async () => {
    await captureMemorySample('before-final-close')
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
  const existingWindowIds = await niriWindowIds()
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
    app.windowId = await waitForNewNiriWindow(existingWindowIds, TIMEOUT.page)
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
    async () => Boolean(await evaluateValue(
      cdp,
      `Promise.resolve(${expression}).then((value) => Boolean(value))`
    )),
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

function titledButtonIdentityAttribute(selector) {
  if (selector === '.project-select') return 'data-project-key'
  if (selector === '.session-item') return 'data-session-key'
  throw new Error(`Unsupported titled button selector: ${selector}`)
}

async function clickTitledButton(cdp, selector, title) {
  const identityAttribute = titledButtonIdentityAttribute(selector)
  const clicked = await evaluateValue(
    cdp,
    `(() => {
      const element = Array.from(document.querySelectorAll(${JSON.stringify(selector)}))
        .find((candidate) => candidate.getAttribute(${JSON.stringify(identityAttribute)}) === ${JSON.stringify(title)})
      if (!(element instanceof HTMLButtonElement) || element.disabled) return false
      element.click()
      return true
    })()`
  )
  if (!clicked) fail('E_CLICK_TITLE')
}

async function clickTitledButtonWithFeedback(cdp, selector, title) {
  const identityAttribute = titledButtonIdentityAttribute(selector)
  await waitForExpression(
    cdp,
    `Array.from(document.querySelectorAll(${JSON.stringify(selector)})).some((candidate) =>
      candidate instanceof HTMLButtonElement &&
      candidate.getAttribute(${JSON.stringify(identityAttribute)}) === ${JSON.stringify(title)} &&
      !candidate.disabled
    )`,
    TIMEOUT.page,
    'E_CLICK_TITLE'
  )
  const observed = await evaluateValue(
    cdp,
    `new Promise((resolveClick) => {
      const element = Array.from(document.querySelectorAll(${JSON.stringify(selector)}))
        .find((candidate) => candidate.getAttribute(${JSON.stringify(identityAttribute)}) === ${JSON.stringify(title)})
      if (!(element instanceof HTMLButtonElement) || element.disabled) {
        resolveClick(false)
        return
      }
      let settled = false
      const finish = (value) => {
        if (settled) return
        settled = true
        observer.disconnect()
        clearTimeout(timer)
        resolveClick(value)
      }
      const feedbackVisible = () =>
        document.querySelector('.runtime-context-status[role="status"]') !== null ||
        element.getAttribute('aria-busy') === 'true'
      const observer = new MutationObserver(() => {
        if (feedbackVisible()) finish(true)
      })
      observer.observe(document.body, { attributes: true, childList: true, subtree: true })
      const timer = setTimeout(() => finish(false), 5_000)
      element.click()
      if (feedbackVisible()) finish(true)
    })`
  )
  return observed === true
}

async function waitForTitledSelection(cdp, selector, title, timeoutMs, code) {
  const identityAttribute = titledButtonIdentityAttribute(selector)
  const stateIdentityField = selector === '.project-select'
    ? 'activeProjectKey'
    : 'activeSessionKey'
  await waitForExpression(
    cdp,
    `window.piGui.getState().then((state) =>
      state[${JSON.stringify(stateIdentityField)}] === ${JSON.stringify(title)} &&
      Array.from(document.querySelectorAll(${JSON.stringify(selector)})).some((element) =>
        element.getAttribute(${JSON.stringify(identityAttribute)}) === ${JSON.stringify(title)} &&
        element.getAttribute('aria-current') === 'true'
      )
    )`,
    timeoutMs,
    code
  )
}

async function selectedTitledButton(cdp, selector) {
  const identityAttribute = titledButtonIdentityAttribute(selector)
  const title = await evaluateValue(
    cdp,
    `document.querySelector(${JSON.stringify(`${selector}[aria-current="true"]`)})?.getAttribute(${JSON.stringify(identityAttribute)}) ?? null`
  )
  return typeof title === 'string' && title.length > 0 ? title : null
}

async function latestParallelSubagentRun(cdp) {
  return evaluateValue(
    cdp,
    `window.piGui.getState().then((state) => {
      const runs = state.conversation.entries
        .filter((entry) => entry.kind === 'tool' && entry.name === 'subagent' && entry.subagent?.mode === 'parallel')
        .map((entry) => ({
          toolCallId: entry.toolCallId,
          toolStatus: entry.status,
          runtime: state.runtime.status,
          participants: entry.subagent.participants.map((participant) => ({
            index: participant.index,
            agent: participant.agent,
            status: participant.status,
            hasFinalOutput: typeof participant.finalOutput === 'string' && participant.finalOutput.length > 0
          }))
        }))
      return runs.at(-1) ?? null
    })`
  )
}

function subagentParticipantLookupExpression(locator) {
  return `Array.from(document.querySelectorAll('button.subagent-run-chip')).find((candidate) =>
    candidate.getAttribute('data-subagent-tool-call-id') === ${JSON.stringify(locator.toolCallId)} &&
    candidate.getAttribute('data-subagent-participant-index') === ${JSON.stringify(String(locator.participantIndex))}
  )`
}

async function openSubagentParticipant(cdp, locator) {
  const lookup = subagentParticipantLookupExpression(locator)
  await waitForExpression(cdp, `(${lookup}) !== undefined`, TIMEOUT.page, 'E_S19_CAPSULE_IDENTITY')
  const clicked = await evaluateValue(
    cdp,
    `(() => {
      const element = ${lookup}
      if (!(element instanceof HTMLButtonElement) || element.disabled) return false
      element.click()
      return true
    })()`
  )
  if (!clicked) fail('E_S19_CAPSULE_CLICK')
  await waitForExpression(
    cdp,
    `document.querySelector('.subagent-task-detail') !== null &&
     (${lookup})?.getAttribute('aria-pressed') === 'true'`,
    TIMEOUT.page,
    'E_S19_DETAIL_OPEN'
  )
}

async function waitForSubagentFocus(cdp, locator, code) {
  const lookup = subagentParticipantLookupExpression(locator)
  await waitForExpression(
    cdp,
    `(() => {
      const active = document.activeElement
      return active instanceof HTMLButtonElement && active === (${lookup})
    })()`,
    TIMEOUT.page,
    code
  )
}

async function niriWindowIds() {
  let output
  try {
    ;({ stdout: output } = await execFileAsync('niri', ['msg', '--json', 'windows'], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024
    }))
  } catch {
    fail('E_NIRI_WINDOWS')
  }
  let windows
  try {
    windows = JSON.parse(output)
  } catch {
    fail('E_NIRI_WINDOWS')
  }
  if (!Array.isArray(windows)) fail('E_NIRI_WINDOWS')
  return new Set(windows.map((window) => window?.id).filter(Number.isInteger))
}

async function waitForNewNiriWindow(existingWindowIds, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    let output
    try {
      ;({ stdout: output } = await execFileAsync('niri', ['msg', '--json', 'windows'], {
        encoding: 'utf8',
        maxBuffer: 1024 * 1024
      }))
      const windows = JSON.parse(output)
      const window = Array.isArray(windows)
        ? windows.find((candidate) =>
          Number.isInteger(candidate?.id) &&
          !existingWindowIds.has(candidate.id) &&
          candidate.app_id === packageJson.build.appId
        )
        : null
      if (window) return window.id
    } catch {
      // Niri may not publish the new surface during the first few renderer frames.
    }
    await delay(100)
  }
  fail('E_NIRI_WINDOW')
}

async function setAppWindowSize(app, cdp, width, height) {
  if (!Number.isInteger(app?.windowId)) fail('E_NIRI_WINDOW')
  try {
    await execFileAsync('niri', ['msg', 'action', 'focus-window', '--id', String(app.windowId)])
    await execFileAsync('niri', ['msg', 'action', 'set-window-width', '--id', String(app.windowId), String(width)])
    await execFileAsync('niri', ['msg', 'action', 'set-window-height', '--id', String(app.windowId), String(height)])
  } catch {
    fail('E_NIRI_WINDOW_SIZE')
  }
  await waitForExpression(
    cdp,
    `window.innerWidth === ${width} && window.innerHeight === ${height}`,
    TIMEOUT.page,
    'E_NIRI_WINDOW_SIZE'
  )
}

async function focusComposer(cdp) {
  const focused = await evaluateValue(
    cdp,
    `(() => {
      const input = document.querySelector('textarea[aria-label="发送给 Pi 的任务"]')
      if (!(input instanceof HTMLTextAreaElement) || input.disabled) return false
      input.focus()
      return document.activeElement === input
    })()`
  )
  if (!focused) fail('E_COMPOSER_FOCUS')
}

async function waitForComposerFocus(cdp) {
  await waitForExpression(
    cdp,
    `(() => {
      const input = document.querySelector('textarea[aria-label="发送给 Pi 的任务"]')
      return input instanceof HTMLTextAreaElement && !input.disabled && document.activeElement === input
    })()`,
    TIMEOUT.page,
    'E_P2_COMPOSER_FOCUS'
  )
}

async function insertText(cdp, text) {
  await cdp.send('Input.insertText', { text })
}

async function dispatchKey(cdp, key, code, modifiers = 0) {
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, modifiers })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, modifiers })
}

async function clearComposer(cdp) {
  const cleared = await evaluateValue(
    cdp,
    `(() => {
      const input = document.querySelector('textarea[aria-label="发送给 Pi 的任务"]')
      if (!(input instanceof HTMLTextAreaElement) || input.disabled) return false
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      if (setter === undefined) return false
      setter.call(input, '')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.focus()
      return true
    })()`
  )
  if (!cleared) fail('E_COMPOSER_CLEAR')
  await waitForExpression(
    cdp,
    `document.querySelector('textarea[aria-label="发送给 Pi 的任务"]')?.value === ''`,
    TIMEOUT.page,
    'E_COMPOSER_CLEAR'
  )
}

async function availableThinkingLevelFromGui(cdp) {
  await openThinkingOptions(cdp)
  const level = await evaluateValue(
    cdp,
    `window.piGui.getState().then((state) => {
      const labelToLevel = Object.fromEntries(
        Object.entries(${JSON.stringify(THINKING_LEVEL_LABELS)})
          .map(([thinkingLevel, label]) => [label, thinkingLevel])
      )
      return Array.from(document.querySelectorAll('#model-picker-popover .model-picker-thinking-list .model-picker-item:not(:disabled)'))
        .map((button) => labelToLevel[button.querySelector('.model-picker-option-label')?.textContent?.trim() ?? ''])
        .find((value) =>
          ['low', 'medium', 'high', 'xhigh', 'max'].includes(value) &&
          value !== state.session.thinkingLevel
        ) ?? null
    })`
  )
  await evaluateValue(
    cdp,
    `document.querySelector('.model-picker-button')?.click()`
  )
  if (typeof level !== 'string') fail('E_P2_TYPED_COMMAND_PRECONDITION')
  return level
}

async function selectThinkingLevelFromGui(cdp, level) {
  const label = THINKING_LEVEL_LABELS[level]
  if (typeof label !== 'string') fail('E_P2_TYPED_COMMAND_PRECONDITION')
  await openThinkingOptions(cdp)
  const selected = await evaluateValue(
    cdp,
    `(() => {
      const button = Array.from(document.querySelectorAll('#model-picker-popover .model-picker-thinking-list .model-picker-item:not(:disabled)'))
        .find((candidate) => candidate.querySelector('.model-picker-option-label')?.textContent?.trim() === ${JSON.stringify(label)})
      if (!(button instanceof HTMLButtonElement)) return false
      button.click()
      return true
    })()`
  )
  if (!selected) fail('E_P2_TYPED_COMMAND_PRECONDITION')
  await waitForExpression(
    cdp,
    `window.piGui.getState().then((state) => state.session.thinkingLevel === ${JSON.stringify(level)})`,
    TIMEOUT.page,
    'E_THINKING_LEVEL'
  )
}

async function openThinkingOptions(cdp) {
  const pickerOpened = await evaluateValue(
    cdp,
    `(() => {
      if (document.querySelector('#model-picker-popover .model-picker-thinking-section') !== null) {
        return true
      }
      const button = document.querySelector('.model-picker-button')
      if (!(button instanceof HTMLElement)) return false
      button.click()
      return true
    })()`
  )
  if (!pickerOpened) fail('E_P2_TYPED_COMMAND_PRECONDITION')
  await waitForExpression(
    cdp,
    `document.querySelector('#model-picker-popover .model-picker-thinking-section') !== null`,
    TIMEOUT.page,
    'E_P2_THINKING_OPTIONS'
  )
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
  const editableCondition = status === 'ready'
    ? ` && (() => {
        const input = document.querySelector('textarea[aria-label="发送给 Pi 的任务"]')
        return input instanceof HTMLTextAreaElement && !input.disabled
      })()`
    : ''
  await waitForExpression(
    cdp,
    `window.piGui.getState().then((state) =>
      state.runtime.status === ${JSON.stringify(status)}${editableCondition}
    )`,
    timeoutMs,
    'E_RUNTIME_STATUS'
  )
}

async function waitForAssistantSettled(cdp, baseline, timeoutMs) {
  await waitForCondition(
    async () => (
      await evaluateValue(cdp, `window.piGui.getState().then((state) => state.runtime.status === 'ready')`)
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
        .connection-status-warning,
        .subagent-task-detail-activity dd,
        .subagent-task-final-output,
        .subagent-task-detail-error {
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
        .process-step-text,
        .subagent-run-chip-label,
        .subagent-task-detail-heading h2 {
          font-size: 0 !important;
        }
        .chronological-activity-text::after,
        .process-step-text::after {
          content: '步骤内容已脱敏';
          font-size: 12px;
        }
        .subagent-run-chip-label::after {
          content: 'Subagent';
          font-size: 12px;
        }
        .subagent-task-detail-heading h2::after {
          content: '任务已脱敏';
          font-size: 14px;
        }
        .session-title,
        .workbench-session-title,
        .conversation-header > strong {
          font-size: 0 !important;
        }
        .session-title::after,
        .workbench-session-title::after,
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
    screenshotFiles.push(filename)
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

async function installMemoryEventProbe(cdp) {
  if (!MEMORY_DIAGNOSTICS_ENABLED) return
  const installed = await evaluateValue(
    cdp,
    `(() => {
      if (globalThis.__PI_GUI_MEMORY_EVENT_PROBE__ !== undefined) return true
      const metrics = {
        fullStateEvents: 0,
        patchEvents: 0,
        compactionEvents: 0,
        otherEvents: 0,
        latestStateEntries: 0,
        patchRuntime: 0,
        patchSession: 0,
        patchConversation: 0,
        appendedChars: 0,
        insertedPayloadChars: 0,
        entryPatches: {
          insert: 0,
          appendMessageText: 0,
          appendThinkingText: 0,
          appendToolOutput: 0
        }
      }
      const stringChars = (value, visited = new Set()) => {
        if (typeof value === 'string') return value.length
        if (value === null || typeof value !== 'object' || visited.has(value)) return 0
        visited.add(value)
        let chars = 0
        if (Array.isArray(value)) {
          for (const item of value) chars += stringChars(item, visited)
        } else {
          for (const item of Object.values(value)) chars += stringChars(item, visited)
        }
        return chars
      }
      const unsubscribe = window.piGui.subscribe((event) => {
        if (event.type === 'kernel.state-changed') {
          metrics.fullStateEvents += 1
          metrics.latestStateEntries = event.state.conversation.entries.length
          return
        }
        if (event.type === 'kernel.state-patched') {
          metrics.patchEvents += 1
          if (event.patch.runtime !== undefined) metrics.patchRuntime += 1
          if (event.patch.session !== undefined) metrics.patchSession += 1
          if (event.patch.conversation === undefined) return
          metrics.patchConversation += 1
          for (const patch of event.patch.conversation.entries ?? []) {
            if (patch.type === 'insert') {
              metrics.entryPatches.insert += 1
              metrics.insertedPayloadChars += stringChars(patch.entry)
            } else if (patch.type === 'append-message-text') {
              metrics.entryPatches.appendMessageText += 1
              metrics.appendedChars += patch.text.length
            } else if (patch.type === 'append-thinking-text') {
              metrics.entryPatches.appendThinkingText += 1
              metrics.appendedChars += patch.text.length
            } else if (patch.type === 'append-tool-output') {
              metrics.entryPatches.appendToolOutput += 1
              metrics.appendedChars += patch.output.length + patch.details.length
            }
          }
          return
        }
        if (event.type === 'kernel.compaction-started' || event.type === 'kernel.compaction-ended') {
          metrics.compactionEvents += 1
        } else {
          metrics.otherEvents += 1
        }
      })
      Object.defineProperty(globalThis, '__PI_GUI_MEMORY_EVENT_PROBE__', {
        value: { metrics, unsubscribe },
        configurable: true
      })
      return true
    })()`
  )
  if (installed !== true) fail('E_MEMORY_EVENT_PROBE')
}

async function captureMemorySample(label) {
  if (!MEMORY_DIAGNOSTICS_ENABLED || activeApp === null || activeCdp === null) return
  if (memoryDiagnostics.samples.length >= MEMORY_DIAGNOSTICS_SAMPLE_LIMIT) return
  const rootPid = activeApp.rootPid
  if (!Number.isInteger(rootPid)) return

  await observeTree(activeApp)
  const pids = [rootPid, ...await descendantPids(rootPid)]
  const records = (await Promise.all(
    pids.map((pid) => readLinuxProcessMemory(pid, rootPid))
  )).filter((record) => record !== null)
  const recordsByPid = new Map(records.map((record) => [record.pid, record]))
  for (const record of records) {
    if (record.baseRole !== 'pi') continue
    record.role = hasPiAncestor(record, recordsByPid) ? 'pi-child' : 'pi-runtime'
  }

  const roles = {}
  const totals = emptyMemoryTotals()
  for (const record of records) {
    const summary = roles[record.role] ?? { processes: 0, ...emptyMemoryTotals() }
    summary.processes += 1
    addMemoryTotals(summary, record.memory)
    roles[record.role] = summary
    addMemoryTotals(totals, record.memory)
  }

  const [rendererState, rendererHeap, rendererDom, rendererEvents] = await Promise.all([
    evaluateValue(
      activeCdp,
      `window.piGui.getState().then((state) => {
        const utf8Bytes = (text) => {
          let bytes = 0
          for (let index = 0; index < text.length; index += 1) {
            const code = text.charCodeAt(index)
            if (code <= 0x7f) bytes += 1
            else if (code <= 0x7ff) bytes += 2
            else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length &&
              text.charCodeAt(index + 1) >= 0xdc00 && text.charCodeAt(index + 1) <= 0xdfff) {
              bytes += 4
              index += 1
            } else bytes += 3
          }
          return bytes
        }
        const bytes = (value) => utf8Bytes(JSON.stringify(value))
        const kinds = {}
        for (const entry of state.conversation.entries) {
          kinds[entry.kind] = (kinds[entry.kind] ?? 0) + 1
        }
        return {
          stateJsonBytes: bytes(state),
          conversationJsonBytes: bytes(state.conversation),
          navigationJsonBytes: bytes({ projects: state.projects, sessions: state.sessions }),
          entries: state.conversation.entries.length,
          entryKinds: kinds,
          projects: state.projects.length,
          sessions: state.sessions.length,
          runtimeStatus: state.runtime.status,
          domElements: document.getElementsByTagName('*').length,
          bodyTextChars: document.body.innerText.length
        }
      })`
    ).catch(() => null),
    activeCdp.send('Runtime.getHeapUsage').catch(() => null),
    activeCdp.send('Memory.getDOMCounters').catch(() => null),
    evaluateValue(
      activeCdp,
      `(() => {
        const metrics = globalThis.__PI_GUI_MEMORY_EVENT_PROBE__?.metrics
        if (metrics === undefined) return null
        return {
          ...metrics,
          entryPatches: { ...metrics.entryPatches }
        }
      })()`
    ).catch(() => null)
  ])

  memoryDiagnostics.samples.push({
    label,
    capturedAt: new Date().toISOString(),
    elapsedMs: Date.now() - Date.parse(STARTED_AT),
    processCount: records.length,
    totals,
    roles,
    renderer: {
      state: rendererState,
      heap: rendererHeap,
      dom: rendererDom,
      events: rendererEvents
    }
  })
}

function hasPiAncestor(record, recordsByPid) {
  const visited = new Set([record.pid])
  let parent = recordsByPid.get(record.ppid)
  while (parent !== undefined && !visited.has(parent.pid)) {
    if (parent.baseRole === 'pi') return true
    visited.add(parent.pid)
    parent = recordsByPid.get(parent.ppid)
  }
  return false
}

async function readLinuxProcessMemory(pid, rootPid) {
  try {
    const [smaps, status, command, commandLine] = await Promise.all([
      readFile(`/proc/${pid}/smaps_rollup`, 'utf8'),
      readFile(`/proc/${pid}/status`, 'utf8'),
      readFile(`/proc/${pid}/comm`, 'utf8'),
      readFile(`/proc/${pid}/cmdline`)
    ])
    const ppid = Number(/^PPid:\s+(\d+)$/m.exec(status)?.[1] ?? 0)
    const comm = command.trim()
    const argv = commandLine.toString('utf8').replaceAll('\0', ' ')
    let role = 'other'
    if (comm === 'pi') role = 'pi'
    else if (argv.includes('--type=renderer')) role = 'renderer'
    else if (argv.includes('--type=gpu-process')) role = 'gpu'
    else if (argv.includes('--type=utility')) role = 'utility'
    else if (argv.includes('--type=zygote')) role = 'zygote'
    else if (pid === rootPid) role = 'app-root'
    else if (comm.includes('pi-gui') || argv.includes('pi-gui-next')) role = 'electron-main'
    return {
      pid,
      ppid,
      role,
      baseRole: role,
      memory: {
        rssBytes: smapsBytes(smaps, 'Rss'),
        pssBytes: smapsBytes(smaps, 'Pss'),
        privateBytes: smapsBytes(smaps, 'Private_Clean') + smapsBytes(smaps, 'Private_Dirty'),
        anonymousBytes: smapsBytes(smaps, 'Anonymous'),
        swapBytes: smapsBytes(smaps, 'Swap')
      }
    }
  } catch {
    return null
  }
}

function smapsBytes(text, field) {
  const value = Number(new RegExp(`^${field}:\\s+(\\d+)\\s+kB$`, 'm').exec(text)?.[1] ?? 0)
  return Number.isFinite(value) ? value * 1024 : 0
}

function emptyMemoryTotals() {
  return {
    rssBytes: 0,
    pssBytes: 0,
    privateBytes: 0,
    anonymousBytes: 0,
    swapBytes: 0
  }
}

function addMemoryTotals(target, value) {
  target.rssBytes += value.rssBytes
  target.pssBytes += value.pssBytes
  target.privateBytes += value.privateBytes
  target.anonymousBytes += value.anonymousBytes
  target.swapBytes += value.swapBytes
}

function memoryDiagnosticsReport() {
  if (!MEMORY_DIAGNOSTICS_ENABLED) return { enabled: false }
  const maxima = {
    processCount: 0,
    totalPssBytes: 0,
    rendererPssBytes: 0,
    piRuntimeProcesses: 0,
    piChildProcesses: 0,
    piPssBytes: 0,
    rendererHeapUsedBytes: 0,
    rendererStateJsonBytes: 0,
    rendererFullStateEvents: 0,
    rendererPatchEvents: 0
  }
  for (const sample of memoryDiagnostics.samples) {
    maxima.processCount = Math.max(maxima.processCount, sample.processCount)
    maxima.totalPssBytes = Math.max(maxima.totalPssBytes, sample.totals.pssBytes)
    maxima.rendererPssBytes = Math.max(
      maxima.rendererPssBytes,
      sample.roles.renderer?.pssBytes ?? 0
    )
    maxima.piRuntimeProcesses = Math.max(
      maxima.piRuntimeProcesses,
      sample.roles['pi-runtime']?.processes ?? 0
    )
    maxima.piChildProcesses = Math.max(
      maxima.piChildProcesses,
      sample.roles['pi-child']?.processes ?? 0
    )
    maxima.piPssBytes = Math.max(
      maxima.piPssBytes,
      (sample.roles['pi-runtime']?.pssBytes ?? 0) + (sample.roles['pi-child']?.pssBytes ?? 0)
    )
    maxima.rendererHeapUsedBytes = Math.max(
      maxima.rendererHeapUsedBytes,
      sample.renderer.heap?.usedSize ?? 0
    )
    maxima.rendererStateJsonBytes = Math.max(
      maxima.rendererStateJsonBytes,
      sample.renderer.state?.stateJsonBytes ?? 0
    )
    maxima.rendererFullStateEvents = Math.max(
      maxima.rendererFullStateEvents,
      sample.renderer.events?.fullStateEvents ?? 0
    )
    maxima.rendererPatchEvents = Math.max(
      maxima.rendererPatchEvents,
      sample.renderer.events?.patchEvents ?? 0
    )
  }
  return {
    enabled: true,
    redacted: true,
    units: 'bytes',
    sampleLimit: MEMORY_DIAGNOSTICS_SAMPLE_LIMIT,
    maxima,
    samples: memoryDiagnostics.samples
  }
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
            const [processName, cwd] = await Promise.all([
              readFile(`/proc/${pid}/comm`, 'utf8'),
              realpath(`/proc/${pid}/cwd`)
            ])
            return cwd === projectPath &&
              processName.trim() === 'pi'
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

async function piProcessesForConfiguredProjects() {
  const entries = await readdir('/proc', { withFileTypes: true })
  return (await Promise.all(
    entries
      .filter((entry) => /^\d+$/.test(entry.name))
      .map(async (entry) => {
        const pid = Number(entry.name)
        try {
          const [processName, cwd] = await Promise.all([
            readFile(`/proc/${pid}/comm`, 'utf8'),
            realpath(`/proc/${pid}/cwd`)
          ])
          return processName.trim() === 'pi' && projectPaths.includes(cwd)
            ? { pid, cwd }
            : null
        } catch {
          return null
        }
      })
  )).filter((process) => process !== null)
}

async function assertConfiguredProjectRuntimeCounts(expectedCounts) {
  if (
    expectedCounts.size !== projectPaths.length ||
    projectPaths.some((projectPath) => !Number.isInteger(expectedCounts.get(projectPath)))
  ) {
    fail('E_P2_RUNTIME_OWNERSHIP_EXPECTATION')
  }
  const processes = await piProcessesForConfiguredProjects()
  const actualCounts = new Map(projectPaths.map((projectPath) => [projectPath, 0]))
  for (const process of processes) {
    activeApp.knownPids.add(process.pid)
    actualCounts.set(process.cwd, actualCounts.get(process.cwd) + 1)
  }
  if (projectPaths.some(
    (projectPath) => actualCounts.get(projectPath) !== expectedCounts.get(projectPath)
  )) {
    fail('E_P2_RUNTIME_OWNERSHIP')
  }
}

async function readRecentSessionPointer(projectPath) {
  let state
  try {
    state = JSON.parse(
      await readFile(join(temporaryRoot, 'state', 'pi-gui-next', 'state.json'), 'utf8')
    )
  } catch {
    fail('E_SESSION_POINTER')
  }
  if (
    typeof state !== 'object' ||
    state === null ||
    state.version !== 6 ||
    !Array.isArray(state.sessions) ||
    !Array.isArray(state.activeSessionKeys) ||
    !Array.isArray(state.archivedSessionKeys)
  ) {
    fail('E_SESSION_POINTER')
  }
  const activeSessionKey = state.activeSessionKeys.find(
    (selection) => selection?.projectPath === projectPath
  )?.sessionKey
  const value = state.sessions.find(
    (pointer) => pointer?.projectPath === projectPath && pointer.sessionFile === activeSessionKey
  )
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
    schemaVersion: 2,
    verification: 'P2/S13/S19 AppImage real UI',
    phase: 'P2/S19',
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
    memoryDiagnostics: memoryDiagnosticsReport(),
    p2Summary,
    s19Summary,
    evidence: {
      screenshotTextRedacted: true,
      screenshots: [...screenshotFiles]
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
