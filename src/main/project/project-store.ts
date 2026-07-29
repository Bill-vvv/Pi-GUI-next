import { access, chmod, mkdir, readFile, realpath, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'

import {
  DEFAULT_APPEARANCE_SETTINGS,
  DEFAULT_GENERAL_SETTINGS,
  DEFAULT_SESSION_NAMING_SETTINGS,
  DEFAULT_SUBAGENT_SETTINGS,
  type AppearanceSettings,
  type GeneralSettings,
  type SessionNamingSettings,
  type SubagentSettings
} from '../../shared/kernel-contract.ts'
import {
  copyShortcutSettings,
  DEFAULT_SHORTCUT_SETTINGS,
  isShortcutSettings,
  type ShortcutSettings
} from '../../shared/shortcut-settings.ts'
import { isRecord } from '../utils/guards.ts'
import {
  upsertSessionPointer,
  type ProjectSessionRegistry,
  type SessionPointer
} from './session-pointer.ts'

type ProjectConfigFileV1 = {
  version: 1
  project: { path: string }
}

type ProjectConfigFileV2 = {
  version: 2
  projects: Array<{ path: string }>
  activeProjectKey: string | null
}

type ProjectConfigFileV3 = {
  version: 3
  projects: Array<{ path: string }>
  activeProjectKey: string | null
  sessionNaming: SessionNamingSettings
}

type LegacyAppearanceSettingsV4 = {
  uiFontFamily: string | null
  codeFontFamily: string | null
}

type LegacyAppearanceSettingsV5 = LegacyAppearanceSettingsV4 & {
  theme: AppearanceSettings['theme']
}

type ProjectConfigFileV4 = {
  version: 4
  projects: Array<{ path: string }>
  activeProjectKey: string | null
  sessionNaming: SessionNamingSettings
  appearance: LegacyAppearanceSettingsV4
}

type ProjectConfigFileV5 = {
  version: 5
  projects: Array<{ path: string }>
  activeProjectKey: string | null
  sessionNaming: SessionNamingSettings
  appearance: LegacyAppearanceSettingsV5
}

type ProjectConfigFileV6 = {
  version: 6
  projects: Array<{ path: string }>
  activeProjectKey: string | null
  sessionNaming: SessionNamingSettings
  appearance: LegacyAppearanceSettingsV5
  general: GeneralSettings
}

type LegacyAppearanceSettingsV7 = {
  theme: AppearanceSettings['theme']
  accentColor: AppearanceSettings['accentColor']
  surfaceTransparency: AppearanceSettings['surfaceTransparency']
  uiFontFamily: string | null
  codeFontFamily: string | null
}

type ProjectConfigFileV7 = {
  version: 7
  projects: Array<{ path: string }>
  activeProjectKey: string | null
  sessionNaming: SessionNamingSettings
  appearance: LegacyAppearanceSettingsV7
  general: GeneralSettings
}

type LegacyAppearanceSettingsV8 = LegacyAppearanceSettingsV7 & {
  textSize: AppearanceSettings['textSize']
}

type ProjectConfigFileV8 = {
  version: 8
  projects: Array<{ path: string }>
  activeProjectKey: string | null
  sessionNaming: SessionNamingSettings
  appearance: LegacyAppearanceSettingsV8
  general: GeneralSettings
}

type ProjectConfigFileV9 = {
  version: 9
  projects: Array<{ path: string }>
  activeProjectKey: string | null
  sessionNaming: SessionNamingSettings
  appearance: LegacyAppearanceSettingsV8
  general: GeneralSettings
  shortcuts: ShortcutSettings
}

type LegacySubagentSettingsV10 = {
  maxDepth: 1 | 2 | 3
  preventCycles: boolean
}

type ProjectConfigFileV10 = {
  version: 10
  projects: Array<{ path: string }>
  activeProjectKey: string | null
  sessionNaming: SessionNamingSettings
  appearance: LegacyAppearanceSettingsV8
  general: GeneralSettings
  shortcuts: ShortcutSettings
  subagent: LegacySubagentSettingsV10
}

type ProjectConfigFileV11 = {
  version: 11
  projects: Array<{ path: string }>
  activeProjectKey: string | null
  sessionNaming: SessionNamingSettings
  appearance: LegacyAppearanceSettingsV8
  general: Pick<GeneralSettings, 'startupWorkspaceRestore' | 'doubleClickBorderMaximize'>
  shortcuts: ShortcutSettings
  subagent: SubagentSettings
}

type ProjectConfigFileV12 = Omit<ProjectConfigFileV11, 'version' | 'general'> & {
  version: 12
  general: GeneralSettings
}

type ProjectConfigFile = Omit<ProjectConfigFileV12, 'version' | 'appearance'> & {
  version: 13
  appearance: AppearanceSettings
}

export type ProjectRegistry = {
  projects: Array<{ path: string }>
  activeProjectKey: string | null
}

export type TaskWorkspace = {
  key: string
  path: string
}

export type TaskRegistry = {
  tasks: TaskWorkspace[]
  activeTaskKey: string | null
  navigatorKind: 'project' | 'task'
}

type TaskStateFile = {
  version: 1
  tasks: TaskWorkspace[]
  activeTaskKey: string | null
  navigatorKind: 'project' | 'task'
}

type ProjectConfiguration = ProjectRegistry & {
  sessionNaming: SessionNamingSettings
  appearance: AppearanceSettings
  general: GeneralSettings
  shortcuts: ShortcutSettings
  subagent: SubagentSettings
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

type ProjectStateFileV3 = {
  version: 3
  sessions: SessionPointer[]
  activeSessionKeys: ActiveSessionSelection[]
}

type ProjectStateFileV4 = {
  version: 4
  sessions: SessionPointer[]
  activeSessionKeys: ActiveSessionSelection[]
  archivedSessionKeys: ActiveSessionSelection[]
}

type ProjectStateFileV5 = {
  version: 5
  sessions: SessionPointer[]
  activeSessionKeys: ActiveSessionSelection[]
  archivedSessionKeys: ActiveSessionSelection[]
  manuallyOrderedProjectPaths: string[]
}

type ProjectStateFile = {
  version: 6
  sessions: SessionPointer[]
  activeSessionKeys: ActiveSessionSelection[]
  archivedSessionKeys: ActiveSessionSelection[]
}

export type ProjectStoreOptions = {
  configHome?: string
  stateHome?: string
}

export class ProjectStore {
  private readonly configFile: string
  private readonly stateFile: string
  private readonly taskStateFile: string
  private readonly taskRoot: string
  private saveQueue: Promise<void> = Promise.resolve()

  constructor(options: ProjectStoreOptions = {}) {
    const configHome = options.configHome ?? xdgHome('XDG_CONFIG_HOME', join(homedir(), '.config'))
    const stateHome = assertAbsolute(
      options.stateHome ?? xdgHome('XDG_STATE_HOME', join(homedir(), '.local', 'state')),
      'XDG state home'
    )
    this.configFile = join(assertAbsolute(configHome, 'XDG config home'), 'pi-gui-next', 'config.json')
    this.stateFile = join(stateHome, 'pi-gui-next', 'state.json')
    this.taskStateFile = join(stateHome, 'pi-gui-next', 'tasks.json')
    this.taskRoot = join(stateHome, 'pi-gui-next', 'tasks')
  }

  async loadProjects(): Promise<ProjectRegistry> {
    return copyRegistry(await this.readConfiguration())
  }

  async loadTasks(): Promise<TaskRegistry> {
    return copyTaskRegistry(await this.readTaskState())
  }

  createTask(): Promise<TaskWorkspace> {
    return this.enqueueSave(async () => {
      const [taskState, sessionState] = await Promise.all([
        this.readTaskState(),
        this.readSessionState()
      ])
      const retainedTasks = taskState.tasks.filter((task) =>
        sessionState.sessions.some((pointer) => pointer.projectPath === task.path)
      )
      const retainedTaskKeys = new Set(retainedTasks.map(({ key }) => key))
      for (const task of taskState.tasks) {
        if (!retainedTaskKeys.has(task.key)) {
          await rm(task.path, { recursive: true, force: true })
        }
      }
      const key = randomUUID()
      const task = { key, path: join(this.taskRoot, key) }
      await mkdir(this.taskRoot, { recursive: true, mode: 0o700 })
      await chmod(this.taskRoot, 0o700)
      await mkdir(task.path, { recursive: false, mode: 0o700 })
      await writeJson(this.taskStateFile, {
        version: 1,
        tasks: [...retainedTasks, task],
        activeTaskKey: key,
        navigatorKind: 'task'
      } satisfies TaskStateFile)
      return { ...task }
    })
  }

  activateTask(taskKey: string): Promise<TaskRegistry> {
    assertTaskKey(taskKey)
    return this.enqueueSave(async () => {
      const state = await this.readTaskState()
      if (!state.tasks.some(({ key }) => key === taskKey)) {
        throw new Error(`Task is not registered: ${taskKey}`)
      }
      const next: TaskStateFile = {
        ...state,
        activeTaskKey: taskKey,
        navigatorKind: 'task'
      }
      await writeJson(this.taskStateFile, next)
      return copyTaskRegistry(next)
    })
  }

  selectNavigator(kind: 'project' | 'task'): Promise<TaskRegistry> {
    return this.enqueueSave(async () => {
      const state = await this.readTaskState()
      if (state.navigatorKind === kind) return copyTaskRegistry(state)
      const next: TaskStateFile = { ...state, navigatorKind: kind }
      await writeJson(this.taskStateFile, next)
      return copyTaskRegistry(next)
    })
  }

  async loadSessionNaming(): Promise<SessionNamingSettings> {
    return copySessionNaming((await this.readConfiguration()).sessionNaming)
  }

  async loadAppearance(): Promise<AppearanceSettings> {
    return copyAppearance((await this.readConfiguration()).appearance)
  }

  async loadGeneral(): Promise<GeneralSettings> {
    return copyGeneral((await this.readConfiguration()).general)
  }

  async loadShortcuts(): Promise<ShortcutSettings> {
    return copyShortcutSettings((await this.readConfiguration()).shortcuts)
  }

  async loadSubagent(): Promise<SubagentSettings> {
    return copySubagent((await this.readConfiguration()).subagent)
  }

  addProject(project: { path: string }): Promise<ProjectRegistry> {
    assertProject(project)
    return this.enqueueSave(async () => {
      const configuration = await this.readConfiguration()
      if (configuration.projects.some(({ path }) => path === project.path)) {
        return copyRegistry(configuration)
      }
      const next: ProjectConfiguration = {
        projects: [...configuration.projects, { ...project }],
        activeProjectKey: configuration.activeProjectKey,
        sessionNaming: configuration.sessionNaming,
        appearance: configuration.appearance,
        general: configuration.general,
        shortcuts: configuration.shortcuts,
        subagent: configuration.subagent
      }
      await writeJson(this.configFile, toProjectConfigFile(next))
      await ensureJson(
        this.stateFile,
        {
          version: 6,
          sessions: [],
          activeSessionKeys: [],
          archivedSessionKeys: []
        } satisfies ProjectStateFile
      )
      return copyRegistry(next)
    })
  }

  activateProject(projectKey: string): Promise<ProjectRegistry> {
    assertAbsolute(projectKey, 'Project key')
    return this.enqueueSave(async () => {
      const [configuration, taskState] = await Promise.all([
        this.readConfiguration(),
        this.readTaskState()
      ])
      if (!configuration.projects.some(({ path }) => path === projectKey)) {
        throw new Error(`Project is not registered: ${projectKey}`)
      }
      const next: ProjectConfiguration = configuration.activeProjectKey === projectKey
        ? configuration
        : { ...configuration, activeProjectKey: projectKey }
      if (next !== configuration) await writeJson(this.configFile, toProjectConfigFile(next))
      if (taskState.navigatorKind !== 'project') {
        await writeJson(this.taskStateFile, { ...taskState, navigatorKind: 'project' } satisfies TaskStateFile)
      }
      return copyRegistry(next)
    })
  }

  reorderProjects(projectKeys: string[]): Promise<void> {
    return this.enqueueSave(async () => {
      const configuration = await this.readConfiguration()
      const projectsByPath = new Map(configuration.projects.map((project) => [project.path, project]))
      assertStrictPermutation(projectKeys, [...projectsByPath.keys()], 'Project keys')
      await writeJson(this.configFile, toProjectConfigFile({
        ...configuration,
        projects: projectKeys.map((projectKey) => projectsByPath.get(projectKey)!)
      }))
    })
  }

  saveSessionNaming(settings: SessionNamingSettings): Promise<void> {
    assertSessionNaming(settings)
    return this.enqueueSave(async () => {
      const configuration = await this.readConfiguration()
      await writeJson(this.configFile, toProjectConfigFile({
        ...configuration,
        sessionNaming: copySessionNaming(settings)
      }))
    })
  }

  saveAppearance(settings: AppearanceSettings): Promise<void> {
    assertAppearance(settings)
    return this.enqueueSave(async () => {
      const configuration = await this.readConfiguration()
      await writeJson(this.configFile, toProjectConfigFile({
        ...configuration,
        appearance: copyAppearance(settings)
      }))
    })
  }

  saveGeneral(settings: GeneralSettings): Promise<void> {
    assertGeneral(settings)
    return this.enqueueSave(async () => {
      const configuration = await this.readConfiguration()
      await writeJson(this.configFile, toProjectConfigFile({
        ...configuration,
        general: copyGeneral(settings)
      }))
    })
  }

  saveShortcuts(settings: ShortcutSettings): Promise<void> {
    assertShortcuts(settings)
    const nextSettings = copyShortcutSettings(settings)
    return this.enqueueSave(async () => {
      const configuration = await this.readConfiguration()
      await writeJson(this.configFile, toProjectConfigFile({
        ...configuration,
        shortcuts: nextSettings
      }))
    })
  }

  saveSubagent(settings: SubagentSettings): Promise<void> {
    assertSubagent(settings)
    const nextSettings = copySubagent(settings)
    return this.enqueueSave(async () => {
      const configuration = await this.readConfiguration()
      await writeJson(this.configFile, toProjectConfigFile({
        ...configuration,
        subagent: nextSettings
      }))
    })
  }

  private async readConfiguration(): Promise<ProjectConfiguration> {
    let text: string
    try {
      text = await readFile(this.configFile, 'utf8')
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        return {
          projects: [],
          activeProjectKey: null,
          sessionNaming: { ...DEFAULT_SESSION_NAMING_SETTINGS },
          appearance: { ...DEFAULT_APPEARANCE_SETTINGS },
          general: { ...DEFAULT_GENERAL_SETTINGS },
          shortcuts: copyShortcutSettings(DEFAULT_SHORTCUT_SETTINGS),
          subagent: { ...DEFAULT_SUBAGENT_SETTINGS }
        }
      }
      throw error
    }

    const value: unknown = JSON.parse(text)
    if (isProjectConfigFile(value)) {
      return copyConfiguration(value)
    }
    if (isProjectConfigFileV12(value)) {
      return {
        ...copyRegistry(value),
        sessionNaming: copySessionNaming(value.sessionNaming),
        appearance: { ...DEFAULT_APPEARANCE_SETTINGS, ...value.appearance },
        general: requireGeneral(value.general),
        shortcuts: copyShortcutSettings(value.shortcuts),
        subagent: copySubagent(value.subagent)
      }
    }
    if (isProjectConfigFileV11(value)) {
      return {
        ...copyRegistry(value),
        sessionNaming: copySessionNaming(value.sessionNaming),
        appearance: { ...DEFAULT_APPEARANCE_SETTINGS, ...value.appearance },
        general: {
          ...copyGeneralV11(value.general),
          fastExtensionLoading: DEFAULT_GENERAL_SETTINGS.fastExtensionLoading
        },
        shortcuts: copyShortcutSettings(value.shortcuts),
        subagent: copySubagent(value.subagent)
      }
    }
    if (isProjectConfigFileV10(value)) {
      return {
        ...copyRegistry(value),
        sessionNaming: copySessionNaming(value.sessionNaming),
        appearance: { ...DEFAULT_APPEARANCE_SETTINGS, ...value.appearance },
        general: requireGeneral(value.general),
        shortcuts: copyShortcutSettings(value.shortcuts),
        subagent: { maxDepth: value.subagent.maxDepth }
      }
    }
    if (isProjectConfigFileV9(value)) {
      return {
        ...copyRegistry(value),
        sessionNaming: copySessionNaming(value.sessionNaming),
        appearance: { ...DEFAULT_APPEARANCE_SETTINGS, ...value.appearance },
        general: requireGeneral(value.general),
        shortcuts: copyShortcutSettings(value.shortcuts),
        subagent: { ...DEFAULT_SUBAGENT_SETTINGS }
      }
    }
    if (isProjectConfigFileV8(value)) {
      return {
        ...copyRegistry(value),
        sessionNaming: copySessionNaming(value.sessionNaming),
        appearance: { ...DEFAULT_APPEARANCE_SETTINGS, ...value.appearance },
        general: requireGeneral(value.general),
        shortcuts: copyShortcutSettings(DEFAULT_SHORTCUT_SETTINGS),
        subagent: { ...DEFAULT_SUBAGENT_SETTINGS }
      }
    }
    if (isProjectConfigFileV7(value)) {
      return {
        ...copyRegistry(value),
        sessionNaming: copySessionNaming(value.sessionNaming),
        appearance: { ...DEFAULT_APPEARANCE_SETTINGS, ...value.appearance },
        general: requireGeneral(value.general),
        shortcuts: copyShortcutSettings(DEFAULT_SHORTCUT_SETTINGS),
        subagent: { ...DEFAULT_SUBAGENT_SETTINGS }
      }
    }
    if (isProjectConfigFileV6(value)) {
      return {
        ...copyRegistry(value),
        sessionNaming: copySessionNaming(value.sessionNaming),
        appearance: { ...DEFAULT_APPEARANCE_SETTINGS, ...value.appearance },
        general: requireGeneral(value.general),
        shortcuts: copyShortcutSettings(DEFAULT_SHORTCUT_SETTINGS),
        subagent: { ...DEFAULT_SUBAGENT_SETTINGS }
      }
    }
    if (isProjectConfigFileV5(value)) {
      return {
        ...copyRegistry(value),
        sessionNaming: copySessionNaming(value.sessionNaming),
        appearance: { ...DEFAULT_APPEARANCE_SETTINGS, ...value.appearance },
        general: { ...DEFAULT_GENERAL_SETTINGS },
        shortcuts: copyShortcutSettings(DEFAULT_SHORTCUT_SETTINGS),
        subagent: { ...DEFAULT_SUBAGENT_SETTINGS }
      }
    }
    if (isProjectConfigFileV4(value)) {
      return {
        ...copyRegistry(value),
        sessionNaming: copySessionNaming(value.sessionNaming),
        appearance: { ...DEFAULT_APPEARANCE_SETTINGS, ...value.appearance },
        general: { ...DEFAULT_GENERAL_SETTINGS },
        shortcuts: copyShortcutSettings(DEFAULT_SHORTCUT_SETTINGS),
        subagent: { ...DEFAULT_SUBAGENT_SETTINGS }
      }
    }
    if (isProjectConfigFileV3(value)) {
      return {
        ...copyRegistry(value),
        sessionNaming: copySessionNaming(value.sessionNaming),
        appearance: { ...DEFAULT_APPEARANCE_SETTINGS },
        general: { ...DEFAULT_GENERAL_SETTINGS },
        shortcuts: copyShortcutSettings(DEFAULT_SHORTCUT_SETTINGS),
        subagent: { ...DEFAULT_SUBAGENT_SETTINGS }
      }
    }
    if (isProjectConfigFileV2(value)) {
      return {
        ...copyRegistry(value),
        sessionNaming: { ...DEFAULT_SESSION_NAMING_SETTINGS },
        appearance: { ...DEFAULT_APPEARANCE_SETTINGS },
        general: { ...DEFAULT_GENERAL_SETTINGS },
        shortcuts: copyShortcutSettings(DEFAULT_SHORTCUT_SETTINGS),
        subagent: { ...DEFAULT_SUBAGENT_SETTINGS }
      }
    }
    if (isProjectConfigFileV1(value)) {
      return {
        projects: [{ path: value.project.path }],
        activeProjectKey: value.project.path,
        sessionNaming: { ...DEFAULT_SESSION_NAMING_SETTINGS },
        appearance: { ...DEFAULT_APPEARANCE_SETTINGS },
        general: { ...DEFAULT_GENERAL_SETTINGS },
        shortcuts: copyShortcutSettings(DEFAULT_SHORTCUT_SETTINGS),
        subagent: { ...DEFAULT_SUBAGENT_SETTINGS }
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

  async taskOwnsSession(taskPath: string): Promise<boolean> {
    assertAbsolute(taskPath, 'Task workspace path')
    const [tasks, state] = await Promise.all([
      this.readTaskState(),
      this.readSessionState()
    ])
    if (!tasks.tasks.some(({ path }) => path === taskPath)) return false
    return state.sessions.some(({ projectPath }) => projectPath === taskPath)
  }

  async loadSessionRegistry(projectPath: string): Promise<ProjectSessionRegistry> {
    assertAbsolute(projectPath, 'Project path')
    const state = await this.readSessionState()
    const archivedSessionKeys = new Set(
      state.archivedSessionKeys
        .filter((selection) => selection.projectPath === projectPath)
        .map((selection) => selection.sessionKey)
    )
    const sessions = state.sessions
      .filter((pointer) =>
        pointer.projectPath === projectPath && !archivedSessionKeys.has(pointer.sessionFile)
      )
      .map((pointer) => ({ ...pointer }))
    const activeSessionKey = state.activeSessionKeys
      .find((selection) => selection.projectPath === projectPath)?.sessionKey ?? null
    return {
      sessions,
      activeSessionKey
    }
  }

  async validateSession(pointer: SessionPointer): Promise<SessionPointer> {
    if (!isSessionPointer(pointer)) {
      throw new Error('Invalid Pi GUI session pointer.')
    }
    const [registry, taskRegistry] = await Promise.all([
      this.loadProjects(),
      this.loadTasks()
    ])
    if (
      !registry.projects.some(({ path }) => path === pointer.projectPath) &&
      !taskRegistry.tasks.some(({ path }) => path === pointer.projectPath)
    ) {
      throw new Error(`Project is not registered as a Project or Task Runtime workspace: ${pointer.projectPath}`)
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
      const [state, taskState] = await Promise.all([
        this.readSessionState(),
        this.readTaskState()
      ])
      const task = taskState.tasks.find(({ path }) => path === canonicalPointer.projectPath)
      if (
        task !== undefined &&
        state.sessions.some((pointer) =>
          pointer.projectPath === task.path && pointer.sessionFile !== canonicalPointer.sessionFile
        )
      ) {
        throw new Error(`Task already owns another session: ${task.key}`)
      }
      if (state.archivedSessionKeys.some((selection) =>
        selection.projectPath === canonicalPointer.projectPath &&
        selection.sessionKey === canonicalPointer.sessionFile
      )) {
        throw new Error(`Session is archived for the project: ${canonicalPointer.sessionFile}`)
      }
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
        version: 6,
        sessions,
        activeSessionKeys,
        archivedSessionKeys: state.archivedSessionKeys
      } satisfies ProjectStateFile)
    })
  }

  archiveSession(projectPath: string, sessionKey: string): Promise<void> {
    assertAbsolute(projectPath, 'Project path')
    assertAbsolute(sessionKey, 'Session key')
    return this.enqueueSave(async () => {
      const state = await this.readSessionState()
      if (!state.sessions.some((pointer) =>
        pointer.projectPath === projectPath && pointer.sessionFile === sessionKey
      )) {
        throw new Error(`Session is not registered for the project: ${sessionKey}`)
      }
      if (state.archivedSessionKeys.some((selection) =>
        selection.projectPath === projectPath && selection.sessionKey === sessionKey
      )) return
      await writeJson(this.stateFile, {
        version: 6,
        sessions: state.sessions,
        activeSessionKeys: state.activeSessionKeys.filter((selection) =>
          selection.projectPath !== projectPath || selection.sessionKey !== sessionKey
        ),
        archivedSessionKeys: [
          ...state.archivedSessionKeys,
          { projectPath, sessionKey }
        ]
      } satisfies ProjectStateFile)
    })
  }

  restoreArchivedSession(
    projectPath: string,
    sessionKey: string
  ): Promise<ProjectSessionRegistry> {
    assertAbsolute(projectPath, 'Project path')
    assertAbsolute(sessionKey, 'Session key')
    return this.enqueueSave(async () => {
      const state = await this.readSessionState()
      if (!state.sessions.some((pointer) =>
        pointer.projectPath === projectPath && pointer.sessionFile === sessionKey
      )) {
        throw new Error(`Session is not registered for the project: ${sessionKey}`)
      }
      if (!state.archivedSessionKeys.some((selection) =>
        selection.projectPath === projectPath && selection.sessionKey === sessionKey
      )) {
        throw new Error(`Session is not archived for the project: ${sessionKey}`)
      }
      await writeJson(this.stateFile, {
        version: 6,
        sessions: state.sessions,
        activeSessionKeys: state.activeSessionKeys,
        archivedSessionKeys: state.archivedSessionKeys.filter((selection) =>
          selection.projectPath !== projectPath || selection.sessionKey !== sessionKey
        )
      } satisfies ProjectStateFile)
      return this.loadSessionRegistry(projectPath)
    })
  }

  private async readTaskState(): Promise<TaskStateFile> {
    let text: string
    try {
      text = await readFile(this.taskStateFile, 'utf8')
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        return {
          version: 1,
          tasks: [],
          activeTaskKey: null,
          navigatorKind: 'project'
        }
      }
      throw error
    }

    const value: unknown = JSON.parse(text)
    if (!isTaskStateFile(value, this.taskRoot)) {
      throw new Error(`Invalid Pi GUI task state: ${this.taskStateFile}`)
    }
    return copyTaskState(value)
  }

  private async readSessionState(): Promise<ProjectStateFile> {
    let text: string
    try {
      text = await readFile(this.stateFile, 'utf8')
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        return {
          version: 6,
          sessions: [],
          activeSessionKeys: [],
          archivedSessionKeys: []
        }
      }
      throw error
    }

    const value: unknown = JSON.parse(text)
    if (isProjectStateFile(value)) return copyProjectState(value)
    if (isProjectStateFileV5(value)) return migrateProjectStateV5(value)
    if (isProjectStateFileV4(value)) return migrateProjectStateV4(value)
    if (isProjectStateFileV3(value)) return migrateProjectStateV3(value)
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

function assertStrictPermutation(actual: string[], expected: string[], label: string): void {
  if (
    actual.length !== expected.length ||
    new Set(actual).size !== actual.length ||
    !actual.every((key) => expected.includes(key))
  ) {
    throw new Error(`${label} must be a strict permutation of the registered keys.`)
  }
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

function isProjectConfigFileV2(value: unknown): value is ProjectConfigFileV2 {
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

function isProjectConfigFileV3(value: unknown): value is ProjectConfigFileV3 {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 4 ||
    value.version !== 3 ||
    !Array.isArray(value.projects) ||
    !value.projects.every(isProject) ||
    new Set(value.projects.map(({ path }) => path)).size !== value.projects.length ||
    (typeof value.activeProjectKey !== 'string' && value.activeProjectKey !== null) ||
    !isSessionNaming(value.sessionNaming)
  ) {
    return false
  }
  return value.activeProjectKey === null || value.projects.some(({ path }) => path === value.activeProjectKey)
}

function isProjectConfigFileV5(value: unknown): value is ProjectConfigFileV5 {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 5 ||
    value.version !== 5 ||
    !Array.isArray(value.projects) ||
    !value.projects.every(isProject) ||
    new Set(value.projects.map(({ path }) => path)).size !== value.projects.length ||
    (typeof value.activeProjectKey !== 'string' && value.activeProjectKey !== null) ||
    !isSessionNaming(value.sessionNaming) ||
    !isAppearanceV5(value.appearance)
  ) {
    return false
  }
  return value.activeProjectKey === null || value.projects.some(({ path }) => path === value.activeProjectKey)
}

function isProjectConfigFileV8(value: unknown): value is ProjectConfigFileV8 {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 6 ||
    value.version !== 8 ||
    !Array.isArray(value.projects) ||
    !value.projects.every(isProject) ||
    new Set(value.projects.map(({ path }) => path)).size !== value.projects.length ||
    (typeof value.activeProjectKey !== 'string' && value.activeProjectKey !== null) ||
    !isSessionNaming(value.sessionNaming) ||
    !isAppearanceV8(value.appearance) ||
    !acceptsGeneral(value.general)
  ) {
    return false
  }
  return value.activeProjectKey === null || value.projects.some(({ path }) => path === value.activeProjectKey)
}

