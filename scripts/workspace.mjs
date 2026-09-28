import { createHash } from 'node:crypto'
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, rmSync, realpathSync, chmodSync, statSync } from 'node:fs'
import { dirname, join, resolve, isAbsolute } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { workspaceSuffix, canReuseBuild } from './workspace-cache.mjs'

const source = dirname(dirname(fileURLToPath(import.meta.url)))
const command = process.argv[2]
if (command === 'doctor' && process.argv.length === 3) {
  await import('./doctor.mjs')
  process.exit(process.exitCode ?? 0)
}
const scripts = { typecheck: 'typecheck', test: 'test:core', 'test-platform': 'test:platform', build: 'build', dev: 'dev', start: null, wsl: null }
if (!Object.hasOwn(scripts, command) || process.argv.length !== 3) throw new Error('Usage: node scripts/workspace.mjs doctor|typecheck|test|test-platform|build|dev|start|wsl')
if (command === 'wsl' && process.platform !== 'win32') throw new Error('Run the wsl command with Windows Node; it starts the Windows desktop client.')
if (command === 'test' && process.platform !== 'linux') throw new Error('The full core suite contains Linux Host fixtures. Run test from WSL/Linux; use test-platform on Windows.')
const pkg = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'))
if (process.versions.node !== pkg.engines.node) throw new Error(`Use Node ${pkg.engines.node} for this workspace (current: ${process.versions.node}).`)
const key = createHash('sha256').update(source).digest('hex').slice(0, 16)
// Keep Windows junction targets short and outside MSIX-redirected LocalAppData.
const cache = process.platform === 'win32' ? join(homedir(), '.cache') : process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache')
if (!cache || !isAbsolute(cache)) throw new Error('An absolute local cache directory is required.')
const workspace = join(cache, 'pi-gui-next', 'development', `${process.platform}-${key}${workspaceSuffix(command)}`)
mkdirSync(workspace, { recursive: true })
const lock = join(workspace, '.workspace-lock')
try { writeFileSync(lock, `${process.pid}\n`, { flag: 'wx' }) } catch (error) {
  if (error.code !== 'EEXIST') throw error
  throw new Error(`Development workspace is in use: ${workspace}. If its process has exited, remove ${lock}.`)
}

async function run(executable, args, env, synchronize) {
  const child = spawn(executable, args, { cwd: workspace, env, stdio: 'inherit' })
  let timer
  let syncError
  if (synchronize) timer = setInterval(() => {
    try { synchronize() } catch (error) { syncError = error; child.kill('SIGTERM') }
  }, 1_000)
  const interrupt = () => child.kill('SIGINT')
  process.once('SIGINT', interrupt)
  process.once('SIGTERM', interrupt)
  try {
    await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code, signal) => {
        if (syncError) reject(syncError)
        else if (code === 0 || signal === 'SIGINT') resolve()
        else reject(new Error(`${executable} failed (${code ?? signal}).`))
      })
    })
  } finally {
    clearInterval(timer)
    process.off('SIGINT', interrupt)
    process.off('SIGTERM', interrupt)
  }
}

function pnpm(script, env, synchronize) {
  // Only fixed commands from the allowlist above enter the Windows command shell.
  const args = script === 'install' ? ['install', '--frozen-lockfile'] : ['run', script]
  if (process.platform === 'win32') return run(process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe', ['/d', '/c', `pnpm ${args.join(' ')}`], env, synchronize)
  return run('pnpm', args, env, synchronize)
}

const sourceStamps = new Map()
function synchronizeSource() {
  const started = performance.now()
  let changed = 0
  const files = execFileSync('git', ['-C', source, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
    .split('\0').filter((file) => file && existsSync(join(source, file)))
  const safePath = (file) => typeof file === 'string' && !isAbsolute(file) && !file.split(/[\\/]/u).some((part) => part === '..' || part === '.git' || part === 'node_modules' || part === '')
  if (!files.every(safePath)) throw new Error('Source contains an unsupported workspace path.')
  const previousList = join(workspace, '.source-files.json')
  const previous = existsSync(previousList) ? JSON.parse(readFileSync(previousList, 'utf8')) : []
  if (!Array.isArray(previous) || !previous.every(safePath)) throw new Error('Invalid previous workspace file inventory.')
  const current = new Set(files)
  for (const file of previous) if (!current.has(file)) {
    rmSync(join(workspace, file), { force: true })
    sourceStamps.delete(file)
    changed += 1
  }
  for (const file of files) {
    const target = join(workspace, file)
    const info = statSync(join(source, file), { bigint: true })
    const stamp = `${info.size}:${info.mtimeNs}:${info.ctimeNs}:${info.mode}`
    if (sourceStamps.get(file) === stamp && existsSync(target)) continue
    const data = readFileSync(join(source, file))
    sourceStamps.set(file, stamp)
    if (existsSync(target) && readFileSync(target).equals(data)) {
      if (process.platform !== 'win32' && (statSync(target).mode & 0o777) !== (Number(info.mode) & 0o777)) {
        chmodSync(target, Number(info.mode) & 0o777)
        changed += 1
      }
      continue
    }
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, data)
    changed += 1
    if (process.platform !== 'win32') chmodSync(target, Number(info.mode) & 0o777)
  }
  writeFileSync(previousList, JSON.stringify(files))
  return { files: files.length, changed, durationMs: Math.round(performance.now() - started) }
}

try {
  console.log(`Source synchronization: ${JSON.stringify(synchronizeSource())}`)
  const env = { ...process.env, PI_GUI_SOURCE_COMMIT: execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() }
  const dependencyKey = createHash('sha256').update(`${process.platform}:${process.versions.node}`).update(readFileSync(join(workspace, 'package.json')))
    .update(readFileSync(join(workspace, 'pnpm-lock.yaml'))).update(readFileSync(join(workspace, 'pnpm-workspace.yaml'))).digest('hex')
  const installed = join(workspace, '.dependencies-key')
  console.log(`Source: ${source}\nDevelopment workspace: ${workspace}`)
  if (!existsSync(installed) || readFileSync(installed, 'utf8') !== dependencyKey || !existsSync(join(workspace, 'node_modules'))) {
    await pnpm('install', env)
    writeFileSync(installed, dependencyKey)
  }
  if (command === 'test') env.PI_GUI_TEST_PI_PACKAGE_ROOT = realpathSync(join(workspace, 'node_modules/@earendil-works/pi-coding-agent'))
  if (command === 'start' || command === 'wsl') {
    if (canReuseBuild(workspace)) console.log('Reusing verified build; source is unchanged.')
    else await pnpm('build', env)
  }
  if (command === 'wsl') {
    const powershell = join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    await run(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(workspace, 'scripts/setup-wsl.ps1'), '-SkipBuild'], env)
    await run(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(workspace, 'scripts/start-wsl.ps1')], env)
  } else if (command === 'start') {
    await run(process.execPath, [join(workspace, 'node_modules/electron/cli.js'), '.'], env)
  } else await pnpm(scripts[command], env, command === 'dev' ? () => {
    for (const file of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']) {
      if (!readFileSync(join(source, file)).equals(readFileSync(join(workspace, file)))) {
        throw new Error('Dependencies changed. Restart the workspace dev command to install the new dependency snapshot.')
      }
    }
    const result = synchronizeSource()
    if (result.changed > 0) console.log(`Source synchronization: ${JSON.stringify(result)}`)
  } : undefined)
} finally {
  unlinkSync(lock)
}
