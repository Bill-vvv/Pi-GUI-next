# Pi GUI 架构

## 运行拓扑

```text
Electron Renderer
    -> typed preload IPC
Workbench Kernel (Electron Main)
    -> RuntimeContext[projectPath, sessionFile]
       -> RuntimeHost
LinuxLocalRuntime（每个 Session RuntimeContext 一个）
    -> PiRpcClient / strict LF JSONL
pi --mode rpc
    -> pi-gui-task-notify / bounded local request
DesktopNotificationBroker（Electron Main）
    -> notify-send / default action
```

Electron Main 仍是唯一 control plane，但可同时管理多个相互隔离的 Session Runtime。当前主路径不建立 GUI server、WebSocket、SQLite、launcher/mirror 或直接 Pi SDK 的第二条主路径。

## 所有权

| 组件 | 唯一职责 | 明确不拥有 |
| --- | --- | --- |
| Electron Renderer | 展示 normalized state；发出 typed command | 子进程、文件系统、raw Pi event |
| Preload | 暴露窄的 typed IPC API | 业务状态、Pi 协议 |
| Workbench Kernel | Project、按 Session 隔离的 Runtime context、Conversation 投影与状态转换 | Linux spawn 细节、JSONL framing |
| LinuxLocalRuntime | executable、cwd、spawn、signal、退出语义，以及 Main 授予该 Pi 子进程的通知 Broker capability | renderer 状态、Pi message 解释 |
| PiRpcClient | LF JSONL framing、request/response correlation、RPC 事件接收 | GUI identity、重启策略 |
| DesktopNotificationBroker | 私有 Unix socket、桌面通知动作和已注册 Session 激活 | Conversation 内容、通用远程控制或任意路径打开 |

Electron Main 是唯一 control plane 和全部 Pi 子进程 owner。Renderer 不启动进程、不读取 Pi stdout，也不解析 raw Pi event。多个 Runtime 可并发运行，但每个 Runtime 只绑定一个 Pi Session；Renderer 同一时间只投影当前选中的 Session，后台状态通过 Session summary 展示。

持久化 Session、受管 `RuntimeContext` 与实际 Pi RPC 进程是三个不同生命周期。新建对话可先拥有仅供活动工作区使用的空 provisional Runtime/identity；它在首条 prompt 被接受前不进入 Project Navigator 或数量统计，切换到其他 Project/Session 时直接停止移除。首条 prompt 成功提交后，同一 identity 才进入导航并等待 Pi JSONL materialization。S26 不向 Renderer 暴露主动休眠命令；Main/Kernel 只保留内部回收原语和保守的自动回收：每分钟扫描一次，后台 Runtime 连续 5 分钟未被激活或观察到活动后才进入候选，同时始终保留前台与最近使用的一个 quiescent 后台 warm Runtime。每个目标在 prepare 前、commit 前和 stop gate 内重新核对 persisted identity、foreground、ready/settled、provisional、queue、usage、naming、compaction、identity commit、stop 与 Runtime generation；stop 失败继续保留 Runtime ownership，再次选择时恢复同一 Session。任何未知 Extension owner、busy lease、协议错误、超时或竞态都只跳过本轮。

## RuntimeHost 最小接口

当前主路径只实现实际使用的五项能力：

```text
start
send
stop
getState
subscribe
```

出现第二个真实后端之前，不增加注册中心、插件发现或 transport 抽象。

## 状态来源

