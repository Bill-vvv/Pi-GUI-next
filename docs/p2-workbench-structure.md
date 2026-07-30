# P2 Workbench 结构

> 适用阶段：P2 — Workbench Foundation
> 历史结构状态：S8 Complete / Confirmed；当前 Slice 状态以 [`development-plan.md`](development-plan.md) 为准
> 最后更新：2026-07-28
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
- Project 或 Session 切换允许在其他 Runtime 运行期间发生；切换只改变当前展示投影，不停止、abort、接管或等待后台 turn settled。
- 并行 Runtime 已按真实需求落地；仍不为远程后端、插件平台或数据库预留空接口。

## 3. Workbench 信息架构

```text
┌─ Project / Task Navigator ────┬─ Active Workspace ─────────────┬─ Optional Right Sidebar ─┐
│ [ Project ] [ Task ]          │ Session Header                 │ [ concrete module tabs ] │
│                               │ scope / session / runtime      ├──────────────────────────┤
│ Project                       ├────────────────────────────────┤ active module content    │
│ ▾ Project A               ＋  │                                │                          │
│   ● Session A1               │ Turn-based Conversation        │                          │
│     Session A2               │ Timeline                       │                          │
│                               │                                │                          │
│ Task                          ├────────────────────────────────┤                          │
│   Standalone task             │ Composer + Command Menu        │                          │
└───────────────────────────────┴────────────────────────────────┴──────────────────────────┘
```

- 右侧栏由 Workbench composition 统一拥有一级展开/收起入口、顶层 Tab、关闭、持久化有界宽度、指针/键盘 separator 与宽窄窗口容器；模块 feature 继续拥有领域内容。Session Header 的一级入口使用与左侧栏镜像的通用右栏图标，不显示领域模块图标；当前真实模块为按可用性出现的“Git”和“子任务”，不显示 Browser、Terminal 或其他占位 Tab，也不建立模块 registry。Settings 仍是独立全页工作区。

- 标题下不保留重复标题语义、无实际作用的介绍性文案；确有必要的补充说明放在对应控件的 tooltip 中，由鼠标悬浮显示，不占用常驻布局。

### 3.1 左侧 Navigator

- 顶层以可访问 Tab 区分“项目”和“任务”；切换 Tab 同时恢复该类别最后查看的目标，不停止其他 Runtime。
- 项目视图同时展示多个 Project；每个 Project 下展示其 Session。
- 任务视图扁平展示独立任务；一个任务严格对应一个 Session，不再增加容器层。
- Project 行负责选择 Project，并提供该 Project 的新建 Session 入口。
- Session 行负责打开已有 Session；选中的 Project 和 Session 必须有唯一、清晰的选中态。
- 全局只保留一个“添加 Project”入口。
- Project path 放在 Project 行的次级信息或 tooltip，不继续占用 Composer 底部。
- Navigator 只展示已经贯通真实能力的行内操作；Session/Task 归档已接入，搜索和其他管理入口仍不得提前展示。
- Task 的应用私有 Runtime path 不进入 Project 行、Header、hover card 或设置作用域；Renderer 只依据 typed `workspaceKind` / `taskKey` 判断类别。

#### 3.1.1 导航排序与行命中要求

