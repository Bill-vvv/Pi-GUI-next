/**
 * Shown on the 插件, 扩展 and 子智能体 pages after this settings visit changed
 * installed packages, local extensions or an adapted extension's enablement.
 * These changes are written to Pi's user settings (every project); Pi Runtimes
 * that are already open keep what they loaded and are never reloaded silently.
 */
export const PLUGIN_RELOAD_PENDING_STATUS =
  '已写入 Pi 用户配置，对所有项目生效。已打开的对话不会自动重载，仍使用打开时加载的插件和扩展；新建或重新载入对话后生效'
