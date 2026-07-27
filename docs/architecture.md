# P1 架构

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
```

Electron Main 仍是唯一 control plane，但可同时管理多个相互隔离的 Session Runtime。P1 不建立 GUI server、WebSocket、SQLite、launcher/mirror 或直接 Pi SDK 的第二条主路径。

## 所有权

| 组件 | 唯一职责 | 明确不拥有 |
| --- | --- | --- |
| Electron Renderer | 展示 normalized state；发出 typed command | 子进程、文件系统、raw Pi event |
| Preload | 暴露窄的 typed IPC API | 业务状态、Pi 协议 |
| Workbench Kernel | Project、按 Session 隔离的 Runtime context、Conversation 投影与状态转换 | Linux spawn 细节、JSONL framing |
| LinuxLocalRuntime | executable、cwd、spawn、signal 和退出语义 | renderer 状态、Pi message 解释 |
| PiRpcClient | LF JSONL framing、request/response correlation、RPC 事件接收 | GUI identity、重启策略 |

Electron Main 是唯一 control plane 和全部 Pi 子进程 owner。Renderer 不启动进程、不读取 Pi stdout，也不解析 raw Pi event。多个 Runtime 可并发运行，但每个 Runtime 只绑定一个 Pi Session；Renderer 同一时间只投影当前选中的 Session，后台状态通过 Session summary 展示。

## RuntimeHost 最小接口

P1 只实现实际使用的五项能力：

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
| Advisor Package 与 Extension 启停（S18-2） | Pi `settings.json` `packages` | 拓展页只识别真实 bare/npm/local source 并控制 Extension resource；未安装时不伪造安装 |
| Advisor system 启用状态（S18-2） | `PI_CODING_AGENT_DIR/pi-gui-multi-advisor.json` | Extension 独占 strict v1 状态；当前 Session capability 经 Kernel 投影，GUI 不复制到 XDG |
| Advisor roster 与指导（S18-3） | Extension 发现的 `WATCHDOG.yml` / `WATCHDOG.md` | Main 只对固定用户级与 canonical Project 路径提供 typed CRUD；祖先与 `.omp` 来源只读 |
| Advisor advisory、状态与用量（S18 目标） | Extension custom entry 与 live state | Kernel 严格归一化；历史进入 Pi Session，瞬时状态只在内存 |
| Project、外观、通用与有限应用快捷键设置 | Workbench Kernel | XDG config |
| 最近 session 指针与非敏感启动证据 | Workbench Kernel | XDG state |
| Runtime 瞬时状态 | Workbench Kernel | 仅内存 |

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

S18 在同一 Pi Runtime 内加载一个固定的多 Advisor Extension。该 Extension
拥有每个 Advisor 的模型、上下文、工具、调度、transcript 和错误状态；Electron Main
不嵌入第二套 Agent Runtime，只提供固定配置路径、窄 typed control 和经过 schema 校验的
advisory/status 投影。拓展页继续唯一负责 Package 安装与 Extension resource 启停；
Advisor 专页只负责已加载系统的总启停、后续单项 roster 配置和真实运行状态。完整边界见
[`advisor-system.md`](advisor-system.md)。

S18-1 已建立独立 Package [`pi-gui-multi-advisor`](../extensions/pi-gui-multi-advisor/README.md)。
它位于主仓库的独立 Package 目录，但不把当前应用改成 workspace；Pi 可以把该目录作为
local PackageSource 手动安装。protocol v1 使用
`pi-gui.multi-advisor/capabilities` custom entry 做能力事实，使用
`pi-gui.multi-advisor/advisory` custom message 保存并交付建议。系统默认关闭，唯一开关事实
是 Agent dir 下的 strict versioned JSON；首版只运行一个使用当前 Provider 中
`gpt-5.6-sol`、固定 `medium` thinking 并复用 Pi auth 的独立只读 Advisor。目标模型、能力或
认证缺失时明确暂停，不回退主模型。S18-2 已由 Pi RPC 固定保留 capability custom entry，
Main 严格投影 capability 与 advisory，preload 只暴露 Advisor system 与固定 Extension
resource 两个 typed control。S18-3 已把 Package 升至 0.2.0 / protocol v2：内建 Default
Advisor 作为第一层，用户级与受信任 Project 的 WATCHDOG 从祖先到叶子合并，同 slug 整项
覆盖；每个 enabled slug 使用独立 Agent、队列和 emission guard。Main 以 YAML AST 提供
user / canonical Project typed list/save/remove，Renderer 显示 effective roster、来源与诊断，
不接触 raw YAML。逐项模型可跟随 Primary 或选择 Pi `provider/model`，thinking 可继承或显式
选择；工具默认 `read/grep/find/ls`，只有 WATCHDOG 显式授权才增加 `edit/write`，不开放
`bash`。配置只在新建或显式 reload Session 后生效。

## Conversation 展示投影

Workbench Kernel 将 Pi message content 按原始顺序投影成 `message`、`thinking`、`tool`、`error`，以及固定适配的 `subagent-notice` 与 `advisor` entry。Advisor 历史和实时消息共用 strict projector，并留在对应 turn 内；Renderer 不接收 raw custom payload。GUI / typed Pi RPC slash 命令另投影为本地-only 的 `command` entry（只存在于当前 Runtime context 的展示投影，不写入 Pi session）。一次工具调用始终由 `toolCallId` 标识为同一个 entry，`pending/running/success/error` 与输出只原地更新，不为 tool result 创建第二个展示节点。

`todowrite` 使用固定工具适配：Main 只从合法完整参数中投影 `id/content/status/priority`，不把原始 Todo 参数或 details 交给专用界面解析。Renderer 只选择最后一个用户轮次内最新的非失败列表；新用户轮次尚未创建 Todo、空列表或 Conversation identity 变化时旧面板退出。Todo 在 Composer 上方使用专用可折叠面板，普通 Timeline 不重复展示同一工具卡；面板实际高度继续由 Composer 测量并进入 Timeline clearance。

Kernel 在活动开始时记录当前 run 的 entry 起点，并只以 `agent_settled` 结束该边界。Renderer 对活动 run 线性展示 thinking 与工具状态；run settled 后，把 thinking 和工具项折叠到该轮最终回答上方，展开时仍使用原始顺序。文件操作摘要只从有明确结构化路径的工具参数提取，不猜测 `bash` 的文件副作用。

固定的 `pi-subagents` 显示适配仍走同一 Conversation projector。Main 只在 `subagent`
工具的结构化 `details` 中提取模式、run/async identity，以及每个参与 Agent 的任务、状态、
当前工具/路径、轮次、工具数、token、耗时、错误和最终输出；原始 details、child messages、
transcript 与 artifact 路径不进入 Renderer。前台运行保留为同一 `toolCallId` 的专用过程项；
后台完成和需要关注等只接受固定 `customType` 且 `display: true` 的 Pi custom message，
投影成严格归一化通知。普通 completion 通知在 Timeline 只渲染轻量可点击的完成任务胶囊，
结果预览只进入任务详情；控制、转向、supervisor 请求和 Watchdog 警告仍可显示。结构化
control/request 额外投影 run、participant、request、reason 与 pending/handled 生命周期；同一
run participant 的具体 request 替代泛化 attention，成功 supervisor reply 原地标记 handled。
这类协调默认是主 Agent 内部状态，只有 completion guard 与 Watchdog blocker 使用 alert；
`subagent_wait`、supervisor reply 和 status/steer/resume 等管理工具只显示简洁状态，原始参数
留在展开技术详情。Main 只按固定 completion 首行协议建立独立详情目标，GUI 不用通知
Markdown 强行关联原 run，也不直接绕过主 Agent 回复子代理。

Composer 附件沿 Pi 0.80.10 的交互式 TUI 与 RPC 边界处理：普通文件只把 `@路径` 放入消息，由 Agent 使用 Pi 原生 `read` 工具按需读取；不在首条 prompt 中内联文件正文。`read` 的文本结果遵循 Pi 的 2,000 行或 50 KiB 截断边界，并可用 offset/limit 继续。图片转换为 RPC `images` 中的 `{ type: "image", mimeType, data }`，直接使用原生多模态输入。系统文件选择由 Main 取得路径，显式拖放由 Renderer 通过 Electron `webUtils.getPathForFile` 取得路径；普通文件只读取小段签名头用于区分图片，图片在进入 IPC/RPC 前满足 2000×2000 与 4.5 MiB base64 边界。

Pi session 仍保存完整用户消息和 image content block。Kernel 对 Renderer 只投影文件名、路径和类型摘要，不把附件正文或图片 base64 放入 `KernelState`；恢复历史和实时事件使用同一投影。用户点击时间线中的图片附件时，Renderer 通过窄 typed command 按需读取对应 session 消息中的 `ImageContent` 并在灯箱中展示，仍不把图片 payload 写入常驻状态。附件变化不能走纯文本 append patch，必须回退全量状态以避免静默丢失附件。

工具结果同样可以携带混合 `TextContent` / `ImageContent`。`tool_execution_update`、`tool_execution_end` 与历史 `role: 'toolResult'` 统一投影为同一 `KernelToolEntry`：文本进入 `output`，合法图片只进入 metadata-only `attachments`（含稳定 `contentIndex` 与 `toolCallId`），base64 绝不进入 KernelState、patch 或 Renderer 常驻状态。支持 PNG/JPEG/GIF/WebP；非法、空、非 canonical、超限或 MIME/signature 不匹配的图片块被忽略，且不破坏同结果中的合法文本或合法图片；terminal tool 忽略晚到的 start/update。Renderer 在普通工具详情中展示图片入口（即使没有文本输出也不显示“等待工具输出”），点击后通过 `getToolImage(sessionKey, toolCallId, contentIndex)` 按需读取；历史以当前 active branch 的 Pi transcript 为事实源。只有 terminal end 可写入 Main 实时兜底 cache；cache 绑定 Project、Session、Runtime generation 与工具图片 identity，只有同一 displayed Runtime 仍投影该附件且消息列表尚未 materialize 对应 toolResult 时才能读取，并受 60 秒 TTL、8 条目和 24 MiB base64 总预算约束。权威消息读取成功、terminal 替换、identity 迁移、归档或停止会清理相应 cache。Subagent 专用工具不投影/显示该通用图片 UI；Session HTML export 不在此路径扩展。

高频 Pi message、thinking 和 tool update 不重复发送完整 `KernelState`。Kernel 发送 `kernel.state-patched`：新 entry 按 index 插入，append-only 文本和工具输出只发送起始长度与新增后缀；非前缀改写或无法安全增量化时立即退回 `kernel.state-changed` 全量快照。Renderer 按顺序应用 patch，并最多每动画帧提交一次 React state。Pi compaction 不进入 Conversation entry：Kernel 以独立 lifecycle 标记所属 Runtime context，成功后核对 identity 并一次替换 Conversation、usage 与生命周期 statistics，失败或取消保留旧投影。

Timeline 默认只挂载最近 60 个 settled turn，用户可按 60 轮继续向前展开且保持当前滚动锚点；折叠的工作过程只保留摘要，展开时才挂载 thinking、工具参数与输出正文。长对话滚动时，Renderer 只从当前已投影的用户 message 计算顶部阅读轮次，供 Prompt 导航轨高亮与定位使用；这只是展示投影，不复制或持久化 Conversation 事实，也不在 Session Header 下粘着 prompt。

## Runtime 状态机

```text
stopped -> starting -> ready -> running -> ready -> stopping -> stopped
任何运行状态 -> crashed -> 用户显式 restart -> starting -> resume session
```

状态变化只有 Workbench Kernel 一个 owner。每个 Session context 独立执行同一状态机，后台事件不得改写当前 Session 投影。Pi 非正常退出必须只让所属 context 进入 `crashed`；不自动无限重启。完整一轮以 `agent_settled` 为稳定点，不把中间的 retry、compaction 或 continuation 误判为结束；`compaction_start` / `compaction_end` 保留 manual、threshold、overflow 与 `willRetry` 语义并单独收口。

## 安全边界

- Pi 使用参数数组、`shell: false` 和显式 cwd 启动。
- stdout 只承载 strict LF JSONL；stderr 单独诊断，不能污染 framing。
- 诊断默认不记录完整 prompt、tool output、环境变量或 credential。
- Linux PATH、XDG、进程和权限逻辑只能存在于 runtime/main 边界，不进入 renderer 或会话模型。
- Renderer 不能按任意路径读取文件；只有 Main 原生选择器返回的文件或用户显式拖放、粘贴产生的 DOM `File` 可以进入附件预处理。普通文件正文不经过 Renderer/IPC，路径只用于发给本地 Pi Agent 按需读取。
- 对话正文使用无 raw HTML 的 CommonMark/GFM AST 渲染；Markdown 图片不自动发起远程请求。
- 流式 Markdown 按动画帧合并并复用稳定顶层块；未稳定 tail 超过 16,384 字符时停止额外的分块预解析，改由同一 React Markdown 管线整篇渲染，任何长度都不降级为纯文本。
- Markdown 外链只能由用户点击触发，经受信 IPC sender 校验及 `http:`、`https:`、`mailto:` 协议白名单后交给系统打开。
