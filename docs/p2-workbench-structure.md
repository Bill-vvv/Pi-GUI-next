# P2 Workbench 结构

> 适用阶段：P2 — Workbench Foundation
> 当前状态：S8 Complete / Confirmed
> 最后更新：2026-07-21

## 1. 用途

本文件固定 S8 的 Workbench 信息架构、状态身份和后续 Slice 边界，供 S9 多 Project、S10 多 Session、S11 Pi/slash command 实现使用。

S8 不实现真实多 Project、多 Session 或命令执行，也不对 icon、动效和像素级视觉作最终定稿。结构经实际界面复核后才标记完成；后续变化追加到开发计划和决策记录，不静默覆盖。

## 2. 已确认边界

- Electron Main / Workbench Kernel 继续是唯一 control plane 和 Pi 子进程 owner。
- Renderer 只展示 normalized state 并发出 typed command，不维护 Project、Session 或 Conversation 的第二份事实。
- P2 可以保存和切换多个 Project、多个 Session，但同一时间只允许一个活动 Runtime。
- 正常 GUI 进程使用 Electron 单实例锁，避免两个 Main 进程并发改写同一 XDG 状态；无状态 `probe-only` 验证不取得该锁，也不初始化 ProjectStore。
- Pi session 文件继续是 Conversation 事实来源；GUI 只保存 Project 注册信息、Session 指针和当前选择。
- Project 切换不得自动中止正在运行的 turn；用户先等待 settled 或显式 abort。
- 不为未来并行 Runtime、远程后端、插件平台或数据库预留空接口。

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

### 3.1 左侧 Navigator

- 同时展示多个 Project；每个 Project 下展示其 Session。
- Project 行负责选择 Project，并提供该 Project 的新建 Session 入口。
- Session 行负责打开已有 Session；选中的 Project 和 Session 必须有唯一、清晰的选中态。
- 全局只保留一个“添加 Project”入口。
- Project path 放在 Project 行的次级信息或 tooltip，不继续占用 Composer 底部。
- P2 不展示尚未实现的归档、附件、搜索或管理入口。

### 3.2 Session Header

- 显示当前 Project、Session 名称和 Runtime 状态。
- 诊断入口移到 Header；展开内容进入正常布局流，不再以浮层遮挡 Timeline。
- Header 不承载 Project/Session 事实，只消费 Kernel 的活动选择投影。

### 3.3 Conversation Timeline

- 保留现有 `message`、`thinking`、`tool`、`error` normalized entry 和增量 patch 路径。
- 以一次 user turn 和随后一个 agent run 形成可辨识的 turn group。
- 活动 run 线性展示 thinking 与 tool；settled 后的工作过程摘要与最终回答保持在同一 turn group 内，不作为脱离回答的独立大卡片。
- 保留按 `toolCallId` 原地更新、最近 60 轮渐进挂载、用户离开底部后停止自动跟随等现有行为。
- Project 或 Session 选择变化时，Timeline identity 随活动二元组变化，不复用上一 Session 的局部 UI 状态。

### 3.4 Composer 与命令入口

- Composer 继续根据 Runtime 状态提供发送或 abort，并保留 Enter 发送、Shift+Enter 换行和 Escape abort。
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
- Pi 0.80.10 的新 Session 在 `get_state` 返回 `sessionFile`、`sessionId` 时，JSONL 文件仍可能尚未创建；此时 Kernel 只保留进程内 provisional identity，不写 Session 索引或活动指针。
- 第一个 assistant `message_end` 后等待 Pi 将 JSONL 落盘，再 canonicalize、校验普通文件并持久化；只有全部成功才发布正式 Session identity。落盘失败时不得登记 ghost Session。
- Session 索引持久化于 XDG state，只保存恢复和导航必需的指针及名称；不复制 Conversation 内容。

### 4.3 活动投影

P2 继续只向 Renderer 投影一个活动 Runtime 和一份活动 Conversation。集合与活动投影分开：

```text
projects[]
activeProjectKey

sessions[]             # S10 加入；只含导航摘要
activeSessionKey       # S10 加入

runtime                # 当前活动 Runtime
session                # 当前活动 Session 的运行态详情
conversation           # 当前活动 Session 的展示投影
```