function isProjectConfigFileV9(value: unknown): value is ProjectConfigFileV9 {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 7 ||
    value.version !== 9 ||
    !Array.isArray(value.projects) ||
    !value.projects.every(isProject) ||
    new Set(value.projects.map(({ path }) => path)).size !== value.projects.length ||
    (typeof value.activeProjectKey !== 'string' && value.activeProjectKey !== null) ||
    !isSessionNaming(value.sessionNaming) ||
    !isAppearanceV8(value.appearance) ||
    !acceptsGeneral(value.general) ||
    !isShortcutSettings(value.shortcuts)
  ) {
    return false
  }
  return value.activeProjectKey === null || value.projects.some(({ path }) => path === value.activeProjectKey)
}

function isProjectConfigFile(value: unknown): value is ProjectConfigFile {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 8 ||
    value.version !== 13 ||
    !Array.isArray(value.projects) ||
    !value.projects.every(isProject) ||
    new Set(value.projects.map(({ path }) => path)).size !== value.projects.length ||
    (typeof value.activeProjectKey !== 'string' && value.activeProjectKey !== null) ||
    !isSessionNaming(value.sessionNaming) ||
    !isAppearance(value.appearance) ||
    !acceptsGeneral(value.general) ||
    !isShortcutSettings(value.shortcuts) ||
    !isSubagent(value.subagent)
  ) {
    return false
  }
  return value.activeProjectKey === null || value.projects.some(({ path }) => path === value.activeProjectKey)
}

