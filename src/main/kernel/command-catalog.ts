import {
  COPY_LAST_ANSWER_COMMAND_ID,
  EXPORT_SESSION_COMMAND_ID,
  FORK_SESSION_COMMAND_ID,
  type KernelCommandDescriptor
} from '../../shared/kernel-contract.ts'
import type { PiRpcSlashCommand } from '../pi-rpc/pi-rpc-client.ts'
import { isInternalHistoryNavigationCommandName } from '../runtime/history-navigation.ts'
import { isInternalOpenAiFastModeCommandName } from '../runtime/openai-fast-mode.ts'
import { isInternalQuiescenceCommandName } from '../runtime/runtime-quiescence.ts'

export const NEW_SESSION_COMMAND_ID = 'gui.new-session'
export const RELOAD_SESSION_COMMAND_ID = 'gui.reload'
export const SET_MODEL_COMMAND_ID = 'pi-rpc.set-model'
export const SET_THINKING_COMMAND_ID = 'pi-rpc.set-thinking-level'
export const COMPACT_COMMAND_ID = 'pi-rpc.compact'
export const SET_SESSION_NAME_COMMAND_ID = 'pi-rpc.set-session-name'

const BUILTIN_COMMANDS: readonly KernelCommandDescriptor[] = [
  {
    id: NEW_SESSION_COMMAND_ID,
    name: 'new',
    description: '在当前项目中新建对话',
    source: 'gui',
    argumentHint: null,
    sourceInfo: null
  },
  {
    id: FORK_SESSION_COMMAND_ID,
    name: 'fork',
    description: '从当前活动路径的用户消息分叉会话',
    source: 'gui',
    argumentHint: null,
    sourceInfo: null
  },
  {
    id: EXPORT_SESSION_COMMAND_ID,
    name: 'export',
    description: '将当前活动分支导出为离线 HTML',
    source: 'gui',
    argumentHint: null,
    sourceInfo: null
  },
  {
    id: COPY_LAST_ANSWER_COMMAND_ID,
    name: 'copy',
    description: '复制最后一条 Assistant 最终回答',
    source: 'gui',
    argumentHint: null,
    sourceInfo: null
  },
  {
    id: SET_MODEL_COMMAND_ID,
    name: 'model',
    description: '切换当前 Pi 模型',
    source: 'pi-rpc',
    argumentHint: '<provider/model>',
    sourceInfo: null
  },
  {
    id: SET_THINKING_COMMAND_ID,
    name: 'thinking',
    description: '设置思考强度',
    source: 'pi-rpc',
    argumentHint: '<off|minimal|low|medium|high|xhigh|max>',
    sourceInfo: null
  },
  {
    id: COMPACT_COMMAND_ID,
    name: 'compact',
    description: '压缩当前 Session 上下文',
    source: 'pi-rpc',
    argumentHint: '[instructions]',
    sourceInfo: null
  },
  {
    id: SET_SESSION_NAME_COMMAND_ID,
    name: 'name',
    description: '设置当前 Session 名称',
    source: 'pi-rpc',
    argumentHint: '<name>',
    sourceInfo: null
  }
]

const RELOAD_SESSION_COMMAND: KernelCommandDescriptor = {
  id: RELOAD_SESSION_COMMAND_ID,
  name: 'reload',
  description: '重新加载当前已持久化 Session',
  source: 'gui',
  argumentHint: null,
  sourceInfo: null
}

export type GuiExtensionDialogMethod = 'select' | 'confirm' | 'input' | 'editor'

type GuiExtensionCommandAdapter = {
  packageSource: string
  argumentHint: string | null
  blockingUiMethods?: readonly GuiExtensionDialogMethod[]
  validateArgument?: (argument: string) => string | null
}

