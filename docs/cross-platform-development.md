# Windows / WSL 共同开发

源码可以由 Windows 和 WSL 编辑；每个平台的 Node 依赖、构建产物和运行进程各自拥有独立目录。项目、Session 与 Pi 配置仍由选定的 Linux Host 维护，开发缓存不保存第二份会话数据。

后续实施顺序与逐项验收见 [跨平台改进计划](cross-platform-improvement-plan.md)。

## 统一入口

先在当前终端启用项目锁定的 Node 26.4.0，并确保 pnpm 与 Git 在 PATH。随后从源码仓库执行：

```text
node scripts/workspace.mjs doctor
node scripts/workspace.mjs typecheck
node scripts/workspace.mjs test-platform
node scripts/workspace.mjs test
node scripts/workspace.mjs build
node scripts/workspace.mjs dev
node scripts/workspace.mjs start
```

- `typecheck` / `test-platform` / `test`：分别执行类型检查、跨平台连接回归和完整核心测试。完整核心测试包含真实 Linux Host fixture，在 WSL/Linux 执行；Windows 执行 `test-platform`。
- `doctor`：只读检查 Node、pnpm 入口、Git 能力与当前平台工具；Windows 额外报告默认 WSL 后端和 OpenSSH，不安装工具或改配置。
- `build`：强制产生带内容清单的生产构建；产物损坏时也使用此命令明确修复。
- `dev`：启动 electron-vite；每秒同步源码改动到开发目录，由现有 HMR / Main 重启机制处理。依赖配置变化时报告并停止，应重新执行入口安装新依赖。
- `start`：输入未变时验证并复用产物，否则重新构建。Windows 首次默认 SSH client，随后恢复上次成功启动的环境；Linux 默认本地 Workbench。

Windows 界面使用本机 WSL 时执行：

```powershell
node scripts/workspace.mjs wsl
```

它依次构建 Windows 客户端、安装并验证 WSL 后端、启动 Windows 窗口。默认发行版是 Ubuntu-24.04；高级使用仍可通过 `setup-wsl.ps1` / `start-wsl.ps1` 的 `-Distribution` 显式选择。更新前关闭已有 WSL 客户端；占用锁时明确拒绝更新，不终止正在工作的 Pi。

入口打印本次使用的目录与同步文件数、改动数、耗时。Windows 缓存位于 `%USERPROFILE%\.cache\pi-gui-next\development\win32-<仓库路径摘要>`，避免 MSIX 对 LocalAppData 的重定向影响 pnpm junction；Linux 位于 `${XDG_CACHE_HOME:-~/.cache}/pi-gui-next/development/linux-<仓库路径摘要>`。校验命令使用额外的 `-checks` 目录与依赖，因此可在 dev 开启期间执行。每条运行/校验通道各自由 `.workspace-lock` 独占；校验命令之间仍串行。入口只同步 Git 已跟踪和未忽略的文件，并清除缓存中已从源码删除的文件，不共享或替换源码目录内的 `node_modules`。dev 轮询对未变文件跳过内容读取；依赖变化需重启。异常终止后应确认对应进程已退出再删除该锁。

原有 `pnpm dev` / `pnpm build` 等命令继续适用于各平台独立 checkout。不要在同一 checkout 的同一个 `node_modules` 中交替执行 Windows 与 Linux 安装。

## 构建身份与更新

`out/main/build-identity.json` 记录 Git commit（出处）、源码 SHA-256、产物 SHA-256 和逐文件摘要。源码摘要包含实际未提交修改，并对源码文本的 CRLF/LF 进行规范化。构建开始和结束均核对源码，变化时拒绝生成身份。

源码身份同时覆盖构建/开发脚本，脚本修改会触发重新构建。启动复用前检查完整产物；同输入的产物损坏会明确报错。WSL 收到与 current 完全相同的清单时，复核现有产物和 Electron 后直接复用，不安装依赖、不替换 release。

SSH 握手中既有的 `buildCommit` 字段承载源码摘要，开发模式直接计算当前源码摘要；运行生产产物时先检查产物清单。`PI_GUI_BUILD_COMMIT` 不再覆盖或绕过内容校验。旧的仅含 commit 的清单需要重新构建。

