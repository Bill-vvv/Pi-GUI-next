import { randomUUID } from 'node:crypto'
import {
  lstat,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, parse, resolve } from 'node:path'

import {
  isAlias,
  isMap,
  isScalar,
  isSeq,
  parseDocument,
  type Document,
  type Node
} from 'yaml'

import {
  ADVISOR_TOOL_NAMES,
  type KernelAdvisorConfiguration,
  type KernelAdvisorDefinition,
  type KernelAdvisorDefinitionInput,
  type KernelAdvisorDefinitionScope,
  type KernelAdvisorDiagnostic,
  type KernelAdvisorEditableScope,
  type KernelAdvisorSource,
  type KernelAdvisorToolName,
  type ThinkingLevel
} from '../../shared/kernel-contract.ts'
import { resolvePiAgentDir } from '../extension/pi-extension-store.ts'

const CONFIG_NAMES = ['WATCHDOG.yml', 'WATCHDOG.yaml'] as const
const SOURCE_NAMES = [...CONFIG_NAMES, 'WATCHDOG.md'] as const
const THINKING_LEVELS = new Set<ThinkingLevel>([
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max'
])
const TOOL_NAMES = new Set<string>(ADVISOR_TOOL_NAMES)
const DEFAULT_TOOLS: KernelAdvisorToolName[] = ['read', 'grep', 'find', 'ls']
const MAX_NAME_CHARS = 128
const MAX_MODEL_CHARS = 256
const MAX_INSTRUCTIONS_CHARS = 100_000

type Candidate = {
  path: string
  scope: KernelAdvisorDefinitionScope
  editable: boolean
}

type ParsedRoster = {
  instructions: string
  definitions: Array<{
    slug: string
    name: string
    enabled: boolean
    model: string | null
    thinking: ThinkingLevel | null
    tools: KernelAdvisorToolName[]
    instructions: string
  }>
}

export type AdvisorDefinitionStoreOptions = {
  agentDir?: string
  userHome?: string
}

export class AdvisorDefinitionStore {
  private readonly agentDir: string
  private readonly userHome: string

  constructor(options: AdvisorDefinitionStoreOptions = {}) {
    this.agentDir = resolve(options.agentDir ?? resolvePiAgentDir())
    this.userHome = resolve(options.userHome ?? homedir())
  }

  async list(projectPath: string | null): Promise<KernelAdvisorConfiguration> {
    const definitions: KernelAdvisorDefinition[] = [{
      id: 'builtin:default-advisor',
      slug: 'default-advisor',
      scope: 'builtin',
      sourcePath: null,
      sourceOrder: 0,
      editable: false,
      name: 'Default Advisor',
      enabled: true,
      model: 'gpt-5.6-sol',
      thinking: 'medium',
      tools: [...DEFAULT_TOOLS],
      instructions: ''
    }]
    const sources: KernelAdvisorSource[] = [{
      id: 'builtin:default-advisor',
      scope: 'builtin',
      path: null,
      sourceOrder: 0,
      editable: false,
      instructions: ''
    }]
    const diagnostics: KernelAdvisorDiagnostic[] = []
    let sourceOrder = 1

    for (const candidate of await this.candidates(projectPath)) {
      let content: string
      try {
        content = await readFile(candidate.path, 'utf8')
      } catch (error) {
        if (isNotFound(error)) continue
        diagnostics.push({ sourcePath: candidate.path, message: errorMessage(error) })
        continue
      }

      if (candidate.path.endsWith('.md')) {
        sources.push(source(candidate, sourceOrder, content))
        sourceOrder += 1
        continue
      }

      const parsed = parseRosterForDiscovery(candidate.path, content, diagnostics)
      if (parsed === null) continue
      sources.push(source(candidate, sourceOrder, parsed.instructions))
      for (const definition of parsed.definitions) {
        definitions.push({
          id: `${candidate.scope}:${sourceOrder}:${definition.slug}`,
          scope: candidate.scope,
          sourcePath: candidate.path,
          sourceOrder,
          editable: candidate.editable,
          ...definition
        })
      }
      sourceOrder += 1
    }
    return { definitions, sources, diagnostics }
  }

