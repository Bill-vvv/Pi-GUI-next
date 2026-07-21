import { access, chmod, mkdir, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'

type ProjectConfigFileV1 = {
  version: 1
  project: { path: string }
}

type ProjectConfigFile = {
  version: 2
  projects: Array<{ path: string }>
  activeProjectKey: string | null
}

export type ProjectRegistry = {
  projects: Array<{ path: string }>
  activeProjectKey: string | null
}

export type SessionPointer = {
  projectPath: string
  sessionFile: string
  sessionId: string
  sessionName: string | null
}

export type ProjectSessionRegistry = {
  sessions: SessionPointer[]
  activeSessionKey: string | null
}

type ProjectStateFileV1 = {
  version: 1
  recentSession: SessionPointer | null
}

type ProjectStateFileV2 = {
  version: 2
  recentSessions: SessionPointer[]
}

type ActiveSessionSelection = {
  projectPath: string
  sessionKey: string
}

type ProjectStateFile = {
  version: 3
  sessions: SessionPointer[]
  activeSessionKeys: ActiveSessionSelection[]
}

export type ProjectStoreOptions = {
  configHome?: string
  stateHome?: string
}

export class ProjectStore {
  private readonly configFile: string
  private readonly stateFile: string
  private saveQueue: Promise<void> = Promise.resolve()

  constructor(options: ProjectStoreOptions = {}) {
    const configHome = options.configHome ?? xdgHome('XDG_CONFIG_HOME', join(homedir(), '.config'))
    const stateHome = options.stateHome ?? xdgHome('XDG_STATE_HOME', join(homedir(), '.local', 'state'))
    this.configFile = join(assertAbsolute(configHome, 'XDG config home'), 'pi-gui-next', 'config.json')
    this.stateFile = join(assertAbsolute(stateHome, 'XDG state home'), 'pi-gui-next', 'state.json')
  }

  async loadProjects(): Promise<ProjectRegistry> {
    return this.readProjects()
  }

  addProject(project: { path: string }): Promise<ProjectRegistry> {
    assertProject(project)
    return this.enqueueSave(async () => {
      const registry = await this.readProjects()
      if (registry.projects.some(({ path }) => path === project.path)) return registry
      const next = {
        projects: [...registry.projects, { ...project }],
        activeProjectKey: registry.activeProjectKey
      }
      await writeJson(this.configFile, toProjectConfigFile(next))
      await ensureJson(
        this.stateFile,
        { version: 3, sessions: [], activeSessionKeys: [] } satisfies ProjectStateFile
      )
      return next
    })
  }

  activateProject(projectKey: string): Promise<ProjectRegistry> {
    assertAbsolute(projectKey, 'Project key')
    return this.enqueueSave(async () => {
      const registry = await this.readProjects()
      if (!registry.projects.some(({ path }) => path === projectKey)) {
        throw new Error(`Project is not registered: ${projectKey}`)
      }
      if (registry.activeProjectKey === projectKey) return registry
      const next = { ...registry, activeProjectKey: projectKey }
      await writeJson(this.configFile, toProjectConfigFile(next))
      return next
    })
  }

  private async readProjects(): Promise<ProjectRegistry> {
    let text: string
    try {
      text = await readFile(this.configFile, 'utf8')
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        return { projects: [], activeProjectKey: null }
      }
      throw error
    }

    const value: unknown = JSON.parse(text)
    if (isProjectConfigFile(value)) {
      return copyRegistry(value)
    }
    if (isProjectConfigFileV1(value)) {
      return {
        projects: [{ path: value.project.path }],
        activeProjectKey: value.project.path
      }
    }
    throw new Error(`Invalid Pi GUI project config: ${this.configFile}`)
  }

  async validateProjectPath(path: string): Promise<string> {
    assertAbsolute(path, 'Project path')
    const canonicalPath = await realpath(path)
    const projectStat = await stat(canonicalPath)
    if (!projectStat.isDirectory()) throw new Error(`Project path is not a directory: ${canonicalPath}`)
    await access(canonicalPath, constants.R_OK | constants.X_OK)
    return canonicalPath
  }

  async loadSessionRegistry(projectPath: string): Promise<ProjectSessionRegistry> {
    assertAbsolute(projectPath, 'Project path')
    const state = await this.readSessionState()
    const sessions = state.sessions
      .filter((pointer) => pointer.projectPath === projectPath)
      .map((pointer) => ({ ...pointer }))
    const activeSessionKey = state.activeSessionKeys
      .find((selection) => selection.projectPath === projectPath)?.sessionKey ?? null
    return { sessions, activeSessionKey }
  }

  async validateSession(pointer: SessionPointer): Promise<SessionPointer> {
    if (!isSessionPointer(pointer)) {
      throw new Error('Invalid Pi GUI session pointer.')
    }
    const registry = await this.readProjects()
    if (!registry.projects.some(({ path }) => path === pointer.projectPath)) {
      throw new Error(`Project is not registered: ${pointer.projectPath}`)
    }
    const canonicalSessionFile = await realpath(pointer.sessionFile)
    const sessionStat = await stat(canonicalSessionFile)
    if (!sessionStat.isFile()) {
      throw new Error(`Session file is not a regular file: ${canonicalSessionFile}`)
    }
    await access(canonicalSessionFile, constants.R_OK)
    return { ...pointer, sessionFile: canonicalSessionFile }
  }

  saveSession(pointer: SessionPointer): Promise<void> {
    if (!isSessionPointer(pointer)) {
      throw new Error('Invalid Pi GUI session pointer.')
    }
    return this.enqueueSave(async () => {
      const canonicalPointer = await this.validateSession(pointer)
      const state = await this.readSessionState()
      const existing = state.sessions.find(({ sessionFile }) => sessionFile === canonicalPointer.sessionFile)
      if (existing !== undefined && existing.projectPath !== canonicalPointer.projectPath) {
        throw new Error(`Session is registered to another project: ${canonicalPointer.sessionFile}`)
      }
      const sessions = upsertSessionPointer(state.sessions, canonicalPointer)
      const activeSessionKeys = state.activeSessionKeys.filter(
        ({ projectPath }) => projectPath !== canonicalPointer.projectPath
      )
      activeSessionKeys.push({
        projectPath: canonicalPointer.projectPath,
        sessionKey: canonicalPointer.sessionFile
      })
      await writeJson(this.stateFile, {
        version: 3,
        sessions,
        activeSessionKeys
      } satisfies ProjectStateFile)
    })
  }

  private async readSessionState(): Promise<ProjectStateFile> {
    let text: string
    try {
      text = await readFile(this.stateFile, 'utf8')
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        return { version: 3, sessions: [], activeSessionKeys: [] }
      }
      throw error
    }

    const value: unknown = JSON.parse(text)
    if (isProjectStateFile(value)) return copyProjectState(value)
    if (isProjectStateFileV2(value)) return migrateSessionPointers(value.recentSessions)
    if (isProjectStateFileV1(value)) {
      return migrateSessionPointers(value.recentSession === null ? [] : [value.recentSession])
    }
    throw new Error(`Invalid Pi GUI project state: ${this.stateFile}`)
  }

  private enqueueSave<T>(task: () => Promise<T>): Promise<T> {
    const save = this.saveQueue.then(task)
    this.saveQueue = save.then(() => {}, () => {})
    return save
  }
}

