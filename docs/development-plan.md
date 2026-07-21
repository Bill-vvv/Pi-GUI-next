# Pi GUI 开发计划

> 当前阶段：P1 — Linux Core Chain / v0.0.1
> 计划版本：1.0
> 最后更新：2026-07-21
> 总体状态：Complete
> 当前 Slice：—（P1 已完成；P2 待开始）

## 1. 计划用途

本文件是 Pi GUI 新项目的当前执行计划，也是开发进度的事实来源。

计划采用“稳定边界 + 可更新状态”的结构：

- 产品边界、架构原则和阶段完成定义只在明确决策后修改。
- Slice 状态、验收证据、阻塞和下一步随开发进展持续更新。
- 已发生的范围变化追加到“计划变更记录”，不得通过覆盖旧结论隐藏历史。
- 旧 Pi GUI 仓库和结项资源包只作为只读参考，不是新项目依赖。

## 2. 状态维护规则

Slice 只使用以下状态：

| 状态 | 含义 |
| --- | --- |
| `Pending` | 尚未开始，且前置条件未满足 |
| `Ready` | 前置条件已满足，可以开始 |
| `In Progress` | 当前正在实施；同一时间只允许一个 Slice 使用此状态 |
| `Blocked` | 存在明确阻塞；必须记录原因、证据和解除条件 |
| `Complete` | 验收条件和证据均已满足 |

每次更新本计划时：

1. 更新文件顶部的最后更新时间、总体状态和当前 Slice。
2. 更新 Slice 表中的状态、完成日期和证据链接或命令结果。
3. 在“进展日志”追加一条记录，说明完成了什么、验证了什么、下一步是什么。
4. 如果范围或架构发生变化，在“计划变更记录”追加原因和影响，不静默改写。
5. 只有实际验收通过后才能标记 `Complete`；代码存在或测试曾经通过都不等于当前完成。

## 3. 来源与边界

本计划吸收以下输入，但不延续旧仓库实现：

- `/home/vvv/Projects/pi-gui/docs/project-closure-report.md`
- `/home/vvv/Projects/pi-gui-closure-2026-07-20/`
- 本机 Pi Coding Agent 0.80.10 的 RPC 文档与实际探针结果

继承的原则：

- 保留宽桌面 Agent Workbench 的长期产品方向。
- 当前阶段采用窄内核、强边界和单一运行拓扑。
- 不整仓迁移，只在新边界下逐个提取协议、纯函数、生命周期策略和验证思路。
- 发布证据从第一条纵向链路开始建立。

明确禁止：

- 将两个旧 Pi GUI 仓库作为新项目源码或依赖。
- 复制旧 `App.tsx`、`RuntimeSupervisor`、global reducer、SQLite schema、launcher/mirror 拓扑或整套 CSS。
- 同时实现外部 Pi RPC 与进程内 `AgentSession` SDK 两套主集成。官方 `RpcClient` 属于 RPC 路径的候选客户端，不视为第二条 runtime 拓扑。
- 为 Windows、WSL、macOS、SSH 或远程后端提前建立未被当前 Linux 实现使用的兼容层。
- 使用 `latest` 作为核心依赖版本。

### 3.1 旧前端资产复用边界

用户在 2026-07-20 明确：后续可复用的“旧资产”特指旧 Pi GUI 的前端资产，包括信息架构、设计 token、组件与交互经验、展示用例和视觉参考，不是要求复用旧 runtime 或 application layer。

执行意见：

- S2 仍只实现 Electron Main 内的 Pi RPC 探针，不为了展示资产而提前增加 renderer 功能。
- 从 S3 的 runtime 状态与诊断界面开始，优先从结项资源包 `curated/` 逐项提取前端 IA、token、正文展示和组件经验。
- 不复制旧 `App.tsx`、global reducer 或整套 feature CSS；提取内容必须进入新组件边界并重新验证。
- `archive-only/` 中授权待确认的字体、Logo、图标和第三方参考素材只作参考，授权确认前不得进入发布产物。

## 4. 当前开发基线

当前已在真实机器上验证：

| 项目 | 当前基线 |
| --- | --- |
| 操作系统 | Arch Linux x86_64 |
| Kernel | Linux 7.1.3-arch2-2 |
| 图形会话 | Wayland / Niri；同时存在 `DISPLAY=:0` |
| Node.js | 26.4.0 |
| pnpm | 11.9.0 |
| npm | 12.0.1 |
| Pi executable | `/home/vvv/.local/bin/pi` |
| Pi Coding Agent | 0.80.10 |
| Pi 要求 | Node.js >= 22.19.0 |
| RPC 探针 | `--mode rpc --no-session --offline` 下 `get_state` 成功 |

P1 固定支持 Pi 0.80.10，不在本阶段设计宽松版本兼容。

## 5. 长期产品方向与当前范围

长期产品方向：Linux、Windows、macOS 桌面工作台；Windows 最终支持原生 Pi 与 WSL Pi 两种后端。

这些跨平台能力属于非常后期范围。当前代码只实现 Linux 本地 Pi，但不得让 Linux 的 PATH、XDG、进程和权限逻辑渗入 renderer 或会话模型。

P1 必须包含：

- Linux Electron 应用启动与退出。
- Pi executable 配置、版本检查和能力探针。
- 单 Project、单 Runtime、单 Session。
- 显式项目路径；选择后直接启动 Pi。
- prompt、assistant streaming、thinking、tool call/result。
- abort。
- Pi 非正常退出检测。
- 使用 `sessionFile` 和 `sessionId` 重启并恢复。
- 一个真实 Linux 打包产物及其启动、对话、崩溃恢复证据。

P1 明确不包含：

- 多 Project 或多 Session 并行。
- Files、Git、Terminal、Browser 等独立工作台模块。
- Activity Bar、Work Item、Plan、Kanban。
- Extension UI 管理界面。
- Windows、WSL、macOS 或 SSH 后端。
- SQLite、Fastify、WebSocket。
- 自动重启、无限重试或静默 fallback。
- 自动更新、远程访问、外部通知。

