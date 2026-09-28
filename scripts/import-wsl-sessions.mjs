import { readdir, open, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { ProjectStore } from '../src/main/project/project-store.ts'

if (process.platform !== 'linux') throw new Error('Run this importer inside the selected WSL distribution.')
const store = new ProjectStore()
if ((await store.loadProjects()).projects.length !== 0) {
  console.log('Existing Pi GUI project registry preserved; session import skipped.')
  process.exit(0)
}
const sessionRoot = join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi/agent'), 'sessions')
let directories
try { directories = await readdir(sessionRoot, { withFileTypes: true }) }
catch (error) {
  if (error.code !== 'ENOENT') throw error
  console.log('No existing WSL Pi sessions to import.')
  process.exit(0)
}
const sessions = []
let skipped = 0
for (const directory of directories.filter((entry) => entry.isDirectory())) {
  const directoryPath = join(sessionRoot, directory.name)
  for (const file of await readdir(directoryPath, { withFileTypes: true })) {
    if (!file.isFile() || !file.name.endsWith('.jsonl')) continue
    const sessionFile = join(directoryPath, file.name)
    const handle = await open(sessionFile, 'r')
    let header
    try {
      const bytes = Buffer.alloc(16 * 1024)
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
      const firstLine = bytes.subarray(0, bytesRead).toString('utf8').split('\n')[0]
      try { header = JSON.parse(firstLine) }
      catch (error) { if (!(error instanceof SyntaxError)) throw error; skipped++; continue }
    } finally { await handle.close() }
    if (header === null || typeof header !== 'object' || header.type !== 'session' || typeof header.id !== 'string' || header.id.length === 0 || typeof header.cwd !== 'string' || !isAbsolute(header.cwd)) { skipped++; continue }
    let projectPath
    try {
      projectPath = await realpath(header.cwd)
      if (!(await stat(projectPath)).isDirectory()) { skipped++; continue }
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error
      skipped++
      continue
    }
    sessions.push({ projectPath, sessionFile, sessionId: header.id, sessionName: null, timestamp: typeof header.timestamp === 'string' ? header.timestamp : '' })
  }
}
const projects = [...new Set(sessions.map((session) => session.projectPath))]
for (const path of projects) await store.addProject({ path: await store.validateProjectPath(path) })
for (const { timestamp: _, ...pointer } of sessions.sort((a, b) => a.timestamp.localeCompare(b.timestamp))) await store.saveSession(pointer)
console.log(JSON.stringify({ importedProjects: projects.length, importedSessionPointers: sessions.length, skippedInvalidOrMissing: skipped, sourceSessionsModified: false }))