| 状态 | 事实来源 | 持久化位置 |
| --- | --- | --- |
| Conversation 内容 | Pi session 文件 | 由 Pi 管理 |
| Pi credential/provider auth | Pi | GUI 不回读凭据；认证与刷新由 Pi 管理 |
| 自定义 Provider/Model 配置与模型单价 | Pi `models.json` | GUI 只编辑官方配置；密钥只写不回读；显式拉价后保存 USD/百万 token 单价 |
| Subagent Package 与 Extension 启停 | Pi `settings.json` `packages` | GUI 只安装固定 Package，并通过官方资源过滤控制其 Extension 是否加载 |
| Subagent 运行参数 | Workbench Kernel | XDG config；只在新建或显式重载 Runtime 时通过 `PI_SUBAGENT_MAX_DEPTH` 环境变量生效 |
| Subagent Agent 定义 | `pi-subagents` Markdown frontmatter | Main 只管理用户级 `~/.agents/` 与当前项目 `.pi/agents/`；内置定义只读 |
| Subagent Agent 启停 | `pi-subagents` `settings.subagents.agentOverrides` | 用户级写入 Pi `settings.json`，项目级写入 `.pi/settings.json`；项目级优先 |
| Magic Context 安装与 Extension 启停 | Pi `settings.json` `packages` | GUI 只展示真实 Package/资源过滤状态；配置与健康由上游 setup、doctor 和 `/ctx-status` 负责 |
| 历史 Advisor advisory | Pi session 中既有的固定 custom message | Kernel 继续严格归一化为只读 Conversation entry；当前产品不再提供安装、启停或 roster 控制面 |
| Project、外观、通用与有限应用快捷键设置 | Workbench Kernel | XDG config |
| 最近 session 指针与非敏感启动证据 | Workbench Kernel | XDG state |
| Runtime 瞬时状态 | Workbench Kernel | 仅内存 |
| 历史 Prompt 分支与活动 leaf | Pi Session Tree / `get_tree` | 由 Pi session 文件管理；GUI 只执行受控 `navigate_tree` 并刷新真实分支 |
| Git repository 状态 | 当前注册 Project 对应的 Git repository | Main 内 `simple-git` 即时读取；Renderer 不提交 cwd、命令或 raw Git 参数，不另建 Git 数据库 |
| Package/Extension/Skill/Prompt 静态 inventory | 已验证 Pi 0.80.10 package root 与 Pi settings | 离线 child 只读投影；不安装 Package、不执行 Extension factory、不表示当前 Runtime effective state |

GUI 不建立 Conversation 数据库，也不把 renderer 投影当作对话事实来源。

自定义模型的 `cost` 仍由 Pi 官方 `models.json` 持久化。用户显式点击一键拉价时，
Electron Main 只请求一次 LiteLLM 公开价格目录，批量匹配当前 Provider 的全部模型，并通过窄
typed IPC 返回每个命中模型的匹配键、四项单价及未命中模型列表；
Renderer 不直接联网，也不建立价格数据库或后台自动刷新。保存后的单价由下一次新建或显式重载的
Runtime 使用，供 Pi 计算后续请求费用；不改写既有 Session 中已经记录的历史 cost。

Subagent 适配固定使用 `pi-subagents`。拓展页以独立的“已适配拓展”区域承载该
Package 的显式安装和启停；Subagent 页不重复安装或启停入口，而是管理 Agent 定义和
运行参数。“关闭”保留 Package 安装，只把对应 Extension resource 在 Pi 官方
PackageSource 中禁用。

Agent 管理通过窄 typed IPC 读写 `pi-subagents` 实际发现的 Markdown 定义。Renderer 只接收
规范化字段，不取得文件路径或任意文件 API；Main 只允许用户级 `~/.agents/*.md` 与当前
canonical Project 的 `.pi/agents/*.md`。内置 Package 文件保持只读，但界面允许直接修改：
首次保存时在用户级或项目级创建同名覆盖，“恢复默认”删除同名覆盖。GUI 只编辑已经接通的
基础与高级字段，保存时保留未由 GUI 管理的 frontmatter。单 Agent 启停复用上游正式的
`agentOverrides.<name>.disabled`，关闭后从 Runtime 发现与可执行列表中移除；不删除定义文件。
Agent 列表按 6 项分页，并支持作用域与启动状态筛选。多选模式一次只批量修改一个公共字段，
不把全部配置同时铺在页面上。

