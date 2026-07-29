import { randomUUID } from 'node:crypto'
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'

import type {
  KernelSubagentDefinition,
  KernelSubagentEditableScope,
  KernelSubagentDefinitionInput,
  KernelSubagentDefinitionScope,
  ThinkingLevel
} from '../../shared/kernel-contract.ts'
import { resolvePiAgentDir } from '../extension/pi-extension-store.ts'

const SUPPORTED_THINKING_LEVELS = new Set<ThinkingLevel>([
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max'
])
const FRONTMATTER_ORDER = [
  'name',
  'package',
  'description',
  'tools',
  'model',
  'fallbackModels',
  'thinking',
  'systemPromptMode',
  'inheritProjectContext',
  'inheritSkills',
  'defaultContext',
  'async',
  'timeoutMs',
  'turnBudget',
  'acceptance',
  'acceptanceRole',
  'skill',
  'skills',
  'skillPath',
  'extensions',
  'subagentOnlyExtensions',
  'output',
  'defaultReads',
  'defaultProgress',
  'interactive',
  'maxSubagentDepth',
  'completionGuard',
  'toolBudget',
  'memory'
] as const
const MAX_AGENT_FILES = 500

type ParsedAgentFile = {
  frontmatter: Map<string, string>
  blockKeys: Set<string>
  body: string
}

type LoadedSubagentDefinition = {
  definition: KernelSubagentDefinition
  filePath: string
  parsed: ParsedAgentFile
}

type ParsedSubagentOverride = {
  model?: string | false
  fallbackModels?: string[] | false
  thinking?: ThinkingLevel | false
  systemPromptMode?: 'replace' | 'append'
  inheritProjectContext?: boolean
  inheritSkills?: boolean
  defaultContext?: 'fresh' | 'fork' | false
  disabled?: boolean
  systemPrompt?: string
  skills?: string[] | false
  tools?: string[] | false
}

type ParsedSubagentSettings = {
  raw: Record<string, unknown>
  overrides: Record<string, ParsedSubagentOverride>
  disableBuiltins: boolean | undefined
  disableThinking: boolean | undefined
  defaultModel: string | undefined
  defaultThinking: ThinkingLevel | undefined
}

type EffectiveSubagentOverride = {
  scope: KernelSubagentEditableScope
  value: ParsedSubagentOverride
}

export type SubagentDefinitionStoreOptions = {
  agentDir?: string
  userHome?: string
}

export class SubagentDefinitionStore {
  private readonly agentDir: string
  private readonly userHome: string

  constructor(options: SubagentDefinitionStoreOptions = {}) {
    this.agentDir = resolve(options.agentDir ?? resolvePiAgentDir())
    this.userHome = resolve(options.userHome ?? homedir())
  }

  async list(projectPath: string | null): Promise<KernelSubagentDefinition[]> {
    return (await this.loadAll(projectPath)).map(({ definition }) => definition)
  }