function isProjectConfigFileV12(value: unknown): value is ProjectConfigFileV12 {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 8 ||
    value.version !== 12 ||
    !Array.isArray(value.projects) ||
    !value.projects.every(isProject) ||
    new Set(value.projects.map(({ path }) => path)).size !== value.projects.length ||
    (typeof value.activeProjectKey !== 'string' && value.activeProjectKey !== null) ||
    !isSessionNaming(value.sessionNaming) ||
    !isAppearanceV8(value.appearance) ||
    !acceptsGeneral(value.general) ||
    !isShortcutSettings(value.shortcuts) ||
    !isSubagent(value.subagent)
  ) {
    return false
  }
  return value.activeProjectKey === null || value.projects.some(({ path }) => path === value.activeProjectKey)
}

function isProjectConfigFileV11(value: unknown): value is ProjectConfigFileV11 {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 8 ||
    value.version !== 11 ||
    !Array.isArray(value.projects) ||
    !value.projects.every(isProject) ||
    new Set(value.projects.map(({ path }) => path)).size !== value.projects.length ||
    (typeof value.activeProjectKey !== 'string' && value.activeProjectKey !== null) ||
    !isSessionNaming(value.sessionNaming) ||
    !isAppearanceV8(value.appearance) ||
    !isGeneralV11(value.general) ||
    !isShortcutSettings(value.shortcuts) ||
    !isSubagent(value.subagent)
  ) {
    return false
  }
  return value.activeProjectKey === null || value.projects.some(({ path }) => path === value.activeProjectKey)
}