- Project 保留手动拖拽排序，但不得把整行做成常驻原生 `draggable`。排序手势只能从主行内容的主指针按下开始，并在超过明确移动阈值后才进入拖拽；action slot、行内按钮和普通单击不得触发排序。实现可使用 pointer capture 与独立拖拽预览，但必须在 `pointerup`、`pointercancel`、lost capture、窗口失焦或目标失效等任一路径清理手势和临时顺序。
- 每个 Project 的 Session 都由 Kernel 独立排序，并将 `running` 项无条件置顶。运行中组和非运行组内部始终按 `lastActivityAt` 倒序输出；最新活动在前，无可用活动时间的项放在末尾，同状态、同时间项保持稳定顺序。Session 不提供手动拖拽或第二套持久化顺序。
- `lastActivityAt` 只读取 Pi transcript 当前 active branch，按 branch entry 顺序选择最后一个顶层 `type: "message"` entry，并且只接受 canonical `Date#toISOString()` 字符串，再一次性转换为 Unix epoch milliseconds。不得跨分支或按数值最大 timestamp 选择，不接受数字秒/毫秒、相对时钟、非 canonical 日期字符串或嵌套 `message.timestamp`；capability custom entry、`session_info`、点击、恢复和其他 Runtime 元数据同样不得刷新活动时间或排序。
- Renderer 的普通历史默认显示 5 个并按 5 个继续展开，但当前展示项、provisional / 非空闲 Runtime，以及后台刚完成但尚未查看的 Session 必须作为分页外保留项；结束后的 Kernel 重排不得让用户尚未查看的完成项从导航消失。未读标记是 Renderer 根据同一 Session identity 的 `lastActivityAt` 观察结果派生的瞬时展示状态：初次观察只建立基线，未展示 Session 的活动时间推进才标记未读，打开后清除，provisional 升级为 canonical identity 时保持连续；Kernel 不持久化第二份未读事实。
- 新建等 Project action slot 不得武装行拖拽；Project 与 Session 行内按钮都必须拥有独立点击边界。
- action slot 内叠放时间文字、运行指示和操作按钮时，操作按钮必须位于最上层并独占可见区域的指针命中；被隐藏或替换的文字、图标及状态层必须使用 `pointer-events: none`，文字层同时禁止文本选择。
- `opacity: 0` 只改变绘制结果，不代表元素已经退出 hit testing。任何悬浮切换实现都必须分别核对视觉层、pointer events、文本选择和 stacking order，不能只验证图标是否显示。
- Project 排序、Project / Session 单击选择和行内操作必须分别可用：未按下时悬浮只改变操作可见性；只有从 Project 主行按下并移动时才开始排序；从行内按钮按下时始终执行按钮动作。

### 3.2 Session Header

- Project Session 显示当前 Project 与 Session 名称；Task 显示“任务”与任务名称，二者都显示 Runtime 状态。
- 诊断入口移到 Header；展开内容进入正常布局流，不再以浮层遮挡 Timeline。
- Header 不承载 Project/Session 事实，只消费 Kernel 的活动选择投影；右侧一级控制只负责共享右侧栏展开/收起，领域模块入口留在栏内真实 Tab。

### 3.3 Conversation Timeline