  async save(
    projectPath: string | null,
    input: KernelSubagentDefinitionInput
  ): Promise<KernelSubagentDefinition[]> {
    const loaded = await this.loadAll(projectPath)
    const original = input.originalId === null
      ? null
      : loaded.find(({ definition }) => definition.id === input.originalId) ?? null
    if (input.originalId !== null && original === null) {
      throw new Error('Subagent definition no longer exists.')
    }

    const targetDir = this.writeDirectory(input.scope, projectPath)
    const targetPath = join(targetDir, `${input.name}.md`)
    const originalEditablePath = original?.definition.editable === true ? original.filePath : null
    if (
      await pathExists(targetPath) &&
      (originalEditablePath === null || resolve(originalEditablePath) !== resolve(targetPath))
    ) {
      throw new Error(`Subagent definition already exists: ${input.name}`)
    }

    const frontmatter = new Map(original?.parsed.frontmatter ?? [])
    const blockKeys = new Set(original?.parsed.blockKeys ?? [])
    setFrontmatter(frontmatter, 'name', input.name)
    setFrontmatter(frontmatter, 'description', input.description)
    setOptionalFrontmatter(frontmatter, 'model', input.model)
    setOptionalListFrontmatter(frontmatter, 'fallbackModels', input.fallbackModels)
    setOptionalFrontmatter(frontmatter, 'thinking', input.thinking)
    setFrontmatter(frontmatter, 'systemPromptMode', input.systemPromptMode)
    setFrontmatter(
      frontmatter,
      'inheritProjectContext',
      input.inheritProjectContext ? 'true' : 'false'
    )
    setFrontmatter(frontmatter, 'inheritSkills', input.inheritSkills ? 'true' : 'false')
    setOptionalFrontmatter(frontmatter, 'defaultContext', input.defaultContext)
    setOptionalListFrontmatter(frontmatter, 'tools', input.tools)
    setOptionalListFrontmatter(frontmatter, 'skills', input.skills)
    setOptionalFrontmatter(
      frontmatter,
      'async',
      input.defaultAsync === null ? null : input.defaultAsync ? 'true' : 'false'
    )
    setOptionalFrontmatter(
      frontmatter,
      'timeoutMs',
      input.timeoutMs === null ? null : String(input.timeoutMs)
    )
    setTurnBudget(frontmatter, input.maxTurns)
    setOptionalFrontmatter(
      frontmatter,
      'maxSubagentDepth',
      input.maxSubagentDepth === null ? null : String(input.maxSubagentDepth)
    )
    for (const key of [
      'name',
      'description',
      'model',
      'fallbackModels',
      'thinking',
      'systemPromptMode',
      'inheritProjectContext',
      'inheritSkills',
      'defaultContext',
      'tools',
      'skills',
      'async',
      'timeoutMs',
      'turnBudget',
      'maxSubagentDepth'
    ]) {
      blockKeys.delete(key)
    }

    await mkdir(targetDir, { recursive: true })
    await writeFileAtomically(
      targetPath,
      serializeAgent(frontmatter, blockKeys, input.systemPrompt)
    )
    if (
      originalEditablePath !== null &&
      resolve(originalEditablePath) !== resolve(targetPath)
    ) {
      await unlink(originalEditablePath)
    }
    return this.list(projectPath)
  }

  async remove(projectPath: string | null, id: string): Promise<KernelSubagentDefinition[]> {
    const target = (await this.loadAll(projectPath)).find(
      ({ definition }) => definition.id === id
    )
    if (target === undefined || !target.definition.editable) {
      throw new Error('Only user or project Subagent definitions can be deleted.')
    }
    await unlink(target.filePath)
    return this.list(projectPath)
  }

  async setEnabled(
    projectPath: string | null,
    id: string,
    scope: KernelSubagentEditableScope,
    enabled: boolean
  ): Promise<KernelSubagentDefinition[]> {
    const target = (await this.loadAll(projectPath)).find(
      ({ definition }) => definition.id === id
    )
    if (target === undefined) throw new Error('Subagent definition no longer exists.')
    const settingsPath = this.settingsPath(scope, projectPath)
    const settings = await readSubagentSettings(settingsPath)
    const subagents = recordValue(settings.raw.subagents) ?? {}
    const overrides = recordValue(subagents.agentOverrides) ?? {}
    const existing = recordValue(overrides[target.definition.name]) ?? {}
    if (enabled && existing.disabled === undefined) return this.list(projectPath)

    const nextEntry = { ...existing }
    if (enabled) delete nextEntry.disabled
    else nextEntry.disabled = true
    const nextOverrides = { ...overrides }
    if (Object.keys(nextEntry).length === 0) delete nextOverrides[target.definition.name]
    else nextOverrides[target.definition.name] = nextEntry
    const nextSubagents = { ...subagents }
    if (Object.keys(nextOverrides).length === 0) delete nextSubagents.agentOverrides
    else nextSubagents.agentOverrides = nextOverrides
    const nextSettings = { ...settings.raw }
    if (Object.keys(nextSubagents).length === 0) delete nextSettings.subagents
    else nextSettings.subagents = nextSubagents

    await mkdir(dirname(settingsPath), { recursive: true })
    await writeFileAtomically(settingsPath, `${JSON.stringify(nextSettings, null, 2)}\n`)
    return this.list(projectPath)
  }