## 6. P1 目标架构

```text
Electron Renderer
    ↓ typed preload IPC
Workbench Kernel（Electron Main）
    ↓ RuntimeHost 最小接口
LinuxLocalRuntime
    ↓ PiRpcClient / strict LF JSONL
pi --mode rpc
```

所有权规则：

- Electron Main 是唯一 control plane 和 Pi 子进程 owner。
- Renderer 不启动进程、不读取 Pi stdout、不解析 raw Pi event。
- `LinuxLocalRuntime` 拥有 Linux executable、cwd、spawn、signal 和退出语义。
- `PiRpcClient` 只拥有 JSONL framing、request/response correlation 和 RPC 事件接收。
- Workbench Kernel 拥有 Project、Runtime、Session 和 Conversation 的 GUI identity 与状态转换。
- Pi session 文件是对话事实来源；GUI 只持久化项目设置和最近 session 指针。

`RuntimeHost` 在 P1 只定义实际使用的五项能力：

- `start`
- `send`
- `stop`
- `getState`
- `subscribe`

不实现插件注册、动态后端发现或远程 transport。

### 6.1 Pi 官方 SDK / `RpcClient` 演进边界

Pi 0.80.10 同时提供进程内 `AgentSession` SDK 和会自行启动 RPC 子进程的 typed `RpcClient`。P1 审计后继续使用 `LinuxLocalRuntime + PiRpcClient`：

- 不将 `AgentSession` 嵌入 Electron Main；Pi 运行时继续保持独立进程。
- 官方 `RpcClient` 作为后续受控迁移候选，不在 P1 与自有客户端并行接入。
- 当前 `LinuxLocalRuntime` 必须继续拥有 executable 解析与精确版本检查、cwd、spawn、异常退出、分阶段停止和脱敏 stderr 语义。
- 可优先评估通过精确固定的 Pi 开发依赖仅复用官方 RPC command/response/event 类型；引入依赖前必须单独评估 lockfile 与打包边界。
- 只有当官方客户端能保留上述 lifecycle/诊断语义或允许注入等价 process transport 时，才能替换自有 `PiRpcClient`。替换必须通过当时完整 release gate，并删除旧客户端，不保留双路径。

## 7. 初始目录结构

P1 采用单 package，不建立 monorepo：

```text
pi-gui-next/
├── package.json
├── pnpm-lock.yaml
├── docs/
│   ├── development-plan.md
│   ├── product-boundary.md
│   ├── architecture.md
│   ├── release-gate.md
│   └── decisions.md
├── src/
│   ├── main/
│   │   ├── kernel/
│   │   ├── pi-rpc/
│   │   └── runtime/
│   │       └── linux-local-runtime.ts
│   ├── preload/
│   ├── renderer/
│   └── shared/
└── scripts/
    ├── smoke-pi-rpc.mjs
    └── verify-linux-release.mjs
```

只有在出现第二个真实 package ownership 边界后，才讨论 workspace 拆分。

## 8. Slice 执行表

| Slice | 目标 | 状态 | 完成日期 | 验收证据 |
| --- | --- | --- | --- | --- |
| S0 | 建立全新 canonical repository、固定工具链和依赖、建立边界文档与唯一启动入口 | `Complete` | 2026-07-20 | `pnpm install --frozen-lockfile` 在临时干净目录通过；`electron-vite/5.0.0 linux-x64 node-v26.4.0`；见 `package.json`、`pnpm-lock.yaml`、`product-boundary.md`、`architecture.md`、`release-gate.md`、`decisions.md` |
| S1 | 建立 Electron Main、preload 和 React renderer 空壳；验证 Wayland/Niri 启停 | `Complete` | 2026-07-20 | `pnpm typecheck`、`pnpm build` 通过；Wayland/Niri 下 `pnpm dev` 显示 `Pi GUI` 窗口，关闭后 dev 进程退出码 0，窗口与 Electron 进程无残留 |
| S2 | 实现 Pi executable 配置、版本检查、LF JSONL、stderr 分流和 `get_state` | `Complete` | 2026-07-20 | 21 项定向测试、`pnpm typecheck`、`pnpm build`、`pnpm smoke:pi` 通过；Electron Main 使用真实 Pi 0.80.10 取得 `get_state`；正常开发启动先完成探针再显示窗口，Pi 与 Electron 进程均正常收口 |
| S3 | 建立最小 typed kernel command/event contract；renderer 展示 runtime 状态和诊断 | `Complete` | 2026-07-20 | 24 项定向测试、`pnpm typecheck`、`pnpm build`、`pnpm smoke:pi` 通过；Wayland/Niri 窗口显示真实 Pi 0.80.10 `ready`，强制终止唯一 Pi 子进程后同一窗口进入 `crashed`，关闭后 Pi/Electron 无残留 |
| S4 | 实现 Project 选择和带明确 cwd 的 Pi runtime 启动 | `Complete` | 2026-07-20 | 审计修复后当前 core tests、`pnpm typecheck`、`pnpm build`、`pnpm smoke:pi` 通过；覆盖 start/stop 竞态、版本检查期取消、XDG 并发保存与 renderer origin；Pi 启动不传 `--approve`/`--no-approve`；构建版在继承错误 `ELECTRON_RENDERER_URL` 时仍加载 bundled renderer，IPC 可用且外部导航/新窗口被拒绝 |
| S5 | 实现 prompt、streaming、thinking、tool card、abort 和 settled 状态 | `Complete` | 2026-07-20 | 41 项当前 core tests、`pnpm typecheck`、`pnpm smoke:pi`、`pnpm build` 通过；Wayland/Niri 构建版完成真实 provider prompt；真实 `bash` tool 记录 `pending → running（0/6/12 字符）→ success`；真实 abort 将运行中 tool 归一化为 error，并在 `agent_settled` 后使 runtime/UI 一致回到 `ready`；视觉层按 Phase B 实际 Workbench 的 332px 侧栏、860px 对话框架、轻量 Header、双层 Composer 与扁平活动流完成 1440×960 Electron 对照；补齐安全 CommonMark/GFM、开放代码围栏、外链策略与稳定块流式复用 |
| S6 | 实现 crash 检测、session 指针持久化、用户显式 restart 和 resume | `Complete` | 2026-07-20 | 二次审计修复后 78 项 core tests、`pnpm typecheck`、`electron-vite build` 和真实 Pi 0.80.10 无状态 probe 通过；覆盖 prompt 退出竞态、并发 resume、恢复验证期间 shutdown、crashed runtime 清理期间 shutdown，以及同时间戳历史消息恢复；隔离 XDG 的 probe 指针哈希、真实 session 副本 `sessionId`/`get_messages` 恢复、构建版 SIGKILL→显式恢复与 GUI 重开恢复证据已建立 |
| S7 | 构建唯一 Linux 产物并从产物完成真实核心链路，生成发布证据 | `Complete` | 2026-07-21 | x86_64 AppImage 与 `electron-builder@26.15.3` 精确固定；候选 `0f76f1e` 上 `pnpm package:linux`、`pnpm verify:linux` 通过，真实产物完成 launch、版本、project/cwd、probe、高思考设置、tool、abort、SIGKILL crash、restart/resume、继续对话、关闭重开恢复和最终收口；脱敏报告 `release/evidence/2026-07-21T04-20-26-724Z-0f76f1e2c756/report.json` 为 passed，五张截图已逐张核验，80 项 core tests 与 `pnpm typecheck` 通过 |

