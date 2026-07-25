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
| Project、外观、通用与有限应用快捷键设置 | Workbench Kernel | XDG config |
| 最近 session 指针与非敏感启动证据 | Workbench Kernel | XDG state |
| Runtime 瞬时状态 | Workbench Kernel | 仅内存 |

GUI 不建立 Conversation 数据库，也不把 renderer 投影当作对话事实来源。

自定义模型的 `cost` 仍由 Pi 官方 `models.json` 持久化。用户显式点击拉取价格时，
Electron Main 从 LiteLLM 公开价格目录匹配模型并通过窄 typed IPC 返回匹配键与四项单价；
Renderer 不直接联网，也不建立价格数据库或后台自动刷新。保存后的单价供 Pi 计算后续请求费用，
不改写既有 Session 中已经记录的历史 cost。

## Conversation 展示投影

Workbench Kernel 将 Pi message content 按原始顺序投影成 `message`、`thinking`、`tool` 和 `error` entry。一次工具调用始终由 `toolCallId` 标识为同一个 entry，`pending/running/success/error` 与输出只原地更新，不为 tool result 创建第二个展示节点。

Kernel 在活动开始时记录当前 run 的 entry 起点，并只以 `agent_settled` 结束该边界。Renderer 对活动 run 线性展示 thinking 与工具状态；run settled 后，把 thinking 和工具项折叠到该轮最终回答上方，展开时仍使用原始顺序。文件操作摘要只从有明确结构化路径的工具参数提取，不猜测 `bash` 的文件副作用。

Composer 附件沿 Pi 0.80.10 的交互式 TUI 与 RPC 边界处理：普通文件只把 `@路径` 放入消息，由 Agent 使用 Pi 原生 `read` 工具按需读取；不在首条 prompt 中内联文件正文。`read` 的文本结果遵循 Pi 的 2,000 行或 50 KiB 截断边界，并可用 offset/limit 继续。图片转换为 RPC `images` 中的 `{ type: "image", mimeType, data }`，直接使用原生多模态输入。系统文件选择由 Main 取得路径，显式拖放由 Renderer 通过 Electron `webUtils.getPathForFile` 取得路径；普通文件只读取小段签名头用于区分图片，图片在进入 IPC/RPC 前满足 2000×2000 与 4.5 MiB base64 边界。

Pi session 仍保存完整用户消息和 image content block。Kernel 对 Renderer 只投影文件名、路径和类型摘要，不把附件正文或图片 base64 放入 `KernelState`；恢复历史和实时事件使用同一投影。附件变化不能走纯文本 append patch，必须回退全量状态以避免静默丢失附件。

高频 Pi message、thinking 和 tool update 不重复发送完整 `KernelState`。Kernel 发送 `kernel.state-patched`：新 entry 按 index 插入，append-only 文本和工具输出只发送起始长度与新增后缀；非前缀改写或无法安全增量化时立即退回 `kernel.state-changed` 全量快照。Renderer 按顺序应用 patch，并最多每动画帧提交一次 React state。Pi compaction 不进入 Conversation entry：Kernel 以独立 lifecycle 标记所属 Runtime context，成功后核对 identity 并一次替换 Conversation、usage 与生命周期 statistics，失败或取消保留旧投影。

Timeline 默认只挂载最近 60 个 settled turn，用户可按 60 轮继续向前展开且保持当前滚动锚点；折叠的工作过程只保留摘要，展开时才挂载 thinking、工具参数与输出正文。长对话滚动时，Renderer 只从当前已投影的用户 message 计算顶部阅读轮次，并在原 prompt 离开视口后将其粘着于 Session Header 下；这只是展示投影，不复制或持久化 Conversation 事实。

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