  private async loadAll(projectPath: string | null): Promise<LoadedSubagentDefinition[]> {
    const builtinDir = join(this.agentDir, 'npm', 'node_modules', 'pi-subagents', 'agents')
    const userOldDir = join(this.agentDir, 'agents')
    const userNewDir = join(this.userHome, '.agents')
    const projectSettingsPath = projectPath === null
      ? null
      : this.settingsPath('project', projectPath)
    const [builtin, user, project, userSettings, projectSettings] = await Promise.all([
      loadScope('builtin', [builtinDir]),
      loadScope('user', [userOldDir, userNewDir]),
      projectPath === null
        ? Promise.resolve([])
        : loadScope('project', [
            join(projectPath, '.agents'),
            join(projectPath, '.pi', 'agents')
          ]),
      readSubagentSettings(this.settingsPath('user', projectPath)),
      projectSettingsPath === null
        ? Promise.resolve(emptySubagentSettings())
        : readSubagentSettings(projectSettingsPath)
    ])
    return [...builtin, ...user, ...project].map((loaded) => ({
      ...loaded,
      definition: applySubagentSettings(loaded, userSettings, projectSettings)
    }))
  }

  private writeDirectory(
    scope: KernelSubagentDefinitionInput['scope'],
    projectPath: string | null
  ): string {
    if (scope === 'project') {
      if (projectPath === null) {
        throw new Error('Select a Project before creating a project Subagent.')
      }
      return join(projectPath, '.pi', 'agents')
    }
    if (process.env.PI_CODING_AGENT_DIR !== undefined) {
      return join(this.agentDir, 'agents')
    }
    return join(this.userHome, '.agents')
  }

  private settingsPath(scope: KernelSubagentEditableScope, projectPath: string | null): string {
    if (scope === 'project') {
      if (projectPath === null) {
        throw new Error('Select a Project before changing a project Subagent setting.')
      }
      return join(projectPath, '.pi', 'settings.json')
    }
    return join(this.agentDir, 'settings.json')
  }
}

async function loadScope(
  scope: KernelSubagentDefinitionScope,
  directories: readonly string[]
): Promise<LoadedSubagentDefinition[]> {
  const byName = new Map<string, LoadedSubagentDefinition>()
  let fileCount = 0
  for (const directory of directories) {
    for (const filePath of await listAgentFiles(directory)) {
      if (isLegacyAgentSkillPath(directory, filePath)) continue
      fileCount += 1
      if (fileCount > MAX_AGENT_FILES) {
        throw new Error(`Too many ${scope} Subagent definition files.`)
      }
      const loaded = await loadAgentFile(scope, directory, filePath)
      if (loaded !== null) byName.set(loaded.definition.name, loaded)
    }
  }
  return [...byName.values()].sort((left, right) =>
    left.definition.name.localeCompare(right.definition.name)
  )
}

async function listAgentFiles(directory: string): Promise<string[]> {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (isNotFound(error)) return []
    throw error
  }
  const files: string[] = []
  for (const entry of entries) {
    const entryPath = join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...await listAgentFiles(entryPath))
    } else if (
      entry.isFile() &&
      entry.name.endsWith('.md') &&
      !entry.name.endsWith('.chain.md')
    ) {
      files.push(entryPath)
    }
  }
  return files.sort()
}

function isLegacyAgentSkillPath(rootDirectory: string, filePath: string): boolean {
  const parts = relative(rootDirectory, filePath)
    .split(/[/\\]/u)
    .map((part) => part.toLocaleLowerCase())
  if (basename(rootDirectory).toLocaleLowerCase() === '.agents') parts.unshift('.agents')
  return parts.some((part, index) => part === '.agents' && parts[index + 1] === 'skills')
}