## 9. Slice 详细验收

### S0 — 建立项目事实源

工作内容：

- 创建全新 Git repository；旧仓库保持只读。
- 固定 Node、pnpm、Electron、React、TypeScript 和 Pi 支持版本。
- 生成并提交 lockfile。
- 建立 `product-boundary.md`、`architecture.md`、`release-gate.md`、`decisions.md`。
- 定义唯一开发入口和唯一 release lifecycle；不建立 stable/dev/canary 三套拓扑。

验收：

- 干净 checkout 可以用 frozen lockfile 安装。
- 工具链版本不依赖隐式 `latest`。
- 文档能回答当前范围、进程 owner、状态来源和发布门槛。

### S1 — Linux 桌面空壳

工作内容：

- 建立 Electron Main、preload、React renderer。
- 开启 context isolation；renderer 不获得 Node.js 直接访问。
- 建立最小窗口和受控 app shutdown。
- 建立最小 token source，不迁移旧 CSS。

验收：

- Wayland/Niri 下应用正常显示、关闭并退出全部进程。
- `pnpm typecheck` 和 `pnpm build` 通过。
- renderer 不能直接访问文件系统或 child process。

### S2 — Pi RPC 探针

工作内容：

- 从显式配置或当前 PATH 解析 Pi；找不到时明确失败并要求用户选择路径，不扫描整盘。
- 验证 Pi 版本等于 P1 支持版本。
- 使用 `shell: false`、参数数组和显式 cwd 启动 Pi。
- 实现 strict LF JSONL parser；stderr 与 stdout 协议分流。
- 实现 request ID 关联、超时和进程退出诊断。
- 支持离线、无 session 的 `get_state` 探针。

验收：

- 能从 Electron Main 启动真实 Pi 并取得 `get_state`。
- 非法 JSON、半包、多包、U+2028/U+2029 和进程退出都能明确处理。
- stderr 不会污染 RPC framing。

### S3 — Kernel Contract

工作内容：

- 定义最小 renderer command、kernel state 和 normalized event。
- 建立 stopped、starting、ready、running、stopping、crashed 状态机。
- preload 只暴露窄的 typed API。
- 增加最小诊断视图。

验收：

- Renderer 不引用 Pi RPC 类型或 raw event。
- 所有状态变化有唯一 owner。
- Pi 非正常退出后 UI 进入 crashed，不继续显示 running。

### S4 — Project

工作内容：

- 选择一个本地目录作为 Project。
- 使用 XDG config/state 保存 GUI 项目设置和最近 session 指针。
- 选择 Project 后直接以明确 cwd 启动 Pi，不增加 GUI 信任等级或传递 project trust override。
- 凭证继续由 Pi 管理，GUI 不读取或复制 API key。

验收：

- cwd 和 Pi executable 在诊断中可见，但不泄露凭证。
- 找不到路径或权限不满足时 Fail Fast。

### S5 — 对话闭环

工作内容：

- 映射 `get_state`、`get_messages`、`prompt`、`abort`、`set_model`、`set_thinking_level`。
- 规范化 agent、message、tool 和 error 事件。
- 建立最小 Project 启动页、Session Header、Timeline 和 Composer。
- 渲染 user、assistant、thinking、tool start/update/end 和 error。

验收：

- 使用真实 provider 完成一次 prompt。
- 至少一次真实 tool execution 从开始、更新到结束可见。
- streaming 文本不重复、不丢失。
- abort 后 runtime 和 UI 回到一致状态。
- `agent_settled` 作为本轮真正结束信号。

### S6 — 崩溃恢复

工作内容：

- 从 `get_state` 保存 `sessionFile`、`sessionId` 和必要的 session metadata。
- 检测 Pi 意外退出，保留退出码与仅含字符数、不含原文的 stderr 诊断摘要。
- 提供显式 Restart and Resume，不自动无限重启。
- 使用新 Pi 进程恢复上一个 session，并通过 `get_messages` 重建 Timeline。

验收：

- 在已有对话后强制终止 Pi。
- GUI 明确显示 crashed。
- 用户操作后能启动新进程、恢复原 session 并继续对话。
- 关闭并重新打开 GUI 后仍能恢复最近 session。