  async save(
    projectPath: string | null,
    input: KernelAdvisorDefinitionInput
  ): Promise<KernelAdvisorConfiguration> {
    assertDefinitionInput(input)
    const filePath = await this.editPath(input.scope, projectPath)
    const document = await readDocumentForEdit(filePath)
    const advisors = ensureAdvisorSequence(document)
    const parsed = parseAdvisorNodes(filePath, advisors.items)
    const originalIndex = input.originalSlug === null
      ? -1
      : parsed.findIndex(({ slug }) => slug === input.originalSlug)
    if (input.originalSlug !== null && originalIndex === -1) {
      throw new Error('Advisor definition no longer exists in the selected scope.')
    }
    const slug = slugifyAdvisorName(input.name)
    if (parsed.some(({ slug: candidate }, index) =>
      candidate === slug && index !== originalIndex
    )) {
      throw new Error(`Advisor definition already exists: ${slug}`)
    }

    const node = originalIndex === -1
      ? document.createNode({})
      : advisors.items[originalIndex]
    if (!isMap(node)) throw new Error(`Unsafe advisor structure in '${filePath}'.`)
    node.set('name', input.name)
    node.set('enabled', input.enabled)
    setOptionalMapValue(node, 'model', input.model)
    setOptionalMapValue(node, 'thinking', input.thinking)
    node.set('tools', [...input.tools])
    setOptionalMapValue(node, 'instructions', input.instructions === '' ? null : input.instructions)
    if (originalIndex === -1) advisors.items.push(node)

    await mkdir(dirname(filePath), { recursive: true })
    await writeFileAtomically(filePath, document.toString())
    return this.list(projectPath)
  }

  async remove(
    projectPath: string | null,
    slug: string,
    scope: KernelAdvisorEditableScope
  ): Promise<KernelAdvisorConfiguration> {
    assertSlug(slug, 'slug')
    if (scope !== 'user' && scope !== 'project') {
      throw new Error('Only user or project Advisor definitions can be deleted.')
    }
    const filePath = await this.editPath(scope, projectPath)
    if (!await pathExists(filePath)) throw new Error('Advisor definition no longer exists.')
    const document = await readDocumentForEdit(filePath)
    const advisors = ensureAdvisorSequence(document)
    const parsed = parseAdvisorNodes(filePath, advisors.items)
    const index = parsed.findIndex((definition) => definition.slug === slug)
    if (index === -1) throw new Error('Advisor definition no longer exists in the selected scope.')
    advisors.items.splice(index, 1)
    if (advisors.items.length === 0) document.delete('advisors')

    if (isMap(document.contents) && document.contents.items.length === 0) {
      await unlink(filePath)
    } else {
      await writeFileAtomically(filePath, document.toString())
    }
    return this.list(projectPath)
  }

  private async candidates(projectPath: string | null): Promise<Candidate[]> {
    const candidates: Candidate[] = []
    for (const name of SOURCE_NAMES) {
      candidates.push({ path: join(this.agentDir, name), scope: 'user', editable: true })
    }
    if (projectPath === null) return candidates

    const cwd = resolve(projectPath)
    const boundary = await discoveryBoundary(cwd, this.userHome)
    const directories: string[] = []
    let current = cwd
    while (true) {
      directories.push(current)
      if (current === boundary) break
      const parent = dirname(current)
      if (parent === current) break
      current = parent
    }
    directories.reverse()
    for (const directory of directories) {
      for (const name of SOURCE_NAMES) {
        candidates.push({
          path: join(directory, name),
          scope: directory === cwd ? 'project' : 'inherited',
          editable: directory === cwd
        })
        candidates.push({
          path: join(directory, '.omp', name),
          scope: 'inherited',
          editable: false
        })
      }
    }
    return candidates
  }

  private async editPath(
    scope: KernelAdvisorEditableScope,
    projectPath: string | null
  ): Promise<string> {
    const directory = scope === 'user'
      ? this.agentDir
      : requireProjectPath(projectPath)
    const yml = join(directory, CONFIG_NAMES[0])
    const yaml = join(directory, CONFIG_NAMES[1])
    const [hasYml, hasYaml] = await Promise.all([
      editableFileExists(yml),
      editableFileExists(yaml)
    ])
    if (hasYml && hasYaml) {
      throw new Error(`Both WATCHDOG.yml and WATCHDOG.yaml exist in '${directory}'.`)
    }
    return hasYaml ? yaml : yml
  }
}

function source(candidate: Candidate, sourceOrder: number, instructions: string): KernelAdvisorSource {
  return {
    id: `${candidate.scope}:${sourceOrder}`,
    scope: candidate.scope,
    path: candidate.path,
    sourceOrder,
    editable: candidate.editable,
    instructions
  }
}

