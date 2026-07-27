import {
  COPY_LAST_ANSWER_COMMAND_ID,
  EXPORT_SESSION_COMMAND_ID,
  FORK_SESSION_COMMAND_ID,
  type KernelCommandDescriptor
} from '../../shared/kernel-contract.ts'
import type { PiRpcSlashCommand } from '../pi-rpc/pi-rpc-client.ts'

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

export function createCommandCatalog(
  piCommands: readonly PiRpcSlashCommand[] = [],
  reloadAvailable = false
): KernelCommandDescriptor[] {
  const catalog = BUILTIN_COMMANDS.map((command) => ({ ...command }))
  if (reloadAvailable) catalog.push({ ...RELOAD_SESSION_COMMAND })
  const knownNames = new Set(catalog.map(({ name }) => name.toLocaleLowerCase()))

  for (const command of piCommands) {
    const normalizedName = command.name.toLocaleLowerCase()
    if (knownNames.has(normalizedName)) continue
    knownNames.add(normalizedName)
    catalog.push({
      id: `pi-command:${command.source}:${command.name}`,
      name: command.name,
      description: command.description ?? fallbackDescription(command.source),
      source: command.source,
      argumentHint: '[arguments]',
      sourceInfo: {
        source: command.sourceInfo.source,
        scope: command.sourceInfo.scope,
        origin: command.sourceInfo.origin
      }
    })
  }

  return catalog
}

function fallbackDescription(source: PiRpcSlashCommand['source']): string {
  if (source === 'extension') return 'Pi Extension 命令'
  if (source === 'prompt') return 'Pi Prompt Template'
  return 'Pi Skill'
}