function emptySubagentSettings(): ParsedSubagentSettings {
  return {
    raw: {},
    overrides: {},
    disableBuiltins: undefined,
    disableThinking: undefined,
    defaultModel: undefined,
    defaultThinking: undefined
  }
}

async function readSubagentSettings(filePath: string): Promise<ParsedSubagentSettings> {
  if (!await pathExists(filePath)) return emptySubagentSettings()
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(filePath, 'utf8'))
  } catch (error) {
    throw new Error(`Failed to parse Subagent settings '${filePath}': ${errorMessage(error)}`)
  }
  const raw = recordValue(parsed)
  if (raw === null) throw new Error(`Subagent settings '${filePath}' must contain a JSON object.`)
  if (raw.subagents === undefined) return { ...emptySubagentSettings(), raw }
  const subagents = recordValue(raw.subagents)
  if (subagents === null) {
    throw new Error(`Subagent settings '${filePath}' has invalid 'subagents'.`)
  }
  const disableBuiltins = optionalSettingBoolean(
    subagents.disableBuiltins,
    'disableBuiltins',
    filePath
  )
  const disableThinking = optionalSettingBoolean(
    subagents.disableThinking,
    'disableThinking',
    filePath
  )
  const defaultModel = optionalSettingText(subagents.defaultModel, 'defaultModel', filePath)
  const defaultThinking = optionalSettingThinking(
    subagents.defaultThinking,
    'defaultThinking',
    filePath
  )
  const rawOverrides = subagents.agentOverrides
  if (rawOverrides === undefined) {
    return {
      raw,
      overrides: {},
      disableBuiltins,
      disableThinking,
      defaultModel,
      defaultThinking
    }
  }
  const overrides = recordValue(rawOverrides)
  if (overrides === null) {
    throw new Error(`Subagent settings '${filePath}' has invalid 'agentOverrides'.`)
  }
  const parsedOverrides: Record<string, ParsedSubagentOverride> = {}
  for (const [name, value] of Object.entries(overrides)) {
    parsedOverrides[name] = parseSubagentOverride(name, value, filePath)
  }
  return {
    raw,
    overrides: parsedOverrides,
    disableBuiltins,
    disableThinking,
    defaultModel,
    defaultThinking
  }
}

function applySubagentSettings(
  loaded: LoadedSubagentDefinition,
  userSettings: ParsedSubagentSettings,
  projectSettings: ParsedSubagentSettings
): KernelSubagentDefinition {
  let definition = applySubagentDefaults(loaded, userSettings, projectSettings)
  const effectiveOverride = loaded.definition.scope === 'builtin'
    ? builtinOverride(loaded.definition.name, userSettings, projectSettings)
    : customOverride(loaded.definition.name, userSettings, projectSettings)
  if (effectiveOverride !== null) {
    definition = loaded.definition.scope === 'builtin'
      ? applyBuiltinDefinitionOverride(definition, effectiveOverride.value)
      : applyCustomDefinitionOverride(loaded, definition, effectiveOverride.value)
  }
  if (loaded.definition.scope === 'builtin') {
    const projectThinkingConfigured = projectSettings.disableThinking !== undefined
    const disableThinking = projectThinkingConfigured
      ? projectSettings.disableThinking === true
      : userSettings.disableThinking === true
    const explicitThinkingSurvives = effectiveOverride !== null &&
      effectiveOverride.value.thinking !== undefined &&
      !(effectiveOverride.scope === 'user' && projectThinkingConfigured)
    if (disableThinking && !explicitThinkingSurvives) definition.thinking = null
  }
  return definition
}