function xdgHome(name: 'XDG_CONFIG_HOME' | 'XDG_STATE_HOME', fallback: string): string {
  return process.env[name] || fallback
}

function assertAbsolute(path: string, label: string): string {
  if (!isAbsolute(path)) throw new Error(`${label} must be an absolute path: ${path}`)
  return path
}

async function ensureJson(path: string, value: unknown): Promise<void> {
  try {
    await access(path, constants.F_OK)
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'ENOENT') throw error
    await writeJson(path, value)
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  const directory = dirname(path)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await chmod(directory, 0o700)
  const temporaryPath = `${path}.tmp-${randomUUID()}`
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    await rename(temporaryPath, path)
  } finally {
    await unlink(temporaryPath).catch((error: unknown) => {
      if (!isNodeError(error) || error.code !== 'ENOENT') throw error
    })
  }
}

function isProjectConfigFileV1(value: unknown): value is ProjectConfigFileV1 {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 2 ||
    value.version !== 1 ||
    !isRecord(value.project) ||
    Object.keys(value.project).length !== 1
  ) {
    return false
  }
  return typeof value.project.path === 'string' && isAbsolute(value.project.path)
}

function isProjectConfigFile(value: unknown): value is ProjectConfigFile {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 3 ||
    value.version !== 2 ||
    !Array.isArray(value.projects) ||
    !value.projects.every(isProject) ||
    new Set(value.projects.map(({ path }) => path)).size !== value.projects.length ||
    (typeof value.activeProjectKey !== 'string' && value.activeProjectKey !== null)
  ) {
    return false
  }
  return value.activeProjectKey === null || value.projects.some(({ path }) => path === value.activeProjectKey)
}