GUI 运行设置只持久化最大嵌套深度；`pi-subagents` 通过该深度上限限制嵌套委派。只有在 Package
已安装且 Extension 已开启时，Workbench Kernel 才把最大深度作为
`PI_SUBAGENT_MAX_DEPTH` 环境变量加入新 Runtime。安装、启停或参数变化都不静默重启
已有 Session；Agent 定义修改同样由用户新建或显式 reload 后进入 Runtime。

Magic Context 作为固定但可选的上下文引擎适配。安装和启停复用 Pi PackageSource；
“已开启”只证明 Extension resource 会在新 Runtime 中加载，不证明 historian、embedding、
SQLite 或 provider 配置健康。GUI 不解析 Magic Context 私有数据库，也不复制其交互式 setup：
用户继续使用上游 `setup --harness pi` 和 `doctor --harness pi`，运行中的缓存、Historian 与
压缩状态通过 Pi 命令目录自然发现的 `/ctx-status` 查看。Extension 启用后由 Magic Context
取消 Pi 原生自动压缩并接管上下文，因此现有 `compaction_start` / `compaction_end` 只描述
仍由 Pi 原生 compaction 产生的生命周期，不能被 Renderer 推断为 Magic Context 状态。

S18 的多 Advisor 安装、Extension resource、实时 system 开关和 roster 管理已退出当前产品。
用户级 Pi 环境不再安装 `pi-gui-multi-advisor`，Settings 也不再展示 Advisor 专页或已适配
拓展入口。仓库中的独立 Package 源码与 [`advisor-system.md`](advisor-system.md) 仅保留为
历史 source snapshot；既有 Session 中合法的 `pi-gui.multi-advisor/advisory` 仍由 strict
Conversation projector 只读展示，避免旧记录因功能退役而不可读。

## Conversation 展示投影

Workbench Kernel 将 Pi message content 按原始顺序投影成 `message`、`thinking`、`tool`、`error`，以及固定适配的 `subagent-notice` 与历史 `advisor` entry。合法的既有 Advisor advisory 继续通过 strict projector 留在对应 turn 内；Renderer 不接收 raw custom payload，也不提供新的 Advisor 控制入口。GUI / typed Pi RPC slash 命令另投影为本地-only 的 `command` entry（只存在于当前 Runtime context 的展示投影，不写入 Pi session）。一次工具调用始终由 `toolCallId` 标识为同一个 entry，`pending/running/success/error` 与输出只原地更新，不为 tool result 创建第二个展示节点。

`todowrite` 使用固定工具适配：Main 只从合法完整参数中投影 `id/content/status/priority`，不把原始 Todo 参数或 details 交给专用界面解析。Renderer 只选择最后一个用户轮次内最新的非失败列表；新用户轮次尚未创建 Todo、空列表或 Conversation identity 变化时旧面板退出。Todo 在 Composer 上方使用专用可折叠面板，普通 Timeline 不重复展示同一工具卡；面板实际高度继续由 Composer 测量并进入 Timeline clearance。

`ask` 使用固定的交互式工具适配。Main 只接受严格归一化的 `single`、`multiple` 与 `text` 问题，把受控交互状态附着在原 `toolCallId` 对应的运行中 tool entry 上，不创建第二个 Timeline 节点，也不把原始 `extension_ui_request` payload 交给 Renderer。Renderer 只通过窄 typed IPC 提交结构化答案或取消；Kernel 必须同时校验当前 `sessionKey`、`toolCallId` 与等待中的 extension UI request，并按问题顺序发送 `extension_ui_response`。Session、工具或请求 identity 变化时旧交互立即失效，提交错误只更新该工具的受控错误状态。

Kernel 在活动开始时记录当前 run 的 entry 起点，并只以 `agent_settled` 结束该边界。Renderer 对活动 run 线性展示 thinking 与工具状态；run settled 后，把 thinking 和工具项折叠到该轮最终回答上方，展开时仍使用原始顺序。文件操作摘要只从有明确结构化路径的工具参数提取，不猜测 `bash` 的文件副作用。