function parseRosterForDiscovery(
  filePath: string,
  content: string,
  diagnostics: KernelAdvisorDiagnostic[]
): ParsedRoster | null {
  try {
    const document = parseDocument(content, { uniqueKeys: true })
    if (document.errors.length > 0) throw document.errors[0]
    assertSafeDocument(document, filePath)
    const value: unknown = document.toJS()
    return parseRosterValue(value, filePath, diagnostics)
  } catch (error) {
    diagnostics.push({ sourcePath: filePath, message: errorMessage(error) })
    return null
  }
}

function parseRosterValue(
  value: unknown,
  filePath?: string,
  diagnostics?: KernelAdvisorDiagnostic[]
): ParsedRoster {
  const record = asRecord(value)
  if (record === null) throw new Error('WATCHDOG YAML must contain a mapping.')
  const instructions = record.instructions === undefined
    ? ''
    : requiredInstructions(record.instructions)
  if (record.advisors === undefined) return { instructions, definitions: [] }
  if (!Array.isArray(record.advisors)) throw new Error("'advisors' must be a sequence.")
  const definitions = record.advisors.map((definition) =>
    parseDefinitionValue(definition, filePath, diagnostics))
  const slugs = definitions.map(({ slug }) => slug)
  if (new Set(slugs).size !== slugs.length) {
    throw new Error('Advisor slugs must be unique within one WATCHDOG file.')
  }
  return { instructions, definitions }
}

function parseDefinitionValue(
  value: unknown,
  filePath?: string,
  diagnostics?: KernelAdvisorDiagnostic[]
): ParsedRoster['definitions'][number] {
  const record = asRecord(value)
  if (record === null) throw new Error('Each advisor must be a mapping.')
  const name = requiredName(record.name)
  const enabled = record.enabled === undefined ? true : requiredBoolean(record.enabled, 'enabled')
  const model = record.model === undefined ? null : requiredModel(record.model)
  const thinking = record.thinking === undefined ? null : requiredThinking(record.thinking)
  const tools = record.tools === undefined
    ? [...DEFAULT_TOOLS]
    : requiredTools(record.tools, filePath, diagnostics)
  const instructions = record.instructions === undefined
    ? ''
    : requiredInstructions(record.instructions)
  return {
    slug: slugifyAdvisorName(name),
    name,
    enabled,
    model,
    thinking,
    tools,
    instructions
  }
}

function assertDefinitionInput(input: KernelAdvisorDefinitionInput): void {
  if (input.scope !== 'user' && input.scope !== 'project') {
    throw new Error('Advisor scope must be user or project.')
  }
  if (input.originalSlug !== null) assertSlug(input.originalSlug, 'originalSlug')
  requiredName(input.name)
  requiredBoolean(input.enabled, 'enabled')
  optionalModel(input.model)
  optionalThinking(input.thinking)
  requiredTools(input.tools)
  optionalInstructions(input.instructions)
  if (Object.keys(input).length !== 8) throw new Error('Advisor definition contains unknown fields.')
}

function requiredName(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.trim() !== value ||
    value.length === 0 ||
    value.length > MAX_NAME_CHARS ||
    /[\0\r\n]/u.test(value)
  ) {
    throw new Error('Advisor name must be a trimmed, non-empty single-line string.')
  }
  const slug = slugifyAdvisorName(value)
  assertSlug(slug, 'slug')
  return value
}

function slugifyAdvisorName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '') || 'advisor'
}

function assertSlug(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length > 128 ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value)
  ) {
    throw new Error(`Advisor ${label} is invalid.`)
  }
}

function requiredBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`Advisor ${label} must be boolean.`)
  return value
}

function optionalModel(value: unknown): string | null {
  if (value === undefined || value === null) return null
  return requiredModel(value)
}

function requiredModel(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.trim() !== value ||
    value.length === 0 ||
    value.length > MAX_MODEL_CHARS ||
    /[\0\r\n]/u.test(value)
  ) {
    throw new Error('Advisor model must be a trimmed non-empty single-line string.')
  }
  return value
}

function optionalThinking(value: unknown): ThinkingLevel | null {
  if (value === undefined || value === null) return null
  return requiredThinking(value)
}

function requiredThinking(value: unknown): ThinkingLevel {
  if (!THINKING_LEVELS.has(value as ThinkingLevel)) {
    throw new Error('Advisor thinking level is invalid.')
  }
  return value as ThinkingLevel
}