function applySubagentDefaults(
  loaded: LoadedSubagentDefinition,
  userSettings: ParsedSubagentSettings,
  projectSettings: ParsedSubagentSettings
): KernelSubagentDefinition {
  const definition = { ...loaded.definition }
  if (!loaded.parsed.frontmatter.has('model')) {
    definition.model = projectSettings.defaultModel ?? userSettings.defaultModel ?? null
  }
  if (!loaded.parsed.frontmatter.has('thinking')) {
    definition.thinking = projectSettings.defaultThinking ?? userSettings.defaultThinking ?? null
  }
  return definition
}

function builtinOverride(
  name: string,
  userSettings: ParsedSubagentSettings,
  projectSettings: ParsedSubagentSettings
): EffectiveSubagentOverride | null {
  const projectOverride = projectSettings.overrides[name]
  if (projectOverride !== undefined) return { scope: 'project', value: projectOverride }
  if (projectSettings.disableBuiltins === true) {
    return { scope: 'project', value: { disabled: true } }
  }
  const userOverride = userSettings.overrides[name]
  if (userOverride !== undefined) return { scope: 'user', value: userOverride }
  if (
    projectSettings.disableBuiltins === undefined &&
    userSettings.disableBuiltins === true
  ) {
    return { scope: 'user', value: { disabled: true } }
  }
  return null
}

function customOverride(
  name: string,
  userSettings: ParsedSubagentSettings,
  projectSettings: ParsedSubagentSettings
): EffectiveSubagentOverride | null {
  const projectOverride = projectSettings.overrides[name]
  if (projectOverride !== undefined) return { scope: 'project', value: projectOverride }
  const userOverride = userSettings.overrides[name]
  return userOverride === undefined ? null : { scope: 'user', value: userOverride }
}

function applyBuiltinDefinitionOverride(
  definition: KernelSubagentDefinition,
  override: ParsedSubagentOverride
): KernelSubagentDefinition {
  const next = { ...definition }
  applyDefinitionOverride(next, override, () => true, true)
  return next
}

function applyCustomDefinitionOverride(
  loaded: LoadedSubagentDefinition,
  definition: KernelSubagentDefinition,
  override: ParsedSubagentOverride
): KernelSubagentDefinition {
  const next = { ...definition }
  applyDefinitionOverride(
    next,
    override,
    (...keys) => !keys.some((key) => loaded.parsed.frontmatter.has(key)),
    false
  )
  return next
}

function applyDefinitionOverride(
  definition: KernelSubagentDefinition,
  override: ParsedSubagentOverride,
  canApply: (...frontmatterKeys: string[]) => boolean,
  includeSystemPrompt: boolean
): void {
  if (override.model !== undefined && canApply('model')) {
    definition.model = override.model === false ? null : override.model
  }
  if (override.fallbackModels !== undefined && canApply('fallbackModels')) {
    definition.fallbackModels = override.fallbackModels === false
      ? null
      : [...override.fallbackModels]
  }
  if (override.thinking !== undefined && canApply('thinking')) {
    definition.thinking = override.thinking === false ? null : override.thinking
  }
  if (override.systemPromptMode !== undefined && canApply('systemPromptMode')) {
    definition.systemPromptMode = override.systemPromptMode
  }
  if (
    override.inheritProjectContext !== undefined &&
    canApply('inheritProjectContext')
  ) {
    definition.inheritProjectContext = override.inheritProjectContext
  }
  if (override.inheritSkills !== undefined && canApply('inheritSkills')) {
    definition.inheritSkills = override.inheritSkills
  }
  if (override.defaultContext !== undefined && canApply('defaultContext')) {
    definition.defaultContext = override.defaultContext === false ? null : override.defaultContext
  }
  if (override.disabled !== undefined) definition.enabled = override.disabled !== true
  if (includeSystemPrompt && override.systemPrompt !== undefined) {
    definition.systemPrompt = override.systemPrompt
  }
  if (override.skills !== undefined && canApply('skill', 'skills')) {
    definition.skills = override.skills === false ? null : [...override.skills]
  }
  if (override.tools !== undefined && canApply('tools')) {
    definition.tools = override.tools === false ? [] : [...override.tools]
  }
}

