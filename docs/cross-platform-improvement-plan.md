# Windows / WSL 后续改进计划

2026-09-13：用户确认按计划逐项实施。保留当前共享工作区的其他修改；每项单独记录实现、验证与未覆盖边界。

## 目标与边界

优先改善 Windows / WSL 共同开发和日常启动体验。Windows 继续负责桌面，WSL / Linux Host 负责 Pi、项目和会话。执行环境采用重启切换，记住明确选择；不迁移正在运行的任务、不增加 Windows 原生 Pi、不自动发现或连接其他主机。客户端偏好使用独立持久化，不复制项目与会话。

## 顺序与验收

| 阶段 | 工作 | 验收 | 状态 |
| --- | --- | --- | --- |
| A | 修复 Git 2.43 remote-tracking 枚举与 Git 子进程错误处理；提供只读环境诊断；复核 WSL 交互验证缺口 | Git 有界枚举、symbolic ref 与错误传播回归；诊断准确报告实际工具链；真实窗口行为与脚本验证分别记录 | 工程完成；交互缺口见下文 |
| B | 分离运行与校验开发目录；复用已验证且输入未变的构建和 WSL release；记录同步耗时 | 开着 dev 可执行校验；依赖安装仍有互斥；无改动复用、变更重建、损坏明确报错；两端验证 | 完成 |
| C | 提供明确的 Windows WSL / SSH 启动选择与当前环境显示，持久化上次选择，重启切换 | 活跃任务阻止切换；目标配置先验证；旧连接完成关闭后重启；失败保留可诊断状态；不跨环境继承旧控制身份 | 完成；原生确认框使用脚本应答 |
| D | 字体、外观、快捷键和窗口行为归客户端；工作区行为继续归 Host | 本机偏好可独立读取/修改；旧 Host 设置只做首次迁移；SSH 与 WSL 使用相同客户端偏好；不会写回 Host 覆盖其他设备 | 完成 |

## 执行规则

- 复用现有 typed IPC、状态和控件；不增加通用 backend registry 或平行配置入口。
- 修改前确认实际 owner；前端遵循 `docs/frontend-guidelines.md`。
- 工程验证使用平台独立依赖目录，记录源码摘要；并发任务后续修改不自动继承此前通过结论。
- 真实通知点击、系统文件对话框等只能用实际交互作为完成证据。未验证项保留开放，可继续不依赖它的后续工程项。
- P4-3 SSH 发布验收仍按原计划的同版本真实 Host 条件执行，不以本计划的源码改进替代。

## 本轮证据

- A：Git suite 66/66；真实 Git 2.43 有界扫描通过，包括 300 个 symbolic ref 后仍可见的真实 branch、超过扫描预算明确截断，以及 hash 子进程 EPIPE 保留实际 Git 错误。`doctor` 在原生 Windows 与 WSL 都完成只读检查。
- B：真实 workspace runner 的持续 dev 进程与 typecheck 并存测试通过；使用轻量 dev 子进程 fixture，锁、依赖目录、源码同步均为实际脚本。测试覆盖后续内容/权限变化与退出释放锁。构建复用覆盖缺失、相同输入、源码/脚本变化和损坏产物；WSL 部署覆盖失败保留旧 release、相同清单复用和损坏明确拒绝。真实隔离 WSL 安装后再次部署，确认为复用现有 release。
- C：Kernel 回归验证活动会话拒绝准备重启，静止后同步关闭 prompt 准入。原生 Windows Electron 在独立数据目录完成 WSL → SSH → 无参数重开 SSH → WSL；目标不存在、取消与并发切换拒绝后原 WSL 连接仍可读。使用实际 Main/preload/Renderer/WSL 与 `app.relaunch`，确认框应答由验证脚本提供，没有执行模型任务或改变用户的默认 Host。
- D：持久化回归覆盖首次迁移、并发字段更新、重建 store、跨环境保留、非法文件/命令拒绝；Windows 实际外观页切换浅色后，本机偏好改变而 Host appearance/shortcuts/general 完全不变。SSH 未连接时仍恢复本机主题，返回 WSL 后偏好相同。
- 完整核心回归 1306 项：1301 通过、5 跳过、0 失败；56 项平台回归在 Linux 为 54 通过/2 跳过，Windows 为 52 通过/4 跳过。两端类型检查与 Desktop/Web 生产构建通过。结果保存在 `release/evidence/cross-platform-improvements-validation.json`。两端最终源码摘要 `e30525a6425872f8c168d3b5bfef6a1531ae5cec3fe07a336e11e408d3b043aa`、产物摘要 `6688bcc67a441f133487d60834a549cf5673d24d327f5eb406f579a051d9afee` 一致；这是当前 dirty 工作区快照，不是发布 tag。
- 窗口尺寸下限实际为 720×560；请求缩小到 640×600 时，Electron 保持 720×600。此实际尺寸下连接页可滚动到环境控件且无横向溢出。测试进程已退出、WSL 锁已释放，Windows/WSL 独立测试数据均已清理。
- 首次核心回归曾有一个前后台状态对比测试因时间戳相差 1ms 失败，后续两次全量通过；该断言的时钟敏感性未在本项重构。