function requiredTools(
  value: unknown,
  filePath?: string,
  diagnostics?: KernelAdvisorDiagnostic[]
): KernelAdvisorToolName[] {
  if (
    !Array.isArray(value) ||
    value.some((tool) => typeof tool !== 'string') ||
    new Set(value).size !== value.length
  ) {
    throw new Error('Advisor tools must be a unique list of supported tool names.')
  }
  if (value.length === 0) return [...DEFAULT_TOOLS]
  const supported = value.filter((tool): tool is KernelAdvisorToolName => TOOL_NAMES.has(tool))
  for (const tool of value) {
    if (TOOL_NAMES.has(tool) || filePath === undefined || diagnostics === undefined) continue
    diagnostics.push({
      sourcePath: filePath,
      message: `Unknown Advisor tool '${tool}' was ignored.`
    })
  }
  return supported
}

function optionalInstructions(value: unknown): string {
  if (value === undefined || value === null) return ''
  return requiredInstructions(value)
}

function requiredInstructions(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length > MAX_INSTRUCTIONS_CHARS ||
    value.includes('\0')
  ) {
    throw new Error('Advisor instructions must be a bounded string without NUL.')
  }
  return value
}

async function readDocumentForEdit(filePath: string): Promise<Document.Parsed> {
  let content = ''
  try {
    content = await readFile(filePath, 'utf8')
  } catch (error) {
    if (!isNotFound(error)) throw error
  }
  const document = parseDocument(content, { uniqueKeys: true })
  if (document.errors.length > 0) {
    throw new Error(`Invalid WATCHDOG YAML '${filePath}': ${document.errors[0]!.message}`)
  }
  if (document.contents === null) {
    document.set('advisors', [])
    document.delete('advisors')
  }
  assertSafeDocument(document, filePath)
  if (!isMap(document.contents)) {
    throw new Error(`WATCHDOG YAML '${filePath}' must contain a mapping.`)
  }
  return document
}

function ensureAdvisorSequence(document: Document.Parsed) {
  let advisors = document.get('advisors', true)
  if (advisors === undefined) {
    document.set('advisors', [])
    advisors = document.get('advisors', true)
  }
  if (!isSeq(advisors)) throw new Error("'advisors' must be a sequence.")
  return advisors
}

function parseAdvisorNodes(filePath: string, nodes: readonly unknown[]) {
  return nodes.map((node) => {
    if (!isMap(node)) throw new Error(`Unsafe advisor structure in '${filePath}'.`)
    return parseDefinitionValue(node.toJSON())
  })
}

function setOptionalMapValue(
  map: Extract<Node, { items: unknown[] }>,
  key: string,
  value: string | null
): void {
  if (!isMap(map)) return
  if (value === null) map.delete(key)
  else map.set(key, value)
}

function assertSafeDocument(document: Document.Parsed, filePath: string): void {
  const visit = (value: unknown): void => {
    if (isAlias(value)) throw new Error(`Aliases are not safe to edit in '${filePath}'.`)
    if (isMap(value)) {
      for (const pair of value.items) {
        if (!isScalar(pair.key) || typeof pair.key.value !== 'string') {
          throw new Error(`Non-string YAML keys are not safe to edit in '${filePath}'.`)
        }
        visit(pair.value)
      }
    } else if (isSeq(value)) {
      for (const item of value.items) visit(item)
    } else if (isScalar(value) && value.tag !== undefined && !value.tag.startsWith('tag:yaml.org,2002:')) {
      throw new Error(`Custom YAML tags are not safe to edit in '${filePath}'.`)
    }
  }
  visit(document.contents)
}

async function discoveryBoundary(cwd: string, userHome: string): Promise<string> {
  let current = cwd
  while (true) {
    if (await pathExists(join(current, '.git'))) return current
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  const home = resolve(userHome)
  return cwd === home || cwd.startsWith(`${home}${parse(home).root === home ? '' : '/'}`)
    ? home
    : parse(cwd).root
}

function requireProjectPath(projectPath: string | null): string {
  if (projectPath === null) throw new Error('Select a Project before editing project Advisors.')
  return resolve(projectPath)
}

async function writeFileAtomically(filePath: string, content: string): Promise<void> {
  const temporaryPath = join(dirname(filePath), `.${basename(filePath)}.${randomUUID()}.tmp`)
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
    return stat.isFile() || stat.isDirectory() || stat.isSymbolicLink()
  } catch (error) {
    if (isNotFound(error)) return false
    throw error
  }
}

async function editableFileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await lstat(filePath)
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`WATCHDOG edit target must be a regular file: '${filePath}'.`)
    }
    return true
  } catch (error) {
    if (isNotFound(error)) return false
    throw error
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