固定的 `pi-subagents` 显示适配仍走同一 Conversation projector。Main 只在 `subagent`
工具的结构化 `details` 中提取模式、run/async identity，以及每个参与 Agent 的任务、状态、
实际模型、input/output/cache read/cache write token、USD 费用、当前工具/路径、轮次、工具数、
耗时、错误、最终输出与显式 file-only output reference；原始 details、child messages、child
transcript 和普通 artifact 清单不进入 Renderer，输出引用也只包含 Agent、绝对路径、展示大小
与行数 metadata，不读取文件正文。前台运行保留为同一 `toolCallId` 的专用过程项；后台完成和
需要关注等只接受固定 `customType` 且 `display: true` 的 Pi custom message，投影成严格归一化
通知。普通 completion 通知在 Timeline 只渲染轻量可点击的完成任务胶囊；Main 从固定通知协议
移除重复 envelope 与 Session file 行，并把合法 `Output saved to` 行投影为输出引用。通知完全没有
携带实际模型、usage 或执行统计时，Renderer 不渲染空的“运行摘要”分区；任一实际摘要字段存在时，
其余缺失项保持 unavailable。Main 与 Renderer 都不从 Agent 配置、名称或 child Session 反推。
结果与输出引用只进入任务详情；控制、转向、supervisor 请求和 Watchdog 警告仍可显示。结构化
control/request 额外投影 run、participant、request、reason 与 pending/handled 生命周期；同一
run participant 的具体 request 替代泛化 attention，成功 supervisor reply 原地标记 handled。
这类协调默认是主 Agent 内部状态，只有 completion guard 与 Watchdog blocker 使用 alert；
`subagent list/status`、`subagent_wait` 与 supervisor/intercom 的 pending/status/list 属于内部发现或
轮询，不进入 Timeline。supervisor reply 与 steer/resume/interrupt/stop 等有意义动作保留简洁状态，
原始参数留在展开技术详情。Main 只按固定 completion 首行协议建立独立详情目标，GUI 不用通知
Markdown 强行关联原 run，也不直接绕过主 Agent 回复子代理。

Composer 附件沿 Pi 0.80.10 的交互式 TUI 与 RPC 边界处理：普通文件只把 `@路径` 放入消息，由 Agent 使用 Pi 原生 `read` 工具按需读取；不在首条 prompt 中内联文件正文。`read` 的文本结果遵循 Pi 的 2,000 行或 50 KiB 截断边界，并可用 offset/limit 继续。图片转换为 RPC `images` 中的 `{ type: "image", mimeType, data }`，直接使用原生多模态输入。系统文件选择由 Main 取得路径，显式拖放由 Renderer 通过 Electron `webUtils.getPathForFile` 取得路径；普通文件只读取小段签名头用于区分图片，图片在进入 IPC/RPC 前满足 2000×2000 与 4.5 MiB base64 边界。

Pi session 仍保存完整用户消息和 image content block。Kernel 对 Renderer 只投影文件名、路径和类型摘要，不把附件正文或图片 base64 放入 `KernelState`；恢复历史和实时事件使用同一投影。用户点击时间线中的图片附件时，Renderer 通过窄 typed command 按需读取对应 session 消息中的 `ImageContent` 并在灯箱中展示，仍不把图片 payload 写入常驻状态。附件变化不能走纯文本 append patch，必须回退全量状态以避免静默丢失附件。