function isProjectConfigFileV10(value: unknown): value is ProjectConfigFileV10 {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 8 ||
    value.version !== 10 ||
    !Array.isArray(value.projects) ||
    !value.projects.every(isProject) ||
    new Set(value.projects.map(({ path }) => path)).size !== value.projects.length ||
    (typeof value.activeProjectKey !== 'string' && value.activeProjectKey !== null) ||
    !isSessionNaming(value.sessionNaming) ||
    !isAppearanceV8(value.appearance) ||
    !acceptsGeneral(value.general) ||
    !isShortcutSettings(value.shortcuts) ||
    !isLegacySubagentV10(value.subagent)
  ) {
    return false
  }
  return value.activeProjectKey === null || value.projects.some(({ path }) => path === value.activeProjectKey)
}

function isProjectConfigFileV7(value: unknown): value is ProjectConfigFileV7 {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 6 ||
    value.version !== 7 ||
    !Array.isArray(value.projects) ||
    !value.projects.every(isProject) ||
    new Set(value.projects.map(({ path }) => path)).size !== value.projects.length ||
    (typeof value.activeProjectKey !== 'string' && value.activeProjectKey !== null) ||
    !isSessionNaming(value.sessionNaming) ||
    !isAppearanceV7(value.appearance) ||
    !acceptsGeneral(value.general)
  ) {
    return false
  }
  return value.activeProjectKey === null || value.projects.some(({ path }) => path === value.activeProjectKey)
}