// Extension commands are executable code and may depend on TUI-only UI methods.
// Only fixed, provenance-checked commands with a verified GUI-safe path enter the catalog.
const GUI_EXTENSION_COMMAND_ADAPTERS: Readonly<Record<string, GuiExtensionCommandAdapter>> = {
  'subagents-watchdog': {
    packageSource: 'npm:pi-subagents',
    argumentHint: '[status|on|off|session on|session off|recommend-model|check|model <provider/model[:thinking]|recommended|inherit>|thinking <level|inherit>|session model <provider/model[:thinking]|recommended|inherit>|test <concern|blocker> <text>]'
  },
  run: {
    packageSource: 'npm:pi-subagents',
    argumentHint: '<agent> [task] [--bg] [--fork]',
    blockingUiMethods: ['select', 'confirm', 'input', 'editor']
  },
  chain: {
    packageSource: 'npm:pi-subagents',
    argumentHint: '<agent/task chain> [--bg] [--fork]'
  },
  'run-chain': {
    packageSource: 'npm:pi-subagents',
    argumentHint: '<chain> -- <task> [--bg] [--fork]'
  },
  parallel: {
    packageSource: 'npm:pi-subagents',
    argumentHint: '<agent/task entries> [--bg] [--fork]'
  },
  'subagent-cost': { packageSource: 'npm:pi-subagents', argumentHint: null },
  'subagents-doctor': { packageSource: 'npm:pi-subagents', argumentHint: null },
  'subagents-stop': {
    packageSource: 'npm:pi-subagents',
    argumentHint: '<run-id>',
    validateArgument: validateSubagentStopArgument
  },
  'prompt-workflow': {
    packageSource: 'npm:pi-subagents',
    argumentHint: '[name] [arguments]'
  },
  'chain-prompts': {
    packageSource: 'npm:pi-subagents',
    argumentHint: '[prompt-chain] [-- arguments]'
  },
  'subagents-models': {
    packageSource: 'npm:pi-subagents',
    argumentHint: '[builtin-agent]'
  },
  'subagents-profiles': { packageSource: 'npm:pi-subagents', argumentHint: null },
  'subagents-refresh-provider-models': {
    packageSource: 'npm:pi-subagents',
    argumentHint: '<provider> [--force]'
  },
  'subagents-generate-profiles': {
    packageSource: 'npm:pi-subagents',
    argumentHint: '<provider>'
  },
  'subagents-check-profile': {
    packageSource: 'npm:pi-subagents',
    argumentHint: '<profile>'
  },
  'ctx-aug': {
    packageSource: 'npm:@cortexkit/pi-magic-context',
    argumentHint: '<prompt>'
  },
  'ctx-flush': {
    packageSource: 'npm:@cortexkit/pi-magic-context',
    argumentHint: null
  },
  'ctx-recomp': {
    packageSource: 'npm:@cortexkit/pi-magic-context',
    argumentHint: '[<start>-<end>|--upgrade]'
  },
  'ctx-wrapup': {
    packageSource: 'npm:@cortexkit/pi-magic-context',
    argumentHint: '[messages-to-keep]'
  },
  'ctx-session-upgrade': {
    packageSource: 'npm:@cortexkit/pi-magic-context',
    argumentHint: null
  },
  'ctx-dream': {
    packageSource: 'npm:@cortexkit/pi-magic-context',
    argumentHint: '[task]'
  },
  'ctx-embed': {
    packageSource: 'npm:@cortexkit/pi-magic-context',
    argumentHint: '[start|pause]'
  },
  todos: {
    packageSource: 'npm:@cortexkit/pi-magic-context',
    argumentHint: null,
    validateArgument: validateNoArgument
  }
}

export function createCommandCatalog(
  piCommands: readonly PiRpcSlashCommand[] = [],
  reloadAvailable = false
): KernelCommandDescriptor[] {
  const catalog = BUILTIN_COMMANDS.map((command) => ({ ...command }))
  if (reloadAvailable) catalog.push({ ...RELOAD_SESSION_COMMAND })
  const knownNames = new Set(catalog.map(({ name }) => name.toLocaleLowerCase()))

  for (const command of piCommands) {
    // App-owned internal runtime commands are invoked only by RuntimeHost, never offered to users.
    if (
      isInternalQuiescenceCommandName(command.name) ||
      isInternalOpenAiFastModeCommandName(command.name) ||
      isInternalHistoryNavigationCommandName(command.name)
    ) continue
    const normalizedName = command.name.toLocaleLowerCase()
    const extensionAdapter = command.source === 'extension'
      ? guiExtensionCommandAdapter(normalizedName, command.sourceInfo.source)
      : null
    if (command.source === 'extension' && extensionAdapter === null) continue
    if (knownNames.has(normalizedName)) continue
    knownNames.add(normalizedName)
    catalog.push({
      id: `pi-command:${command.source}:${command.name}`,
      name: command.name,
      description: command.description ?? fallbackDescription(command.source),
      source: command.source,
      argumentHint: command.source === 'extension'
        ? extensionAdapter!.argumentHint
        : '[arguments]',
      sourceInfo: {
        source: command.sourceInfo.source,
        scope: command.sourceInfo.scope,
        origin: command.sourceInfo.origin
      }
    })
  }

  return catalog
}

export function adaptedExtensionCommandAllowsBlockingUi(
  command: KernelCommandDescriptor,
  method: GuiExtensionDialogMethod
): boolean {
  if (command.source !== 'extension' || command.sourceInfo === null) return false
  const adapter = guiExtensionCommandAdapter(
    command.name.toLocaleLowerCase(),
    command.sourceInfo.source
  )
  return adapter?.blockingUiMethods?.includes(method) === true
}

export function assertAdaptedExtensionCommandArgument(
  command: KernelCommandDescriptor,
  argument: string
): void {
  if (command.source !== 'extension' || command.sourceInfo === null) return
  const adapter = guiExtensionCommandAdapter(
    command.name.toLocaleLowerCase(),
    command.sourceInfo.source
  )
  if (adapter === null) throw new Error(`/${command.name} is not adapted for Pi GUI.`)
  const validationError = adapter.validateArgument?.(argument.trim()) ?? null
  if (validationError !== null) throw new Error(validationError)
}

function guiExtensionCommandAdapter(
  normalizedName: string,
  source: string
): GuiExtensionCommandAdapter | null {
  const adapter = GUI_EXTENSION_COMMAND_ADAPTERS[normalizedName]
  if (adapter === undefined) return null
  if (
    source !== adapter.packageSource &&
    !source.startsWith(`${adapter.packageSource}@`)
  ) return null
  return adapter
}

function validateSubagentStopArgument(argument: string): string | null {
  return argument.length > 0 ? null : '/subagents-stop 需要参数：<run-id>'
}

function validateNoArgument(argument: string): string | null {
  return argument.length === 0 ? null : '此命令不接受参数。'
}

function fallbackDescription(source: PiRpcSlashCommand['source']): string {
  if (source === 'extension') return 'Pi Extension 命令'
  if (source === 'prompt') return 'Pi Prompt Template'
  return 'Pi Skill'
}