工具结果同样可以携带混合 `TextContent` / `ImageContent`。`tool_execution_update`、`tool_execution_end` 与历史 `role: 'toolResult'` 统一投影为同一 `KernelToolEntry`：文本进入 `output`，合法图片只进入 metadata-only `attachments`（含稳定 `contentIndex` 与 `toolCallId`），base64 绝不进入 KernelState、patch 或 Renderer 常驻状态。支持 PNG/JPEG/GIF/WebP；非法、空、非 canonical、超限或 MIME/signature 不匹配的图片块被忽略，且不破坏同结果中的合法文本或合法图片；terminal tool 忽略晚到的 start/update。Renderer 在普通工具详情中展示图片入口（即使没有文本输出也不显示“等待工具输出”），点击后通过 `getToolImage(sessionKey, toolCallId, contentIndex)` 按需读取；历史以当前 active branch 的 Pi transcript 为事实源。只有 terminal end 可写入 Main 实时兜底 cache；cache 绑定 Project、Session、Runtime generation 与工具图片 identity，只有同一 displayed Runtime 仍投影该附件且消息列表尚未 materialize 对应 toolResult 时才能读取，并受 60 秒 TTL、8 条目和 24 MiB base64 总预算约束。权威消息读取成功、terminal 替换、identity 迁移、归档或停止会清理相应 cache。Subagent 专用工具不投影/显示该通用图片 UI；Session HTML export 不在此路径扩展。

高频 Pi message、thinking 和 tool update 不重复发送完整 `KernelState`。Kernel 发送带单调 revision 的 `kernel.state-patched`：新 entry 按 index 插入，append-only 文本和工具输出只发送起始长度与新增后缀；非前缀改写或无法安全增量化时立即退回带 revision 的 `kernel.state-changed` 全量快照。初始读取和显式重同步返回将 state 与当前 revision 原子绑定的 `KernelSnapshot`。Renderer 严格按 revision 应用事件，连续 patch 最多每动画帧提交一次 React state；revision 缺口、patch 队列溢出或 acknowledgement 等待超时只触发一个定向 snapshot 重同步，已经应用更新后的同 revision 或旧 snapshot 直接忽略，不能回退较新的事件状态。

会发布状态的 mutating typed IPC 不再在 invoke 返回值中复制完整 `KernelState`，而是返回窄的 `KernelMutationAck { revision }`；归档、fork 等操作只在同一 acknowledgement 上增加必要的领域结果。Renderer 只有在 revision barrier 确认该 ack 对应的 state event 已应用后，才把操作视为 settled，因此 invoke 完成不能覆盖或回退事件通路已经发布的较新状态。仍属于目录查询、预览、图片读取等 read/domain API 的调用按各自窄结果返回，不伪装成状态 mutation。

Main→Renderer 的连续 `kernel.state-changed` / `kernel.state-patched` 使用 8ms 窗口和最多 64 个成员的有界 envelope。新的完整 state 会替代此前尚未发送的 state/patch，之后的 patch 仍按 revision 顺序保留；compaction 等领域事件先 flush pending state，作为顺序屏障。Renderer 逐成员复用同一 revision barrier、RAF patch 合并和 snapshot resync，不改变 ack 语义。该边界约束 Main 发送前队列与 structured-clone envelope 数量，不声称能够控制 Electron/Chromium 已接收后的下游字节队列。

Pi compaction 不进入 Conversation entry：Kernel 以独立 lifecycle 标记所属 Runtime context，成功后核对 identity 并一次替换 Conversation、usage 与生命周期 statistics，失败或取消保留旧投影。

Timeline 默认只挂载最近 60 个 settled turn，用户可按 60 轮继续向前展开且保持当前滚动锚点；折叠的工作过程只保留摘要，展开时才挂载 thinking、工具参数与输出正文。当前 60-turn 规则只是 Renderer 的 DOM 挂载窗口，活动 Conversation 仍整体存在于 KernelState 与 Renderer 投影中，不等同于数据分页、工作集驱逐或内存预算已经完成。长对话滚动时，Renderer 只从当前已投影的用户 message 计算顶部阅读轮次，供 Prompt 导航轨高亮与定位使用；这只是展示投影，不复制或持久化 Conversation 事实，也不在 Session Header 下粘着 prompt。

## 历史 Prompt 与 P3 前置基础