function isProjectConfigFileV6(value: unknown): value is ProjectConfigFileV6 {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 6 ||
    value.version !== 6 ||
    !Array.isArray(value.projects) ||
    !value.projects.every(isProject) ||
    new Set(value.projects.map(({ path }) => path)).size !== value.projects.length ||
    (typeof value.activeProjectKey !== 'string' && value.activeProjectKey !== null) ||
    !isSessionNaming(value.sessionNaming) ||
    !isAppearanceV5(value.appearance) ||
    !acceptsGeneral(value.general)
  ) {
    return false
  }
  return value.activeProjectKey === null || value.projects.some(({ path }) => path === value.activeProjectKey)
}

function isProjectConfigFileV4(value: unknown): value is ProjectConfigFileV4 {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 5 ||
    value.version !== 4 ||
    !Array.isArray(value.projects) ||
    !value.projects.every(isProject) ||
    new Set(value.projects.map(({ path }) => path)).size !== value.projects.length ||
    (typeof value.activeProjectKey !== 'string' && value.activeProjectKey !== null) ||
    !isSessionNaming(value.sessionNaming) ||
    !isAppearanceV4(value.appearance)
  ) {
    return false
  }
  return value.activeProjectKey === null || value.projects.some(({ path }) => path === value.activeProjectKey)
}