## 2026-09-14 运行边界补验

- Windows Node 26.4.0 原生执行当前 `test:platform` 中的完整测试列表：66 项，61 通过、0 失败、5 项因 Linux 文件权限、部署或 dev fixture 条件跳过。字体枚举、Credential Manager 和 npm shim 均在 Windows 实际通过。平台入口已补入 `pi-executable.test.ts`，凭据测试改用每次唯一的测试名称并注册失败后的清理。
- 新增 `shared-pi-prompt.test.ts`，使用真实 Shared Host / Pi SDK 与临时项目、Agent 目录和本地模型响应 fixture，覆盖两个并发会话的同名文件读取、SSE 分片、分叉、销毁 Host 后恢复三个会话及继续对话。4 次 prompt、8 次模型 HTTP 请求、4 次内置 read 执行通过；原会话文件和另一个会话的历史保持一致。
- 这是 SDK 运行边界的自动化回归，不覆盖 Windows Renderer → WSL 管道 → Kernel 的完整 prompt/tool 产品路径，也不替代下面的原生交互和 SSH 发布 gate。没有更换用户默认安装或使用用户模型账户。完整本轮证据见 [架构审查第七轮](architecture-review-2026-09-13.md#11-第七轮windows-原生检查与真实-sdk-会话回归)。

## 2026-09-14 真实模型链路补验

- 原生 Windows Node 使用生产 `startWslBackend` / `WslPipe` 启动独立 WSL 数据目录中的实际 Electron Main、Kernel 和 Shared Pi SDK，两端验证同一构建清单。使用用户配置的真实 `grok-4.6`；测试项目、会话及凭据副本均隔离。
- 发现并修复 Shared SDK 遗漏 CLI 代理初始化的问题：握手与会话启动成功，但模型直连超时。`SharedPiProcessEnvironment` 在首个 Host 创建时通过 Node 公开 API 捕获 `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY`（含小写形式），最后一个 Host 释放时恢复原设置；会话内环境覆盖不会重置进程网络配置。没有新增依赖或私有 SDK 导入。
- 修复后通过 11 个检查点：真实 prompt/read/write/bash、Windows 中文空格路径附件映射与读取、实际 HTML 导出及内容核对、分叉身份、归档撤销、独立归档预览及凭证只能使用一次、活跃工具阻止环境切换、中止工具、Host 重启后恢复原会话及分叉会话并继续对话、空闲关闭。中止后超过原工具执行期限复查，无迟到写文件；Host 进程退出、锁释放、凭据副本移除。
- 本轮没有操作 Windows Renderer。附件路径由验证程序提供，导出提供明确路径；4 次通知转发只由 transport 接收器记录，没有显示或点击原生通知。不得将这些结果记为原生交互完成。
- 核心回归 1,310 项（1,307 通过、3 项 Windows 条件跳过、0 失败），Windows 代理与实际 SDK 定向回归 3/3；类型检查与生产构建通过。代理回归使用无法直连解析的 `.invalid` 模型域名、本地 CONNECT 代理和 gzip SSE，修复前失败、修复后通过，并验证 `NO_PROXY` 直连。
- 源码摘要 `c8dae8607765eed328dc89e2a756656dc8aaf654a8332bde55bb3bc9eb9820d9`，产物摘要 `61272073c297456012fcdb95e189af59c6fc1f19467dc140a55b2e9b6de5a29e`。证据见 `release/evidence/pi-gui-wsl-live-mbeztalk/`；默认 WSL 安装和用户全局配置未替换。

## 2026-09-14 Windows 原生交互验收

- 正式 Computer Use 已恢复，可通过 `@oai/sky` 操作真实 Windows 窗口。使用独立 Windows appData 与 WSL XDG/Agent 目录运行同一生产构建；没有替换用户默认安装，没有 mock 文件对话框或执行 Renderer 脚本。
- 已实际通过：项目目录选择及取消、WSL UNC 项目路径转换、附件选择及取消、中文空格文件名附件由真实模型调用 read 读取、HTML 保存及取消、正常关闭重开恢复原会话、分叉后编辑发送及新旧会话切换、归档、原生环境重启确认的取消和 WSL → 未连接 SSH 客户端的确认重启。取消确认后再次归档成功，确认重启后 WSL 锁释放。
- 首条用户消息分叉首次验收失败：SDK 会延迟保存没有助手历史的分叉，而 Kernel 立即校验文件导致 ENOENT 并停止 Runtime。修复复用现有临时会话生命周期；仅当没有助手历史且校验为 ENOENT 时延迟登记，首次助手回复落盘后再保存指针。权限错误和已包含助手历史的文件缺失继续报错。真实窗口复测已收到 `NATIVE-FORK-FIX-20260914`，新文件保留正确 `parentSession`，原文件完整。
- 定向回归 5/5，完整 Kernel 与实际 SDK 回归 246/246；最终源码核心回归 1,313 项（1,310 通过、3 跳过、0 失败），类型检查、生产构建通过。源码摘要 `579aed41b319151657b7cd36d574f969fefdd00f4b1d4af6bcebfee3eba4b8ad`，产物摘要 `4b4d76a961a47b5651bb67cbace48b84e7d85708ab4257accba425157d102da7`，已复核工作区源码与测试构建一致。
- 证据见 `release/evidence/pi-gui-native-96we6oyk/README.md`。测试窗口已正常关闭，Host 锁已释放，临时模型凭证已移除，并对隔离数据及证据检查实际密钥字节残留，结果为零。

## 仍开放的验收

- 系统通知已由 WinRT 通知历史确认送达，修复后的正文为纯文本；横幅可见性与原生点击返回正确会话仍未取得证据。2026-09-15 用户要求跳过当前系统通知点击验收，本轮停止该项，记为用户跳过，未计为通过。应用内完成通知的“查看”跳转已通过，但不能替代系统通知点击。
- 归档与人工操作撤销已通过；用户明确尚未执行“临时查看”，该项仍未验。归档撤销由用户完成后确认，随后复查真实窗口与持久化状态：四条合成会话均在列表，归档标记为空；工具没有捕获点击过程。此前自动化续验从归档到观察按钮为 853ms，到下一次输入为 9149ms，超过 5 秒有效期；未因此修改产品时限。证据见 `release/evidence/pi-gui-native-assisted-20260915/undo-result.json`。P4-4 保持 In Progress。
- 本轮隔离测试窗口已关闭，WSL 锁已释放，临时模型凭证已移除；扫描隔离数据和本轮证据的 131 个文件，未检出实际密钥字节残留。用户默认安装未修改。收尾记录见 `release/evidence/pi-gui-native-assisted-20260915/cleanup.json`。
- P4-3 同 tag 的真实 Linux SSH Host 配对/对话/重连/撤销发布 gate 仍由用户暂缓；双向切换中的 SSH 端只验证断开状态的桌面客户端。
- 用户默认 WSL 安装未被测试环境替换。使用本轮代码时，从 Windows 执行 `node scripts/workspace.mjs wsl` 更新对应后端；已有窗口先正常关闭。

## 2026-09-14 原生续验

- SSH → WSL 原生反向重启通过：通过 `WSLENV` 仅向测试进程传递隔离 XDG/Agent 目录，先验证目录传递，再由真实界面选择 WSL、点击独立原生确认框，重启后成功恢复隔离项目。没有改写默认后端或发起 SSH 配对。
- 运行中切换拦截通过：真实模型调用 WSL bash 执行 `sleep 90`；在工具执行期间由原生确认框提交环境切换，界面明确拒绝“有会话正在工作或等待回复”。原连接保留，工具自然结束并收到 `NATIVE-GUARD-NOTIFY-20260914`。
- 通知排查：现有 Electron 开始菜单快捷方式的 target 与 AppUserModelID 已匹配测试实例，没有新建或修改快捷方式；WinRT ToastNotifier 设置为 Enabled。`SHQueryUserNotificationState` 连续两次返回 2（`QUNS_BUSY`），其中一次紧随 Pi GUI 前台激活。按 [微软定义](https://learn.microsoft.com/en-us/windows/win32/api/shellapi/ne-shellapi-query_user_notification_state)，该状态表示全屏应用运行或应用了演示设置；通知显示与点击仍需在合适的桌面状态下补验，不能据此确定唯一根因。
- 本轮未修改产品代码，测试构建源码指纹仍与工作区一致。证据见 `release/evidence/pi-gui-native-followup-20260914/`；此前全库回归保留为原构建证据，不重复计为本轮新跑测试。

## 2026-09-15 通知续验与修复

- Windows 状态恢复为 `QUNS_ACCEPTS_NOTIFICATIONS`（5），ToastNotifier 为 Enabled；真实 WSL `sleep 30` 完成后，WinRT 通知历史包含对应“用时 35 秒”的通知。之前未观察到横幅不能推断为未送达系统。桌面工具没有返回可操作的系统通知窗口，已请求用户打开通知中心协助最终点击。
- 原生应用内完成通知的“查看”按钮已打开正确会话并显示 `NATIVE-NOTIFY-READY-20260914`，未把它计为系统通知点击通过。
- 修复正文格式：通知扩展统一输出纯文本，避免 Windows 显示字面的 `<b>` 标签。修复生命周期：Windows 横幅 `close(reason=timedOut)` 不再释放点击动作；客户端与 WSL Host 共用现有 5 分钟期限，用户取消、期限届满或退出仍释放通知与回调。[Electron 文档](https://www.electronjs.org/docs/latest/api/notification#event-close)明确区分横幅超时与通知中心的保留状态。
- 生命周期回归接入实际 WSL presenter/client，验证横幅超时 30 秒后仍能激活且只执行一次，并覆盖用户取消、过期、退出清理；用旧生命周期替换修复实现时，该回归失败。Linux 通知相关 11/11、Windows 定向 5/5、类型检查与生产构建通过。未重复运行完整核心回归。
- 修复构建重启后，真实 WSL `sleep 20` 任务收到 `NATIVE-NOTIFY-FIX-20260915`；Windows 通知历史从 5 条增至 6 条，新增“用时 25 秒”正文已无 HTML 标签。源码摘要 `b7d8538fe2b6d4d747e0b020c660b55eec84432b645e7a2b5e60a0165170c70d`，产物摘要 `d3d804af0704c55ec9c2cb9b28f327ab67a0b4b64cec356405ae9b778817736a`，与工作区源码核对一致。
- 归档撤销/临时预览仍受 5 秒操作窗口限制，未取得原生成功证据；未调整归档时限。P4-3 SSH gate 继续暂停。详细证据、资源清理与未覆盖项见 `release/evidence/pi-gui-native-followup-20260914/notification-fix-validation.json`。
- 最终构建补验退出：收到 `NATIVE-NOTIFY-SHUTDOWN-20260915`，WinRT 历史新增纯文本通知；原生关闭后，该通知移除且历史恢复为先前 5 条，WSL 锁释放。客户端退出不再向即将断开的 Host 发送冗余撤销请求，最终桌面日志没有该竞争错误。测试实例已关闭，临时模型凭证已移除，隔离数据与证据未检出实际密钥字节残留。旧构建遗留的 5 条测试通知没有批量清除。