历史 Prompt 原位编辑沿用 Pi TUI Tree 的事实与顺序，不建立第二套分支协议：Renderer 只对当前可见活动分支中的纯文本 user turn显示编辑入口；Main 将该 turn fail-fast 解析为 Pi active path 上的 entry ID，调用 `navigate_tree` 后返回 revision acknowledgement；Renderer 再复用现有 `prompt`。导航成功而发送失败时保留草稿并只重试 prompt；Session identity 变化、Runtime busy、图片消息或无法唯一解析时明确拒绝。旧分支继续由 Pi Session Tree 保存，GUI 不改写 JSONL。

P3 的 Git 与 Capability Inventory 当前只提供 Main 侧基础。Git typed bridge 只接受已注册的 Project identity，ancestor repository 需要绑定当前 root 与 status revision 的内存 trust challenge；diff/mutation 继续使用 service snapshot fence。Capability Inventory 每次 spawn 前复用现有 Pi executable、精确 0.80.10 与 package-root export 验证，并在无网络、无 Extension factory 的 child 中生成有界静态投影。两者尚未形成 Git 工作台或 Settings Capability Center，不能视为 P3 已启动或完成。

## Runtime 状态机

```text
stopped -> starting -> ready -> running -> ready -> stopping -> stopped
任何运行状态 -> crashed -> 用户显式 restart -> starting -> resume session
```

状态变化只有 Workbench Kernel 一个 owner。每个 Session context 独立执行同一状态机，后台事件不得改写当前 Session 投影。Pi 非正常退出必须只让所属 context 进入 `crashed`；不自动无限重启。完整一轮以 `agent_settled` 为稳定点，不把中间的 retry、compaction 或 continuation 误判为结束；`compaction_start` / `compaction_end` 保留 manual、threshold、overflow 与 `willRetry` 语义并单独收口。

“重启后自动继续”是默认关闭的调试开关，只在正常 GUI shutdown 边界工作。Kernel 在停止 admission 前精确快照当时全部 `running + unsettled` 的已持久化 Context，并排除 provisional、Ask 等待、compaction、identity commit、stopping 与无法校验的 Session。一次性状态保存 exact `projectPath + sessionFile + sessionId` 和 canonical epoch-millisecond `capturedAt`；下一 boot 先绑定 boot ID，逐 Session 在发送继续 prompt 前原子 claim，claim 后即使崩溃也不自动重放。未被当前 boot 消费的旧状态在再下一次启动直接失效，不能根据 transcript、crashed、mtime 或 `settled=false` 猜测任务仍在运行。恢复可后台启动多个 Project/Task Runtime，但不得持久化改写最后的前台 Workspace/Session；需要新 Project trust 决定的候选等用户正常打开并授权后再继续。

## Runtime 内存与休眠边界

持久 Session、managed RuntimeContext 与 Renderer 工作集是三个不同生命周期。休眠停止一个非前台 Pi Runtime，同时保留 Session pointer、导航 identity 与 transcript；再次选择时按同一 Session identity 重新启动。Renderer 的 Chromium native allocation 不属于 Runtime 休眠直接回收的内存。

每个 managed Pi RPC 都显式加载 app-owned `pi-gui-runtime-quiescence` Extension。Main 通过隐藏命令和 nonce-correlated `setStatus` 取得 provider 协调结果，通过严格 `get_extensions` RPC 取得完整、脱敏、版本化的 loaded-Extension inventory；Pi 0.80.10 使用受版本约束的 private inventory bridge。protocol、complete/loading 一致性、capability、数量、路径边界或 owner discovery 任一异常都 fail-closed，不允许回退扫描 Timeline 或猜测 Extension 状态。

安全休眠由 coordinator 和每个后台 owner 共同执行 generation-fenced `prepare -> commit -> stop -> release`。coordinator 为同一 Session lifecycle 与 attempt 生成 exact token；Magic Context、pi-subagents、MCP adapter、CPA Responses WebSocket、Multi Advisor、ask 与 task-notify 等 owner 必须先同步关闭新 mutation admission，再确认已经进入的工作全部 drain。busy owner 快速拒绝且不取消原任务；stop 或 rollback 失败只允许用同一 generation、attempt 与 token 重试，不能用新 lease 覆盖仍冻结的 provider。

