import { SHORTCUT_ACTION_IDS } from '../../../../shared/shortcut-settings.ts'
import type { SettingsSection } from './SettingsNavigation'
import { SHORTCUT_ACTION_LABELS, shortcutLabelId } from './shortcut-labels.ts'

/**
 * One searchable setting. `target` is the DOM id of the row label, control or
 * group heading that the page renders; the jump scrolls to its row or group.
 * Only fixed setting names, groups and hand-written synonyms are indexed —
 * never credentials, endpoints, agent prompts, logs or other user data.
 */
export type SettingsSearchEntry = {
  section: SettingsSection
  target: string
  label: string
  group: string
  keywords: readonly string[]
  /** Also rendered by the SSH client, which has no Host-owned settings. */
  client?: true
}

const SHORTCUT_KEYWORDS = ['快捷键', '按键', '组合键', 'shortcut', 'keybinding', 'hotkey']

export const SETTINGS_SEARCH_ENTRIES: readonly SettingsSearchEntry[] = [
  {
    section: 'general', target: 'general-startup-workspace-restore-label', label: '启动后显示', group: '启动',
    keywords: ['恢复', '上次', '打开应用', '项目', '对话', 'startup', 'restore']
  },
  {
    section: 'general', target: 'session-naming-mode', label: '自动对话命名', group: '对话',
    keywords: ['标题', '会话名称', '重命名', 'session', 'title', 'naming']
  },
  {
    section: 'general', target: 'general-double-click-border-maximize', label: '双击边框最大化', group: '窗口',
    keywords: ['窗口', '最大化', '全屏', 'window', 'maximize'], client: true
  },
  {
    section: 'general', target: 'general-fast-extension-loading', label: '扩展启动加速', group: '实验性功能',
    keywords: ['实验', '性能', '加载', '导入', 'extension', 'loading', 'experimental']
  },
  {
    section: 'general', target: 'general-auto-continue-interrupted-tasks', label: '自动继续中断的任务', group: '实验性功能',
    keywords: ['实验', '恢复', '续跑', '中断', '退出', 'resume', 'continue', 'experimental']
  },
  {
    section: 'appearance', target: 'appearance-theme-heading', label: '主题', group: '主题',
    keywords: ['深色', '浅色', '暗色', '亮色', '跟随系统', '夜间', 'dark', 'light', 'theme'], client: true
  },
  {
    section: 'appearance', target: 'appearance-accent-color', label: '强调色', group: '界面强调',
    keywords: ['颜色', '主题色', 'accent', 'color'], client: true
  },
  {
    section: 'appearance', target: 'appearance-surface-transparency', label: '面板透明度', group: '界面强调',
    keywords: ['透明', '毛玻璃', '不透明', 'transparency', 'opacity'], client: true
  },
  {
    section: 'appearance', target: 'appearance-token-count-format-label', label: 'Token 数量', group: '对话',
    keywords: ['用量', '格式', '缩写', 'token', 'usage'], client: true
  },
  {
    section: 'appearance', target: 'appearance-tool-density-label', label: '工作过程密度', group: '对话',
    keywords: ['思考', '工具', '紧凑', '标准', '详细', '过程', 'density', 'thinking'], client: true
  },
  {
    section: 'appearance', target: 'appearance-text-size-label', label: '界面字号', group: '字体',
    keywords: ['字号', '字体大小', '缩放', '文字大小', 'font size', 'zoom'], client: true
  },
  {
    section: 'appearance', target: 'appearance-ui-font', label: '界面字体', group: '字体',
    keywords: ['字体', 'font', 'ui'], client: true
  },
  {
    section: 'appearance', target: 'appearance-code-font', label: '代码字体', group: '字体',
    keywords: ['字体', '等宽', 'monospace', 'code font'], client: true
  },
  ...SHORTCUT_ACTION_IDS.map((actionId): SettingsSearchEntry => ({
    section: 'shortcuts',
    target: shortcutLabelId(actionId),
    label: SHORTCUT_ACTION_LABELS[actionId],
    group: '应用快捷键',
    keywords: SHORTCUT_KEYWORDS,
    client: true
  })),
  {
    section: 'models', target: 'settings-conversation-model', label: '对话模型', group: '对话模型',
    keywords: ['模型', '切换模型', 'provider', 'model']
  },
  {
    section: 'models', target: 'settings-model-visibility', label: '模型菜单', group: '模型菜单',
    keywords: ['显示模型', '隐藏模型', '可见', '模型列表', 'visibility', 'model menu']
  },
  {
    section: 'models', target: 'provider-credentials-heading', label: '凭证', group: '凭证',
    keywords: ['登录', '退出登录', '认证', '账号', '授权', 'login', 'oauth', 'api key', 'credential']
  },
  {
    section: 'models', target: 'custom-provider-settings-heading', label: '自定义 Provider', group: '自定义 Provider',
    keywords: ['自定义模型', '兼容', '添加 provider', 'custom provider', 'models.json']
  },
  {
    section: 'packages', target: 'settings-installed-packages-heading', label: '已安装插件', group: '已安装',
    keywords: ['插件', '更新', '卸载', 'pi package', 'package']
  },
  {
    section: 'packages', target: 'settings-pi-dev-package-heading', label: '从 pi.dev 安装插件', group: 'pi.dev',
    keywords: ['安装', '搜索插件', '市场', '目录', 'pi.dev', 'package']
  },
  {
    section: 'extensions', target: 'settings-extensions-magic-context-heading', label: 'Magic Context', group: 'Magic Context',
    keywords: ['上下文', '压缩', '记忆', 'context', 'memory', 'extension']
  },
  {
    section: 'extensions', target: 'settings-local-extensions-heading', label: '本地扩展', group: '本地路径',
    keywords: ['本地路径', '安装本地扩展', '路径', 'local', 'extension']
  },
  {
    section: 'extensions', target: 'settings-pi-dev-extension-heading', label: '从 pi.dev 安装扩展', group: 'pi.dev',
    keywords: ['安装', '搜索扩展', '市场', '目录', 'pi.dev', 'extension']
  },
  {
    section: 'skills', target: 'settings-skill-create', label: '新建技能', group: '技能',
    keywords: ['创建技能', 'skill', 'create']
  },
  {
    section: 'skills', target: 'settings-skill-search', label: '已发现的技能', group: '技能',
    keywords: ['技能列表', '搜索技能', 'skill', 'slash', '命令']
  },
  {
    section: 'subagent', target: 'settings-subagent-agents-heading', label: '智能体管理', group: '智能体管理',
    keywords: ['智能体', '新建智能体', '角色', '定义', 'agent', 'subagent']
  },
  {
    section: 'subagent', target: 'settings-subagent-max-depth', label: '最大嵌套层数', group: '运行设置',
    keywords: ['嵌套', '深度', '层数', 'depth', 'subagent']
  },
  {
    section: 'remote', target: 'settings-tailscale-remote', label: '一键联网', group: '一键联网',
    keywords: ['tailscale', '远程', '手机', '浏览器', '外网', 'remote']
  },
  {
    section: 'remote', target: 'settings-remote-status', label: '远程访问', group: '状态',
    keywords: ['手机访问', '远程', '状态', 'remote', 'web']
  },
  {
    section: 'remote', target: 'settings-remote-pairing', label: '手机配对', group: '配对',
    keywords: ['配对码', '已配对手机', '设备', '二维码', 'pairing', 'phone']
  },
  {
    section: 'remote', target: 'settings-desktop-host-status', label: '桌面远程客户端', group: 'Desktop Host（SSH）',
    keywords: ['windows', 'ssh', '桌面客户端', '远程', 'desktop', 'host']
  },
  {
    section: 'remote', target: 'settings-desktop-host-pairing', label: 'Windows 桌面配对', group: 'Desktop Host（SSH）',
    keywords: ['一次性配对码', '配对', 'windows', 'ssh', 'pairing']
  },
  {
    section: 'remote', target: 'settings-desktop-host-devices', label: '已配对设备', group: 'Desktop Host（SSH）',
    keywords: ['桌面设备', '撤销', 'windows', 'devices']
  }
]

function normalize(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim()
}

/**
 * Entries whose label, group or synonyms contain every whitespace-separated
 * query term, best label matches first; an empty query returns nothing.
 */
export function searchSettings(
  query: string,
  { clientOnly = false }: { clientOnly?: boolean } = {}
): SettingsSearchEntry[] {
  const normalized = normalize(query)
  if (normalized === '') return []
  const terms = normalized.split(' ')
  const ranked: Array<{ entry: SettingsSearchEntry; rank: number; order: number }> = []
  SETTINGS_SEARCH_ENTRIES.forEach((entry, order) => {
    if (clientOnly && entry.client !== true) return
    const label = normalize(entry.label)
    const haystack = [label, normalize(entry.group), ...entry.keywords.map(normalize)].join('\n')
    if (!terms.every((term) => haystack.includes(term))) return
    const rank = label.startsWith(normalized) ? 0
      : label.includes(normalized) ? 1
        : terms.every((term) => label.includes(term)) ? 2
          : 3
    ranked.push({ entry, rank, order })
  })
  return ranked
    .sort((left, right) => left.rank - right.rank || left.order - right.order)
    .map(({ entry }) => entry)
}
