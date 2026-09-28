import { spawnSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const checks = []
function check(name, executable, args, required = true) {
  const result = spawnSync(executable, args, { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10_000, maxBuffer: 64 * 1024 })
  const value = { name, required, ok: result.status === 0 && !result.error, detail: (result.error?.message ?? (result.status === 0 ? result.stdout : result.stderr)).trim() }
  checks.push(value)
  return value
}
checks.push({ name: 'Node', required: true, ok: process.versions.node === pkg.engines.node, detail: `${process.versions.node}; required ${pkg.engines.node}; ${process.execPath}` })
// Locate the package-manager shim without triggering Corepack downloads or installation.
check('pnpm launcher', process.platform === 'win32' ? 'where.exe' : 'sh', process.platform === 'win32' ? ['pnpm.cmd'] : ['-c', 'command -v pnpm'])
const git = check('Git', 'git', ['--version'])
if (git.ok) {
  const capability = check('Git bounded refs', 'git', ['for-each-ref', '--count=1', '--format=%(refname)%00%(symref)', 'refs/remotes/'])
  if (capability.ok) capability.detail = 'Bounded remote-tracking enumeration available (no start-after dependency).'
}
if (process.platform === 'win32') {
  const ssh = join(process.env.SystemRoot, 'System32/OpenSSH/ssh.exe')
  checks.push({ name: 'SSH client', required: false, ok: existsSync(ssh), detail: ssh })
  check('WSL default backend', 'wsl.exe', ['-d', 'Ubuntu-24.04', '--exec', 'sh', '-c', 'set -eu; git --version; base="${XDG_DATA_HOME:-$HOME/.local/share}/pi-gui-next-wsl"; if [ -L "$base/current" ]; then printf "Release: "; readlink "$base/current"; else printf "Backend not installed; run workspace wsl.\\n"; fi'], false)
} else if (process.platform === 'linux') {
  for (const executable of ['sh', 'tar', 'flock', 'unzip', 'curl']) {
    check(executable, 'sh', ['-c', 'command -v "$1"', 'doctor', executable])
  }
}
console.log(JSON.stringify({ platform: process.platform, source: root, checks }, null, 2))
if (checks.some((entry) => entry.required && !entry.ok)) process.exitCode = 1