### S7 — Linux 发布证据

工作内容：

- 只选择一种 P1 Linux 产物格式。
- 从打包产物启动，不用开发服务器替代。
- 执行 launch、probe、project、prompt、tool、abort、crash、resume 链路。
- 输出不包含 prompt 正文、tool 敏感输出或 credential 的 JSON 验证报告。
- 保存一组关键流程截图基线。

验收：

- 新产物在当前 Arch Linux/Wayland/Niri 环境重复通过核心链路。
- 发布报告记录 app、Node/Electron、Pi、平台、步骤结果和时间。
- 工作区干净，计划状态、commit 和证据一致。

## 10. Pi RPC 映射范围

P1 只暴露以下命令：

```text
get_state
get_messages
prompt
abort
set_model
set_thinking_level
```

P1 只规范化以下事件：

```text
agent_start
agent_settled
message_start
message_update
message_end
tool_execution_start
tool_execution_update
tool_execution_end
extension_error
```

其余 RPC 能力保留在 Pi，不创建未使用的 GUI skeleton。

## 11. Runtime 状态机

```text
stopped
  → starting
  → ready
  → running
  → ready
  → stopping
  → stopped

任何运行状态
  → crashed
  → 用户显式 restart
  → starting
  → resume session
```

自动 retry、compaction 和 queued continuation 是 Pi session 事件语义，不应被 GUI 错误解释为一次 `agent_end` 后已经完全结束；P1 使用 `agent_settled` 作为完整稳定点。

## 12. 数据与安全边界

- Pi credential 和 provider auth 由 Pi 自己管理。
- Pi session 文件是 Conversation 的事实来源。
- GUI 项目配置使用 XDG config。
- GUI 最近 session 指针和非敏感启动证据使用 XDG state。
- Runtime 瞬时状态只在内存中维护。
- P1 不建立 SQLite。
- 默认诊断不记录完整 prompt、tool output、环境变量或 API endpoint credential。
- stderr 原文不进入 KernelState 或 renderer，只保留累计字符数。
- child process 必须使用参数数组和 `shell: false`。

## 13. 计划中的验证命令

以下脚本将在对应 Slice 创建后成为统一入口：

```bash
pnpm typecheck
pnpm test:core
pnpm smoke:pi
pnpm build
pnpm package:linux
pnpm verify:linux
```

P1 只保留三组定向自动测试：

- LF JSONL framing。
- RPC request/response correlation。
- Runtime lifecycle/crash transition。

不设置覆盖率目标，不提前铺设大批组件单元测试。

## 14. P1 完成定义

P1 只有同时满足以下条件才可完成：

1. 从全新 checkout 可以重复安装和构建。
2. Linux GUI 能检测并启动 Pi 0.80.10。
3. 用户选择项目后能直接启动 Pi。
4. 能完成真实 prompt、streaming 和工具调用。
5. abort 行为正确。
6. Pi 被终止后 GUI 不会继续假装其正在运行。
7. 能重新启动并恢复原 session。
8. 打包产物通过同一条真实链路。
9. 工作区干净，计划、commit 和证据一致。
10. 新项目没有依赖或复制旧项目 application layer。

P1 完成后进入 P2。P2/P3 的当前路径见下一节；后续调整继续通过状态维护规则和计划变更记录显式更新。

## 15. P2/P3 后续开发路径

本节记录当前已确认、允许后续迭代的阶段路径。P1 的范围和完成门槛不因本节变化；S7 与 P1 实际完成后才开始 P2，不把后续功能提前并入当前发布候选。

### 15.1 阶段边界

| 阶段 | 目标 | 状态 | 开始条件 |
| --- | --- | --- | --- |
| P1 — Linux Core Chain | 建立第一条可发布的 Linux 本地 Pi 核心链路 | `Complete` | 2026-07-21 完成 |
| P2 — Workbench Foundation | 补齐日常工作台基础功能，并完成 UI 与交互收敛 | `Pending` | S7 和 P1 完成 |
| P3 — Ecosystem Integration | 接入 Pi Extension、Package、Skill、prompt template 与 MCP 等扩展能力 | `Pending` | P2 完成且工作台交互边界稳定 |

### 15.2 P2 — Workbench Foundation

P2 先用一个短 Slice 固定结构，再实现基础功能，随后在真实功能上完成视觉与交互优化。布局、Project/Session 导航和对话流属于结构设计；icon、视觉细节和动效不在结构确定前完整精修。

| Slice | 目标 | 状态 | 主要工作与边界 |
| --- | --- | --- | --- |
| S8 | Workbench 信息架构与状态模型 | `Pending` | 确定主布局、Project/Session 导航、对话流、Composer 与 slash command 入口；同步明确 typed Kernel state/command 所有权；只完成结构和必要原型，不做最终视觉精修 |
| S9 | 多 Project | `Pending` | 保存、展示、选择和切换多个 Project；第一版同一时间只拥有一个活动 Runtime，切换时可靠停止旧 Runtime 后再加载目标 Project，不实现多 Project 并行运行 |
| S10 | 多 Session | `Pending` | 每个 Project 支持创建、列出、切换和恢复多个 Session；Pi session 文件继续作为 Conversation 事实来源，GUI 只保存必要索引和选择状态 |
| S11 | Pi 基础命令与 slash command | `Pending` | 扩展当前 RPC command 范围；建立统一的命令发现、搜索、补全和执行入口；区分 GUI 本地命令、typed RPC 命令以及 extension/prompt/skill 命令，不把 TUI 本地命令无条件当作 RPC 文本透传 |
| S12 | UI 视觉收敛 | `Pending` | 在真实多 Project、多 Session 和命令入口上完成布局、对话流、信息层级、design token 与 icon 系统；不以脱离真实状态的静态 mock 作为完成证据 |
| S13 | 交互优化与 P2 发布证据 | `Pending` | 完成键盘与焦点、滚动、Project/Session 切换反馈、命令补全、加载/错误/空状态等交互；从打包产物重复验证 P2 核心链路并生成脱敏证据 |

