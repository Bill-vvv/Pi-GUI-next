import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { PiProjectTrust } from './pi-project-trust.ts'

test('uses only the exact Pi root export and isolates inherited and persisted trust', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-project-trust-'))
  t.after(async () => rm(root, { recursive: true, force: true }))
  const packageRoot = join(root, 'package')
  const dist = join(packageRoot, 'dist')
  const agentDir = join(root, 'agent')
  const parentProject = join(root, 'workspace')
  const childProject = join(parentProject, 'child')
  await mkdir(join(childProject, '.pi'), { recursive: true })
  await mkdir(dist, { recursive: true })
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
    type: 'module',
    version: '0.83.0',
    exports: { '.': { import: './dist/index.js' } }
  }))
  await writeFile(join(dist, 'cli.js'), `#!/usr/bin/env node
if (process.argv[2] === '--version') process.stdout.write('0.83.0\\n')
`, { mode: 0o755 })
  await writeFile(join(dist, 'index.js'), `
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
export function hasTrustRequiringProjectResources(cwd) {
  return existsSync(join(cwd, '.pi'))
}
export class ProjectTrustStore {
  constructor(agentDir) { this.path = join(agentDir, 'trust.json') }
  entries() {
    try { return JSON.parse(readFileSync(this.path, 'utf8')) } catch { return [] }
  }
  getEntry(cwd) {
    let current = cwd
    const entries = this.entries()
    for (;;) {
      const found = entries.find((entry) => entry.path === current)
      if (found) return found
      const parent = dirname(current)
      if (parent === current) return null
      current = parent
    }
  }
  set(cwd, decision) {
    const entries = this.entries().filter((entry) => entry.path !== cwd)
    entries.push({ path: cwd, decision })
    mkdirSync(dirname(this.path), { recursive: true })
    writeFileSync(this.path, JSON.stringify(entries))
  }
}
`)

  const service = new PiProjectTrust({
    agentDir,
    explicitExecutable: join(dist, 'cli.js')
  })
  assert.deepEqual(await service.inspect(childProject), {
    requiresDecision: true,
    decision: null
  })
  await service.persist(parentProject, false)
  assert.deepEqual(await service.inspect(childProject), {
    requiresDecision: true,
    decision: false
  })
  assert.deepEqual(JSON.parse(await readFile(join(agentDir, 'trust.json'), 'utf8')), [{
    path: parentProject,
    decision: false
  }])
})

test('fails fast when the exact package root import export is missing', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-project-trust-export-'))
  t.after(async () => rm(root, { recursive: true, force: true }))
  const dist = join(root, 'dist')
  const project = join(root, 'project')
  await mkdir(dist, { recursive: true })
  await mkdir(project)
  await writeFile(join(root, 'package.json'), JSON.stringify({
    version: '0.83.0',
    exports: { './private': './dist/index.js' }
  }))
  await writeFile(join(dist, 'cli.js'), `#!/usr/bin/env node
if (process.argv[2] === '--version') process.stdout.write('0.83.0\\n')
`, { mode: 0o755 })
  const service = new PiProjectTrust({
    agentDir: join(root, 'agent'),
    explicitExecutable: join(dist, 'cli.js')
  })

  await assert.rejects(service.inspect(project), /root export/)
})

test('fails fast when the package root import export is a symlink outside the package', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-project-trust-symlink-'))
  t.after(async () => rm(root, { recursive: true, force: true }))
  const packageRoot = join(root, 'package')
  const dist = join(packageRoot, 'dist')
  const outside = join(root, 'outside')
  const project = join(root, 'project')
  await mkdir(dist, { recursive: true })
  await mkdir(outside)
  await mkdir(project)
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
    type: 'module',
    version: '0.83.0',
    exports: { '.': { import: './dist/index.js' } }
  }))
  await writeFile(join(dist, 'cli.js'), `#!/usr/bin/env node
if (process.argv[2] === '--version') process.stdout.write('0.83.0\\n')
`, { mode: 0o755 })
  await writeFile(join(outside, 'index.js'), `
export function hasTrustRequiringProjectResources() { return false }
export class ProjectTrustStore {}
`)
  await symlink(join(outside, 'index.js'), join(dist, 'index.js'))
  const service = new PiProjectTrust({
    agentDir: join(root, 'agent'),
    explicitExecutable: join(dist, 'cli.js')
  })

  await assert.rejects(service.inspect(project), /outside its package root/)
})
