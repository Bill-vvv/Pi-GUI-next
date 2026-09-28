import { spawnSync, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, copyFileSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build, Platform, Arch } from 'electron-builder'
import { readBuildIdentityFile, verifyBuildArtifacts, sourceBuildDigest } from '../src/main/build-identity.ts'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Build the Windows + WSL installer with Windows x64 Node.')
if (process.versions.node !== pkg.engines.node) throw new Error(`Use Node ${pkg.engines.node}.`)
const electronDist = join(dirname(createRequire(import.meta.url).resolve('electron/package.json')), 'dist')
if (readFileSync(join(electronDist, 'version'), 'utf8').trim() !== pkg.devDependencies.electron) throw new Error('Install the pinned Windows Electron binary before packaging.')
const version = process.argv[2] ?? `${pkg.version}-wsl.${new Date().toISOString().slice(0, 10).replaceAll('-', '')}`
if (!/^\d+\.\d+\.\d+-wsl\.\d{8}(?:\.\d+)?$/u.test(version)) throw new Error('Use a preview version such as 0.0.1-wsl.20260928.')

const result = spawnSync(process.execPath, ['scripts/build.mjs'], { cwd: root, stdio: 'inherit' })
if (result.error) throw result.error
if (result.status !== 0) process.exit(result.status ?? 1)
const identity = readBuildIdentityFile(join(root, 'out/main/build-identity.json'))
if (identity === null) throw new Error('Build manifest is missing.')
verifyBuildArtifacts(root, identity)
const output = join(root, 'release')
mkdirSync(output, { recursive: true })
const payload = mkdtempSync(join(output, 'wsl-payload-'))
try {
  execFileSync('tar.exe', [
    '-cf', join(payload, 'backend.tar'), '--exclude=node_modules', '--exclude=.git', '-C', root,
    'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'out', 'extensions',
    'scripts/verify-build.mjs', 'scripts/start-wsl-host.sh', 'src/main/build-identity.ts'
  ], { cwd: root, stdio: 'inherit' })
  for (const file of ['setup-wsl-host.sh', 'install-wsl-backend.ps1']) copyFileSync(join(root, 'scripts', file), join(payload, file))
  const artifacts = await build({
    projectDir: root,
    targets: Platform.WINDOWS.createTarget(['nsis'], Arch.x64),
    publish: 'never',
    config: {
      electronDist,
      extraMetadata: { version },
      extraResources: [{ from: payload, to: 'wsl' }],
      nsis: { include: join(root, 'scripts/installer-wsl.nsh'), oneClick: false, perMachine: false, allowElevation: false },
      win: { artifactName: 'pi-gui-next-${version}-win-${arch}-setup.${ext}' }
    }
  })
  const installer = artifacts.find((path) => path.endsWith('-setup.exe'))
  if (!installer) throw new Error('Windows installer was not produced.')
  if (sourceBuildDigest(root) !== identity.sourceDigest) throw new Error('Source changed during packaging. Rebuild the installer.')
  const sha256 = createHash('sha256').update(readFileSync(installer)).digest('hex')
  writeFileSync(`${installer}.sha256`, `${sha256}  ${installer.split(/[\\/]/u).at(-1)}\n`)
  writeFileSync(`${installer}.json`, `${JSON.stringify({
    version, builtAt: new Date().toISOString(), sha256, buildIdentity: identity,
    platform: 'win32-x64', backend: 'Ubuntu-24.04 (WSL2 x86_64)',
    channel: 'local-preview', signed: false
  }, null, 2)}\n`)
  console.log(`Windows + WSL installer: ${installer}\nSHA-256: ${sha256}`)
} finally {
  rmSync(payload, { recursive: true, force: true })
}