- 保留现有 `message`、`thinking`、`tool`、`error` normalized entry，为固定 Subagent 适配增加 `subagent-notice`，并为既有 Session 保留历史 `advisor` compatibility entry；全部继续使用同一 Conversation 与增量 patch 路径，当前产品不再提供新的 Advisor 控制入口。
- 固定适配的 `ask` 交互仍附着在原 `toolCallId` 对应的运行中 tool entry 上，以同一 Timeline 工具卡展示严格归一化的问题、提交和取消状态；它不成为脱离 Conversation 的弹窗式第二事实，也不让 Renderer 解析原始 extension UI payload。
- 以一次 user turn 和随后一个 agent run 形成可辨识的 turn group。
- 活动 run 线性展示 thinking 与 tool；Renderer 将同一 turn 内连续的 thinking entry 合为一个视觉阶段，任意非-thinking 过程项封口，同时保留 Kernel 中每条 entry 的原始 identity 与顺序。若 error 或其他 content entry 将活动 run 切成多个过程 chunk，后续 chunk 出现新 thinking 时只挂载最新含 thinking chunk 的 thinking；更早 thinking 在 settled 后的完成过程展开中恢复，跨 chunk 的 tool、commentary 与 error 继续保留。活动阶段以最新摘要作为标题且不在正文重复该行，完成阶段仅有一个非空源码行的短思考直接显示正文，多行或多段内容才保留一个“思考” disclosure；重叠的现场 thinking 计时取最长完整观测跨度，不相加。普通工具批次只有一个 entry 时，外层汇总展开后直接显示真实详情而不重复该工具标题。settled 后的工作过程摘要与最终回答保持在同一 turn group 内，不作为脱离回答的独立大卡片。
- 保留按 `toolCallId` 原地更新、最近 60 轮渐进挂载、用户离开底部后停止自动跟随等现有行为。当前 60-turn 规则只限制 Renderer 的 DOM 挂载，不代表活动 Conversation 已完成分页读取、状态拆分或工作集驱逐。
- 固定适配的 `pi-subagents` 在拉起后进入同一 turn：唤起中与运行中的 Subagent 必须直接显示，不得藏入 thinking 或通用工具详情 disclosure；前台运行默认按参与者显示紧凑、可聚焦的任务胶囊和同行整体状态。胶囊用“当前展示 Conversation identity + Subagent toolCallId + participant.index”作为稳定目标；点击后选择共享右侧栏中的“子任务”Tab。宽窗口右侧栏作为真实第三列与 Timeline / Composer 并排，用户可通过可访问 separator 指针或键盘调宽，并可收起后从 Conversation 重新展开；较窄窗口复用同一右侧栏 contract，在主工作区显示带返回入口的完整详情面。关闭、返回、Escape、Project/Session/Conversation identity 变化和目标消失继续按稳定 locator 恢复或清理焦点/选择。`SubagentTaskDetail` 自己拥有领域标题与正文，composition 不解析或复制其内容。详情按状态重排：运行中显示当前活动，完成态显示结果或输出文件，失败态显示错误，暂停态显示已有输出与最后活动；实际模型、input/output/cache token、费用、轮次、工具数和耗时跟随归一化 patch 更新。普通完成通知在 Timeline 只形成轻量可点击的完成任务胶囊，并保留通知协议中的原始 Agent 名称作为胶囊标签；Main 移除重复 completion envelope 与 Session file 行，把固定 `Output saved to` 协议投影为 metadata-only 输出引用，用户可显式打开但 GUI 不读取正文。通知未携带模型或 usage 时明确 unavailable，不从配置或 Session 猜测。关闭/返回/Escape 恢复合理焦点；Project、Session、新对话、归档预览 identity 变化、目标消失或设置页打开时关闭旧详情。`subagent list/status`、`subagent_wait` 以及 supervisor/intercom 的 pending/status/list 是内部发现或轮询，不进入 Timeline；控制、转向、暂停、停止、回复与 Watchdog 警告仍以独立通知显示。Main 从白名单 details 投影 supervisor request 的稳定 identity 与 pending/handled 生命周期，同一 run participant 的具体 request 替代泛化 attention，成功 reply 原地更新。该协作默认不作为用户 alert，只有 completion guard 与 Watchdog blocker 使用 alert。GUI 不读取子 Session transcript 或普通 artifact，不建立任务数据库或运行控制，也不按通知文案猜测原 run identity。
- 既有 Session 中合法的历史 Advisor advisory 继续留在触发它的 turn 内，按归一化 entry 时序只读显示名称、严重度、正文和 guidance；blocker 不覆盖 Assistant 最终回答，Renderer 不解析 raw custom message 或 XML，也不恢复已退役的 Advisor 安装、启停或 roster 控制面。
- Navigator 完全展开时，Timeline 左缘显示与真实用户轮次对应的 Prompt 导航短标记；悬浮或键盘聚焦可预览内容，首次悬浮成立后扩展为连续命中带，邻近标记保持固定线高和矩形端点、只按整数像素成组延长，短暂离轨不会立即收起，点击定位对应轮次；折叠与窄窗口下隐藏。不在 Session Header 下粘着当前阅读轮次的用户 prompt。
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

### 4.1.1 Task identity

- `taskKey` 是持久化的稳定随机标识；Task 的 Runtime cwd 位于 XDG state 下应用私有目录，但该绝对路径不是用户可见 identity。
- Task registry 与 Project config 分离；Project 列表只保存用户添加的真实目录。
- 一个 Task workspace 只允许登记一个持久 Session；不同 Task 不共享 Project 级资源或长期上下文。

### 4.2 Session identity

- 已持久化 Session 的 GUI 主键使用 canonical `sessionFile`。
- `sessionId` 是 Pi 返回并在 resume 时校验的身份字段，不单独作为跨 Project 主键。
- Pi 0.80.10 的新 Session 在 `get_state` 返回 `sessionFile`、`sessionId` 时，JSONL 文件仍可能尚未创建；此时 Kernel 只保留进程内 provisional identity，**不写 XDG Session 索引**。
- Kernel 可立即把 provisional identity 投影进活动工作区的 `sessions[]`（`provisional: true`）并设 `activeSessionKey`，供 Composer、模型和首条消息使用；但在首条 prompt 被 Runtime 接受前，不把该空 identity 投影进 Project 的 Navigator `projects[].sessions`，也不计入 Project Session 数量。用户切换到其他 Project/Session 时回收该空 Runtime，不留下不可访问的后台 context。
- 首条 prompt 被 Runtime 接受后，同一 provisional identity 立即进入 Project Navigator；它仍不可 resume/archive/export。第一个 assistant `message_end` 后等待 Pi 将 JSONL 落盘，再 canonicalize、校验普通文件并持久化；只有全部成功才把同一导航项升级为正式 Session identity。发送失败时重新隐藏空 identity，落盘失败时不得登记 ghost Session。
- Session 索引持久化于 XDG state，只保存恢复和导航必需的指针及名称；不复制 Conversation 内容。