WSL 同步整套产物，握手使用产物摘要；校验覆盖 Main、独立 worker、preload、Renderer、Web Remote、锁文件和应用打包的扩展资源。后端先安装到 `~/.local/share/pi-gui-next-wsl/releases/release.*`，安装、清单验证与 Node Host 入口检查全部成功后，原子替换 `current` symlink。WSL 后端以随附的 Node 26.4.0 运行 `out/main/pi-host.js wsl`（D-095），不下载 Electron，也不依赖 WSLg。失败保留原版本；成功后保留当前和上一版本。旧版 `app` 目录在首次迁移时保留，不作为新启动入口。

## 操作与桌面能力的归属

Windows 生产窗口在连接页或「设置 → 常规 → 运行环境」显示当前 WSL/SSH，并提供重启切换。目标 WSL 需要已安装且产物与客户端一致；先检查目标，再确认未发送草稿不会迁移。WSL 在同一个 Host 入口检查进行中的业务操作、Package 安装以及全部会话，再同步关闭新任务入口；完成旧后端关闭后重启。SSH 需要先显式断开 Host。校验失败或取消时保留原连接；旧后端关闭失败会明确退出并报告错误。选择仅在新环境启动成功后持久化。

Desktop 的主题、字体选择、外观密度、应用快捷键和边框双击行为存于 Electron `appData/pi-gui-next-desktop/settings.json`；Windows 通常为 `%APPDATA%\pi-gui-next-desktop\settings.json`。WSL 与 SSH 共用同一份 Windows 偏好，连接页无需 Host 即可读取。旧 Host 设置只在首次初始化时迁移，后续修改不写回 Host；项目、模型、启动恢复和会话行为仍由 Host 维护。SSH 设置只显示已接通的本机应用项。浏览器 Remote 保持其既有设置契约。

Renderer 应用权威状态时向 preload 更新观察到的 Project/Session identity。preload 在提交命令时捕获该 identity；SSH Main 不读取 Host 最新状态来替换命令目标。Host 切换会话后拒绝旧身份命令，不重试 mutation。

关闭 SSH 窗口或普通断开只释放 SSE 和隧道，保留 Credential Manager 凭证；Windows 的“管理 Host 连接 → 取消配对”或 Linux 端撤销设备才解除配对。客户端撤销需要 Host 明确确认，响应未确认时保留本机凭证并显示错误，见 D-087。

Windows 字体由 Windows Main 枚举。WSL 的文件选择、文件打开、系统通知呈现和窗口聚焦也在 Windows 执行；通知只跨管道传递有界文字和一次性 opaque id，Linux 保留已验证 Session 的激活回调。内部桌面通道不暴露给 Renderer。通知支持条件遵循 [Electron Windows 通知说明](https://www.electronjs.org/docs/latest/tutorial/notifications#windows)，失败会报告，不回退到 Linux 通知。

## 验证边界

`test-platform` 覆盖会话身份、退出与配对、SSH transport、WSL framing、通知回调、字体归属、构建清单和 WSL 更新失败保留旧版本。Windows 原生运行额外覆盖 Credential Manager 与真实字体枚举；WSL 更新脚本的文件系统测试只在 Linux 执行。

完整 `test` 使用当前安装的 Pi 包，不依赖开发者个人全局安装路径。其余核心测试仍要求各模块规定的工具链；Git Branch Sync 已使用有上限的 `for-each-ref --count` 扫描，兼容 Ubuntu 24.04 自带的 Git 2.43；符号引用也计入扫描预算，超过预算明确报告截断，不再依赖 `--start-after`。类型检查和平台回归通过不能替代真实 Windows/WSL 的项目选择、附件、对话、导出、通知点击和关闭重开验收。P4-3 SSH 发布 gate 与 P4-4 的交互 gate 继续单独记录。

2026-09-13 首轮验证记录保存在本机 `release/evidence/cross-platform-validation.json`，其中完整核心测试的旧失败清单已由后续验证更新。本轮改进的结果与仍开放的真实交互项见 [改进计划](cross-platform-improvement-plan.md)；证据只适用于记录的源码快照，并发修改需要重新验证。