自动回收每分钟运行一次。后台 Runtime 连续 5 分钟未被激活或观察到活动后才进入候选，并始终保留前台 Runtime 与最近使用的一个 quiescent 后台 warm Runtime。Kernel 在 prepare 前、commit 前和 launch/stop 串行 gate 内重检 persisted identity、foreground、Runtime generation、ready/settled、provisional、compaction、queued messages、naming、usage refresh 与 stop 状态；任何竞态、超时、未知 owner 或 provider 拒绝都只跳过本轮。

Runtime memory diagnostics 是独立的只读 typed API：只返回 opaque Runtime ID、root Pi PID、状态、RSS/PSS/private/anonymous bytes 与固定 unavailable reason；不返回 Project、Session、路径、命令行、prompt/output 或 provider 私有状态。Settings 把 memory 与 quiescence 两份同轮快照只按 opaque Runtime ID 合并；Runtime 集合、active 或 status 在两次采样之间变化时必须显示不完整/状态变化，不能选择任一侧冒充权威。采样期间 identity/PID 变化必须标记 stale/ownership-changed，不能把旧 PID 数据归到新 Runtime。该面板无轮询、无自动刷新、无 stop/hibernate action。

## 安全边界

- Pi 使用参数数组、`shell: false` 和显式 cwd 启动。
- stdout 只承载 strict LF JSONL；stderr 单独诊断，不能污染 framing。
- 诊断默认不记录完整 prompt、tool output、环境变量或 credential。
- Linux PATH、XDG、进程和权限逻辑只能存在于 runtime/main 边界，不进入 renderer 或会话模型。
- 任务完成通知由 Main 的私有 Unix socket Broker 接收 strict v1 单行请求：目录 `0700`、socket `0600`、随机 capability token、固定限长 schema、无 Shell 插值，并以 `notify-send --print-id` 的服务端 ID 回执确认动作通知已创建。点击动作必须重新校验 canonical Project、未归档注册 Session 与可读常规文件；只为首轮 provisional materialization 对同一 identity 做 bounded 重试，验证后才聚焦并调用既有 `activateProject` / `activateSession`。Broker 在 Kernel shutdown 前停止接收并 drain 已开始的激活。
- Renderer 不能按任意路径读取文件；只有 Main 原生选择器返回的文件或用户显式拖放、粘贴产生的 DOM `File` 可以进入附件预处理。普通文件正文不经过 Renderer/IPC，路径只用于发给本地 Pi Agent 按需读取。
- 对话正文使用无 raw HTML 的 CommonMark/GFM + math AST 渲染；`$...$`、`$$...$$`、`\\(...\\)`、`\\[...\\]` 与 `math` code fence 经 `remark-math-extended` / `rehype-katex` 在本地转为 KaTeX HTML/MathML，`trust: false` 禁止公式生成受信链接或外部资源，KaTeX CSS 与字体随应用打包。Markdown 图片仍不自动发起远程请求。
- 流式 Markdown 按动画帧合并并复用稳定顶层块，分块预解析器与最终 Renderer 使用同一 math 语法；未稳定 tail 超过 16,384 字符时停止额外的分块预解析，改由同一 React Markdown 管线整篇渲染，任何长度都不降级为纯文本或仅在 settled 后补公式格式。
- Markdown 链接只能由用户点击触发并经过受信 IPC sender 校验。`http:`、`https:`、`mailto:` 交给系统外部 URL handler；Linux 绝对路径与无远程 host 的 `file:` URL 由 Main 转换为本地路径后使用 `shell.openPath` 打开。Renderer 不直接导航或读取目标，相对路径与其他 scheme 继续拒绝。