function parseSubagentOverride(
  name: string,
  value: unknown,
  filePath: string
): ParsedSubagentOverride {
  const entry = recordValue(value)
  if (entry === null) {
    throw new Error(`Subagent override '${name}' in '${filePath}' must be an object.`)
  }
  const prefix = `Subagent override '${name}' in '${filePath}'`
  const override: ParsedSubagentOverride = {}
  if (entry.model !== undefined) {
    override.model = settingTextOrFalse(entry.model, 'model', prefix)
  }
  if (entry.fallbackModels !== undefined) {
    override.fallbackModels = settingListOrFalse(entry.fallbackModels, 'fallbackModels', prefix)
  }
  if (entry.thinking !== undefined) {
    override.thinking = settingThinkingOrFalse(entry.thinking, 'thinking', prefix)
  }
  if (entry.systemPromptMode !== undefined) {
    if (entry.systemPromptMode !== 'replace' && entry.systemPromptMode !== 'append') {
      throw new Error(`${prefix} has invalid 'systemPromptMode'.`)
    }
    override.systemPromptMode = entry.systemPromptMode
  }
  if (entry.inheritProjectContext !== undefined) {
    override.inheritProjectContext = settingBoolean(
      entry.inheritProjectContext,
      'inheritProjectContext',
      prefix
    )
  }
  if (entry.inheritSkills !== undefined) {
    override.inheritSkills = settingBoolean(entry.inheritSkills, 'inheritSkills', prefix)
  }
  if (entry.defaultContext !== undefined) {
    if (
      entry.defaultContext !== 'fresh' &&
      entry.defaultContext !== 'fork' &&
      entry.defaultContext !== false
    ) {
      throw new Error(`${prefix} has invalid 'defaultContext'.`)
    }
    override.defaultContext = entry.defaultContext
  }
  if (entry.disabled !== undefined) {
    override.disabled = settingBoolean(entry.disabled, 'disabled', prefix)
  }
  if (entry.systemPrompt !== undefined) {
    if (typeof entry.systemPrompt !== 'string') {
      throw new Error(`${prefix} has invalid 'systemPrompt'.`)
    }
    override.systemPrompt = entry.systemPrompt
  }
  if (entry.skills !== undefined) {
    override.skills = settingListOrFalse(entry.skills, 'skills', prefix)
  }
  if (entry.tools !== undefined) {
    override.tools = settingListOrFalse(entry.tools, 'tools', prefix)
  }
  return override
}

function optionalSettingBoolean(
  value: unknown,
  field: string,
  filePath: string
): boolean | undefined {
  if (value === undefined) return undefined
  return settingBoolean(value, field, `Subagent settings '${filePath}'`)
}

function optionalSettingText(
  value: unknown,
  field: string,
  filePath: string
): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Subagent settings '${filePath}' has invalid '${field}'.`)
  }
  return value.trim()
}

function optionalSettingThinking(
  value: unknown,
  field: string,
  filePath: string
): ThinkingLevel | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !SUPPORTED_THINKING_LEVELS.has(value as ThinkingLevel)) {
    throw new Error(`Subagent settings '${filePath}' has invalid '${field}'.`)
  }
  return value as ThinkingLevel
}

function settingBoolean(value: unknown, field: string, prefix: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${prefix} has invalid '${field}'.`)
  return value
}

function settingTextOrFalse(value: unknown, field: string, prefix: string): string | false {
  if (value === false) return false
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${prefix} has invalid '${field}'.`)
  }
  return value.trim()
}

function settingThinkingOrFalse(
  value: unknown,
  field: string,
  prefix: string
): ThinkingLevel | false {
  if (value === false) return false
  if (typeof value !== 'string' || !SUPPORTED_THINKING_LEVELS.has(value as ThinkingLevel)) {
    throw new Error(`${prefix} has invalid '${field}'.`)
  }
  return value as ThinkingLevel
}

function settingListOrFalse(
  value: unknown,
  field: string,
  prefix: string
): string[] | false {
  if (value === false) return false
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${prefix} has invalid '${field}'.`)
  }
  return value.map((item) => item.trim()).filter(Boolean)
}