S9 只加入多 Project 实际需要的 `projects[]` 与 `activeProjectKey`。S10 再加入 Session 集合与选择；不得为了保持旧字段而长期并存两套 Project/Session contract。

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

1. 如果 Runtime 为 `running`，拒绝切换并要求先 settled 或显式 abort；`starting` / `stopping` 期间同样拒绝切换。
2. 在停止当前 Runtime 前，校验目标 `projectKey` 已登记且仍对应 canonical、可读、可执行的目录，并加载其最近 Session 指针作为 resume availability 输入。
3. 如果存在已启动 Runtime，使用现有受控 stop 语义收口。
4. 持久化 `activeProjectKey`，再一次性发布目标 Project 的空 Conversation 投影和 resume availability；不把上一 Project 的 Conversation 标成目标 Project。
5. 持久化失败时保留旧活动 Project identity 和投影，但 Runtime 可以已经安全停止；错误必须显式返回。
6. 用户显式选择已有 Session 或新建 Session 后再启动 Pi。

### 6.2 Session 切换

1. 如果 Runtime 为 `running`，拒绝切换并要求先 settled 或显式 abort；`starting` / `stopping` 期间同样拒绝切换。
2. 校验目标 Session 指针已登记到目标 Project；将 `sessionFile` canonicalize，并确认它是普通、可读文件。
3. 受控停止当前 Runtime。
4. 启动新 Pi 进程并 resume；通过 `get_state` 核对 `sessionId`，再通过 `get_messages` 建立候选 Conversation 投影。
5. 上述步骤和指针持久化全部成功后，才一次性提交 `activeSessionKey`、Session 运行态和 Conversation 投影。
6. 持久化期间如果 Pi 异常退出，crashed 状态优先；不得在延迟操作返回后重新提交 `ready` 或目标 Session。
7. 任一步失败都保留明确错误与原活动 Session identity，不把旧 Conversation 标成目标 Session，也不静默新建 Session。

## 7. S8 不实现

- 多 Project 或多 Session 的真实持久化与切换。
- 多 Runtime 并行、后台运行或自动切换。
- Session 重命名、删除、归档、搜索、分支树或批量管理。
- slash command 查询、补全或执行。
- 附件、Files、Git、Terminal、Browser 等 Workbench module。
- 最终 icon 资产、完整动效、主题系统或像素级视觉验收。
- SQLite、插件 registry、通用 transport 或 renderer 侧事实库。

## 8. S8 验收

S8 完成前必须满足：

1. 当前 P1 截图和实现已映射到新的 Navigator、Header、Timeline、Composer 四区结构。
2. Project、Session 和活动 Runtime 的 identity、事实源与持久化边界明确。
3. S9/S10 的最小 command 和安全切换顺序明确，且保持单活动 Runtime。
4. slash command 入口位置与来源分类明确，但产品代码中没有假命令或空插件系统。
5. 低保真结构经实际界面复核并获得用户确认；未确认前 S8 保持 `In Progress`。

## 9. 当前验证记录

- `pnpm typecheck` 通过。
- `pnpm build` 通过。
- 构建版 Electron 窗口已核对折叠与展开诊断两种状态：Session Header 保持单行，诊断展开进入正常布局流并将 Timeline 下推，不覆盖 Conversation。
- S8 验收时的低保真实现只使用当时真实的单 Project/Session state；未增加假列表、假命令或空后端 contract。S9 后续按本文件边界加入真实多 Project contract。
- 用户已确认低保真结构方向；S8 完成，后续实现按本文件边界进入 S9。
- S8 审计后，Composer 已提供无假命令的 S11 空态，Navigator 只保留一个全局“添加项目”入口；同时把 `sessionFile` canonicalization 和成功后原子提交明确为 S10 验收约束，不代表 S8 提前实现多 Session。
- S10 审计后以真实 Pi 0.80.10 确认新 Session 文件采用延迟落盘；Kernel 使用 provisional identity 等待首个 assistant 消息完成后再登记，并修复切换持久化期间进程退出后错误回到 `ready`。正常 GUI 同时增加单实例锁，避免跨进程 XDG Session 索引丢失更新。