function toProjectConfigFile(configuration: ProjectConfiguration): ProjectConfigFile {
  return {
    version: 13,
    projects: configuration.projects.map((project) => ({ ...project })),
    activeProjectKey: configuration.activeProjectKey,
    sessionNaming: copySessionNaming(configuration.sessionNaming),
    appearance: copyAppearance(configuration.appearance),
    general: copyGeneral(configuration.general),
    shortcuts: copyShortcutSettings(configuration.shortcuts),
    subagent: copySubagent(configuration.subagent)
  }
}

function copyRegistry(registry: ProjectRegistry): ProjectRegistry {
  return {
    projects: registry.projects.map((project) => ({ ...project })),
    activeProjectKey: registry.activeProjectKey
  }
}

function copyConfiguration(configuration: ProjectConfiguration): ProjectConfiguration {
  return {
    ...copyRegistry(configuration),
    sessionNaming: copySessionNaming(configuration.sessionNaming),
    appearance: copyAppearance(configuration.appearance),
    general: requireGeneral(configuration.general),
    shortcuts: copyShortcutSettings(configuration.shortcuts),
    subagent: copySubagent(configuration.subagent)
  }
}

function copySessionNaming(settings: SessionNamingSettings): SessionNamingSettings {
  return settings.mode === 'model'
    ? { mode: 'model', provider: settings.provider, modelId: settings.modelId }
    : { mode: settings.mode }
}

function copyAppearance(settings: AppearanceSettings): AppearanceSettings {
  return {
    theme: settings.theme,
    accentColor: settings.accentColor,
    surfaceTransparency: settings.surfaceTransparency,
    textSize: settings.textSize,
    tokenCountFormat: settings.tokenCountFormat,
    uiFontFamily: settings.uiFontFamily,
    codeFontFamily: settings.codeFontFamily
  }
}

function copyGeneral(settings: GeneralSettings): GeneralSettings {
  return {
    startupWorkspaceRestore: settings.startupWorkspaceRestore,
    doubleClickBorderMaximize: settings.doubleClickBorderMaximize,
    fastExtensionLoading: settings.fastExtensionLoading
  }
}

function copyGeneralV11(
  settings: Pick<GeneralSettings, 'startupWorkspaceRestore' | 'doubleClickBorderMaximize'>
): Pick<GeneralSettings, 'startupWorkspaceRestore' | 'doubleClickBorderMaximize'> {
  return {
    startupWorkspaceRestore: settings.startupWorkspaceRestore,
    doubleClickBorderMaximize: settings.doubleClickBorderMaximize
  }
}

function copySubagent(settings: SubagentSettings): SubagentSettings {
  return {
    maxDepth: settings.maxDepth
  }
}

function assertSubagent(value: SubagentSettings): void {
  if (!isSubagent(value)) throw new Error('Invalid Pi GUI subagent settings.')
}

function isSubagent(value: unknown): value is SubagentSettings {
  return isRecord(value) &&
    Object.keys(value).length === 1 &&
    (value.maxDepth === 1 || value.maxDepth === 2 || value.maxDepth === 3)
}

function isLegacySubagentV10(value: unknown): value is LegacySubagentSettingsV10 {
  return isRecord(value) &&
    Object.keys(value).length === 2 &&
    (value.maxDepth === 1 || value.maxDepth === 2 || value.maxDepth === 3) &&
    typeof value.preventCycles === 'boolean'
}

function assertShortcuts(value: ShortcutSettings): void {
  if (!isShortcutSettings(value)) throw new Error('Invalid Pi GUI shortcut settings.')
}

function assertGeneral(value: GeneralSettings): void {
  if (!isGeneral(value)) throw new Error('Invalid Pi GUI general settings.')
}

function isGeneral(value: unknown): value is GeneralSettings {
  return isRecord(value) &&
    Object.keys(value).length === 3 &&
    (value.startupWorkspaceRestore === 'restore' || value.startupWorkspaceRestore === 'none') &&
    typeof value.doubleClickBorderMaximize === 'boolean' &&
    typeof value.fastExtensionLoading === 'boolean'
}