async function loadAgentFile(
  scope: KernelSubagentDefinitionScope,
  root: string,
  filePath: string
): Promise<LoadedSubagentDefinition | null> {
  const parsed = parseAgentFile(await readFile(filePath, 'utf8'))
  const name = parsed.frontmatter.get('name')?.trim()
  const description = parsed.frontmatter.get('description')?.trim()
  if (
    name === undefined ||
    description === undefined ||
    !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(name)
  ) {
    return null
  }
  const thinkingValue = parsed.frontmatter.get('thinking')
  const thinking = thinkingValue !== undefined &&
    SUPPORTED_THINKING_LEVELS.has(thinkingValue as ThinkingLevel)
    ? thinkingValue as ThinkingLevel
    : null
  const timeoutMs = positiveInteger(parsed.frontmatter.get('timeoutMs'))
  const maxSubagentDepth = nonNegativeInteger(parsed.frontmatter.get('maxSubagentDepth'))
  const turnBudget = jsonRecord(parsed.frontmatter.get('turnBudget'))
  const maxTurns = positiveInteger(turnBudget?.maxTurns)
  const relativePath = relative(root, filePath)
  const id = `${scope}:${Buffer.from(relativePath).toString('base64url')}`

  return {
    filePath,
    parsed,
    definition: {
      id,
      scope,
      editable: scope !== 'builtin',
      enabled: true,
      name,
      description,
      systemPrompt: parsed.body,
      model: optionalText(parsed.frontmatter.get('model')),
      fallbackModels: optionalList(parsed.frontmatter.get('fallbackModels')),
      thinking,
      systemPromptMode: parsed.frontmatter.get('systemPromptMode') === 'append'
        ? 'append'
        : 'replace',
      inheritProjectContext: parsed.frontmatter.get('inheritProjectContext') === 'true',
      inheritSkills: parsed.frontmatter.get('inheritSkills') === 'true',
      defaultContext: parseDefaultContext(parsed.frontmatter.get('defaultContext')),
      tools: optionalList(parsed.frontmatter.get('tools')),
      skills: optionalList(
        parsed.frontmatter.get('skills') ?? parsed.frontmatter.get('skill')
      ),
      defaultAsync: optionalBoolean(parsed.frontmatter.get('async')),
      timeoutMs,
      maxTurns,
      maxSubagentDepth
    }
  }
}

function parseAgentFile(content: string): ParsedAgentFile {
  const normalized = content.replace(/\r\n/gu, '\n')
  if (!normalized.startsWith('---\n')) {
    return { frontmatter: new Map(), blockKeys: new Set(), body: normalized.trim() }
  }
  const endIndex = normalized.indexOf('\n---', 4)
  if (endIndex === -1) {
    return { frontmatter: new Map(), blockKeys: new Set(), body: normalized.trim() }
  }
  const frontmatter = new Map<string, string>()
  const blockKeys = new Set<string>()
  const lines = normalized.slice(4, endIndex).split('\n')
  let index = 0
  while (index < lines.length) {
    const line = lines[index]!
    const match = line.match(/^([\w-]+):\s*(.*)$/u)
    if (match === null) {
      index += 1
      continue
    }
    const key = match[1]!
    const rawValue = match[2]!.trim()
    if (rawValue !== '' && rawValue !== '>' && rawValue !== '>-') {
      frontmatter.set(key, unquote(rawValue))
      index += 1
      continue
    }
    index += 1
    const block: string[] = []
    while (index < lines.length && (/^\s/u.test(lines[index]!) || lines[index] === '')) {
      block.push(lines[index]!.replace(/^ {2}/u, ''))
      index += 1
    }
    frontmatter.set(key, block.join('\n').trim())
    blockKeys.add(key)
  }
  return {
    frontmatter,
    blockKeys,
    body: normalized.slice(endIndex + 4).trim()
  }
}

