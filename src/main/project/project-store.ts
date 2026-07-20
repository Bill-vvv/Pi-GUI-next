import { access, chmod, mkdir, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'

import type { KernelProjectState, ProjectTrust } from '../../shared/kernel-contract.ts'

type ProjectConfigFile = {
  version: 1
  project: { path: string; trust: ProjectTrust }
}

type ProjectStateFile = {
  version: 1
  recentSession: null
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

  async loadProject(): Promise<KernelProjectState> {
    let text: string
    try {
      text = await readFile(this.configFile, 'utf8')
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return { path: null, trust: null }
      throw error
    }

    const value: unknown = JSON.parse(text)
    if (!isProjectConfigFile(value)) {
      throw new Error(`Invalid Pi GUI project config: ${this.configFile}`)
    }
    return { ...value.project }
  }

  async validateProjectPath(path: string): Promise<string> {
    assertAbsolute(path, 'Project path')
    const canonicalPath = await realpath(path)
    const projectStat = await stat(canonicalPath)
    if (!projectStat.isDirectory()) throw new Error(`Project path is not a directory: ${canonicalPath}`)
    await access(canonicalPath, constants.R_OK | constants.X_OK)
    return canonicalPath
  }

  saveProject(project: { path: string; trust: ProjectTrust }): Promise<void> {
    const save = this.saveQueue.then(async () => {
      await writeJson(this.configFile, { version: 1, project } satisfies ProjectConfigFile)
      await ensureJson(this.stateFile, { version: 1, recentSession: null } satisfies ProjectStateFile)
    })
    this.saveQueue = save.catch(() => {})
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

function isProjectConfigFile(value: unknown): value is ProjectConfigFile {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.project)) return false
  return (
    typeof value.project.path === 'string' &&
    isAbsolute(value.project.path) &&
    (value.project.trust === 'trusted' || value.project.trust === 'untrusted')
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