function isGeneralV11(
  value: unknown
): value is Pick<GeneralSettings, 'startupWorkspaceRestore' | 'doubleClickBorderMaximize'> {
  return isRecord(value) &&
    Object.keys(value).length === 2 &&
    (value.startupWorkspaceRestore === 'restore' || value.startupWorkspaceRestore === 'none') &&
    typeof value.doubleClickBorderMaximize === 'boolean'
}

function isLegacyGeneral(value: unknown): value is Pick<GeneralSettings, 'startupWorkspaceRestore'> {
  return isRecord(value) &&
    Object.keys(value).length === 1 &&
    (value.startupWorkspaceRestore === 'restore' || value.startupWorkspaceRestore === 'none')
}

type LegacyGeneralWithBorderFlag = {
  startupWorkspaceRestore: GeneralSettings['startupWorkspaceRestore']
  doubleClickBorderFullscreen?: boolean
  doubleClickBorderAction?: 'off' | 'maximize' | 'fullscreen'
}

function isLegacyGeneralWithBorderFlag(value: unknown): value is LegacyGeneralWithBorderFlag {
  if (!isRecord(value) || Object.keys(value).length !== 2) return false
  if (value.startupWorkspaceRestore !== 'restore' && value.startupWorkspaceRestore !== 'none') return false
  return typeof value.doubleClickBorderFullscreen === 'boolean' ||
    value.doubleClickBorderAction === 'off' ||
    value.doubleClickBorderAction === 'maximize' ||
    value.doubleClickBorderAction === 'fullscreen'
}

function normalizeGeneral(value: unknown): GeneralSettings | null {
  if (isGeneral(value)) return copyGeneral(value)
  if (isGeneralV11(value)) {
    return {
      ...copyGeneralV11(value),
      fastExtensionLoading: DEFAULT_GENERAL_SETTINGS.fastExtensionLoading
    }
  }
  if (isLegacyGeneralWithBorderFlag(value)) {
    const enabled = value.doubleClickBorderAction === undefined
      ? Boolean(value.doubleClickBorderFullscreen)
      : value.doubleClickBorderAction !== 'off'
    return {
      startupWorkspaceRestore: value.startupWorkspaceRestore,
      doubleClickBorderMaximize: enabled,
      fastExtensionLoading: DEFAULT_GENERAL_SETTINGS.fastExtensionLoading
    }
  }
  if (isLegacyGeneral(value)) {
    return {
      startupWorkspaceRestore: value.startupWorkspaceRestore,
      doubleClickBorderMaximize: DEFAULT_GENERAL_SETTINGS.doubleClickBorderMaximize,
      fastExtensionLoading: DEFAULT_GENERAL_SETTINGS.fastExtensionLoading
    }
  }
  return null
}

function acceptsGeneral(value: unknown): boolean {
  return normalizeGeneral(value) !== null
}

function requireGeneral(value: unknown): GeneralSettings {
  const general = normalizeGeneral(value)
  if (general === null) throw new Error('Invalid Pi GUI general settings.')
  return general
}

function assertAppearance(value: AppearanceSettings): void {
  if (!isAppearance(value)) throw new Error('Invalid Pi GUI appearance settings.')
}

function isAppearance(value: unknown): value is AppearanceSettings {
  return isRecord(value) &&
    Object.keys(value).length === 7 &&
    isAppearanceTheme(value.theme) &&
    isAppearanceAccentColor(value.accentColor) &&
    isSurfaceTransparency(value.surfaceTransparency) &&
    isTextSize(value.textSize) &&
    isTokenCountFormat(value.tokenCountFormat) &&
    isOptionalFontFamily(value.uiFontFamily) &&
    isOptionalFontFamily(value.codeFontFamily)
}

function isAppearanceV8(value: unknown): value is LegacyAppearanceSettingsV8 {
  return isRecord(value) &&
    Object.keys(value).length === 6 &&
    isAppearanceTheme(value.theme) &&
    isAppearanceAccentColor(value.accentColor) &&
    isSurfaceTransparency(value.surfaceTransparency) &&
    isTextSize(value.textSize) &&
    isOptionalFontFamily(value.uiFontFamily) &&
    isOptionalFontFamily(value.codeFontFamily)
}

function isAppearanceV7(value: unknown): value is LegacyAppearanceSettingsV7 {
  return isRecord(value) &&
    Object.keys(value).length === 5 &&
    isAppearanceTheme(value.theme) &&
    isAppearanceAccentColor(value.accentColor) &&
    isSurfaceTransparency(value.surfaceTransparency) &&
    isOptionalFontFamily(value.uiFontFamily) &&
    isOptionalFontFamily(value.codeFontFamily)
}

function isAppearanceV5(value: unknown): value is LegacyAppearanceSettingsV5 {
  return isRecord(value) &&
    Object.keys(value).length === 3 &&
    isAppearanceTheme(value.theme) &&
    isOptionalFontFamily(value.uiFontFamily) &&
    isOptionalFontFamily(value.codeFontFamily)
}

function isAppearanceV4(value: unknown): value is LegacyAppearanceSettingsV4 {
  return isRecord(value) &&
    Object.keys(value).length === 2 &&
    isOptionalFontFamily(value.uiFontFamily) &&
    isOptionalFontFamily(value.codeFontFamily)
}

function isAppearanceTheme(value: unknown): value is AppearanceSettings['theme'] {
  return value === 'system' || value === 'dark' || value === 'light'
}

function isAppearanceAccentColor(value: unknown): value is AppearanceSettings['accentColor'] {
  return value === 'amber' ||
    value === 'blue' ||
    value === 'green' ||
    value === 'purple' ||
    value === 'rose'
}

function isSurfaceTransparency(value: unknown): value is AppearanceSettings['surfaceTransparency'] {
  return value === 0 || value === 10 || value === 20 || value === 30 || value === 40
}

function isTextSize(value: unknown): value is AppearanceSettings['textSize'] {
  return value === 'small' || value === 'default' || value === 'large'
}

function isTokenCountFormat(value: unknown): value is AppearanceSettings['tokenCountFormat'] {
  return value === 'full' || value === 'compact'
}

function isOptionalFontFamily(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && value.trim().length > 0)
}

function assertSessionNaming(value: SessionNamingSettings): void {
  if (!isSessionNaming(value)) throw new Error('Invalid Pi GUI session naming settings.')
}