function serializeAgent(
  frontmatter: ReadonlyMap<string, string>,
  blockKeys: ReadonlySet<string>,
  body: string
): string {
  const lines = ['---']
  const written = new Set<string>()
  for (const key of FRONTMATTER_ORDER) {
    const value = frontmatter.get(key)
    if (value === undefined) continue
    appendFrontmatter(lines, key, value, blockKeys.has(key))
    written.add(key)
  }
  for (const [key, value] of frontmatter) {
    if (!written.has(key)) appendFrontmatter(lines, key, value, blockKeys.has(key))
  }
  lines.push('---', '', body.trim(), '')
  return lines.join('\n')
}

function appendFrontmatter(
  lines: string[],
  key: string,
  value: string,
  block: boolean
): void {
  if (!block && !value.includes('\n')) {
    lines.push(`${key}: ${value}`)
    return
  }
  lines.push(`${key}:`)
  lines.push(...value.split('\n').map((line) => `  ${line}`))
}

function setFrontmatter(frontmatter: Map<string, string>, key: string, value: string): void {
  frontmatter.set(key, value)
}

function setOptionalFrontmatter(
  frontmatter: Map<string, string>,
  key: string,
  value: string | null
): void {
  if (value === null) frontmatter.delete(key)
  else frontmatter.set(key, value)
}

function setOptionalListFrontmatter(
  frontmatter: Map<string, string>,
  key: string,
  value: string[] | null
): void {
  setOptionalFrontmatter(frontmatter, key, value === null ? null : value.join(', '))
}

function setTurnBudget(frontmatter: Map<string, string>, maxTurns: number | null): void {
  if (maxTurns === null) {
    frontmatter.delete('turnBudget')
    return
  }
  const existing = jsonRecord(frontmatter.get('turnBudget')) ?? {}
  frontmatter.set('turnBudget', JSON.stringify({ ...existing, maxTurns }))
}

async function writeFileAtomically(filePath: string, content: string): Promise<void> {
  const temporaryPath = join(
    dirname(filePath),
    `.${basename(filePath)}.${randomUUID()}.tmp`
  )
  try {
    await writeFile(temporaryPath, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    await rename(temporaryPath, filePath)
  } finally {
    await unlink(temporaryPath).catch((error: unknown) => {
      if (!isNotFound(error)) throw error
    })
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    const stat = await lstat(filePath)
    return stat.isFile() || stat.isSymbolicLink()
  } catch (error) {
    if (isNotFound(error)) return false
    throw error
  }
}

function optionalText(value: string | undefined): string | null {
  return value === undefined || value.trim() === '' ? null : value.trim()
}

function optionalList(value: string | undefined): string[] | null {
  if (value === undefined) return null
  const items = value
    .split('\n')
    .flatMap((line) => {
      const trimmed = line.trim()
      return (trimmed.match(/^-\s+(.+)$/u)?.[1] ?? trimmed).split(',')
    })
    .map((item) => item.trim())
    .filter(Boolean)
  return items.length === 0 ? null : items
}

function optionalBoolean(value: string | undefined): boolean | null {
  if (value === 'true') return true
  if (value === 'false') return false
  return null
}

function parseDefaultContext(value: string | undefined): 'fresh' | 'fork' | null {
  return value === 'fresh' || value === 'fork' ? value : null
}

function positiveInteger(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

function nonNegativeInteger(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null
}

function jsonRecord(value: string | undefined): Record<string, unknown> | null {
  if (value === undefined || value.trim() === '') return null
  try {
    const parsed: unknown = JSON.parse(value)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function unquote(value: string): string {
  return (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) ? value.slice(1, -1) : value
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
}