### 4.3 当前投影

Workbench Kernel 按 Session 管理多个相互隔离的 RuntimeContext。Renderer 同一时间只展示当前选中 Session 的 Runtime、Session 和 Conversation；后台 Runtime 状态通过 `sessions[]` 摘要展示。集合与当前投影分开：

```text
projects[]             # Kernel 内部 Runtime workspace；Task 带 workspaceKind/taskKey
navigatorKind          # 当前 Project / Task Navigator Tab
activeProjectKey       # 当前内部 Runtime workspace path，不直接用于 Task 展示

sessions[]             # 当前 workspace 导航摘要，含各 Session 的 Runtime 状态
activeSessionKey       # 当前选中的 Session

runtime                # 当前选中 Session 的 Runtime 投影
session                # 当前选中 Session 的运行态详情
conversation           # 当前选中 Session 的展示投影
```

S9 先加入 `projects[]` 与 `activeProjectKey`，S10 再加入 Session 集合与选择；这是历史演进顺序。D-059 在不复制前台 Conversation 的前提下，为内部 workspace 增加 typed Project/Task 类别；Renderer 仍只消费一份 Kernel state，不维护第二套导航事实。

## 5. Typed command 演进

### S9

- `kernel.add-project`：由 Main 打开目录选择并注册 canonical path。
- `kernel.activate-project { projectKey }`：仅切换活动 Project，不隐式创建 Session。
- 现有 start/resume、prompt、abort、model 和 thinking command 继续服务当前活动投影。

### S10

- `kernel.start-session`：在活动 Project 或已创建 Task workspace 中创建新 Session。
- `kernel.activate-session { sessionKey }`：验证指针后打开并恢复已有 Session。
- `kernel.select-navigator { kind }`：切换 Project/Task 顶层视图并恢复该类别最后目标；空类别不自动创建 Runtime。
- `kernel.create-task`：创建独立 Task workspace；重复请求复用当前空 provisional Task。
- `kernel.activate-task { taskKey }`：按稳定 Task identity 激活其唯一 Session，不把隐藏 path 当作 Project command 参数。

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
4. 后台启动不得阻塞导航：不把 `activate-session` / `start-session` 做成全局 exclusive busy；侧栏在启动过程中仍可继续点击。快速连点历史 Session 时以短 settle（约 120ms）合并启动意图，只真正启动最后停留的目标；已有受管 Runtime 的目标立即切换，无 settle。Kernel 侧 launch 仍单飞，Renderer 用串行 ensure 泵对齐。目标 Session 已进入 `starting` 后，Composer 仍可先接受一条普通 prompt，并等待同一启动任务完成后提交；slash 命令必须等目标命令目录可用。
5. 新 Session 先进入可输入的空白工作区，后台启动 Runtime；首次提交复用同一启动任务。
6. 失败时保留目标页面并显式展示错误，不把旧 Conversation 标成新目标，也不静默新建 Session。
7. 普通选择或切换不得收口原 Runtime；归档、显式 reload/stop、应用退出等生命周期操作才可停止对应进程。S26 只在 Main/Kernel 内保留单个后台持久 Runtime 的回收原语，用于复用严格 busy gate、stop ownership、launch 串行化与同 Pi Session 恢复；它不经 typed IPC 暴露，Renderer 没有 Session、Project 或全局主动休眠入口。未来自动回收必须先取得 Kernel 与已加载 Extension 的 quiescence/operation lease 事实，再由策略选择候选；未知状态 fail-closed，自动回收与 LRU 当前仍未交付。

### 6.3 Project / Task Tab 切换

1. 切换 Tab 先持久化目标类别，再恢复该类别最后一个仍有效的 Project 或 Task Session；没有目标时发布明确空态，不自动创建。
2. Task 的隐藏 workspace 只参与 Main/Kernel Runtime ownership、Session pointer 和通知定位；Renderer 只显示 Task 名称与状态。
3. 从空 provisional Task 切走时遵循 D-057，停止并移除不可持久化 Runtime；已接受首条 prompt 的 Task 与普通 Project Session 一样保持后台运行。
4. Task 不启用 Project `@` 路径搜索、Project trust 对话框、Project scope 设置/Agent/Skill 或同 workspace Fork；用户级能力、附件、绝对路径、归档、导出和 Subagent 保持可用。

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
