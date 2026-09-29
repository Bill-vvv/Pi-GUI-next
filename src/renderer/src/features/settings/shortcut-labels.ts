import type { ShortcutActionId } from '../../../../shared/shortcut-settings'

export const SHORTCUT_ACTION_LABELS: Record<ShortcutActionId, string> = {
  'new-session': '新建对话',
  'focus-composer': '聚焦 Composer',
  'open-settings': '打开设置',
  'open-model-selector': '打开模型选择器',
  'reload-session': '重载当前对话',
  'previous-project': '上一个项目',
  'next-project': '下一个项目',
  'previous-session': '上一个对话',
  'next-session': '下一个对话',
  'archive-session': '归档当前对话',
  'copy-last-answer': '复制最后一条 Assistant 最终回答'
}

/** DOM id of a shortcut row label; also a settings search target. */
export function shortcutLabelId(actionId: ShortcutActionId): string {
  return `shortcut-${actionId}-label`
}