function isSessionNaming(value: unknown): value is SessionNamingSettings {
  if (!isRecord(value) || typeof value.mode !== 'string') return false
  if (value.mode === 'auto' || value.mode === 'off') {
    return Object.keys(value).length === 1
  }
  return value.mode === 'model' &&
    Object.keys(value).length === 3 &&
    typeof value.provider === 'string' &&
    value.provider.trim().length > 0 &&
    typeof value.modelId === 'string' &&
    value.modelId.trim().length > 0
}

function assertProject(project: { path: string }): void {
  if (!isProject(project)) throw new Error('Invalid Pi GUI project registration.')
}

function assertTaskKey(value: string): void {
  if (!isTaskKey(value)) throw new Error('Invalid Pi GUI task key.')
}

function isTaskKey(value: unknown): value is string {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)
}

function isTaskStateFile(value: unknown, taskRoot: string): value is TaskStateFile {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 4 ||
    value.version !== 1 ||
    !Array.isArray(value.tasks) ||
    (typeof value.activeTaskKey !== 'string' && value.activeTaskKey !== null) ||
    (value.navigatorKind !== 'project' && value.navigatorKind !== 'task')
  ) return false
  const tasks = value.tasks
  if (!tasks.every((task): task is TaskWorkspace =>
    isRecord(task) &&
    Object.keys(task).length === 2 &&
    isTaskKey(task.key) &&
    task.path === join(taskRoot, task.key)
  )) return false
  return new Set(tasks.map(({ key }) => key)).size === tasks.length &&
    new Set(tasks.map(({ path }) => path)).size === tasks.length &&
    (value.activeTaskKey === null || tasks.some(({ key }) => key === value.activeTaskKey))
}

function copyTaskState(state: TaskStateFile): TaskStateFile {
  return {
    version: 1,
    tasks: state.tasks.map((task) => ({ ...task })),
    activeTaskKey: state.activeTaskKey,
    navigatorKind: state.navigatorKind
  }
}

function copyTaskRegistry(state: TaskRegistry): TaskRegistry {
  return {
    tasks: state.tasks.map((task) => ({ ...task })),
    activeTaskKey: state.activeTaskKey,
    navigatorKind: state.navigatorKind
  }
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
    Object.keys(value).length !== 4 ||
    value.version !== 6 ||
    !Array.isArray(value.sessions) ||
    !Array.isArray(value.activeSessionKeys) ||
    !Array.isArray(value.archivedSessionKeys)
  ) return false
  return isProjectStateCollectionsValid(
    value.sessions,
    value.activeSessionKeys,
    value.archivedSessionKeys
  )
}

function isProjectStateFileV5(value: unknown): value is ProjectStateFileV5 {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 5 ||
    value.version !== 5 ||
    !Array.isArray(value.sessions) ||
    !Array.isArray(value.activeSessionKeys) ||
    !Array.isArray(value.archivedSessionKeys) ||
    !Array.isArray(value.manuallyOrderedProjectPaths)
  ) return false
  const sessions = value.sessions
  const manuallyOrderedProjectPaths = value.manuallyOrderedProjectPaths
  return (
    isProjectStateCollectionsValid(
      sessions,
      value.activeSessionKeys,
      value.archivedSessionKeys
    ) &&
    manuallyOrderedProjectPaths.every((path) =>
      typeof path === 'string' &&
      isAbsolute(path) &&
      sessions.some((pointer) => pointer.projectPath === path)
    ) &&
    new Set(manuallyOrderedProjectPaths).size === manuallyOrderedProjectPaths.length
  )
}

function isProjectStateFileV4(value: unknown): value is ProjectStateFileV4 {
  return (
    isRecord(value) &&
    Object.keys(value).length === 4 &&
    value.version === 4 &&
    Array.isArray(value.sessions) &&
    Array.isArray(value.activeSessionKeys) &&
    Array.isArray(value.archivedSessionKeys) &&
    isProjectStateCollectionsValid(
      value.sessions,
      value.activeSessionKeys,
      value.archivedSessionKeys
    )
  )
}

function isProjectStateCollectionsValid(
  sessions: unknown[],
  activeSessionKeys: unknown[],
  archivedSessionKeys: unknown[]
): sessions is SessionPointer[] {
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
    ) &&
    archivedSessionKeys.every(isActiveSessionSelection) &&
    new Set(archivedSessionKeys.map(({ projectPath, sessionKey }) =>
      `${projectPath}\u0000${sessionKey}`
    )).size === archivedSessionKeys.length &&
    archivedSessionKeys.every((selection) =>
      sessions.some((pointer) =>
        pointer.projectPath === selection.projectPath &&
        pointer.sessionFile === selection.sessionKey
      ) &&
      !activeSessionKeys.some((activeSelection) =>
        activeSelection.projectPath === selection.projectPath &&
        activeSelection.sessionKey === selection.sessionKey
      )
    )
  )
}

function isProjectStateFileV3(value: unknown): value is ProjectStateFileV3 {
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
    version: 6,
    sessions: pointers.map((pointer) => ({ ...pointer })),
    activeSessionKeys: pointers.map((pointer) => ({
      projectPath: pointer.projectPath,
      sessionKey: pointer.sessionFile
    })),
    archivedSessionKeys: []
  }
}

function migrateProjectStateV3(state: ProjectStateFileV3): ProjectStateFile {
  return {
    version: 6,
    sessions: state.sessions.map((pointer) => ({ ...pointer })),
    activeSessionKeys: state.activeSessionKeys.map((selection) => ({ ...selection })),
    archivedSessionKeys: []
  }
}

function migrateProjectStateV4(state: ProjectStateFileV4): ProjectStateFile {
  return {
    version: 6,
    sessions: state.sessions.map((pointer) => ({ ...pointer })),
    activeSessionKeys: state.activeSessionKeys.map((selection) => ({ ...selection })),
    archivedSessionKeys: state.archivedSessionKeys.map((selection) => ({ ...selection }))
  }
}

function migrateProjectStateV5(state: ProjectStateFileV5): ProjectStateFile {
  return {
    version: 6,
    sessions: state.sessions.map((pointer) => ({ ...pointer })),
    activeSessionKeys: state.activeSessionKeys.map((selection) => ({ ...selection })),
    archivedSessionKeys: state.archivedSessionKeys.map((selection) => ({ ...selection }))
  }
}

function copyProjectState(state: ProjectStateFile): ProjectStateFile {
  return {
    version: 6,
    sessions: state.sessions.map((pointer) => ({ ...pointer })),
    activeSessionKeys: state.activeSessionKeys.map((selection) => ({ ...selection })),
    archivedSessionKeys: state.archivedSessionKeys.map((selection) => ({ ...selection }))
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