P2 的“多 Project、多 Session”首先指多个对象可保存、可发现、可切换，不等于多个 Pi Runtime 并行运行。只有出现明确并行使用需求后，才单独决定是否扩展 runtime ownership 和调度模型，不预留空的并行抽象。

P2 只有同时满足以下条件才可完成：

1. 多个 Project 可保存和切换，且任一时刻只有一个明确的活动 Runtime owner。
2. 每个 Project 下可创建、列出、切换和恢复多个 Session。
3. 当前支持的 Pi 日常命令与 slash command 在 GUI 中可发现、可执行，并能区分命令来源与执行路径。
4. 布局、对话流、icon 和基础交互经过真实工作流验证，不再依赖 P1 的单 Project/单 Session 占位结构。
5. 打包产物通过 P1 回归链路和 P2 新增核心链路，工作区、计划、commit 与脱敏证据一致。

### 15.3 P3 — Ecosystem Integration

P3 在 P2 的导航、命令入口和交互容器上接入扩展生态，当前固定范围方向，不提前建立未被真实能力使用的插件平台：

- Pi Extension 的发现、命令、事件和可支持的 UI request。
- Pi Package 的安装、移除、更新、列出、配置和资源重载。
- Skill 与 prompt template 的发现、说明和调用；复用 P2 的统一命令入口。
- MCP server、tool、resource、配置和运行状态；先核对届时固定 Pi 版本的真实支持边界，不预设能够经 Pi RPC 直接透传。
- 为上述能力统一来源标识、错误、权限提示和诊断体验。

P3 的具体 Slice 在 P2 接近完成、Pi 支持版本和可用接口重新核验后追加到本计划。后续拆分必须继续遵循 KISS：先接入一条真实可验证的能力链路，再扩展第二类资源或管理界面。

## 16. 进展日志

