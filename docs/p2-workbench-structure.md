# P2 Workbench 结构

> 适用阶段：P2 — Workbench Foundation
> 当前状态：S8 Complete / Confirmed
> 最后更新：2026-07-24
> 2026-07-23 修订：本文中的“单活动 Runtime”是 S8–S10 的历史边界，已由 [`D-017`](decisions.md#d-017--恢复按-session-隔离的多-runtime-并行) 替代；当前实现允许多个 Session Runtime 并行，Renderer 仍保持单一当前投影。

## 1. 用途

本文件固定 S8 的 Workbench 信息架构、状态身份和后续 Slice 边界，供 S9 多 Project、S10 多 Session、S11 Pi/slash command 实现使用。

S8 不实现真实多 Project、多 Session 或命令执行，也不对 icon、动效和像素级视觉作最终定稿。结构经实际界面复核后才标记完成；后续变化追加到开发计划和决策记录，不静默覆盖。

## 2. 已确认边界

- Electron Main / Workbench Kernel 继续是唯一 control plane 和 Pi 子进程 owner。
- Renderer 只展示 normalized state 并发出 typed command，不维护 Project、Session 或 Conversation 的第二份事实。
- P2 最初只允许一个活动 Runtime；该限制已被 D-017 替代，当前按 Session 隔离并行 Runtime。
- 正常 GUI 进程使用 Electron 单实例锁，避免两个 Main 进程并发改写同一 XDG 状态；无状态 `probe-only` 验证不取得该锁，也不初始化 ProjectStore。
- Pi session 文件继续是 Conversation 事实来源；GUI 只保存 Project 注册信息、Session 指针和当前选择。
- Project 切换不得自动中止正在运行的 turn；用户先等待 settled 或显式 abort。
- 并行 Runtime 已按真实需求落地；仍不为远程后端、插件平台或数据库预留空接口。

## 3. Workbench 信息架构

```text
┌─ Project / Session Navigator ─┬─ Active Session Workspace ───────────────┐
│ Projects                      │ Session Header                           │
│                               │ project / session / runtime / diagnostics│
│ ▾ Project A               ＋  ├──────────────────────────────────────────┤
│   ● Session A1               │                                          │
│     Session A2               │ Turn-based Conversation Timeline         │
│ ▸ Project B               ＋  │                                          │
│                               │                                          │
│ ＋ Add Project                ├──────────────────────────────────────────┤
│                               │ Composer + Command Menu                  │
└───────────────────────────────┴──────────────────────────────────────────┘
```

- 标题下不保留重复标题语义、无实际作用的介绍性文案；确有必要的补充说明放在对应控件的 tooltip 中，由鼠标悬浮显示，不占用常驻布局。

### 3.1 左侧 Navigator

- 同时展示多个 Project；每个 Project 下展示其 Session。
- Project 行负责选择 Project，并提供该 Project 的新建 Session 入口。
- Session 行负责打开已有 Session；选中的 Project 和 Session 必须有唯一、清晰的选中态。
- 全局只保留一个“添加 Project”入口。
- Project path 放在 Project 行的次级信息或 tooltip，不继续占用 Composer 底部。
- Navigator 只展示已经贯通真实能力的行内操作；Session 归档已在 S14 接入，搜索和其他管理入口仍不得提前展示。

#### 3.1.1 导航排序与行命中要求

- Project 保留手动拖拽排序；Project 行不得常驻原生 `draggable`，只有主行内容收到鼠标主键按下后才临时武装，并在 `pointerup`、`pointercancel` 或 `dragend` 任一路径立即解除。
- 每个 Project 的 Session 都由 Kernel 独立排序，并将 `running` 项无条件置顶。运行中组和非运行组内部始终按 `lastActivityAt` 倒序输出；最新活动在前，无可用活动时间的项放在末尾，同状态、同时间项保持稳定顺序。`lastActivityAt` 取 Pi transcript 中最新 `message` entry 的时间；仅打开/恢复 Session 时写入的 capability、`session_info` 等运行元数据不属于对话活动，也不得刷新时间或排序。Session 不提供手动拖拽或第二套持久化顺序。Renderer 的普通历史默认显示 5 个并按 5 个继续展开，但当前展示项、provisional / 非空闲 Runtime，以及后台刚完成但尚未查看的 Session 必须作为分页外保留项；结束后的 Kernel 重排不得让用户尚未查看的完成项从导航消失。
- 新建等 Project action slot 不得武装行拖拽；Project 与 Session 行内按钮都必须拥有独立点击边界。
- action slot 内叠放时间文字、运行指示和操作按钮时，操作按钮必须位于最上层并独占可见区域的指针命中；被隐藏或替换的文字、图标及状态层必须使用 `pointer-events: none`，文字层同时禁止文本选择。
- `opacity: 0` 只改变绘制结果，不代表元素已经退出 hit testing。任何悬浮切换实现都必须分别核对视觉层、pointer events、文本选择和 stacking order，不能只验证图标是否显示。
- Project 排序、Project / Session 单击选择和行内操作必须分别可用：未按下时悬浮只改变操作可见性；只有从 Project 主行按下并移动时才开始排序；从行内按钮按下时始终执行按钮动作。

### 3.2 Session Header

- 显示当前 Project、Session 名称和 Runtime 状态。
- 诊断入口移到 Header；展开内容进入正常布局流，不再以浮层遮挡 Timeline。
- Header 不承载 Project/Session 事实，只消费 Kernel 的活动选择投影。

### 3.3 Conversation Timeline

- 保留现有 `message`、`thinking`、`tool`、`error` normalized entry，并为固定 Subagent / Advisor 适配增加 `subagent-notice` 与 `advisor`；全部继续使用同一 Conversation 与增量 patch 路径。
- 以一次 user turn 和随后一个 agent run 形成可辨识的 turn group。
- 活动 run 线性展示 thinking 与 tool；settled 后的工作过程摘要与最终回答保持在同一 turn group 内，不作为脱离回答的独立大卡片。
- 保留按 `toolCallId` 原地更新、最近 60 轮渐进挂载、用户离开底部后停止自动跟随等现有行为。
- 固定适配的 `pi-subagents` 在拉起后进入同一 turn：唤起中与运行中的 Subagent 必须直接显示，不得藏入 thinking 或通用工具详情 disclosure；前台运行默认按参与者显示紧凑、可聚焦的任务胶囊和同行整体状态。胶囊用“当前展示 Conversation identity + Subagent toolCallId + participant.index”作为稳定目标；点击后宽窗口打开不覆盖 Timeline / Composer 的 Workbench 第三列，较窄窗口在主工作区显示带返回入口的完整详情面，并原地跟随归一化 patch 更新 Agent、状态、当前活动、用量、错误和最终输出。关闭/返回/Escape 恢复合理焦点；Project、Session、新对话、归档预览 identity 变化、目标消失或设置页打开时关闭旧详情。普通完成通知在 Timeline 只形成轻量可点击的完成任务胶囊，并保留通知协议中的原始 Agent 名称作为胶囊标签，不用“后台任务结果”等通用文案替代；不展开结果预览，点击后由同一 Workbench 任务详情显示完整内容。控制、转向、supervisor 协作与 Watchdog 警告仍以独立通知显示；Main 从白名单 details 投影 supervisor request 的稳定 identity 与 pending/handled 生命周期，同一 run participant 的具体 request 替代泛化 attention，成功 reply 原地更新。该协作默认不作为用户 alert，只有 completion guard 与 Watchdog blocker 使用 alert。GUI 不读取子 Session transcript 或 artifact，不建立任务数据库或运行控制，也不按通知文案猜测原 run identity。
- 固定适配的 Advisor advisory 留在触发它的 turn 内，按归一化 entry 时序显示名称、严重度、
  正文和 guidance；blocker 不覆盖 Assistant 最终回答，Renderer 不解析 raw custom message
  或 XML。
- Navigator 完全展开时，Timeline 左缘显示与真实用户轮次对应的 Prompt 导航短标记；悬浮或键盘聚焦可预览内容，点击定位对应轮次，折叠与窄窗口下隐藏。不在 Session Header 下粘着当前阅读轮次的用户 prompt。
- 复制回答、导出 HTML 与分叉对话属于当前 Conversation 操作：每个具备真实操作能力的已完成 turn 都在下方常驻预留同高的内联图标槽，悬停该 turn 或用键盘聚焦槽内按钮时只切换图标可见性与命中，不改变后续内容位置，也不占用 Session Header。复制/导出反馈固定留在发起操作的同一 turn 槽内，并以单行省略保持槽高；没有 turn 来源的快捷键反馈才使用时间线末尾的稳定位置。图标保持无底板的轻量外观。导出与分叉仍是会话级能力；复制作用于当前聚焦轮次的最终回答。
- Project 或 Session 选择变化时，Timeline identity 随活动二元组变化，不复用上一 Session 的滚动和 disclosure 状态。

### 3.4 Composer 与命令入口

- Composer 在 Runtime `ready` 时使用 Enter 发送普通 prompt；在 `running` 时继续可编辑，Enter 排队 `follow_up`、Alt+Enter 排队 `steer`，同时保留 Shift+Enter 换行和 Escape abort。
- Composer 支持系统多选、拖放和剪贴板附件；普通文件按 Pi 交互式 TUI 的 `@路径` 语义引用，并由 Agent 使用原生 `read` 工具按需读取；图片走 Pi RPC 原生 `images`。两者都适用于 prompt、steer 与 follow-up。
- 输入 `/` 时，命令菜单在 Composer 上方进入正常交互层；S8 只提供明确指向 S11 的空态，不实现假命令、查询或执行。
- S11 的命令表区分 GUI 本地命令、typed Pi RPC 命令，以及 Pi `get_commands` 返回的 extension、prompt 和 skill 命令。
- 不建立一个可绕过 typed Kernel 边界的通用“执行任意命令”IPC。

## 4. P2 状态身份

### 4.1 Project identity

- `projectKey` 使用 Main 校验后的 canonical absolute path。
- 展示名称由 path basename 派生，不成为独立事实源。
- Project 注册表持久化于 XDG config；未知 schema version 继续 Fail Fast。

### 4.2 Session identity

- 已持久化 Session 的 GUI 主键使用 canonical `sessionFile`。
- `sessionId` 是 Pi 返回并在 resume 时校验的身份字段，不单独作为跨 Project 主键。
- Pi 0.80.10 的新 Session 在 `get_state` 返回 `sessionFile`、`sessionId` 时，JSONL 文件仍可能尚未创建；此时 Kernel 只保留进程内 provisional identity，**不写 XDG Session 索引**。
- 导航层可立即把 provisional identity 投影进 `sessions[]`（`provisional: true`）并设 `activeSessionKey`，供左侧列表占位与选中；该占位不可 resume/archive/export，失败或停止后必须从列表移除，不得留下 ghost。
- 第一个 assistant `message_end` 后等待 Pi 将 JSONL 落盘，再 canonicalize、校验普通文件并持久化；只有全部成功才把同一导航项升级为正式 Session identity。落盘失败时不得登记 ghost Session。
- Session 索引持久化于 XDG state，只保存恢复和导航必需的指针及名称；不复制 Conversation 内容。

### 4.3 当前投影

Workbench Kernel 按 Session 管理多个相互隔离的 RuntimeContext。Renderer 同一时间只展示当前选中 Session 的 Runtime、Session 和 Conversation；后台 Runtime 状态通过 `sessions[]` 摘要展示。集合与当前投影分开：

```text
projects[]
activeProjectKey

sessions[]             # 导航摘要，含各 Session 的 Runtime 状态
activeSessionKey       # 当前选中的 Session

runtime                # 当前选中 Session 的 Runtime 投影
session                # 当前选中 Session 的运行态详情
conversation           # 当前选中 Session 的展示投影
```

S9 先加入 `projects[]` 与 `activeProjectKey`，S10 再加入 Session 集合与选择；这是历史演进顺序。当前 contract 只保留一套 Project/Session identity 与一份前台 Conversation 投影，不为后台 Runtime 建立第二份 Renderer 事实源。

## 5. Typed command 演进

### S9

- `kernel.add-project`：由 Main 打开目录选择并注册 canonical path。
- `kernel.activate-project { projectKey }`：仅切换活动 Project，不隐式创建 Session。
- 现有 start/resume、prompt、abort、model 和 thinking command 继续服务当前活动投影。

### S10

- `kernel.start-session`：在活动 Project 创建新 Session。
- `kernel.activate-session { sessionKey }`：验证指针后打开并恢复已有 Session。

### S11

- Kernel 提供 normalized command catalog；Renderer 只负责搜索、选择和参数输入。
- GUI 本地命令映射到明确的 typed command。
- Pi extension、prompt、skill 命令按其真实调用语义进入 prompt 路径。
- TUI 本地命令逐项映射为 GUI 行为或底层 typed RPC，不把整套 TUI slash parser 搬入 Renderer。

命令名和 payload 在对应实现 Slice 完整审计后固定；S8 不增加未使用的 contract skeleton。

## 6. 切换顺序

### 6.1 Project 切换

1. 校验目标 `projectKey` 已登记且仍对应 canonical、可读、可执行的目录，并加载该 Project 的 Session 注册表。
2. 当前 Project 存在运行中的 Session 时仍允许切换；切换不停止或取消其他 Project 的 Runtime。
3. 持久化 `activeProjectKey` 后发布目标 Project 的 Session 摘要和当前投影；不得把上一 Project 的 Conversation 标成目标 Project。
4. 目标 Session 已有受管 RuntimeContext 时直接载入该 context；停止状态的历史 Session 在用户点击时无感激活 Runtime，可先异步投影历史。
5. 持久化或加载失败时保留明确错误，不创建 ghost Session，也不静默停止后台 Runtime。

### 6.2 Session 切换

1. Renderer 先切换可见目标，再异步加载目标 Session；快速连续切换只接受最后一次读取结果。
2. 目标 Session 已有受管 RuntimeContext 时直接切换当前投影，不停止原 Session 或其他后台 Runtime。
3. 停止状态的历史 Session 在点击时立即切换可见目标，并后台激活 Runtime；先校验 canonical `sessionFile`、普通文件、可读性和 `sessionId`，再启动或恢复。可先异步投影历史，不要求用户再点“启动 Pi”。
4. 后台启动不得阻塞导航：不把 `activate-session` / `start-session` 做成全局 exclusive busy；侧栏在启动过程中仍可继续点击。快速连点历史 Session 时以短 settle（约 120ms）合并启动意图，只真正启动最后停留的目标；已有受管 Runtime 的目标立即切换，无 settle。Kernel 侧 launch 仍单飞，Renderer 用串行 ensure 泵对齐。
5. 新 Session 先进入可输入的空白工作区，后台启动 Runtime；首次提交复用同一启动任务。
6. 失败时保留目标页面并显式展示错误，不把旧 Conversation 标成新目标，也不静默新建 Session。
7. 只有归档目标 Session、应用退出或用户对目标 Runtime 的显式停止才收口对应 Runtime。

## 7. S8 当时不实现（历史）

以下条目记录 S8 完成时的真实范围；其中单 Runtime 限制已由 D-017 替代，不是当前产品约束。

- 多 Project 或多 Session 的真实持久化与切换。
- 多 Runtime 并行、后台运行或自动切换。
- Session 重命名、删除、归档、搜索、分支树或批量管理。
- slash command 查询、补全或执行。
- 附件、Files、Git、Terminal、Browser 等 Workbench module。
- 最终 icon 资产、完整动效、主题系统或像素级视觉验收。
- SQLite、插件 registry、通用 transport 或 renderer 侧事实库。

## 8. S8 当时验收（历史）

以下是 S8 当时的完成门槛；“保持单活动 Runtime”只描述历史验收，不适用于当前多 Runtime 实现。

1. 当前 P1 截图和实现已映射到新的 Navigator、Header、Timeline、Composer 四区结构。
2. Project、Session 和活动 Runtime 的 identity、事实源与持久化边界明确。
3. S9/S10 的最小 command 和安全切换顺序明确，且保持单活动 Runtime。
4. slash command 入口位置与来源分类明确，但产品代码中没有假命令或空插件系统。
5. 低保真结构经实际界面复核并获得用户确认；未确认前 S8 保持 `In Progress`。

## 9. S8 验证记录（历史）

- `pnpm typecheck` 通过。
- `pnpm build` 通过。
- 构建版 Electron 窗口已核对折叠与展开诊断两种状态：Session Header 保持单行，诊断展开进入正常布局流并将 Timeline 下推，不覆盖 Conversation。
- S8 验收时的低保真实现只使用当时真实的单 Project/Session state；未增加假列表、假命令或空后端 contract。S9 后续按本文件边界加入真实多 Project contract。
- 用户已确认低保真结构方向；S8 完成，后续实现按本文件边界进入 S9。
- S8 审计后，Composer 已提供无假命令的 S11 空态，Navigator 只保留一个全局“添加项目”入口；同时把 `sessionFile` canonicalization 和成功后原子提交明确为 S10 验收约束，不代表 S8 提前实现多 Session。
- S10 审计后以真实 Pi 0.80.10 确认新 Session 文件采用延迟落盘；Kernel 使用 provisional identity 等待首个 assistant 消息完成后再登记，并修复切换持久化期间进程退出后错误回到 `ready`。正常 GUI 同时增加单实例锁，避免跨进程 XDG Session 索引丢失更新。