function toProjectConfigFile(registry: ProjectRegistry): ProjectConfigFile {
  return {
    version: 2,
    projects: registry.projects.map((project) => ({ ...project })),
    activeProjectKey: registry.activeProjectKey
  }
}

function copyRegistry(registry: ProjectRegistry): ProjectRegistry {
  return {
    projects: registry.projects.map((project) => ({ ...project })),
    activeProjectKey: registry.activeProjectKey
  }
}

function assertProject(project: { path: string }): void {
  if (!isProject(project)) throw new Error('Invalid Pi GUI project registration.')
}

function isProject(value: unknown): value is { path: string } {
  return (
    isRecord(value) &&
    Object.keys(value).length === 1 &&
    typeof value.path === 'string' &&
    isAbsolute(value.path)
  )
}

function isProjectStateFile(value: unknown): value is ProjectStateFile {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 3 ||
    value.version !== 3 ||
    !Array.isArray(value.sessions) ||
    !Array.isArray(value.activeSessionKeys)
  ) return false
  const sessions = value.sessions
  const activeSessionKeys = value.activeSessionKeys
  return (
    sessions.every(isSessionPointer) &&
    new Set(sessions.map(({ sessionFile }) => sessionFile)).size === sessions.length &&
    new Set(sessions.map(({ projectPath, sessionId }) => `${projectPath}\u0000${sessionId}`)).size ===
      sessions.length &&
    activeSessionKeys.every(isActiveSessionSelection) &&
    new Set(activeSessionKeys.map(({ projectPath }) => projectPath)).size ===
      activeSessionKeys.length &&
    activeSessionKeys.every((selection) =>
      sessions.some((pointer) =>
        pointer.projectPath === selection.projectPath &&
        pointer.sessionFile === selection.sessionKey
      )
    )
  )
}

function isProjectStateFileV2(value: unknown): value is ProjectStateFileV2 {
  return (
    isRecord(value) &&
    Object.keys(value).length === 2 &&
    value.version === 2 &&
    Array.isArray(value.recentSessions) &&
    value.recentSessions.every(isSessionPointer) &&
    new Set(value.recentSessions.map(({ projectPath }) => projectPath)).size ===
      value.recentSessions.length
  )
}

function isProjectStateFileV1(value: unknown): value is ProjectStateFileV1 {
  return (
    isRecord(value) &&
    Object.keys(value).length === 2 &&
    value.version === 1 &&
    (value.recentSession === null || isSessionPointer(value.recentSession))
  )
}

function isActiveSessionSelection(value: unknown): value is ActiveSessionSelection {
  return (
    isRecord(value) &&
    Object.keys(value).length === 2 &&
    typeof value.projectPath === 'string' &&
    isAbsolute(value.projectPath) &&
    typeof value.sessionKey === 'string' &&
    isAbsolute(value.sessionKey)
  )
}

function isSessionPointer(value: unknown): value is SessionPointer {
  return (
    isRecord(value) &&
    Object.keys(value).length === 4 &&
    typeof value.projectPath === 'string' &&
    isAbsolute(value.projectPath) &&
    typeof value.sessionFile === 'string' &&
    isAbsolute(value.sessionFile) &&
    typeof value.sessionId === 'string' &&
    value.sessionId.length > 0 &&
    (typeof value.sessionName === 'string' || value.sessionName === null)
  )
}

function migrateSessionPointers(pointers: SessionPointer[]): ProjectStateFile {
  return {
    version: 3,
    sessions: pointers.map((pointer) => ({ ...pointer })),
    activeSessionKeys: pointers.map((pointer) => ({
      projectPath: pointer.projectPath,
      sessionKey: pointer.sessionFile
    }))
  }
}

function upsertSessionPointer(pointers: SessionPointer[], pointer: SessionPointer): SessionPointer[] {
  const index = pointers.findIndex((existing) =>
    existing.sessionFile === pointer.sessionFile ||
    (
      existing.projectPath === pointer.projectPath &&
      existing.sessionId === pointer.sessionId
    )
  )
  if (index === -1) return [...pointers, { ...pointer }]
  return pointers.map((existing, pointerIndex) =>
    pointerIndex === index ? { ...pointer } : { ...existing }
  )
}

function copyProjectState(state: ProjectStateFile): ProjectStateFile {
  return {
    version: 3,
    sessions: state.sessions.map((pointer) => ({ ...pointer })),
    activeSessionKeys: state.activeSessionKeys.map((selection) => ({ ...selection }))
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