| 日期 | Slice | 记录 | 下一步 |
| --- | --- | --- | --- |
| 2026-07-20 | Planning | 完成旧项目结项报告阅读；确认新项目从零开始；确认 Linux 为当前开发平台；本机 Pi 0.80.10 离线 RPC `get_state` 成功；形成 P1 活计划 | 开始 S0，建立 canonical repository 和项目边界文件 |
| 2026-07-20 | S0 | 初始化 canonical Git repository；精确固定 Node 26.4.0、pnpm 11.9.0、Electron 43.1.1、React 19.2.7、TypeScript 7.0.2、Pi 0.80.10 及兼容构建依赖；生成 lockfile；建立产品、架构、发布门槛和决策事实源；临时干净目录 frozen install 通过 | 开始 S1，建立 Linux Electron 桌面空壳并验证 Wayland/Niri 启停 |
| 2026-07-20 | S1 | 开始建立 Electron Main、preload 和 React renderer 空壳；增加共享构建与类型检查入口 | 完成两层实现并验证 Wayland/Niri 启停与进程收口 |
| 2026-07-20 | S1 | 完成 Electron Main、空 preload 和 React renderer 空壳；修正 pnpm Electron postinstall 允许项；typecheck/build 通过；Wayland/Niri 窗口显示、关闭及进程收口通过 | 开始 S2，实现真实 Pi RPC 探针 |
| 2026-07-20 | S2 | 明确旧资产是旧项目的前端 IA、token、组件与展示经验；固定从 S3 开始逐项提取的复用边界；开始实现 Pi executable、LF JSONL、request correlation 和真实 `get_state` 探针 | 完成协议、runtime、Main 接线和真实 Pi 0.80.10 验收 |
| 2026-07-20 | S2 | 完成显式路径/PATH 解析、Pi 0.80.10 精确版本检查、strict LF JSONL、request ID/timeout/exit 诊断、stderr 分流和 Linux Local probe；21 项测试及真实 Electron Main `get_state` smoke 通过；默认日志只记录 stderr 长度，不输出内容 | 开始 S3，建立 typed kernel contract，并按计划逐项提取旧前端资产实现 runtime 状态与诊断界面 |
| 2026-07-20 | S3 | 完成最小 `KernelCommand`/`KernelState`/`KernelEvent`、RuntimeHost 五方法、Workbench Kernel 六态状态机、持久 Pi runtime、窄 preload IPC 和按需诊断视图；使用 CommonJS preload 保持 Electron 默认 sandbox；24 项测试、typecheck、build、真实 Pi smoke 通过；Wayland/Niri 下验证 ready、SIGKILL 后 crashed、关闭后进程收口 | 开始 S4，实现单 Project 选择、显式 trust 与明确 cwd |
| 2026-07-20 | S4 | 完成单 Project 目录选择、显式 trusted/untrusted、XDG config 持久化与 XDG state 初始化；Project 路径在 Main canonicalize 并验证目录及权限，Kernel 以所选 Project 创建唯一 runtime；Pi 每次显式使用 `--approve` 或 `--no-approve`；UI 和诊断显示 cwd、trust、executable 与 version；29 项测试、typecheck、build、真实 Pi smoke、两种 trust probe 及隔离 XDG renderer 启动链路通过 | 开始 S5，实现最小对话闭环 |
| 2026-07-20 | S4 Audit | 修复 inherited renderer URL 获得 preload、start/stop 并发后旧 start 复活、版本检查后延迟 spawn、XDG 固定临时文件并发冲突四项审计问题；Main 只接受 electron-vite development 模式下的 loopback origin，并校验导航、窗口打开和 IPC sender；41 项当前 core tests、build/smoke、两种 trust probe、构建版错误环境继承和开发入口验收通过 | S4 保持 Complete；S5 状态由其独立验收结果维护 |
| 2026-07-20 | S5 | 完成六项 Pi RPC command 映射和 agent/message/tool/error 归一化；以旧前端的暖炭灰 token、单工作台 IA、可折叠 thinking 和紧凑 tool card 经验重建 Project 启动页、Session Header、Timeline、Composer，不复制旧 application layer 或受限资产；真实 provider prompt、工具流式更新、abort 与 `agent_settled` 闭环通过，41 项 core tests、typecheck、smoke、build 全部通过 | 开始 S6，实现显式 restart、session 指针持久化与 resume |
| 2026-07-20 | S5 Visual Parity | 用户复核后将 Phase B 的实际 React/CSS Workbench 升格为视觉规格：恢复 12px 浮动外框、332px 半透明侧栏、860px 主对话框架、轻量绝对定位 Header、底部双层 Composer、右对齐用户气泡以及扁平 thinking/tool 时间线；移除新加的大品牌区、页面级标题胶囊、中央空状态宣传与底部状态条；未复制受限字体、Logo 或应用资产；在真实 Electron 中以 1440×960 与历史工作台同尺寸对照并重跑 typecheck、core tests、build | S5 保持 Complete；继续 S6 |
| 2026-07-20 | S4 Scope Correction | 移除 GUI 自定义的 trusted/untrusted 状态、IPC、持久化、启动参数、UI 与诊断字段；config 严格只接受项目路径；core tests、typecheck、真实 Pi 0.80.10 smoke 与 build 通过 | S4 保持 Complete；继续 S6 |
| 2026-07-20 | S5 Markdown Completion | 修复对话仅输出纯文本却误用 `markdown-message` 命名的 S5 验收缺口；正文与 thinking 统一接入无 raw HTML 的 CommonMark/GFM；历史内容 memo、活动尾块按帧更新、稳定 GFM AST 顶层块复用；引用/脚注定义保持整篇解析；外链经 Main 白名单打开，远程图片不自动加载；106,500 字符/1,500 次追加的分块模型基准约 0.59ms/update；53 项 core tests、typecheck、build、真实 Pi smoke 与生产依赖审计通过 | S5 保持 Complete；继续 S6 |
| 2026-07-20 | S6 | 完成 Pi session 持久化启动、严格 XDG recent session 指针、`sessionFile`/`sessionId` 捕获、裁剪后的 stderr 摘要、显式 restart/resume IPC 与 renderer 入口；49 项 core tests、typecheck、build、真实 Pi smoke 通过；隔离构建版完成真实 provider 两消息会话、SIGKILL→crashed→显式重启恢复，并验证 GUI 关闭重开后仍可恢复且进程无残留 | 开始 S7，选择唯一 Linux 产物并生成发布证据 |
| 2026-07-21 | S6 Audit | 修复 probe 改写 recent session、缺失 session 文件被 Pi 当成新会话、恢复后 `sessionId` 未核对、启动投影失败遗留 runtime、清理失败丢失进程所有权、stopping 期间迟到事件改写 UI、stderr 原文进入 renderer，以及 crashed/无效恢复指针缺少新建入口；恢复前验证普通可读文件，probe 使用 `--no-session`；65 项 core tests、typecheck、直接 build、隔离 XDG 哈希校验及真实 Pi session 副本恢复通过 | S6 保持 Complete；不改变 S7 范围与状态 |
| 2026-07-21 | S7 | 选择 x86_64 AppImage 为唯一 P1 Linux 产物；精确固定 electron-builder；实现只打包 `out/` 与运行依赖的 AppImage 配置，以及通过 CDP 驱动真实产物 UI 的脱敏验证器；初次 AppImage 构建、包内容边界和真实 Pi 0.80.10 probe 通过 | 建立干净 commit，执行完整 prompt/tool/abort/crash/resume/reopen 产物链路并生成最终证据 |
| 2026-07-21 | S5 Flow UX | 按用户确认的流程重建 conversation 展示投影：thinking 成为有序过程项，工具按 `toolCallId` 单项原地更新，活动 run 线性展示并在 `agent_settled` 后折叠到回答上方；展开后保留原顺序，并汇总 `read`/`edit`/`write` 的文件路径与基础悬浮信息；diff 延后。65 项 core tests、typecheck、build 通过；Wayland/Niri 构建版用真实 provider 验证 `read → write → read`、4 秒 bash 运行态、settled 折叠、过程展开和文件 hover，QA 临时文件已清理 | S5 保持 Complete；继续 S7，不扩大发布范围 |
| 2026-07-21 | S6 Re-audit | 修复 prompt transport rejection 覆盖 crashed、并发 resume 泄漏 Runtime、恢复验证与 crashed runtime 清理期间 shutdown 未完整收口，以及历史消息仅用 role/timestamp 造成恢复碰撞；增加 Kernel 单一 launch operation、取消/项目切换边界与确定的历史消息 identity；78 项 core tests、typecheck、diff check、build 和真实 Pi 0.80.10 无状态 probe 通过 | S6 保持 Complete；S7 继续在干净 commit 上执行完整产物 crash/resume/reopen 链路 |
| 2026-07-21 | S5 Performance Hardening | 将 Pi 高频更新从完整 `KernelState` 改为 entry insert/append suffix patch，Renderer 每帧最多提交一次；流式 Markdown tail 超过 16,384 字符后安全降级为纯文本并在 settled 后完整解析；Timeline 初始挂载最近 60 轮、折叠过程按需挂载；Composer 按实际高度避让并保持跟随输出；主动 abort 使用中性“已中止”。106,500 字符/1,500 次追加三类基准平均 0.52ms/update、最坏 P95 2.60ms；浏览器 1,500 patch 仅 1 组 DOM mutation，长输入遮挡为 0，70 轮展开锚点偏移 0.16px；79 项 core tests、typecheck、build、真实 Pi 0.80.10 probe 通过 | S5 保持 Complete；继续 S7 |
| 2026-07-21 | S5 Streaming Markdown Correction | 按用户确认移除超长流式 tail 的纯文本 fallback；16,384 字符只限制分块预解析，超限后仍由同一 React Markdown 管线整篇实时渲染 GFM。浏览器核验 17,606 字符未闭合代码围栏、24,220 字符 GFM 表格和 16,426 字符末尾引用定义均保持真实 Markdown DOM；106,500 字符/300 帧的超长单段渲染平均 12.81ms、P95 22.41ms | S5 保持 Complete；保留其他性能修复并继续 S7 |
| 2026-07-21 | Architecture Audit | 核对本机 Pi 0.80.10 的进程内 `AgentSession` SDK、官方 typed `RpcClient` 与当前 `LinuxLocalRuntime + PiRpcClient`；确认当前六项命令的最小 adapter 满足 P1，官方 `RpcClient` 的自行 spawn、完整 stderr 保留/输出和较简化的停止语义不能原样替换当前 runtime；79 项 core tests 通过；记录先复用官方类型、后在满足 lifecycle/诊断门槛时受控迁移的路径 | S7 保持 In Progress；建立包含计划/ADR 更新的干净 commit，再运行完整产物验证 |
| 2026-07-21 | S7 Evidence Sync | 复核候选 `8a63c29` 及发布验证器；脚本已覆盖 launch、project/probe、prompt/tool、abort、crash、restart/resume、close/reopen，但当时不存在 passed 的 `release/evidence` 报告和五张截图；实现存在不等于验收证据已生成 | 在新的干净 commit 上执行 `pnpm package:linux` 与 `pnpm verify:linux`；只有脱敏报告为 passed 且重复链路成功后才将 S7/P1 标记 Complete |
| 2026-07-21 | S7 Candidate Gate | 候选 `8a63c29` 的 frozen install、typecheck、79 项 core tests、真实 Pi smoke、build 与 AppImage package 通过；真实产物验证通过 launch、Electron/Pi 版本、project/cwd、probe 和高思考设置，在 `tool_turn/E_THINKING_ACTIVITY` 超时后 Fail Fast，Pi/Electron 无残留。根因是 S5 Flow UX 已将过程节点改为 `process-step`，验证器仍等待旧 `chronological-activity` DOM；`a2e5c28` 改为通过 typed kernel state 计数工具状态，并接受当前 thinking status 或持久 thinking entry | 在包含 0.9 计划与 ADR 的干净 commit 上重新打包并执行完整链路；失败候选不计入完成证据 |
| 2026-07-21 | S7 Candidate Gate | 候选 `91ba7a9` 的 AppImage package 与真实产物验证再次执行；launch、版本、project/cwd、probe、高思考设置、真实 tool 和 abort 均通过，在 `crash_detection/E_PI_PROCESS_MISSING` Fail Fast，Pi/Electron 无残留。根因是 AppImage 启动器 PID 不能作为 Pi 进程的稳定祖先；验证器改为全局扫描同时满足本次唯一临时 project cwd 与精确 RPC 参数的进程，并继续拒绝零个或多个匹配 | 在新的干净 commit 上重跑 package 与完整 crash/resume/reopen 链路；失败候选不计入完成证据 |
| 2026-07-21 | S7 Candidate Gate | 候选 `64b4534` 的 AppImage package 与真实产物验证再次执行；launch、版本、project/cwd、probe、高思考设置和真实 tool 通过；abort 已观察到运行中 tool 且 runtime 回到 ready，但工具可能在 abort RPC 生效前完成，旧断言因没有 error tool 报 `E_ABORT_FAILED_TOOL`，随后 Fail Fast 且 Pi/Electron 无残留。验证器改为要求终态无 pending/running tool，并接受 failed tool 或 assistant `stopReason=aborted` 作为中止证据 | 在新的干净 commit 上重新打包并重跑完整链路；失败候选不计入完成证据 |
| 2026-07-21 | S7 Candidate Gate | 候选 `e278359` 的 AppImage package 与真实产物验证再次执行；launch、版本、project/cwd、probe、高思考设置和真实 tool 通过；中止请求后 runtime 回到 ready 且 tool 已终止，但当前 kernel state 没有独立 abort marker，Pi 在此链路也没有投影 failed tool 或 `stopReason=aborted`，旧验证器因而报 `E_ABORT_SETTLED`，随后 Fail Fast 且 Pi/Electron 无残留。验证器改为先确认 UI 中止入口可用和 tool 正在运行，再直接等待 preload `abort` 的成功 RPC 响应，并验证终态无运行中 tool；该响应只有在 Pi RPC 返回 success 后才完成 | 在新的干净 commit 上重新打包并重跑完整链路；失败候选不计入完成证据 |
| 2026-07-21 | S7 Candidate Gate | 候选 `eecc22d` 的 AppImage package 与真实产物验证再次执行；launch、版本、project/cwd、probe、高思考设置和真实 tool 通过，验证器在 tool running 时取得 Pi abort 成功响应，runtime 回到 ready；但 Pi 未投影 `tool_execution_end`，当前 run 的 tool card 永久残留为 running，验证器报 `E_ABORT_SETTLED` 后 Fail Fast，Pi/Electron 无残留。kernel 的统一 settle 边界改为只将当前 run 遗留的 pending/running tool 归一化为 error，并补充确定性回归测试 | 在新的干净 commit 上重新打包并重跑完整链路；失败候选不计入完成证据 |
| 2026-07-21 | S7 Candidate Gate | 候选 `bd6158c` 的 AppImage package 与真实产物验证再次执行；launch、版本、project/cwd、probe、高思考设置、真实 tool 和 abort 均通过，abort 获得 Pi 成功响应，tool card 归一化为 error 且 runtime/UI 回到一致终态；在 crash 前因 Pi 将 Linux process title 改为 `pi`、`/proc/<pid>/cmdline` 不再保留启动参数而报 `E_PI_PROCESS_MISSING`，随后 Fail Fast 且 Pi/Electron 无残留。验证器改为以本次唯一临时 project cwd 加 `/proc/<pid>/comm` 的 `pi` 唯一定位进程，继续拒绝零个或多个匹配 | 在新的干净 commit 上重跑 package 与完整 crash/resume/reopen 链路；失败候选不计入完成证据 |
| 2026-07-21 | P2/P3 Planning | 确认 P1 只负责可发布的 Linux 核心链路；P2 依次完成 Workbench 结构、多 Project、多 Session、Pi/slash command、视觉与交互收敛；P3 再接入 Extension、Package、Skill、prompt template 和 MCP，并保留后续显式修订空间 | 先完成 S7/P1；随后以 S8 固定 Workbench 信息架构与状态模型，并在 S9 实现多 Project |
| 2026-07-21 | S7 / P1 Complete | 候选 `0f76f1e` 的 AppImage package 与真实产物验证完整通过；报告 13 个步骤全部 pass，覆盖 launch、runtime identity、project/cwd、probe、高思考、真实 tool、Pi 成功响应的 abort、SIGKILL crash、restart/resume、继续对话、graceful close、reopen/reopen resume 和 final close；五张 1271×1523 截图均非空且 prompt、assistant、thinking、tool 详情已脱敏，报告不含 prompt 正文、tool 输出或 credential；80 项 core tests、typecheck 通过，验证后 Pi/Electron 无残留 | P1 完成；P2 保持 Pending，下一步从 S8 Workbench 信息架构与状态模型开始 |

## 17. 计划变更记录

| 日期 | 版本 | 变更 | 原因 | 影响 |
| --- | --- | --- | --- | --- |
| 2026-07-20 | 0.1 | 建立 P1 Linux Core Chain 计划 | 新项目决定从零构建，并吸取旧 Pi GUI 的结项经验 | 当前只实现 Linux Local Pi；跨平台后端延后 |
| 2026-07-20 | 0.2 | 明确旧资产特指旧项目前端资产；复用从 S3 可视界面开始，S2 保持纯 Main/RPC 边界 | 用户澄清资产含义；需要同时保留视觉积累与 Slice 边界 | S2 不增加 renderer 功能；S3 起逐项提取 IA、token、组件和展示经验，授权未确认资产继续阻塞发布 |
| 2026-07-20 | 0.3 | 移除 GUI 的项目 trusted/untrusted 选择及 `--approve`/`--no-approve` override | 这些 Pi 参数控制项目本地资源加载，不是工具执行审批；原 UI 将其误表述成执行权限等级 | Project 只保存路径；选择后直接启动；不保留旧 trust schema 兼容 |
| 2026-07-20 | 0.4 | 将安全、流式优化的 CommonMark/GFM 明确纳入 S5 完成证据 | 原 S5 只验证文本可见，未覆盖 Markdown 基础渲染；长回复完整重解析会损害流式体验 | S5 增加统一 Markdown 管线、稳定块复用、外链白名单和定向性能验证；S6/S7 范围不变 |
| 2026-07-21 | 0.5 | S7 选择 x86_64 AppImage 作为 P1 唯一 Linux 产物，并落地真实 UI 发布验证入口 | 当前 Arch Linux/Wayland/Niri 机器已具备 FUSE；单文件、免 root 的 AppImage 能保持唯一发布路径且不绑定发行版包管理器 | 新增精确固定的 electron-builder、`package:linux`、`verify:linux`、脱敏报告与截图证据；不增加第二种产物格式 |
| 2026-07-21 | 0.6 | 明确活动 run 的线性过程流、settled 后折叠规则，以及工具单项状态更新与文件信息展示 | 用户确认现有 thinking/tool 时间线缺少真实顺序和完成后的信息层级，并明确 tool call/result 不拆成两个展示节点 | S5 增加独立 thinking entry、活动 run 边界、完成过程摘要和文件 hover；diff 延后，S7 范围与状态不变 |
| 2026-07-21 | 0.7 | 为 S5 固定高频增量 patch、16,384 字符流式解析预算、最近 60 轮挂载窗口和动态 Composer clearance | 审计确认完整状态/长单块解析/全历史挂载会放大长回复成本，输入框增高会覆盖末尾消息 | 保留完整 settled Markdown 与可展开历史；长回复热路径有界；S6/S7 功能范围不变 |
| 2026-07-21 | 0.8 | 取消超长流式 Markdown 的纯文本 fallback；16,384 字符预算只用于停止分块预解析，超限后整篇实时渲染 GFM | 用户明确要求 streaming 与 settled 的实际 Markdown 效果一致，不能在消息结束时再发生格式切换 | 保留增量 state patch、帧合并、历史挂载窗口和 Composer clearance；极端超长单块恢复 O(n) GFM 渲染并记录实测边界，S6/S7 范围不变 |
| 2026-07-21 | 0.9 | 澄清 Pi 的进程内 `AgentSession` SDK、官方 typed `RpcClient` 与当前自有 typed RPC adapter 的边界；将官方 `RpcClient` 记为受控迁移候选 | 官方 `RpcClient` 同时提供 SDK 体验和 RPC 进程隔离，但 Pi 0.80.10 的实现尚不满足当前 executable ownership、异常退出证据、分阶段停止与脱敏 stderr 要求 | P1 拓扑与六项命令范围不变；允许先评估仅复用官方类型，完整替换需满足 lifecycle/诊断门槛、通过完整 release gate 并删除旧路径 |
| 2026-07-21 | 1.0 | 增加 P2 Workbench Foundation 与 P3 Ecosystem Integration 后续路径；P2 规划 S8–S13，并将多 Project 放在结构 Slice 后立即实施 | 用户确认需要在 P1 后补齐多 Project、多 Session、slash command、UI 与交互，再扩展 Pi 与 MCP 生态；同时要求路线可继续修改 | P1/S7 范围和门槛不变；P2 首先建立可切换但不并行的多 Project/Session 工作台，P3 的具体 Slice 延后到 P2 接近完成时核验并追加 |
