# Pi GUI 开发计划

> 当前阶段：P3 — Ecosystem Integration
> 计划版本：9.7
> 最后更新：2026-07-30
> 总体状态：In Progress
> 当前 Slice：P3-2 — Commit & Push（Ready）

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
| `Paused` | 已开始但为当前 Slice 让路；必须记录恢复条件，且不与当前 Slice 同时记为 In Progress |
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

当前优先级明确保持为把 Linux GUI 的功能、体验、稳定性、内存预算和发布链路做好。跨平台能力属于后期范围，实施顺序固定为 macOS → Windows 原生 → 按真实需求评估 WSL；在对应阶段正式开始前，不为这些平台增加当前 Linux 主路径未使用的兼容层或占位抽象。Linux 的 PATH、XDG、进程和权限逻辑仍必须留在 Main/Runtime 边界，不得渗入 renderer 或会话模型。

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

P1 完成后进入 P2。P2/P3/P4 的当前路径见下一节；后续调整继续通过状态维护规则和计划变更记录显式更新。

## 15. P2/P3/P4 后续开发路径

本节记录当前已确认、允许后续迭代的阶段路径。P1 的范围和完成门槛不因本节变化；S7 与 P1 实际完成后才开始 P2，不把后续功能提前并入当前发布候选。

### 15.1 阶段边界

| 阶段 | 目标 | 状态 | 开始条件 |
| --- | --- | --- | --- |
| P1 — Linux Core Chain | 建立第一条可发布的 Linux 本地 Pi 核心链路 | `Complete` | 2026-07-21 完成 |
| P2 — Workbench Foundation | 补齐日常工作台基础功能，并完成 UI、交互、Runtime 治理与内存预算收敛 | `Complete` | 2026-07-30；commit `152a9a3` 的 19 步正式 AppImage + memory gate 通过 |
| P3 — Ecosystem Integration | 接入 Pi Extension、Package、Skill、prompt template、Git Workbench 与 MCP 等扩展能力 | `In Progress` | P3-1 已完成；P3-2 从已验证的 staged-content 链路增加 Commit & Push |
| P4 — Cross-platform Desktop | 将已经稳定的 Linux Workbench 依次移植到 macOS、Windows 原生，并按需评估 WSL | `Deferred` | Linux GUI 的功能、体验、稳定性、内存预算和正式发布门槛稳定，且用户显式重新开启跨平台范围 |

### 15.2 P2 — Workbench Foundation

P2 先用一个短 Slice 固定结构，再实现基础功能，随后在真实功能上完成视觉与交互优化。布局、Project/Session 导航和对话流属于结构设计；icon、视觉细节和动效不在结构确定前完整精修。

下表中的 S8–S13 描述保留各 Slice 当时的验收边界和发布证据；其中“单活动 Runtime”属于历史事实，已由 D-017 和 S14-32 替代，不再是当前实现或后续验收要求。

| Slice | 目标 | 状态 | 主要工作与边界 |
| --- | --- | --- | --- |
| S8 | Workbench 信息架构与状态模型 | `Complete` | 形成 `p2-workbench-structure.md`：确定主布局、Project/Session 导航、对话流、Composer 与 slash command 入口，明确 identity、事实源、typed command 与单活动 Runtime 切换顺序；低保真 Renderer 已通过 typecheck/build、真实 Electron 折叠/展开诊断复核和用户确认，不做最终视觉精修 |
| S9 | 多 Project | `Complete` | 保存、展示、选择和切换多个 Project；`projects[]` / `activeProjectKey` typed contract、按 Project 隔离的最近 Session 指针和单活动 Runtime 切换已落地；运行中拒绝切换，ready/crashed 切换先停止旧 Runtime，不实现多 Project 并行运行 |
| S10 | 多 Session | `Complete` | `sessions[]` / `activeSessionKey` typed contract、XDG state v3 Session 索引与 v1/v2 迁移、每 Project 创建/列出/切换/恢复已落地；Pi 0.80.10 新 Session 在 JSONL 延迟落盘期间使用不入索引的 provisional identity，落盘校验并持久化后才正式提交；切换持久化期间进程退出保持 crashed；正常 GUI 使用单实例锁避免跨进程 XDG 丢失更新 |
| S11 | Pi 基础命令与 slash command | `Complete` | Kernel 在 Runtime 启动时通过真实 `get_commands` 建立 normalized catalog；内建 `/new`、`/model`、`/thinking`、`/compact`、`/name` 分别路由到 GUI 或 typed RPC，extension/prompt/skill 只允许调用当前 catalog 中的 ID 后进入 Pi prompt 语义；Composer 支持来源标识、搜索、键盘选择、补全、参数输入和未知命令 Fail Fast，不存在任意 raw command IPC |
| S12 | UI 视觉收敛 | `Complete` | 真实构建版通过隔离 XDG 的 ProjectStore/WorkbenchKernel 载入 2 个 Project、3 个 Session，切换后只显示目标 Project 的 Session；真实 Pi 0.80.10 启动到 ready 并展示 `/new`、`/model`、`/thinking`、`/compact`、`/name` catalog；slash menu 位于 Composer 上方且无溢出，Header/流内诊断不覆盖 Timeline；109 项 core tests、`pnpm typecheck`、生产 build、diff check 通过 |
| S12.5 | 重复职责解耦 | `Complete` | 审计当前实现后只收敛跨模块高重复且存在语义漂移风险的纯逻辑：Main 通用 record guard、错误文本归一化、Project Session pointer 类型与 upsert，以及 Renderer Runtime 状态判定；不按文件大小拆分，不为单次逻辑增加函数、类或中间层；109 项 core tests、`pnpm typecheck`、生产 build 和 diff check 通过 |
| S13 | 交互优化与 P2 发布证据 | `Complete` | 完成低成本可配置的 Session 语义命名、Tab/Arrow slash 补全与 combobox 语义、Runtime context action 成功后的 Composer 焦点恢复、Project/Session 切换反馈、Kernel 连接重试以及空对话与无详情 crash 状态；候选 `fe1e559` 的 AppImage 通过 17 步 P1 回归与 P2 双 Project、双 Session、slash command、单 Runtime 和交互链路，schema v2 脱敏报告与六张截图位于 `release/evidence/2026-07-22T03-37-46-614Z-fe1e559bca43/` |
| S14 | 优化 | `Complete` | 按实际使用中发现的问题完成四十二项交互、并行 Runtime、输入、设置和职责边界优化；队列修改因 Pi 0.80.10 缺少 typed mutation RPC 明确延期，不以 Renderer 伪实现阻塞收口 |
| S15 | TUI 日常能力补齐 | `Complete` | 六个阶段均已完成：Project 资源 trust / reload、Session Fork / 归档即时补救、安全导出 / 回复复制 / 生命周期统计、Project 路径搜索 / GUI typed 命令、公开 SDK 凭证交互 / Provider 定向 reload 标记，以及窗口内快捷键 / Pi 压缩生命周期；未照搬 Tree、Clone、CLI/headless、工具控制或完整生态管理 |
| S16 | Subagent Extension 适配 | `Complete` | 固定适配 `pi-subagents`；拓展页以独立“已适配拓展”区域负责安装和真实启停；独立 Subagent 页只读取可用状态并修改最大嵌套深度，Runtime 通过 `PI_SUBAGENT_MAX_DEPTH` 配置，新建或显式 reload 后生效；不实现 Agent definition CRUD、任务监控或内建 Subagent Runtime |
| S17 | Subagent Agent 管理 | `Complete` | Subagent 页接入真实用户级与当前项目 Agent Markdown 定义；内置 Package 文件不改写，界面直接编辑并可恢复默认；Agent 启停复用官方 disabled override，列表每页 6 项并支持作用域/启动状态筛选与多选批量修改；编辑器分基础/高级设置；Main 只读写固定 Agent 与 settings 路径，Renderer 不取得任意文件能力；core tests、typecheck、生产 build 与 diff check 通过 |
| S17.1 | Magic Context 可选适配 | `Complete` | 拓展页增加固定 `@cortexkit/pi-magic-context` 安装与 Extension resource 启停；Package 状态不冒充配置健康，setup/doctor 继续由上游 CLI 负责，运行态复用 Pi 命令目录中的 `/ctx-status`；不解析私有 SQLite、不内嵌配置器或伪造缓存指标 |
| S18 | OMP 多 Advisor Extension 与 GUI 适配 | `Paused` | S18-1 至 S18-4 已完成；S18-5 可观测性与发布作为非阻塞 backlog 保留，后续只有在恢复 Advisor 产品范围时继续，不阻塞 P2 完成或 P3-1 |
| S19 | Subagent 任务详情侧栏 | `Complete` | Canonical clean commit `b9562b4` 的正式 `pnpm verify:linux` 已通过完整 P1/P2 回归与 S19：3 路并行 worker 同时 running、运行中选择、Escape 优先级、live→completed、宽屏第三列、窄屏替换、关闭/返回/Escape 焦点恢复和 reduced-motion。AppImage SHA-256 为 `4bbe45a505f601966c75ba8c3b4074f793ee88a7aff88e83bf00af03f039c29d`，证据位于 `release/evidence/2026-07-27T16-45-59-798Z-b9562b4ca6c3/` |
| S20 | 动效与交互基础 | `Paused` | S20-1 与 S20-2 已完成；S20-3 作为非阻塞交互 backlog 保留，仅在真实一致性缺陷出现或对应产品面继续实施时恢复 |
| S21 | Settings Workspace 2.0 | `Planned` | 设置导航按“应用 / 模型 / Agent / 生态”分组，增加收起、真实设置搜索和应用内 deep link；统一作用域、事实来源、生效时间及 saved/loaded 差异，不建立通用设置 registry，不静默 reload Runtime |
| S22 | Personalization v1 | `Planned` | 第一批只增加用户级的对话阅读宽度、Navigator 密度和动效偏好；使用有限语义枚举与统一 token，窄窗口、触控命中和 OS reduced-motion 继续拥有更高约束，不提供任意 CSS、像素或颜色编辑 |
| S23 | Subagent Effective State 与任务一致性 | `Planned` | Main 投影 effective Agent definition、覆盖来源、最终启停/depth、Package/Extension/当前 Runtime 加载及 reload 状态；任务详情补同 run participant 切换、汇总和实时→历史恢复一致性，不读取 child transcript/artifact，不提前加入 GUI 运行控制 |
| S24 | Magic Context 状态可见性 | `Planned` | 安装/启停继续留在拓展页，独立 Context 页只读展示 Package、Extension、当前 Session loaded、真实 `/ctx-status`、状态时间与过期语义，并提供复制 setup/doctor 命令和上游文档入口；不解析 SQLite 或把“已开启”冒充健康 |
| S25 | Magic Context 结构化可观测协议 | `Research` | 与上游共同评估版本化 capability/status/usage 协议，候选覆盖上下文占用、后台状态和 prompt-free token/cache/cost；协议稳定前不建立仪表盘，不暴露 prompt/output、embedding、credential、数据库路径或私有 schema |
| S26 | Memory Budget & Automatic Runtime Hibernation | `Complete` | commit `152a9a3` 的正式 AppImage memory gate 建立并执行首轮硬预算；3 个物化 Runtime 经五分钟 grace 自动降到 2 个，显式恢复后回到 3 个且对话保留；峰值总 PSS 2.50 GiB、Renderer PSS 156.7 MiB、heap 25.9 MiB、state 98.2 KiB、swap 0，全部低于固定红线 | `release/evidence/2026-07-29T18-48-57-827Z-152a9a3a0725/report.json`；旧 Timeline 分页、内存压力触发和 30 分钟 slope 属于按真实回归触发的后续优化，不冒充本次已验证 |

P2 最初把“多 Project、多 Session”限定为可保存、发现和切换。2026-07-23 用户确认并行是旧版已有且当前必须恢复的核心能力后，D-017 替代该限制：Workbench Kernel 现在按 Session 管理独立 Runtime context，允许多个 Pi Runtime 并行，同时保持 Electron Main 单一 control plane。

#### S18 — OMP 多 Advisor Extension 与 GUI 适配

当前状态：`Paused`。S18-4 已完成 Extension 内交付与韧性；S18-5 继续保持 `Pending`。2026-07-28 因 S26 内存治理成为最高优先级而暂停后续可观测性与正式发布收敛；S26 建立可重复诊断、IPC/Renderer 有界增长和安全 Runtime 回收边界后再恢复。

目标：

- 复刻固定 OMP 基线中多 Advisor 的用户可感知行为，同时继续以 Pi 0.80.10 为唯一 Agent Runtime。
- 形成可由用户手动安装、加载和关闭的固定 Extension，并沿用 `pi-subagents` 的“拓展页总开关 + 功能专页配置”模式。
- 为 Conversation Timeline、Advisor 设置和运行状态建立专门的 typed GUI 适配，不向 Renderer 透传 raw custom event。

完整产品、协议、事实来源和安全边界见
[`advisor-system.md`](advisor-system.md)。S18 是用户确认的固定适配纵向链路，不代表建立通用
Extension adapter registry，也不提前激活 P3 的全部生态管理范围。

实施顺序：

| 阶段 | 状态 | 范围 | 完成门槛 |
| --- | --- | --- | --- |
| S18-1 协议与单 Advisor 基线 | `Complete` | 已审计 Pi 0.80.10 Extension API 和固定 OMP WATCHDOG parser；已建立 `pi-gui-multi-advisor` 0.1.0、strict 默认关闭 state、protocol v1 与一个默认使用当前 Provider 中 `gpt-5.6-sol + medium` 的只读独立 Advisor；模型或认证不满足时明确暂停 | 7 项离线测试、独立类型校验、Package dry-run、真实 Pi 安装/加载/命令/capability，以及 `terra + low` primary → `sol + medium` Advisor 的真实 `blocker` 与 Session 持久化闭环通过 |
| S18-2 GUI 投影与控制 | `Complete` | capability 与历史/实时 advisory strict projector、Pi RPC 固定 adapter allowlist、Extension resource / Session system 两个窄 typed control、拓展页固定项、最小 Advisor 状态页和 turn 内 Timeline 卡片 | 151 项后端定向测试、Renderer typecheck、生产 build 与 diff check 通过；Renderer 不接触 raw event，未知/非法 custom payload 不 fallback |
| S18-3 多 Advisor roster | `Complete` | WATCHDOG 发现/合并、多个隔离 Advisor、protocol v2、Advisor 专页 typed CRUD 与固定工具授权 | 用户/Project 覆盖可解释；单项启停、模型、thinking、固定工具和指令在 reload 后真实生效；默认只读，`edit/write` 显式授权，`bash` 不开放 |
| S18-4 交付与韧性 | `Complete` | Package 0.3.0 实现 nit/concern/blocker delivery、steer 后三轮 interrupt immunity、每 Advisor 最新一项且 30 秒过期的异步 backlog、generation/run-token lifecycle ownership、完整 context budget 与一次 fresh-context 恢复、4096 项 session dedupe/噪声抑制、assistant `message_end` 工具执行前 quarantine，以及 transient 三次上限、quota/permanent/auth/no-model 明确暂停 | 29 项 Extension 测试、独立 Extension typecheck、453 项 core tests、Package dry-run 与隔离真实 Pi RPC 双轮 smoke 通过；两轮 Advisor 均 running→idle，只交付首条同 note advisory，第二条被 dedupe，0 Extension error。Pi 0.80.10 无 turn-end 阻塞 gate，因此本阶段只承诺可证明的异步 bounded catch-up，不伪造同步 `syncBacklog` |
| S18-5 可观测性与发布 | `Pending`（debug usage telemetry 已局部接通） | `usage:true` 与 prompt-free realtime review usage event 已供项目级调试扩展消费；GUI status/usage/cost/context、dump、独立 transcript、可选 Advisor subagents 与 AppImage 验证仍待完成 | 只有真实能力可见；脱敏发布证据覆盖总开关、多个 Advisor、故障和恢复 |

进入 S18-1 的前置条件（已满足）：

- S17 已完成，拓展页“已适配拓展”与独立功能设置页模式已经存在。
- OMP 参考基线和现有 Pi 单 Advisor 移植已经完成只读调查。
- [`D-034`](decisions.md#d-034--多-advisor-采用固定-pi-extension-与-gui-特别适配)
  已接受 Extension ownership、两层 GUI 入口和 typed projection 边界。

S18 总体验收：

1. Package 安装、Extension resource、Advisor system 和单 Advisor 四种状态可区分，均来自真实事实源。
2. 至少两个 Advisor 使用独立模型上下文并审阅同一主 turn；其 advisory 不互相递归，也不伪装成 Assistant 回答。
3. `WATCHDOG.yml` 的用户级与 Project 级发现、覆盖、校验和 GUI round-trip 与冻结 schema 一致。
4. `nit`、`concern`、`blocker` 的 delivery 与主 Agent settled 边界一致，异常或 quota 状态明确。
5. 历史与实时 advisory 使用同一 Kernel projector，并保持 Session identity、turn group、增量 patch 和最近 60 轮挂载边界。
6. Renderer 不读取 YAML、raw Pi event、Advisor transcript 或 credential；Electron Main 不运行 Advisor 模型。
7. Extension 关闭后新建或 reload 的 Runtime 不加载 Advisor 代码；任何设置变化都不静默重启已有 Session。
8. 定向 core tests、typecheck、生产 build、真实 Pi smoke 和 AppImage 多 Advisor 脱敏链路通过。

明确不做：

- 不接入 OMP executable/backend，不在 Electron Main 内实现第二套 Agent Runtime。
- 不建立通用 adapter registry、raw Extension RPC、第二个 Conversation/usage 数据库或自动权限审批。
- 不在第一条发布链路开放有副作用工具；扩大工具范围必须独立审计和决策。

#### S19 — Subagent 任务详情侧栏

当前边界：

- Source slice 已加入 Workbench 第三列详情容器、窄窗口工作区降级、稳定 participant locator 与焦点协议；原行内完整 disclosure 已移除，整体运行状态仍留在 Timeline 同行。
- Review 修复后，设置 dirty surface、Subagent detail 与 Composer abort 形成明确 Escape 优先级；关闭/返回/Escape 从当前 main-chat DOM 按 `toolCallId + participant.index` 重新定位最新胶囊后恢复焦点。
- Tool output 只有真实增长才走 `append-tool-output`，metadata-only 与 terminal 固定输出更新回退完整 state；patch 携带并校验 `toolCallId`，旧 duplicate suffix 不再覆盖新 metadata。
- 实现只消费现有 `KernelSubagentRun` / `KernelSubagentParticipant` 与受约束的 `append-tool-output` patch；没有新增 IPC、持久化 schema、child transcript/artifact 读取、任务数据库或运行控制。
- Timeline 不再渲染普通 Subagent completion notice 的结果预览，只显示轻量可点击的完成任务胶囊；任务处理内容与最终输出在同一详情面阅读。控制、转向、supervisor 协作和 Watchdog 通知继续保留。结构化 request 使用稳定 identity，同一 run participant 的具体 request 替代泛化 attention，成功 reply 原地标记已处理；内部协作不默认使用用户 alert，只有 completion guard 与 Watchdog blocker 使用 alert。
- 隔离候选 AppImage `source_snapshot` 曾提前验证 3 路并行 worker、运行态 capsule、live→completed、宽/窄窗口、三种焦点恢复与 reduced-motion；该历史证据位于 `release/evidence/2026-07-26T21-31-42-278Z-s19-source-snapshot/`，不作为正式发布结论。
- Canonical clean commit `b9562b4` 的正式 `pnpm verify:linux` 已通过 18 个步骤。S19 摘要确认三名 worker 同时 running、Escape 不 abort、live→completed identity 保持、宽屏第三列、1100px 窄屏替换、关闭/返回/Escape 焦点恢复和 reduced-motion 全部通过；报告与九张脱敏截图位于 `release/evidence/2026-07-27T16-45-59-798Z-b9562b4ca6c3/`，AppImage SHA-256 为 `4bbe45a505f601966c75ba8c3b4074f793ee88a7aff88e83bf00af03f039c29d`。
- 正式 gate 同时捕获并修复 active crashed Context 显式恢复未替换 Runtime、managed Session 激活未持久化 active pointer，以及 live Subagent custom message start/end 产生重复 completion notice 三项产品缺陷；旧 DOM/contract locator 也在唯一官方 verifier 中同步收敛。

实现范围：

1. Workbench composition 拥有当前选中 Subagent participant 与详情栏开关；Project、Session 或 Conversation identity 变化时关闭旧详情。
2. 宽窗口使用占据真实布局空间的第三列详情栏，不覆盖 Timeline 或 Composer；窄窗口改为同一工作区内的完整详情面，并提供明确返回入口。
3. 点击不同胶囊原地切换详情目标。面板标题显示任务摘要，正文显示 Agent、状态、当前活动、轮次、工具数、token、耗时、错误与最终输出 Markdown。
4. 关闭按钮、Escape、返回操作和 Session 切换都恢复到合理焦点；当前胶囊具有可辨识的 selected/focus-visible 状态。
5. 只消费现有归一化 Subagent 运行摘要。child transcript、artifact、子 Session 浏览、运行控制、可调整宽度、面板标签系统和通用 inspector registry 不进入首版。

完成门槛：

- 三项及以上并行 Subagent 可从胶囊分别打开、切换、关闭详情，运行中 patch 与完成状态不丢失当前选择。
- 宽窗口、窄窗口、键盘、Escape、Project/Session 切换和 reduced-motion 路径通过定向复核。
- typecheck、生产 build、diff check 与相关 Renderer 定向测试通过。
- canonical clean commit/worktree 的正式 `pnpm verify:linux` 产出脱敏 AppImage 报告与截图；临时 source snapshot 只用于提前发现真实交互问题。

#### P2.1 — Experience Refinement

P2.1 在现有工作台能力基本完整后，集中处理动效/交互稳定、Subagent详情和 Runtime内存治理。2026-07-30 的 P2正式 Gate已覆盖 S19、S20-1/S20-2 与 S26完成范围；P2.1 的其余设想转为非阻塞 backlog，不再维持一条必须全部实施的阶段流水线。

收口状态：

1. S19、S20-1、S20-2 与 S26 已完成并进入同一 canonical AppImage回归链路。
2. S26 的自动回收继续严格保护 busy、provisional、前台与 quiescence未知 Runtime；用户主动休眠入口保持删除。
3. S20-3、S21、S22、S23 与 S24 只在对应产品范围或真实缺陷出现时恢复；Settings/Package/Extension相关事项优先在 P3 capability范围重新核对，不自动沿用旧顺序。
4. S25 保持 Research；没有稳定结构化协议前不建立 Magic Context仪表盘。
5. S18-5 保持 Pending；Advisor专属 dump、独立 transcript与发布验收不阻塞 P2/P3。

##### S20 — 动效与交互基础

| 阶段 | 状态 | 范围 | 完成门槛 |
| --- | --- | --- | --- |
| S20-1 Motion Contract | `Complete` | feedback/reveal 继续使用既有 duration/easing token，持续 activity 保留 feature-local 周期；Workbench 列宽与 Todo 托盘 measured clearance 不再插值 intrinsic grid geometry，状态动画在 OS reduced-motion 下显式静止且保留文字、ARIA、形状或颜色语义；未加入 S22 motionPreference | 新增 5 项静态 contract tests；clean `600d186` + S20 patch 隔离 worktree 的 typecheck、生产 build、446 项 core tests 与 diff check 通过。合成 browser preview 验证浅/深根 token、侧栏切换 1084→1416px 一次提交且 240ms 后不漂移，以及 loading/Todo/thinking/Project/Session 五类 activity 的 computed animation 全为 none |
| S20-2 Timeline & Composer Stability | `Complete` | 明确 `following` 与 `reading` 两种用户意图；任何有效上滚立即进入 reading，只有用户回到 canonical output-end 才恢复 following；entries、streaming、Composer clearance、窗口/sidebar/detail reflow 共用同步稳定器，reading 以 caret/turn anchor 抵消布局变化，following 只对齐 output sentinel 而不滚入 navigation tail；窄屏 0×0 隐藏期间不测量，Workbench layout effect 在 focus rAF 前恢复 | commit `22cf15c` 的 clean isolated candidate 通过 typecheck、生产 build、457 项 core、11 项 contract tests 与 diff check；Electron preview 实测 30px 上滚退出 following，宽/窄 detail 与隐藏期间上方新增 180px 后 reading caret 均保持 122.98px，Composer/streaming 后 output-end 误差 0.48px 且保留 447px tail；独立 review 无 blocker/high，chrome offset 与 stale programmatic marker 已修复 |
| S20-3 Interaction Consistency | `Pending` | 统一最内层 popover → 局部 editor/detail → workspace 的 Escape 层级，以及外点、返回、focus restoration、disabled 和触摸语义；窄窗口任务详情允许在同一 run participant 间切换 | Keyboard、pointer、touch、dirty draft、Project hover/action 互斥和异步双提交场景通过定向测试；不抽象无证据的万能 menu/popover |

S20 明确不以“更多动画”为目标，不让位移或 pulse 成为 running/error 的唯一表达，也不通过延时猜测 DOM 已稳定。

##### S21 — Settings Workspace 2.0

| 阶段 | 状态 | 范围 | 完成门槛 |
| --- | --- | --- | --- |
| S21-1 Information Architecture | `Pending` | 导航分为“应用：常规/外观/快捷键”“模型：模型/凭证”“Agent：Subagent/Advisor/Context”“生态：Package/拓展/技能”；自动对话命名并入常规，删除单项偏好分类；导航可收起 | 既有功能和 dirty draft 保护无回退；窄窗口使用可访问的单页/覆盖式导航；Context 只有在 S24 有真实内容时出现 |
| S21-2 Search & Deep Link | `Pending` | 扩展窄 typed section/group metadata，索引真实设置名称、组和人工同义词；搜索结果跳到稳定应用内目标 | 不索引 credential、endpoint、Agent prompt 或日志；Enter/Escape、焦点恢复和无结果状态通过；不注册 OS URL protocol，不建立插件 registry |
| S21-3 Scope, Source & Activation | `Pending` | 为重要设置表达 application/user/project/session 作用域、GUI/Pi/Extension 事实来源与 immediate/next-session/reload 生效时机；区分 saved config 与当前 Runtime loaded config | Package installed、Extension enabled、当前 Session loaded、健康 verified 四层状态不混淆；设置保存不静默重启，reload 失败不伪装已应用 |

设置行不机械堆叠三个 badge；默认立即生效项保持简洁，只在特殊作用域、外部事实源或需 reload 时提高可见性。`settings-redesign-preview.html` 只作为交互参考，模拟状态和未接通选项不是生产事实。

##### S22 — Personalization v1

第一批只接入三个用户级设置：

1. `conversationWidth: compact | standard | wide`：通过语义化 Conversation max-width 调整阅读宽度；窄窗口自动服从可用空间，Composer 与 Timeline 保持同一左右边界。
2. `navigatorDensity: comfortable | compact`：只调整 Project/Session 行高、组间距和辅助信息密度；普通历史默认 5 个、每次继续展开 5 个及分页外保留项规则不变，触控/键盘命中仍满足最小尺寸。
3. `motionPreference: system | reduced | minimal`：`system` 遵循 OS；`reduced/minimal` 只能进一步减少动效，不能覆盖 OS reduced-motion 强制恢复完整动画。

配置使用有限枚举、明确 migration 和首帧尽早应用；非法值回退默认。第一批不增加任意像素宽度、CSS、颜色、圆角或间距编辑，代码字号比例、默认 Sidebar 状态、代码换行和详情宽度留待真实使用反馈后另行规划。

##### S23 — Subagent Effective State 与任务一致性

实施顺序：

1. Main 归一化 effective Agent definition：最终来源、builtin/user/project 各层存在性、控制 enabled 的作用域、shadowed override、effective model/thinking/context/tools/skills、全局与单 Agent depth 结果。
2. 同一 typed projection 同时报告 Package 安装、Extension resource、当前 Runtime 是否发现该 Agent，以及是否等待 reload；Renderer 不解析 Markdown frontmatter、settings JSON 或 Agent 名称。
3. 任务详情显示 single/parallel/chain mode、participant 总量和 pending/running/completed/failed 汇总；窄窗口可直接切换同一 run 的 participant。若现有数据不能表达 chain DAG，则只展示真实 participant 列表，不绘制推测工作流。
4. 验证实时运行 → completion → settled → Session 切换 → reload → 历史读取的 identity 一致；缺少 child transcript/artifact 时明确只保存了概要和最终输出。

stop/interrupt/resume/steer/supervisor reply 先保持 Research：只有 `pi-subagents` 提供稳定 typed capability，且 run/participant/request identity 与主 Agent 协调所有权明确后，才另行决定 GUI 控制；不得拼接 slash、Shell 或文本命令绕过父 Agent。

##### S24 — Magic Context 状态可见性

状态模型必须分离：

- Package：missing / installed。
- Extension：disabled / enabled。
- Session：unavailable / not-loaded / loaded。
- Status：unknown / fresh / stale / warning / error。

事实来源分别为 Pi Package service、resource filter、真实 command catalog/capability 和受约束的 `/ctx-status` custom entry。状态绑定 Project、Session、Runtime identity、来源与接收时间；Runtime reload 后旧状态立即失效。没有结构化 setup/doctor 证据时，健康始终为 unknown。

Context 页包含安装与加载摘要、最近一次真实状态、更新时间/过期语义、刷新入口，以及复制官方 setup/doctor 命令和打开上游文档。安装与启停仍只在拓展页操作；Conversation 内最多显示轻量“Context managed”状态入口，info 状态不持续占据 Timeline，warning/error 继续允许进入 Timeline。GUI 不执行任意 Shell、不编辑 `magic-context.jsonc`、不解析 SQLite，也不从 Pi 原生 compaction 推断 Magic Context 后台状态。

##### S25 — Magic Context 结构化可观测协议

S25 保持 `Research`，需要与 Magic Context 上游共同冻结版本化 capability/status/usage 协议后才能实施。候选只包含有界、脱敏的运行状态、上下文占用、是否接管原生压缩、最近后台操作、pending operation 和 historian/dreamer/sidekick/cache 的 prompt-free token/cost。协议不得携带 prompt、output、memory 内容、embedding、credential、数据库路径或私有 schema；项目级 debug telemetry 在成为公开稳定协议前不得冒充用户产品状态。

##### S26 — Memory Budget & Automatic Runtime Hibernation

详细测量、证据分级、产品对照、首轮预算和诊断安全边界见 [`memory-diagnostics.md`](memory-diagnostics.md)。

首轮 `verified_current` 现场事实：

- 同一次约 1 小时 52 分运行中，Renderer 达到约 5.4 GiB RSS，其中约 4.98 GiB 为 Chromium private anonymous `PartitionAlloc`；当时活动 Session JSONL 约 400 KiB，最大历史 Session 约 8 MiB，不能解释该增长。
- 重启后的运行中，完整 `KernelState` 序列化约 936 KiB、Conversation 约 840 KiB / 155 entries、DOM 约 520 节点、Renderer JS heap 约 58 MiB，但 Renderer working set 仍约 755 MiB；主要差额属于 native allocation，而非普通 DOM 或 V8 heap。
- 首轮故障时 Workbench Kernel 为每个 managed Session 保留完整 `RuntimeContext.state` 且没有 idle eviction；重启不足一分钟即可因并行恢复/工作重新出现 6 个顶层 Pi Runtime。当前源码已加入严格 quiescence lease、五分钟 grace 和一个后台 warm Runtime 的自动回收。
- 首轮故障时 Main 对大量 mutating command 同时发布 `kernel.state-changed/patched` 并在 invoke 返回值再次传输完整 `KernelState`，且只在 Renderer `requestAnimationFrame` 内合并。当前源码已改为窄 revision ack、identity-safe metadata patch，并以 8ms/64 项 Main state envelope 在 structured clone 前合并连续更新。
- 同一诊断 AppImage 已重复通过现有 18 步 gate，第二轮绑定 clean commit `981282e`：80 秒三路 Subagent 场景稳定产生 305–317 个完整 state 与 31–33 个 patch，而新增正文/工具 payload 仅为数 KiB；真实工作 Session 的约 936 KiB state 按同频率会形成约 286–297 MiB/80 秒的单向 Renderer payload，尚未计 Main copy、structured clone 和 invoke-return 副本。

完成状态（2026-07-30）：用户主动休眠产品面保持删除。Main/Kernel 使用严格 quiescence prepare→commit→stop lease、五分钟 grace、最近一个后台 warm Runtime 与保守自动回收；busy、前台、provisional、pending ask/queue、compaction 和未知 quiescence 均 fail-closed。Mutating IPC 使用 revision ack，高频 metadata 与 stderr diagnostic 使用窄 patch，连续 state event 在 Main 发送前按 8ms/64 项有界合并。

P2 完成 Gate 已在唯一 `scripts/verify-linux-release.mjs` 中通过：

1. 同一真实 AppImage覆盖单 Runtime、tool、abort、crash/recovery、两个 Project、三个物化 Session Runtime、三路 Subagent 与宽/窄详情交互。
2. memory diagnostics 执行固定红线：总 PSS ≤ 4 GiB、Renderer PSS ≤ 512 MiB、Renderer heap ≤ 128 MiB、完整 state ≤ 2 MiB、swap = 0、工作完成后总 PSS ≤ busy 峰值的 80%。
3. 三个物化 Runtime 经真实五分钟 grace 和 sweep 自动降到两个；重新选择已休眠 Project、点击现有“恢复对话”后恢复到三个，原 user/assistant 对话仍在。
4. 正式观测值为峰值总 PSS 2,687,216,640 bytes、Renderer PSS 164,363,264 bytes、heap 27,195,464 bytes、state 100,568 bytes、swap 0；busy 后 settled PSS 1,662,782,464 bytes，休眠后 1,304,407,040 bytes，恢复后 1,575,842,816 bytes。
5. 自动回收候选保护由 core tests 覆盖 busy、foreground、provisional、pending ask/queue、compaction、lease 与 unknown-quiescence fail-closed；正式 UI Gate不通过人为缩短 grace或伪造 Kernel时钟。

为遵守 KISS/YAGNI，下列压力扩展不再作为 P2 完成前置，也不冒充已验证：连续浏览 20 个 Session、三个父 Runtime同时 busy、内存压力触发、旧 Timeline分页/驱逐和 30 分钟 settled slope。只有后续出现真实预算回归，或对应产品面进入实施时，才恢复这些专项；不得为假设性规模继续扩大当前 Runtime协议。

P2.1 共通验收：

- 深色与浅色主题；1440px、约 1000px 和 700px 以下窗口。
- 鼠标、键盘、Escape、焦点恢复、触摸语义和 reduced-motion。
- 长 Timeline 的底部跟随与历史阅读锚点。
- 当前 Session、后台 Session、reload 和历史恢复。
- 每个 source Slice 至少通过定向测试、`pnpm typecheck`、生产 build 与 `git diff --check`；涉及 Runtime、Extension 或跨进程 contract 时再补 `pnpm test:core`、真实 Pi smoke，并在候选发布点运行 `pnpm verify:linux`。

#### S14 — 优化记录

本节只记录实际使用中发现的问题和待讨论方向，不预先固定实现方案或处理顺序。

| 编号 | 类型 | 记录 | 状态 |
| --- | --- | --- | --- |
| S14-01 | 交互缺陷 | 当前已识别的模型选择器与 slash command 菜单支持点击外部收起；内容型 disclosure 不改变 | 已完成（首批） |
| S14-02 | 设置界面 | 新建独立设置界面，以左侧栏导航各设置分类；删除常驻的无用介绍，必要说明移入对应控件 tooltip；拓展页展示 Extension 本体，不以命令目录代替 | 已完成（首期） |
| S14-03 | Session 切换 | Session 单击无感切换：立即显示目标历史，并后台激活/启动该 Session 的 Runtime；不暴露特殊查看模式，也不再要求先点“启动 Pi”或等到首次发送 | 已完成 |
| S14-04 | 导航排序 | Project 与当前 Project 下的 Session 支持拖拽排序；严格校验全排列并持久化，活动身份和 Runtime ownership 不变 | Project 部分保留；Session 部分由 S14-42 替代 |
| S14-05 | 运行中输入 | 当前任务执行时 Composer 不应锁定；接入 Pi 0.80.10 原生 `steer` / `follow_up` 与 `queue_update`，运行中支持 Enter 转向、Alt+Enter 跟进，并保留显式中止 | 已完成 |
| S14-06 | 对话归档 | Session 行右侧在悬浮或键盘聚焦时显示归档入口；归档只在 XDG 索引标记并从普通列表隐藏，不删除 Pi session 文件；活动 Session 先受控停止 Runtime 再清空投影 | 已完成 |
| S14-07 | 拓展管理 | 设置页直接展示 Pi 用户设置 `extensions` 中的 Extension 路径；可选择 `.ts` / `.js` 文件或目录写入配置，并从配置中卸载，源码文件始终保留；权限和生效时机仅放在 tooltip，不接入 Package、npm、Git、命令目录或内嵌市场 | 已完成 |
| S14-08 | 组件样式 | 将偏好设置中的原生下拉替换为共享 `Select` 组件；展开面板复用 Workbench popover、hover、focus 与文字 token，并支持分组、禁用项、外点收起和键盘选择 | 已完成 |
| S14-09 | 运行中输入语义 | Pi 运行时普通输入默认作为 `follow_up`，`steer` 只通过 Alt+Enter 特别提交；右侧不再并列展示 Follow up / Steer 按钮，保留显式中止 | 已完成 |
| S14-10 | 运行中队列可见性 | 保留 Pi `queue_update` 的 steering / followUp 正文并显示在 Composer 上方，但界面只展示排队内容、不展示类型；两类原生处理时序保持不变；面板限高滚动且参与 Composer clearance | 已完成 |
| S14-11 | 工具过程密度 | 工具过程提供紧凑汇总、标准步骤和详细卡片三档；默认标准档弱化徽标、时间线和详情容器，偏好仅保存在 Renderer 本机；thinking 展示与 Kernel/RPC contract 不变 | 已完成 |
| S14-12 | 导航拖拽命中 | Project / Session 排序只在主行按下后临时启用拖拽，松开或取消后立即关闭；Session 归档按钮不触发拖拽，并固定在时间文字之上独占指针命中；长期约束见 [`p2-workbench-structure.md`](p2-workbench-structure.md#311-导航行命中与拖拽要求) 3.1.1 | Project 部分保留；Session 拖拽由 S14-42 移除 |
| S14-13 | 队列管理适配 | 后续支持排队内容拖拽排序、follow-up 转 steer、单条删除及对应移动/移除动效；Pi 0.80.10 RPC 当前没有删除、重排、转换或替换队列命令，等待评估上游 typed RPC 与能力探测方案 | 已延期（缺少上游 typed RPC，不阻塞 S14 收口） |
| S14-14 | 对话导航感知 | Session 点击当帧先切换 Renderer 视图，再异步读取历史；旧响应使用请求序号丢弃。新建对话先进入空白工作区并允许输入，再后台启动 Runtime；首次提交复用同一启动任务。失败保留目标页并显式展示错误 | 已完成 |
| S14-15 | 对话过程层级 | 完成态工作过程默认收起为“已处理 + 可观测真实耗时”的极简 disclosure，移除卡片、状态点和统计串；展开后 thinking 使用独立“思考了 + 可观测耗时”折叠与低强调正文，工具继续保持原始时序和三档密度，最终回答始终位于过程之外；历史无可靠耗时时不伪造 | 已完成 |
| S14-16 | 外观设置布局 | 外观页按主题、Agent 对话、字体分组；组内使用连续设置行与右侧紧凑控件，窄窗口改为上下布局；只重排已有主题状态、工具密度和字体设置，不增加未接通的外观能力 | 已完成 |
| S14-17 | 冷启动对话 | 已有活动 Project 时冷启动直接进入空白新对话并后台启动 Runtime，不再默认选中最近 Session 或要求选择恢复；历史 Session 在侧栏点击时无感启动，Project 切换与崩溃恢复语义不变 | 已完成 |
| S14-18 | 主题与密度说明 | 外观主题提供跟随系统、深色、浅色三项共享下拉；跟随系统监听系统明暗变化，浅色使用完整 token 覆盖，选择经 Kernel 与 XDG config 持久化；核查工具密度三档真实分支，并在滑杆下用极简图示展示聚合摘要、逐条操作与展开详情的差异 | 已完成 |
| S14-19 | pi.dev 拓展目录 | 拓展页接入 pi.dev 的 Extension 类型筛选目录、搜索、详情和对应 Package 安装状态；保留 50 项结果并使用最多约 3 行高的滚动列表，品牌头使用完整的单一 `pi.dev` SVG；安装与卸载明确作用于承载 Extension 的整个 Package，并严格调用固定 Pi 版本的用户级 `pi install/remove npm:<name> --no-approve`；本地路径 Extension 入口继续独立保留 | 已完成 |
| S14-20 | 新建技能 | 技能页增加新建入口，收集合法技能名称、用途和用户级/当前项目范围后，将受约束的创建请求发送给当前 Pi 会话；Pi 必须先检查目标、展示完整拟写内容并等待用户确认，不新增旁路文件写入 API | 已完成 |
| S14-21 | Package 分类 | 设置导航新增独立 Package 页面并展示不带资源类型过滤的完整 pi.dev Package 目录；拓展页保留 Extension 类型筛选目录与直接维护 `settings.json.extensions` 的本地 `.ts` / `.js`、目录入口。Package 是安装与分发单位，Extension 是其中一种资源；npm 安装和卸载始终作用于整个 Package | 已完成 |
| S14-22 | Package 管理 | Package 页增加用户级已安装列表，展示 Pi 配置中的完整 source 与资源过滤状态；支持单项更新、全部更新和卸载，分别调用 Pi 0.80.10 原生 `update --extension`、`update --extensions` 和 `remove`，不实现第二套下载、依赖或配置引擎 | 已完成 |
| S14-23 | Pi 路径解析 | Electron 从桌面环境启动且 `PATH` 缺少用户目录时，除显式路径与 `PATH` 外继续检查 `~/.local/bin/pi`；仍执行固定版本校验，不硬编码具体用户名或绕过可执行权限检查 | 已完成 |
| S14-24 | 模型菜单布局 | 模型与思考强度菜单使用共享 viewport 定位并挂载到顶层浮层；按触发器右侧对齐，依据可用空间上下翻转、动态限宽限高并保留列表内部滚动；补齐打开聚焦、Escape 关闭和上下文切换收起 | 已完成 |
| S14-25 | 模型菜单结构 | 删除模型/思考强度左右分类栏；主菜单改为上方直接列出当前模型的全部可用思考强度、下方显示当前模型，点击模型行才展开紧凑模型列表 | 已完成 |
| S14-26 | 思考强度能力语义 | 按 Pi 0.80.10 的 `getSupportedThinkingLevels` 规则解释稀疏 `thinkingLevelMap`：基础档位缺失时仍可用、显式 `null` 才隐藏，`xhigh`/`max` 需显式声明；GUI contract 与 IPC 支持完整七档 | 已完成 |
| S14-27 | 模型子菜单方向 | 点击主菜单底部模型行后，以独立顶层浮层从右侧展开模型列表；右侧空间不足时才向左避让，主菜单高度保持不变，并保留外点收起、分层 Escape 与打开聚焦 | 已完成 |
| S14-28 | 强调色与透明度 | 外观页增加琥珀、蓝、绿、紫、玫红五种强调色和 0–40% 面板透明度；选择即时作用于统一 token，并经 Kernel 与 XDG config v7 持久化；旧 v4–v6 配置使用默认强调色与透明度迁移 | 已完成 |
| S14-30 | 模型设置真实性 | Provider 与 Model 选择行只保留选择本身；Provider 标准 `/models` 提供模型 ID 与 `owned_by`，GUI 再使用固定 Pi 0.80.10 对应的原生 Provider 定义取得 Pi-compatible 的名称、上下文、最大输出和输入能力，并在 Runtime 建立前同步进 `models.json`；详情只展示一套实际模型参数，不再把 Codex-client 目录的 372K 与 Pi 生效值并列；凭据状态同时识别 Pi `auth.json` 与 Provider 内联 `apiKey` | 已完成 |
| S14-29 | 工作过程密度 | 将既有工具三级扩展为统一工作过程三级：紧凑档实时只保留一行轮换状态；标准档保留首段有效 thinking 并在下方轮换单行状态；详细档继续展示完整 thinking 与工具时序。三档完成后都收进“已处理”，完整记录始终可展开 | 已完成 |
| S14-31 | Thinking 摘要识别 | 纠正标准档按“第一段 thinking”保留正文的错误理解：从 Pi `thinkingSignature.summary` 投影显式摘要标记；摘要 thinking 只进入折叠过程，commentary 与非摘要 thinking 才保留在实时正文。活动状态只认最后一项真实运行内容，已完成摘要不再持续显示“正在思考”或自动展开 | 已完成 |
| S14-32 | 多对话并行恢复 | 将单一全局 Runtime ownership 改为按 Project/Session 隔离的 Runtime context；运行中的对话可留在后台并继续接收事件，用户可立即新建或切换其他对话。Session summary 展示各自运行状态；归档只停止目标 Runtime，应用退出收口全部 Runtime | 已完成 |
| S14-33 | 思考正文排版稳定 | commentary 与非摘要 thinking 在流式、完成和展开状态统一使用正文大小与行高；状态只通过动效、标题、颜色和最终折叠变化，不再因进入过程层而缩小并重新换行 | 已完成 |
| S14-34 | 状态动效 | Project 行按真实 Runtime context 汇总进行中的对话数量；Session 行以启动、处理、收尾三段生命周期轨迹替代无限转圈；thinking 使用独立短波形呼吸，并在减少动态效果偏好下静态展示。不伪造百分比、剩余时间或后端未提供的子阶段 | 已完成 |
| S14-35 | Session 圆形动效纠正 | Session 运行指示恢复常规圆形，不再使用三段轨迹；圆内使用渐变弧、前端光点和非匀速转动，starting/running/stopping 只调整节奏与强调度。Project 汇总和 thinking 动效保持不变 | 已完成 |
| S14-36 | 图片与文件输入 | Composer 支持系统多选、文件拖放和剪贴板图片/文件；普通文件按 Pi 交互式 TUI 的 `@路径` 语义引用，由 Agent 使用原生 `read` 按需分段读取，不把全文塞进首条 prompt；图片按 Pi 0.80.10 原生 `ImageContent` 进入 prompt、steer 与 follow-up；大图遵循 2000×2000 和 4.5 MiB 边界，历史投影只展示附件摘要 | 已完成 |
| S14-37 | 运行状态归属 | Session 行只显示自身 Runtime context 的 starting/running/stopping 状态；启动目标 Session 时不再把顶层 Runtime 状态误挂到上一个 Session，启动失败清理临时归属；Project 后台任务汇总语义不变 | 已完成 |
| S14-38 | 发送后交互锁定 | prompt、steer 与 follow-up 只等待各自 Pi RPC 响应，不再占用 Renderer 的全局导航互斥；Composer 派发后立即清空已提交草稿并保持可编辑，失败时仅在仍停留原对话且没有新草稿时恢复；其他 Project/Session 生命周期动作继续串行 | 已完成 |
| S14-39 | Session 时间与手动排序优先级 | Session 默认按 JSONL 最近活动时间倒序，最新活动在前、未知时间置后且同时间稳定；保留 Session 拖拽，首次拖拽后该 Project 的持久化手动顺序优先于时间排序，XDG session state v5 记录手动排序标记并从 v1–v4 安全迁移；Project 手动排序保持不变 | 已由 S14-42 替代 |
| S14-40 | 对话流时序与可读性 | 默认标准档保留 commentary / 非摘要 thinking 主阅读线，将摘要 thinking 与工具按原始顺序收进同一个轮换状态并支持展开；工具隐藏无价值的成功耗时，过程样式移除默认时间线节点和紧凑汇总卡片感，最终回答继续位于完成过程之外 | 已完成 |
| S14-41 | 职责边界审计 | 将跨 feature 装配的 Workbench 移回 Renderer composition 层；工作过程密度定义收敛为三个真实调用点共享的纯工具；单消费者 Runtime 状态判定回收到 Composer；同步区分多 Runtime 当前边界与 S8–S13 单 Runtime 历史证据，不拆分仍内聚的大文件或引入通用中间层 | 已完成 |
| S14-42 | Session 排序收口 | 删除无模式提示、无恢复入口的 Session 持久化手动顺序与拖拽入口；每个 Project 始终由 Kernel 按 `running` 优先、其余 `lastActivityAt` 倒序输出。XDG session state v6 删除手动排序标记，并从 v5 迁移时丢弃旧标记；Project 手动拖拽排序保持不变 | 已完成 |

#### S15 — TUI 日常能力补齐

目标：

- 补齐 GUI 日常替代 TUI 时仍然明显缺失、且已有真实产品价值的能力。
- 继续使用 Pi Session、RPC、配置和认证作为事实源；Renderer 不模拟 Pi 内部状态。
- 每项能力只实现已经逐项确认的最小 GUI 语义，不把 CLI、TUI 组件或后续生态平台整体搬入桌面端。

启动前置条件（已满足）：

- S14 已完成收口；S15 六个阶段均已完成。
- 对固定 Pi 0.80.10 重新验证公开能力面：RPC 的 `get_entries`、`fork`、`get_session_stats`、`get_state`、`get_messages` 与 `compaction_start` / `compaction_end`，包根导出的 `ModelRuntime`、`ProjectTrustStore`、`hasTrustRequiringProjectResources`，以及仅本次 trust 的 `--approve` / `--no-approve` 启动参数。
- S15 只使用包根公开导出、现有外部 Pi RPC 和明确 CLI 参数；不通过私有 deep import 取得 TUI 组件或内部 helper。公开能力缺失时对应入口保持不可用并明确报错，不复制 Pi 内部实现作为 fallback。
- 每个阶段必须完成本阶段的 typed contract、失败语义、定向验证和 diff 复核后再进入下一阶段；命令只有在对应执行链路真实可用后才进入 normalized catalog。

实施顺序：

| 阶段 | 状态 | 范围 | 明确边界 |
| --- | --- | --- | --- |
| S15-1 项目资源与 Runtime | `Complete` | 在首个 Runtime 启动前承载项目资源 trust 提示；持久决定只通过 Pi `ProjectTrustStore` 写入 `trust.json`，仅本次决定只进入目标 Runtime 的 `--approve` / `--no-approve` 参数。实现当前 settled Session 的 typed reload，并在成功后重新获取 `get_state`、`get_messages`、`get_commands` 和 `get_available_models` | 首期只提供“持久信任当前 Project”“持久不信任当前 Project”“仅本次信任”“仅本次不信任”四项；识别继承的父目录决定但不提供写入父目录的快捷项。trust 不是工具权限，不建立 GUI trust schema 或常驻徽标；`/reload` 只在完整执行链路落地后进入 catalog，不监听资源文件或静默 reload |
| S15-2 Session 操作 | `Complete` | 从 Pi `get_entries` 的真实 entry ID 与 leaf 计算当前活动路径，只给其中 settled、无 `ImageContent` 的用户消息提供 Fork；成功后将原消息文本回填 Composer。Fork 在同一 Pi 进程切换 Session 后，Kernel 必须校验新 `sessionFile` / `sessionId`、持久化新指针并原子迁移 Runtime context。归档后由 Main 建立约 5 秒的内存撤销凭据，并提供撤销与保持归档的临时只读查看 | 不按消息正文或历史下标猜 ID，不使用返回全部历史用户消息的列表代替活动路径；原 Session 指针和文件保持不变，新 Session 不继承 GUI 归档或排序私有状态。带图片消息首期不显示 Fork；不实现 Clone、完整 `/tree` UI、同文件 leaf 切换、branch summary、归档中心、永久删除或批量管理。撤销不自动重启 Runtime；临时预览不启动 Runtime，离开、超时或重启后不可再次进入 |
| S15-3 阅读、导出与统计 | `Complete` | Main 从当前活动分支的 Pi 消息事实生成离线 HTML；只保留用户消息、Assistant 最终回答、Markdown、代码块和 Pi `ImageContent`。逐条复制 Assistant 最终回答的原始 Markdown。Session 行 tooltip 显示可用的文件路径、ID、消息数、Token 和累计成本；上下文 tooltip 增加 Pi 记录费用 | 导出复用现有 CommonMark/GFM 安全语义，禁用 raw HTML、脚本和远程资源，写入严格 CSP；Pi 图片以内联 data URL 保存，远程 Markdown 图片只保留安全链接或占位。导出不含其他分支、JSONL、thinking/commentary、工具参数/输出/diff、system prompt、工具定义、完整项目路径、费用统计或隐藏 JSON。统计口径固定为 Pi Session 全生命周期，包含已压缩和废弃分支；不为 tooltip 启动 Runtime，不持久化第二份统计事实 |
| S15-4 Composer 与命令 | `Complete` | Composer 输入 `@` 时经 Main 的窄 typed 查询模糊搜索当前 canonical Project 的文件和目录；排除 `.git`，遵守 `.gitignore` 与 `.ignore`，不遍历越出 Project 的目录 symlink，单次最多返回 100 项并丢弃过期响应。选择后复用现有路径引用转义，只插入相对 `@path` 或 `@"path with spaces"`。内建目录增加 typed `/fork`、`/export`、`/copy`；`/reload` 复用 S15-1 已完成链路 | `/fork` 无参数时打开当前活动路径的可 Fork 消息选择；`/export` 无参数时始终打开系统保存对话框；`/copy` 无参数时复制最后一条 Assistant 最终回答。Slash 文本不传给 Pi；不增加普通路径 Tab 补全、`!`/`!!` Shell 输入或外部编辑器。Renderer 不获得任意路径读取能力，搜索与选择前后均不读取普通文件正文 |
| S15-5 凭证 | `Complete` | 设置新增独立“凭证”页：按 Provider 与 SDK 实际声明的认证类型展示 OAuth/API Key 状态，并由已验证 Pi 安装的包根 `ModelRuntime` 驱动 login/logout；不支持的认证动作不显示。现有自定义 Provider/Model 配置迁入同页独立分区。认证变化后刷新凭证与模型目录，并只把使用对应 Provider 的 Session 标记为需要用户显式 reload | OAuth 是 Provider 的认证方式，不是独立 Provider；已有 token、refresh token 和 API Key 绝不回读 Renderer。用户本次主动键入的 API Key 可在受控输入中瞬时经过 Renderer 和窄 typed IPC，但不得进入 Kernel state、事件、日志、错误或 GUI config。认证变化不静默切换模型、不中断正在生成的回复、不重启 Session；不把 Pi/Provider SDK 打进产物，不使用私有 deep import 或直接修改 `auth.json` |
| S15-6 桌面效率与生命周期 | `Complete` | 设置新增 GUI 原生快捷键页，支持有限应用级动作、冲突检测、清除和恢复默认值；自动压缩开始时显示“正在整理上下文”，结束后刷新 Conversation 与使用量，失败或取消给出提示 | 文本编辑、输入法、Tab、Enter/Shift+Enter、Escape、复制粘贴等基础按键不可重映射；不兼容 TUI `keybindings.json`；压缩继续使用 Pi 默认模型、提示词和参数，不增加高保真压缩、独立压缩模型、二次审查或测评工具 |

快捷键只在 Pi GUI 窗口聚焦时生效，不注册系统级 `globalShortcut`。首期固定默认表如下；“未绑定”仍可由用户配置：

| 动作 | 默认组合 |
| --- | --- |
| 新建对话 | `Ctrl+N` |
| 聚焦 Composer | `Ctrl+L` |
| 打开设置 | `Ctrl+,` |
| 打开模型选择器 | 未绑定 |
| reload 当前 Session | 未绑定 |
| 上一个 / 下一个 Project | 未绑定 |
| 上一个 / 下一个 Session | `Ctrl+PageUp` / `Ctrl+PageDown` |
| 归档当前 Session | 未绑定 |
| 复制最后一条 Assistant 最终回答 | 未绑定 |

菜单、模态弹窗、认证交互、组合输入和输入法 composing 状态优先于应用快捷键；文本输入获得焦点时只允许不改变编辑语义的已确认组合。冲突检测同时覆盖默认值、用户绑定和 Electron/系统保留组合；破坏性归档始终默认不绑定。

验收：

1. Trust 检测只使用 Pi 公开资源检测与 `ProjectTrustStore`；已有当前或父目录决定时不重复提示。取消不启动 Runtime，修改决定不静默重启已有 Runtime；持久与仅本次四种当前 Project 动作分别通过隔离验证。
2. Reload 只接受当前持久化、settled、`ready` Session，保持同一 Project、Session、旧 Conversation 和 Composer 草稿，只停止并重启目标 Runtime；新投影全部读取成功后才替换旧投影。失败保留可恢复 Session，并明确进入 error/crashed 状态；其他后台 Runtime 不受影响。
3. Fork 只接受当前活动路径中的真实用户 entry ID；无图片消息的原文与 `@` 引用可回填 Composer。Pi 切换、新文件 canonical 校验、`sessionId` 核对、XDG 指针持久化和 Runtime context 迁移全部成功后才发布新 Session；任一步失败不得产生 ghost Session，也不得把旧 Conversation 标成新目标。
4. 归档撤销凭据由 Main 绑定目标 Session 与单调截止时间，多次归档各自独立；过期、重复或不匹配的撤销 Fail Fast。撤销只恢复导航索引而不启动 Runtime；临时只读查看始终保持 archived，提示过期、离开预览和应用重启都会失效。
5. HTML 导出与复制结果符合精简内容边界；导出文件没有脚本、远程请求、隐藏元数据或完整项目路径，图片离线可读，写入只发生在用户本次通过系统对话框选择的路径。复制只取得目标最终回答的原始 Markdown，不复制渲染 HTML。
6. Session 统计与 Pi `get_session_stats` 对同一 fixture 的全生命周期消息数、Token 和成本一致；有 Runtime 的 Session 使用 RPC，stopped Session 可由 Main 对固定 0.80.10 Session entries 只读聚合但不得为 tooltip 启动 Pi。未知字段明确省略，tooltip 可由 hover 和键盘 focus 触发并在窄窗口内避让。
7. `@` 搜索只遍历当前 canonical Project，遵守固定忽略与 symlink 边界并排除 `.git`；过期请求不能覆盖新结果，带空格路径按既有引用语义转义，选择、发送和历史投影均不读取普通文件正文。菜单具备 combobox/listbox 的 ARIA、键盘、Escape、焦点恢复、portal 和窄窗口语义。
8. 只展示 `ModelRuntime` 实际声明且 GUI 已实现完整交互的认证动作；每一种已展示的 login/logout 路径都有定向验证，且至少一条真实公开认证流程使用专用 QA/provider 账户完成闭环。已有凭据绝不回读；用户本次输入也不得出现在 state、事件、日志、错误或报告中。
9. 认证变化只刷新凭证与模型目录，并按 Provider 标记受影响 Session；正在生成的回复继续完成，不静默切换模型或重启 Runtime。显式 reload 成功后才清除对应 Session 标记。
10. 快捷键冲突不能保存；菜单、弹窗、认证交互、输入法和文本编辑优先于应用快捷键。清除和恢复上述固定默认表经 XDG config 持久化，重启后保持一致；未绑定动作不产生隐藏快捷键。
11. `compaction_start` / `compaction_end` 成为独立 normalized lifecycle：`reason` 区分 manual、threshold、overflow；`willRetry=true` 的中间失败不显示终态错误。压缩不产生伪 `agent_settled`；成功后原子刷新 Timeline、上下文占用和累计统计，失败或取消保留压缩前投影。
12. 定向 core tests、`pnpm typecheck`、生产 build、真实 Pi 0.80.10 smoke 和最终 AppImage 核心链路通过。所有 trust、credential、Session 和导出验证使用临时 Project、隔离 XDG 与隔离 `PI_CODING_AGENT_DIR`；真实认证只使用明确选择的 QA/provider 账户，不接触默认用户 `auth.json` / `trust.json`。发布报告继续脱敏，不记录 prompt、工具输出、导出正文、设备码或 credential。

明确延后或不做：

- 完整 `/tree`、Clone、branch summary、带 `ImageContent` 的历史消息 Fork 回填、归档中心、永久删除、JSONL 导入/导出和外部分享。
- 普通路径补全、Shell 快捷输入、外部编辑器、scoped models、模型循环和任意工具 allowlist/exclude。
- 队列取回、删除、编辑、转换和排序继续等待 Pi typed queue mutation RPC，不在 Renderer 伪实现。
- Skill、Prompt Template、Package 逐资源管理和 Extension UI 继续由 P3 或专门 Slice 规划；纯净模式不加载第三方 Extension，增强模式的官方 Extension UI RPC 适配不进入 S15。
- Trust 父目录写入快捷项、常驻 trust 状态、文件/工具权限管理和私有 TUI trust selector 不进入 S15；已有父目录决定仍按 Pi `ProjectTrustStore` 继承。
- CLI/headless、print/json、管道输入、无持久化 Session、自定义 Session 目录和启动参数表单不是 GUI 产品目标。
- 高保真压缩与压缩测评后续单独优化；S15 只完成 Pi 默认压缩的状态和投影适配。

#### S12.5 — 重复职责解耦

判断规则：

- 完全相同或同一领域语义的逻辑已在三个以上调用点出现时，优先收敛到其最窄共同 owner。
- 逻辑只出现两次时，只有同时跨越独立职责边界、已经造成类型倒置或存在明确语义漂移风险，才进行解耦。
- 单次业务流程、一次性格式化、单消费者布局协议、开发预览 fixture 和独立发布验证链路，即使代码较长也保留原位；文件大小本身不是拆分依据。
- 新边界必须减少重复或依赖方向，不建立后续功能尚未使用的接口、基类、注册器或兼容层。

本次处理：

- Main 的四份 `isRecord` 与三份 `errorMessage` 分别收敛为纯工具，调用端错误文案与行为不变。
- Project Session pointer 的类型和两份相同 upsert 逻辑收敛到 Project 领域纯模块；Kernel 不再从持久化 Store 获取该领域类型。
- Renderer 的 Project/Session 切换与 Runtime 启动状态判定收敛到 Renderer 共享纯模块；Composer 不依赖 Chat feature 内部实现。

明确不处理：

- 不因行数拆分 `WorkbenchKernel`、`Composer`、`Timeline` 或 Linux release verifier。
- 不抽取只使用一次的时间/标题格式化、命令参数解析、Composer DOM 测量、Preview fixture 或视觉原子组件。
- 不修改 IPC/RPC contract、持久化 schema、Runtime ownership、视觉结构或交互行为。

验收：

- 被收敛逻辑只保留一个定义，调用端依赖方向与 owner 一致。
- `pnpm typecheck`、`pnpm test:core`、`pnpm build` 和 `git diff --check` 通过。
- 最终 diff 不包含本 Slice 边界外的顺手重构。

P2 只有同时满足以下条件才可完成：

1. 多个 Project 可保存和切换；Runtime 按 Session 隔离并可并行运行，每个 Runtime 都有唯一 owner，Renderer 同一时间只展示当前选中 Session 的完整投影。
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

S14-07 已按用户要求前移 Pi Extension 本地路径的列出、安装和卸载最小链路，只读写用户级 `settings.json` 的 `extensions` 字段。S14-19 进一步前移 pi.dev 中带 Extension 资源的 npm Package 目录与用户级 Package 安装/卸载；S14-21 增加完整 Package 目录，但保留 Extension 类型筛选视图；S14-22 补齐用户级已安装列表、更新和卸载。新增 Git/本地 Package 来源以及已安装 Package 的逐资源过滤仍留在 P3，不与本地路径 Extension 语义混用。

S14-20 前移 Skill 的最小创建入口：Pi 0.80.10 没有独立的新建技能 RPC 或命令，GUI 只按官方能力向当前 Pi 会话发送结构化创建请求，并固定用户级 `~/.pi/agent/skills/` 与项目级 `.pi/skills/` 目标；Skill 目录管理、编辑、删除和 Package 分发仍留在 P3。

P3 的具体 Slice 在 P2 接近完成、Pi 支持版本和可用接口重新核验后追加到本计划。后续拆分必须继续遵循 KISS：先接入一条真实可验证的能力链路，再扩展第二类资源或管理界面。

#### P3-0 — 已集成的前置基础（P3 启动前）

2026-07-30 在 P3 启动前，canonical 候选提前收口了四项可独立验证、且当时不改变 P3 阶段状态的窄基础：

- 历史 Prompt 原位编辑直接复用 Pi Tree：GUI 解析当前可见活动路径上的 user turn，先调用受控 `navigate_tree`，再复用现有 `prompt`；发送失败保留草稿并只重试 prompt。没有新增 atomic navigate+prompt、projection watermark 或第二份 Conversation 事实源。
- P3-1 开始前，Workbench composition 已拥有通用右侧栏壳层，当时唯一模块是“子任务”；P3-1 已增加真实 Git Tab，MCP、Browser、Terminal 仍不显示占位 Tab。
- Git Main/IPC 使用 `simple-git@3.36.0` 提供受 Project identity 与 ancestor trust challenge 约束的 status/diff/stage 基础；P3-1 已接入 Renderer Changes 工作台，commit/push 和同步 UI 仍未实施。
- Capability Inventory 是只读、离线的 Main service，复用现有 Pi 0.80.10 executable/package-root 验证；它不安装 Package、不执行 Extension factory，也尚未接 Settings 页面。

P2/S26 已在 commit `152a9a3` 的正式 AppImage + memory gate 中完成；P3 现为 `In Progress`，P3-1 已完成且 P3-2 为 `Ready`。上述基础只能按实际接线 Slice 继续扩展，不能据此声明 Commit & Push、Capability Center、MCP 管理或 P3 已完成。

P3 按以下顺序实施；只有当前 Slice 的真实调用链和 UI 验收通过后才进入下一项，不并行建立未使用的 Git、Capability 或 MCP 平台能力：

1. P3-1 Git Changes Sidebar。
2. P3-2 Commit & Push。
3. P3-3 Git History。
4. P3-4 Branches & Sync。
5. P3-5 Settings Capability Center。
6. P3-6 Package / Extension / Skill / Prompt 管理。
7. P3-7 MCP 管理。

**P3 并行实施规则**：

- 顶层仍保持单一当前 Slice：当前 Slice 未验收前不启动下一项产品实现（现为 P3-2 未验收前不启动 P3-3），后续同理。允许并行的是当前 Slice 内已经冻结边界的独立层，不是提前铺设未来平台。
- 每批最多两个隔离 writer + 一个只读 reviewer。Parent先冻结最小 typed contract和文件 ownership，两个 writer分别在独立 worktree/source snapshot写入；Parent负责唯一集成、冲突解决和最终验收。测试随对应 writer的实现一起维护，reviewer不向共享树写修复。
- P3-1 可并行：① Header / shared Right Sidebar composition、焦点和响应式壳层；② 新建的 Git Changes feature状态、列表、diff和mutation UI；③ 只读 reviewer核对现有 `window.piGit` DTO、trust/stale/conflict边界。Shell writer不写Git feature文件，feature writer不改Workbench/RightSidebar既有composition文件，Parent最后完成单一接线。
- P3-2 可并行：① commit/amend/push typed contract与Main adapter；② 紧凑确认层和结果UI。只有Parent先冻结 snapshot、结果和错误 DTO 后才开始；公共 `git-contract.ts` 只由backend writer拥有，Parent完成最终preload/Workbench接线。
- P3-3 可并行：① 有界history/detail/diff Main读取；② History列表与详情组件。read-only接口冻结前不实现Renderer猜测或raw revision/path调用。
- P3-4 可并行：① branch/fetch/pull/push Main动作和安全结果；② Branches & Sync UI。共享Git controller、preload和右侧栏导航的集成顺序由Parent串行完成，Commit & Push路径不由第二个writer复制。
- P3-5 可并行：① Settings scope/navigation壳层；② 只读Capability Inventory视图组件。Inventory writer只新增页面组件和feature样式，不修改Settings总路由；Parent接入现有bounded DTO。
- P3-6 可并行：① Package mutation桥与Package页面；② Extension / Skill / Prompt资源页面和现有服务适配。共享Settings导航、page draft和即时operation状态由Parent串行集成；Package与Extension不得各自实现一套install/reload事实源。
- P3-7 可并行：① `pi-mcp-adapter`配置/状态/auth窄桥；② MCP Settings页面。凭证/provenance reviewer可与两条writer并行只读复核，但config writer是唯一安全边界owner。
- 不可并行写同一共享边界：`Workbench.tsx`/RightSidebar composition、Settings总导航、`git-contract.ts`、Git controller/preload、MCP config writer和同一feature CSS由单一owner串行修改。正式build或UI gate只对Parent集成后的单一候选运行，不分别为兄弟worktree重复启动应用。

#### P3-1 — Git Changes Sidebar（Complete）

本地 source snapshot 已接通 Header 通用右侧栏展开/收起入口、Git/Subagent 真实 Tab 组合、Project/Settings/宽窄窗口/Escape/焦点合同，以及 Cursor 式紧凑 Changes 范围选择、默认折叠文件列表、Working/Staged diff、Stage/Unstage、ancestor trust、stale 与 bounded error 状态。性能加固后的 Parent 验证为相关 Renderer 67/67、Main Git 49/49、`pnpm typecheck`、`pnpm build` 与 `git diff --check` 全部通过；多轮独立只读审计已将 snapshot/trust、并发 mutation、虚拟 DOM、水平宽度、完整复制和可访问性 blocker/high 清零。按本 Slice 最小 gate 未启动 Electron 或增加截图证据。

目标是只接通现有 typed Git foundation 与右侧栏 `Changes` 页面，先证明 Project identity、Git trust、diff 和文件级 mutation 的完整产品链路。

**入口与容器**：

- 普通 Project 的 Session Header 右侧增加通用右侧栏展开/收起按钮，使用与左侧栏镜像的壳层图标；Git 不作为一级图标，只在右侧栏内作为真实 Tab。Task workspace 没有可用右侧模块时不显示该入口，Navigator 不增加重复 Git 按钮，也不显示没有刷新保证的变化数量徽标。
- 点击后打开 composition-owned 的共享右侧栏，顶层模块标签为“Git”。只有 Git 实际打开、或用户已经选择真实 Subagent 任务时才显示对应真实 Tab；不显示 History、Branches、Sync、MCP、Browser、Terminal 等占位 Tab。
- Project 切换时保持 Git 模块打开并刷新为新 Project；打开 Settings 时关闭右侧栏。收起后由同一 Header 通用按钮重新展开；关闭或 Escape 尽力把焦点恢复到仍代表同一操作的 Header 右侧栏按钮或 Subagent 胶囊；窄窗口继续复用现有右侧栏替换主工作区与“返回对话”合同。

**Changes 内容**：

- 顶部展示当前 branch、detached 状态、upstream、ahead/behind 和手动刷新入口；没有 upstream 时显示明确 unavailable，不推断 remote。
- 主体只有一个 Changes 列表，顶部以 Cursor 式紧凑选择器切换 `Uncommitted / Unstaged / Staged` 投影；默认 `Uncommitted`。mixed 文件可进入 unstaged 与 staged 投影，但同一时刻的单列表不重复文件。每行展示 staged、unstaged、mixed、untracked 或 conflicted 状态；rename 使用 `originalPath → path`。
- 所有文件 diff 默认折叠，每个文件独立展开/折叠并可同时保留多个展开项；标题区提供“全部折叠”，并以 per-file request token 隔离并发返回。pointer/focus 意图只预取 typed diff 数据且不挂载隐藏 DOM，点击文件行时优先消费 exact snapshot 缓存，冷路径仍原位加载。普通未暂存与 untracked 文件显示 Working diff；已暂存文件显示 Staged diff；mixed 文件在 Uncommitted 投影提供 `Working / Staged` 切换并默认 Working，在过滤投影只显示对应一侧。binary、oversized、非 UTF-8 和不支持的 diff shape 显示后端 canonical 状态，不由 Renderer 猜测或解析 raw patch。
- diff hunk 前和 hunk 间根据 `oldStart/oldLines/newStart/newLines` 精确显示 `N unmodified lines` 折叠条，取代 raw `@@` header。当前 DTO 不含被 Git 省略的源码文本和文件尾总行数，因此 P3-1 不提供假的上下文展开箭头；真实展开需后续新增有界 `contextLines` Main/IPC request，并继续服从 stale、output 与 identity fence。
- diff DTO 缓存严格绑定 Project、repository root、status revision、HEAD、index tree、worktree fingerprint、file identity/fingerprint 与 Working/Staged kind；同 key single-flight，LRU 最多 8 条且估算不超过 8 MiB，错误、trust 与 stale 结果不缓存。最多同时展开 8 个文件；单个 diff 在 300 行以内保持直接 React 渲染，超过阈值时使用 feature-local `@tanstack/react-virtual` 的固定 32px 行窗口、稳定全量水平宽度和 overscan，并提供完整文本模式与“复制全部”。
- Unstaged / untracked 文件提供 Stage，staged 文件提供 Unstage；mixed 文件在 Uncommitted 投影同时提供两项，在 Unstaged/Staged 投影只保留对应操作。操作只使用当前 `GitRepositoryState` 的 repository root、HEAD、index、worktree、file fingerprint 和 status revision；stale 时替换为后端返回的新状态并要求用户重新确认，不自动重放 mutation。
- Conflicted 文件只显示紧凑冲突状态且不提供 mutation；P3-1 不提供假 diff、自动解决或“暂存为已解决”入口。Rename 继续由现有 Main service 原子处理 old/new path。现有 DTO 不提供 repository 总增删行、Last Turn 或 Branch Commits，因此 P3-1 不扫描全部 diff 猜统计，也不显示不可用占位项。

**刷新、信任与状态**：

- 不增加 watcher 或 polling。只在打开 Git 模块、切换 Project、手动刷新、Stage / Unstage 完成后刷新；Project identity 或 request revision 变化后丢弃迟到结果。
- Project 不是 repository 时显示明确空态，不提供 `git init`。Project 位于 ancestor repository 时显示 repository root 并要求用户显式“允许本次使用”；授权继续绑定现有 root + status revision challenge，只在当前 Main 进程内有效，Project/repository identity 变化后重新确认。
- `truncated`、not-repository、trust-required、stale、timeout、output-limit 和 bounded public error 都按 typed DTO 展示；Renderer 不接收任意 cwd、raw Git 参数、stderr 或任意路径读取。

**明确非目标**：

- 不实现 Commit、Amend、Push、Pull、Fetch、History、Branches 或 Sync。
- 不实现 hunk/line staging、文件 watcher、定时 polling、conflict resolver、repository 初始化或 AI commit message。
- 不把 Git 状态并入 KernelState，不建立第二份 repository 数据库或通用 Workbench module registry。

**验收**：

- 覆盖普通、untracked、mixed、staged、rename、conflict、binary/oversized 文件，clean/not-repository/detached/unborn repository，以及 ahead/behind 和无 upstream。
- 覆盖 Project 切换、ancestor trust允许/拒绝/过期、stale diff/mutation、操作后刷新、迟到请求丢弃和错误脱敏。
- 覆盖右侧栏 Git/Subagent真实 Tab组合、关闭/收起/Project切换/Settings、宽窄窗口替换、键盘 Tab、Escape、焦点恢复和 reduced-motion。
- 最小 gate 为相关 Git/Renderer定向测试、`pnpm typecheck`、`pnpm build` 和 `git diff --check`；除非实际变更需要视觉运行证据，不启动 Electron或增加截图 gate。

#### P3-2 — Commit & Push（Ready）

在 P3-1 的 staged-content 链路通过后增加提交能力。`Commit & Push` 点击后必须先打开紧凑确认层，展示 staged 文件数量、目标 branch/remote 和自动生成但可编辑的 commit message，并提供明确的 Commit、Commit & Push、Amend 选择。提交请求绑定确认时的 HEAD 与 index snapshot，不执行 `git add -A`，不把未勾选内容顺带暂存；commit成功而push失败时分别报告两个结果。确认层复用 `useModalDialog` 的焦点/Escape合同。AI message只能作为可编辑建议，不能成为提交前置条件，也不能修改 index。

#### P3-3 — Git History（Planned）

增加只读提交历史、提交元信息、changed files 和按文件 diff；复用同一 Project/repository identity和有界 DTO，不读取任意 revision/path。首期不提供 reset、rebase、cherry-pick、revert 或历史改写入口；只有真实只读链路验收后再决定是否需要独立 mutation Slice。

#### P3-4 — Branches & Sync（Planned）

增加当前/本地/远端 branch展示、受控新建与切换，以及彼此独立的 Fetch、Pull、Push动作。每项操作显示明确目标和独立结果，不建立含义不透明的“一键同步”；dirty worktree、detached HEAD、上游缺失、非 fast-forward、冲突和认证失败均 Fail Fast。Commit & Push继续复用 P3-2确认合同，不复制另一套提交路径。

#### P3-5 — Settings Capability Center（Planned）

Settings继续是独立全页，不进入右侧栏。先把现有只读、离线 Capability Inventory 接入 Settings，以 user/project scope、继承/override、来源和静态 resolved 状态统一展示 Package、Extension、Skill和Prompt；不得把配置声明误标成 Runtime实际加载成功。页面只消费 bounded DTO，不显示 Prompt/Skill正文、Theme body、settings JSON、credential或 package cache绝对路径。

#### P3-6 — Package / Extension / Skill / Prompt 管理（Planned）

在 P3-5只读模型通过后，逐项接入已有真实服务：Package负责安装/更新/卸载和资源过滤；Extension负责已加载代码与Runtime状态；Skill/Prompt负责发现、作用域和现有管理入口。页面 draft与 install/remove/update/reload等即时动作分离，后者各自确认并独立报告；不把 Package存在等同于 Extension已加载，也不建立第二个 Package Manager。

#### P3-7 — MCP 管理（Planned）

复用已安装的 `pi-mcp-adapter`，在 Settings中管理 server配置、连接/认证状态及真实 tools/resources；Package仍管理 adapter安装，Extension仍管理 loaded code，MCP只管理外部server和capability。配置 mutation继续使用严格 provenance、scope ownership和 malformed-target Fail Fast边界；不重写 MCP client、不复制 secret、不暴露 raw config或任意 Extension command passthrough。

### 15.4 P4 — Cross-platform Desktop

P4 明确延后，不与当前 Linux GUI 实施并行。正式启动后仍保留同一套 Renderer、Workbench Kernel、typed IPC、Pi RPC 与 Session 事实边界，只在 Electron Main/Runtime 中增加被目标平台真实使用的窄适配。

实施顺序：

1. **macOS**：先接通本地 Pi、路径搜索、通知、字体、Command 快捷键与原生窗口生命周期，再完成 arm64/x64 产物、签名和 notarization。
2. **Windows 原生**：处理 `pi.cmd`/Pi package root、Bash 前置条件、盘符与 UNC 路径、进程树、named pipe、安装包、签名和 SmartScreen；首期不同时引入 WSL。
3. **WSL**：仅在 Windows 原生版稳定且存在明确需求后评估；Windows 与 WSL 的路径、`~/.pi`、credential、Session 文件和 Runtime host identity 必须保持显式归属，不静默复制或合并。

P4 开始前必须重新确认 Pi 的分发策略：默认继续使用用户已安装且版本受控的 Pi；是否捆绑 Node、Pi 或 Windows Bash 需作为独立产品与发布决策，不在移植中顺手扩大范围。每个平台只有在原生打包产物完成 launch、Project、prompt/tool、abort、crash、restart/resume、Session 恢复和进程收口，并生成与 commit/产物一致的脱敏证据后，才可报告为完成。

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
| 2026-07-21 | S8 | P2 正式开始；基于 P1 真实产物截图和当前 Renderer/Kernel/ProjectStore 审计，形成 Workbench Navigator、Session Header、turn-based Timeline、Composer command surface 的低保真结构，并明确 canonical project path、session file、单活动 Runtime 与切换顺序；Renderer 低保真实现移除重复 Project picker、不可用附件/归档入口和遮挡 Timeline 的诊断浮层，typecheck/build 及真实 Electron 折叠/展开诊断复核通过 | 等待用户确认结构方向；确认后完成 S8，进入 S9 多 Project |
| 2026-07-21 | S8 Complete / S9 Start | 用户确认低保真 Workbench 结构方向；S8 完成。S9 开始实现多 Project 注册表、按 Project 隔离的最近 Session、`projects[]` / `activeProjectKey` typed contract、添加/激活命令、单活动 Runtime 安全切换和真实 Navigator 列表 | 完成全量 core tests、typecheck、build 与最终 diff 复核；验收通过后再完成 S9 |
| 2026-07-21 | S9 Complete | 完成多 Project 注册表、v1 配置/状态迁移、按 Project 隔离的最近 Session、typed add/activate command、单活动 Runtime 安全切换和真实 Navigator 列表；84 项 core tests、typecheck、生产 build、diff check 通过；隔离 XDG 构建版烟测确认两个 Project 可显示、激活并持久化，且全程不启动 Pi 对话、只有一个 stopped runtime | S10 Ready；下一步实现每个 Project 下的多 Session |
| 2026-07-21 | S8 Audit Repair | 补齐无假命令的 slash command 空态，移除重复“添加项目”入口；修正结构文档中的 Project/Session 切换顺序，明确 `starting` / `stopping` 拒绝、canonical Session identity 和成功后原子提交约束。Session 持久化与切换实现仍归 S10，不在本次 S8 修复中提前落地 | 复核 S8 Renderer 与文档定向 diff；S8 保持 Complete，S10 状态由其独立实现和验收维护 |
| 2026-07-21 | S10 Complete | 完成每 Project 多 Session 索引、活动选择、typed `start-session` / `activate-session` IPC、Navigator 列表和 Timeline identity；Pi session 文件仍是 Conversation 事实源，GUI state 只保存 canonical pointer、`sessionId`、名称和选择。新建或切换只使用一个 Runtime，运行中拒绝，目标 Session 在普通可读文件校验、受控 stop、`sessionId` 核对、`get_messages` 和指针持久化成功后才提交；失败不把旧 Conversation 标成目标 Session。90 项 core tests、typecheck、生产 build、真实 Pi 0.80.10 无状态 smoke 和 diff check 通过 | S11 Ready；下一步审计 Pi 0.80.10 的真实命令目录与调用语义，再实现统一 slash command 入口 |
| 2026-07-21 | S11 Complete | 审计并接入 Pi 0.80.10 的 `get_commands`、`compact`、`set_session_name`；Kernel 合并 GUI、typed RPC、extension、prompt、skill 五类 normalized command，并只接受当前 catalog ID。Composer 完成来源展示、搜索、Arrow 导航、补全、参数输入和未知 slash Fail Fast；TUI builtin 不做文本盲传。105 项 core tests、typecheck、生产 build、`smoke:pi`、diff check 通过；真实 Pi `get_commands` 成功返回 catalog，typed `set_session_name` 成功并产生 `session_info_changed` 事件 | S12 Ready；在真实多 Project、多 Session 和命令入口上完成 UI 视觉收敛 |
| 2026-07-21 | S9/S10 Audit Repair | 修复 Project 激活持久化期间可并发启动旧 Project、退出遗漏校验期 launch、同路径并发添加破坏内存 registry 三项竞态；Kernel 增加 Project 变更与 launch 的同步 fail-fast lifecycle 门，Main 在 Kernel 存在时始终委托 `stop()`，并补充两项确定性并发回归测试。92 项 core tests、typecheck、生产 build、真实 Pi 0.80.10 无状态 smoke 和 diff check 通过 | S9/S10 保持 Complete；S11 保持 Ready |
| 2026-07-21 | S10 Audit Repair | 修复 Session 切换持久化期间 Pi 退出后错误提交 `ready` 和目标 identity；按 Pi 0.80.10 的真实延迟落盘语义加入 provisional 新 Session，首个 assistant 消息落盘、canonical 校验与持久化完成前不登记索引或活动指针；正常 GUI 增加单实例锁，消除两个 Main 进程共享 XDG 时的 Session 索引丢失更新。94 项 core tests、typecheck、生产 build、diff check、持锁期间真实 Pi smoke 通过；隔离 XDG/Session 目录的真实 Pi 双 Session 验证覆盖创建、切回、重建 Kernel 后恢复，两个 Session 均恢复 2 条消息 | S10 保持 Complete；S11 保持 Ready |
| 2026-07-21 | S11 Audit Repair | 修复 `/name` 只更新瞬时 Session、未同步导航索引与 XDG 指针的问题，并覆盖 existing/provisional Session 的持久化和重启恢复；`/compact` 成功后原子读取 `get_state`/`get_messages` 重建 Timeline，投影失败时保留原状态；Composer 直接展示 catalog 参数语法。`smoke:pi` 现在通过真实 Pi 0.80.10 重复验证 `get_commands`、typed `set_session_name` 和真实 `session_info_changed.name`；108 项 core tests、typecheck、生产 build、smoke 与 diff check 通过 | S11 保持 Complete；S12 保持 Ready |
| 2026-07-21 | S12.5 Complete | 先审计 Main、Renderer 与跨目录依赖，只处理有重复证据的纯逻辑：四份 record guard、三份错误文本归一化、两份跨 Kernel/Store 的 Session pointer upsert，以及 Project/Session/启动入口重复的 Runtime 状态判定；保留 Composer DOM 测量、Timeline、preview 和 release verifier 等单一职责或单次逻辑。109 项 core tests、typecheck、生产 build、diff check 通过 | S12 的视觉验收状态不因本次解耦自动改变；完成 S12 后再进入 S13 |
| 2026-07-21 | S12 Complete | 完成当前多 Project/多 Session Navigator、Session Header、Timeline、Composer、slash command、design token 与 icon 改版的并行审计；修复 Header 遗失 Project/Session/Runtime 与流内诊断的结构回归、Composer 错误 token 漂移、preview 跨 Project 复用 Session 的错误 fixture，以及 700px rail 的空白 Project initial。开发预览在 1440×960 与窄视口下确认诊断不覆盖 Timeline、页面无横向溢出、Project 切换只显示所属 Session；随后构建版 Electron 使用隔离 XDG、2 个真实临时 Project 目录和 3 个 Session 指针，经真实 ProjectStore/WorkbenchKernel 验证 Project/Session 隔离，并启动真实 Pi 0.80.10 取得五项 builtin catalog，确认 slash menu 完整位于 Composer 上方。全程未写用户 XDG、未发送 provider prompt，验证后 Pi/Electron 全部收口，临时状态与截图移入 Trash；109 项 core tests、typecheck、生产 build、diff check 通过 | S12 与 S12.5 均完成；S13 Ready，下一步进行交互优化与 P2 打包发布证据 |
| 2026-07-22 | S12.5 Re-audit Repair | 多 Agent 按三个互斥写入边界修复复审遗漏：Main 剩余三处内联错误文本提取改用唯一纯工具；移除 ProjectStore 对 Session pointer 领域类型的兼容 re-export，并让 Kernel 测试直接依赖领域 owner；删除无调用方且 Runtime 状态判定已漂移的旧 `ProjectStartup`。主线程逐项复核实际 diff，确认未修改 IPC/RPC contract、持久化 schema、Runtime ownership、视觉结构或交互行为；109 项 core tests、typecheck、生产 build 与 diff check 通过 | S12.5 保持 Complete；S13 保持 Ready，继续交互优化与 P2 发布证据 |
| 2026-07-22 | S13 Semantic Session Naming | 新 Session 首轮 settled 并落盘后，通过隔离、无 Session、无工具与项目资源的 Pi metadata 请求生成目的导向名称；已有未命名 Session 在下次恢复时补生成，手动 `/name`、切换、停止和崩溃会取消自动结果；118 项 core tests 通过 | 核对 OAuth 与模型成本边界，避免自动命名占用高成本主模型 |
| 2026-07-22 | S13 Naming Cost and OAuth | 自动模式改为只从 Pi 当前授权目录、活动 provider 内按 nano/mini/luna 选择低成本模型，无候选时不回退主模型；侧边栏设置提供自动、关闭和指定已授权模型，config v3 仅保存模式与模型 ID，OAuth/API key 仍完全由 Pi 管理；119 项 core tests 与 typecheck 通过 | 完成生产构建与 diff check，再继续 S13 其余发布验证 |
| 2026-07-22 | S13 Interaction Completion | 多 Agent 并行审计键盘/焦点、滚动、切换反馈、命令补全和加载/错误/空状态；确认 Timeline 的底部跟随、用户上滚保持、Session/Project 切换重置和历史展开视口补偿链路成立；补齐 Tab/Arrow slash 补全、combobox ARIA、Runtime context action 成功后的 Composer 焦点恢复、可访问切换状态、空对话、无详情 crash fallback 和 Kernel 连接重试。119 项 core tests、typecheck、生产 build、真实 Pi 0.80.10 无状态 smoke 与 diff check 通过 | 在干净 commit 的打包产物上执行 P2 完整真实 UI 链路，确认交互时序并生成脱敏证据 |
| 2026-07-22 | S13 P2 Release Verifier | 保留 P1 的 13 步真实 AppImage 回归，新增双 Project 发现/切换与单 Runtime 采样、同 Project 双 Session materialize/list/switch/restore、slash 来源与 Arrow/Tab 补全、typed `/thinking`、未知命令 Fail Fast、空态/切换反馈/焦点恢复断言；报告升级为 schema v2 与 P2 摘要。复核时同步移除 S12 后失效的 DOM 选择器，并按当前 XDG state v3 的 `sessions[]` / `activeSessionKeys[]` 读取恢复事实；脚本语法、diff check 与 AppImage package 通过 | 先整理当前 P2 工作区为干净 commit，再运行 `pnpm verify:linux`；passed 报告和六张脱敏截图生成前，S13/P2 保持 In Progress |
| 2026-07-22 | S14 Planning | 新增后续 Slice S14“优化”；不预先拆分具体事项，实际交互问题按出现顺序处理 | S13 继续 In Progress；完成后进入 S14 |
| 2026-07-22 | S14 Intake | 记录首批四项实际体验问题：菜单外点击收起、设置界面首期范围、无感浏览 Session 与 Runtime 启动语义、Project/Session 拖拽排序 | 继续接收问题；具体方案和顺序留待逐项讨论 |
| 2026-07-22 | S13 Complete / S14 Ready | 候选 `fe1e559` 从 AppImage 完成 17 步真实 UI 验证：完整保留 P1 launch、probe、tool、abort、crash、restart/resume、reopen 链路，并通过 2 个 Project 发现/切换、同 Project 2 个 Session 落盘/列出/切换/恢复、5 个命令与 2 类来源发现、Arrow/Tab 补全、typed `/thinking`、未知命令 Fail Fast、空态、切换反馈、焦点恢复和单 Runtime 采样；schema v2 报告为 passed，六张 1271px 宽截图均非空且正文、工具详情和标题已脱敏。119 项 core tests、typecheck、生产 build、真实 Pi 0.80.10 smoke 与 AppImage package 均通过 | S13 完成；S14 Ready，按优化记录逐项讨论和实施 |
| 2026-07-22 | S14 首批优化 | 修复模型与 slash 菜单外点收起；建立只含外观/扩展的首期设置页；Session 浏览不改变 Runtime，首次发送或执行命令时后台自动激活目标 Session；增加 Project/Session 拖拽排序和 XDG 持久化。76 项定向 core tests、typecheck、生产 build、开发 Renderer HTTP 检查通过 | S14 保持 In Progress；继续逐项接收和处理实际体验问题 |
| 2026-07-22 | P2 Re-audit Repair | 修复 Project 切换期间可并发启动旧 Project Runtime、同路径并发添加导致内存 registry 重复两项 lifecycle 缺陷；发布验证器的 typed `/thinking` 现在必须观察目标 thinking level；设置页关闭后焦点回到设置入口。135 项 core tests、typecheck、生产 build、验证器语法和 diff check 通过 | P2 既有发布证据保持历史记录；S14 继续 In Progress，下一次候选发布时从真实 AppImage 重跑完整 gate |
| 2026-07-22 | S14 Steer / Follow up | 修复 Runtime `running` 时 Composer 被禁用且只能 abort 的交互缺口；按固定 Pi 0.80.10 原生协议贯通 `steer`、`follow_up` 和 `queue_update`，运行中可继续输入，Enter 发送转向消息、Alt+Enter 发送完成后跟进，两个动作均有显式按钮，排队数量由 Kernel 状态投影 | S14 保持 In Progress；继续按实际体验追加优化，下一次候选发布时重跑完整 AppImage gate |
| 2026-07-22 | S14 Session 归档 | Session 行增加右侧悬浮/聚焦归档按钮；typed IPC、Kernel 与 ProjectStore 使用 XDG state v4 的独立归档索引闭环，v1/v2/v3 自动迁移；非活动归档不影响 Runtime，活动 ready Session 先停止再清空投影，Pi JSONL 保留。142 项 core tests、`pnpm typecheck`、生产 build 与 diff check 通过 | S14 保持 In Progress；归档管理与取消归档不在本项范围，继续按实际体验追加优化 |
| 2026-07-22 | S14 拓展管理修正 | 严格区分 Extension 与 Package：删除 `pi install/remove/list`、npm/Git 来源和 package 目录入口；Main 直接维护 Pi 用户 `settings.json` 的 `extensions` 路径数组，设置页选择 `.ts` / `.js` 文件或目录，卸载仅移除配置且不删除源码；权限与生效时机移入 tooltip | S14 保持 In Progress；Pi Package 继续作为 P3 的独立能力，不与拓展页混用 |
| 2026-07-22 | S14 下拉组件 | 偏好设置不再使用系统原生菜单；新增共享 `Select`，使用既有前端 token 实现触发器、popover、分组、选中/禁用态、外点收起及 Arrow/Home/End/Enter/Escape 键盘交互，并由“自动对话命名”首个接入。`pnpm typecheck` 与生产 build 通过 | S14 保持 In Progress；后续仅在出现第二个真实下拉调用点时继续复用，不改造语义不同的模型与 slash 菜单 |
| 2026-07-22 | S14 运行中输入语义 | 将运行态普通提交改为 `follow_up`，Alt+Enter 作为 `steer` 特别提交；移除输入框右侧并列的 Follow up / Steer 按钮，仅保留中止按钮和排队数量。`pnpm typecheck` 与 diff check 通过 | S14 保持 In Progress；下一次候选发布时从真实 AppImage 重跑完整 gate |
| 2026-07-22 | S14 运行中队列可见性 | 核对 Pi 0.80.10 原生语义：steer 在当前工具调用结束后、下一次 LLM 调用前送达，follow_up 只在 agent 停止后送达；Kernel 不再丢弃 `queue_update` 正文，Composer 上方只显示实际排队内容、不显示类型，面板限高滚动并由既有高度测量为 Timeline 自动让位。149 项 core tests、`pnpm typecheck` 与 diff check 通过 | S14 保持 In Progress；下一次候选发布时从真实 AppImage 重跑完整 gate |
| 2026-07-22 | S14 工具过程密度 | 将工具过程从单一高强调时间线改为三档 Renderer 展示：紧凑档聚合文件、命令与其他工具数量；标准档使用无徽标、无圆点、无详情盒的轻量步骤；详细档按工具卡片展示输入与输出。外观设置提供三段滑杆并用 localStorage 保存，默认标准档；thinking 投影与展示未改。149 项 core tests、`pnpm typecheck`、生产 build 与 diff check 通过 | S14 保持 In Progress；下一项单独处理 thinking 与整体对话流层级 |
| 2026-07-22 | S14 导航拖拽命中修复 | Project / Session 行不再常驻原生 draggable；仅从主行内容按下时临时启用，pointer up、pointer cancel 或 drag end 后关闭，行内新增/归档操作不武装拖拽；归档按钮显式置于时间文字上层，底层时间与运行指示不接收指针或文本选择。`pnpm typecheck` 与定向 diff check 通过 | S14 保持 In Progress；继续按实际体验追加优化 |
| 2026-07-22 | S14 队列管理适配记录 | 记录队列拖拽排序、follow-up 转 steer、单条删除和动效需求；确认 Pi 0.80.10 公开 RPC 只支持入队与队列模式，不支持修改已有队列，Renderer 不能伪造状态 | 暂缓实现；优先评估 Pi 上游 typed RPC，并通过能力探测渐进启用；Pi GUI 不默认携带 Extension、不静默修改用户已安装的 Pi |
| 2026-07-22 | S14 对话导航感知 | 将可见 Session 目标与 Kernel 活动 Session 分离：已有对话先更新选中态并清空旧正文，再异步补历史；快速连续切换只接收最后一次 preview。新建对话先显示空白页并聚焦 Composer，后台启动期间可先输入，提交等待同一启动 Promise 后继续；未修改 Kernel contract、XDG schema 或单 Runtime ownership。`pnpm typecheck`、生产 build 与定向 diff check 通过 | S14 保持 In Progress；下一次候选发布时从真实 AppImage 重跑完整 gate |
| 2026-07-22 | S14 对话过程层级 | 按用户确认的参考样式重做 settled 工作过程与 thinking：外层使用“已处理 + 耗时 + 箭头 + 分隔线”，内层 thinking 独立折叠并弱化正文，删除旧卡片、状态点、过程统计和重复文件汇总；Renderer 只记录当前实际观察到的 run/thinking 时长，历史无数据时省略耗时。工具三档、原始顺序与最终回答层级不变。`pnpm typecheck`、生产 build 与定向 diff check 通过 | S14 保持 In Progress；下一次候选发布时从真实 AppImage 重跑完整 gate |
| 2026-07-22 | S14 外观设置布局 | 参考成熟外观页的信息层级，将已有主题状态、工具过程密度、界面字体和代码字体收为主题、Agent 对话、字体三组；同组采用连续设置行与右侧紧凑控件，窄窗口自动上下排列；未新增无后端语义的换行、色调、透明度或字号选项。`pnpm typecheck`、生产 build 与定向 diff check 通过 | S14 保持 In Progress；继续按实际体验追加优化 |
| 2026-07-22 | S14 冷启动对话 | 冷启动取得首份 KernelState 后立即投影空白新对话，并在已有活动 Project 时复用现有新建链路后台启动 Runtime；最近 Session 不再成为默认启动页，历史浏览、首次操作恢复、Project 切换和 crash resume 均保持原语义。`pnpm typecheck`、生产 build 与定向 diff check 通过 | S14 保持 In Progress；下一次候选发布时从真实 AppImage 重跑完整 gate |
| 2026-07-22 | S14 主题与密度说明 | 外观页主题由只读“深色”改为共享下拉，支持跟随系统、深色和浅色；Renderer 在 system 模式监听 `prefers-color-scheme`，浅色覆盖完整界面 token，设置经 typed Kernel contract 与 XDG config v6 持久化，旧 v4 配置默认迁移为 system。复核工具密度三档真实渲染后，增加聚合摘要、逐条操作、展开详情三种极简图示。153 项 core tests、`pnpm typecheck`、生产 build 与定向 diff check 通过 | S14 保持 In Progress；下一次候选发布时从真实 AppImage 重跑主题切换与核心链路 |
| 2026-07-22 | S14 pi.dev 拓展接入 | 在现有本地路径拓展区之外增加 pi.dev Extension 目录、显式搜索、详情跳转与安装状态；目录请求固定到 pi.dev 并对当前服务端 package card 元数据 Fail Fast 解析，安装/卸载只接受合法 npm 包名并通过 Pi 0.80.10 用户级包管理命令执行。真实 pi.dev 搜索 HTML 解析通过，156 项 core tests、`pnpm typecheck`、生产 build 与 diff check 通过 | S14 保持 In Progress；真实安装涉及执行第三方代码，本次未选择任意第三方包做破坏性验收，下一次候选发布时从 AppImage 复核完整交互 |
| 2026-07-22 | S14 新建技能 | 技能页增加“新建技能”表单，按 Pi 标准校验名称并选择用户级或当前项目目录；提交后复用现有 Session 激活与 prompt 链路，将技能用途、固定目标和“先展示、确认后写入”的约束交给 Pi。156 项 core tests、`pnpm typecheck`、生产 build 与 diff check 通过 | S14 保持 In Progress；本次未实际写入技能目录，后续在真实交互中由用户审查并确认具体技能内容 |
| 2026-07-22 | S14 pi.dev 目录修复 | 真实 Electron 请求因 pi.dev 对冗余排序参数和查询顺序返回 302，而严格重定向策略 Fail Fast；目录 URL 改为站点规范形式并继续禁止跳转，同时补齐目录错误/状态句位于卡片末尾时的底部留白。真实响应头确认规范 URL 为 200，3 项定向测试、`pnpm typecheck`、生产 build 与 diff check 通过 | S14 保持 In Progress；不放宽跨域或任意重定向策略 |
| 2026-07-22 | S14 pi.dev 目录密度与品牌（首轮理解） | 首轮将“一次最多展示三个”理解为只返回 3 项并移除滚动，同时只采用 Press Kit 的 Pi 图形标记；随后用户明确需要保留滚动列表，并指出品牌头缺少 `.dev` | 由下一条记录纠正，不把首轮理解保留为当前行为 |
| 2026-07-23 | S14 pi.dev 列表与品牌纠正 | 恢复每次最多解析 50 项；列表以 288px 高度滚动，常规密度下最多可见约 3 行。品牌头使用官网真实 Pi 标记并追加 `.dev` 形成完整组合，保留本地 SVG 与明暗主题适配。3 项目录定向测试、生产 build 与 diff check 通过；全量 typecheck 被并行 provider API 改动中 preview fixture 缺少四个方法阻断 | S14 保持 In Progress；provider 类型缺口由其所属改动修复，本项不越界修改 |
| 2026-07-23 | S14 Package 分类 | 设置导航新增 Package 分类和独立图标；pi.dev/npm 目录移入 Package 页面并统一 Package 文案，本地路径 Extension 继续单独留在拓展页。`pnpm typecheck` 与定向 diff check 通过 | S14 保持 In Progress；后续 Package 能力和 Extension 原生 UI 适配在该边界上分别演进 |
| 2026-07-23 | S14 Package / Extension 边界纠正 | 依据固定 Pi 0.80.10 的真实模型纠正首轮迁移：Package 是可包含 Extension、Skill、Prompt、Theme 的安装分发单位，Extension 是其中一类可执行资源。Package 页使用完整 pi.dev 目录；拓展页恢复 `type=extension` 筛选目录并保留本地路径，安装提示明确作用于整个 Package；`pi.dev` 品牌改为单一 SVG 图像。4 项目录定向测试、`pnpm typecheck` 与 diff check 通过 | S14 保持 In Progress；逐资源启停仍由 Pi `config` 语义负责，未在本项提前实现 |
| 2026-07-23 | S14 Package 管理 | Package 页增加用户级已安装列表和资源过滤标记；支持单项更新、全部更新及卸载，Main 对 Renderer 提交的 source 先与 Pi 用户设置核对，并把无版本 npm 身份解析回实际固定 source。所有修改调用 Pi 原生命令，不复制下载或依赖处理逻辑。4 项目录/命令定向测试、`pnpm typecheck` 与 diff check 通过 | S14 保持 In Progress；本项不新增 Git/本地来源输入或资源级启停 |
| 2026-07-23 | S14 Pi 路径修复 | 修复 Electron 主进程缺少用户级 PATH 时 Package 命令报“Pi was not found”的问题；解析顺序保持显式配置、PATH、`~/.local/bin/pi`，并继续校验可执行文件和固定 Pi 版本。13 项 Package/路径定向测试、`pnpm typecheck`、diff check及空 PATH 下真实 `/home/vvv/.local/bin/pi` 0.80.10 探测通过；开发主进程已重启 | S14 保持 In Progress；不增加平台外路径猜测或第二套 Pi 安装机制 |
| 2026-07-23 | S14 模型菜单布局 | 多 Agent 分别审计根因、既有浮层模式、响应式边界与验证范围；模型复合菜单改用共享 viewport 定位和 body portal，从固定大面板收敛为首选 520×360px，并按实际空间翻转、缩放和滚动；补齐 portal 外点判断、打开聚焦、Escape 关闭及上下文切换收起。160 项 core tests、`pnpm typecheck`、生产 build 与 diff check 通过 | S14 保持 In Progress；下一次真实工作流中复核模型与思考强度切换的最终视觉 |
| 2026-07-23 | S14 模型菜单结构纠正 | 用户复核后删除不必要的左右分类与面板切换；浮层收窄为首选 380px 单列，上方直接显示思考强度选项，下方模型行按需展开最多 220px 高的滚动列表；保留 viewport 定位、外点收起、Escape 与焦点行为 | S14 保持 In Progress；在当前开发窗口复核最终信息层级 |
| 2026-07-23 | S14 思考强度能力修复 | 实测 Pi 0.80.10 当前 `vvqq-cpa/gpt-5.6-luna` 返回稀疏 map `{xhigh,max}` 但当前状态为 `high`；核对 Pi 本机源码确认 `off/minimal/low/medium/high` 缺失时默认支持。GUI 改为相同判定并贯通七档 shared contract、RPC 投影、IPC 校验与 slash 参数；160 项 core tests、`pnpm typecheck`、生产 build 与 diff check 通过 | S14 保持 In Progress；当前 Luna 菜单应展示七个真实可选档位 |
| 2026-07-23 | S14 模型子菜单方向 | 模型行不再在主菜单内向下展开列表；主浮层移到入口左侧预留空间，模型列表使用独立 portal 优先从模型行右侧展开，并只在可用宽度不足时向左避让。外点收起覆盖两层浮层，Escape 先收子菜单再收主菜单，打开后聚焦当前模型；160 项 core tests、`pnpm typecheck` 与生产 build 通过 | S14 保持 In Progress；在当前开发窗口复核右侧级联菜单的最终位置与宽度 |
| 2026-07-23 | S14 强调色与透明度 | 外观页主题组增加五种强调色和 0–40% 面板透明度选择；Renderer 通过统一 CSS token 即时更新强调状态、侧栏、卡片与 Composer 面板，配置 schema 升级到 v7 并迁移旧 v4–v6 外观设置。81 项 ProjectStore/Kernel 定向测试、`pnpm typecheck` 与 diff check 通过 | S14 保持 In Progress；下一次真实工作流中复核深浅主题下的颜色与通透程度 |
| 2026-07-23 | S14 模型设置真实性 | 纠正只检查本地 `models.json` 的错误判断：CPA 标准 `/v1/models` 只返回 ID，但同一接口带固定 Pi 版本的 `client_version` 后会返回完整 Codex 模型元数据。Provider Store 现在使用 `auth.json` 凭据在锁外读取该目录，严格只解析当前已配置模型；本地显式字段优先，远端名称、上下文、推理和输入能力只读回退，绝不进入编辑草稿或写回配置。真实读取确认 Luna/Sol/Terra 为 372000 且支持图片，5.5/5.4/5.4-mini/Grok 为 272000 且支持图片，Spark 为 128000 且仅文本；接口未声明最大输出，因此保持“未声明”。默认值污染、三态设置和底部说明删除修复继续保留；`pnpm typecheck`、生产 build、diff check 与真实目录读取通过 | S14 保持 In Progress；后续只展示 Provider 实际返回的字段，不按模型名称猜测 |
| 2026-07-23 | S14 工作过程密度 | 复用既有紧凑、标准、详细设置统一控制活动 thinking 与工具过程：紧凑档单行轮换“正在思考/阅读/运行/修改”，标准档固定首段有效 thinking 并只轮换后续状态，详细档保留完整过程；完成态继续统一收起，展开仍可查看原始记录。设置文案同步改为“工作过程密度”。`pnpm typecheck`、生产 build 与定向 diff check 通过 | S14 保持 In Progress；在当前开发窗口中按三个档位观察真实长任务的实时切换节奏 |
| 2026-07-23 | S14 Thinking 摘要识别纠正 | 复核真实 Pi Session 后确认截图中的英文粗体 thinking 来自 `thinkingSignature.summary`，长段中文过程正文来自 `phase=commentary`。Kernel thinking 投影增加摘要标记；标准档不再固定首条，而是保留 commentary 与非摘要 thinking，摘要和工具留在单行状态的折叠详情中；同一流式 assistant message 中只有最后一项真实活动显示运行态，旧摘要默认收起。5 项投影测试通过；全量 typecheck 仅被并行 `WorkbenchKernel/contextKey` 与 Preview `runtimeStatus` 未完成改动阻断 | S14 保持 In Progress；用同类真实长任务复核摘要收起、正文保留和状态轮换 |
| 2026-07-23 | S14 多对话并行恢复 | 纠正重建时移除旧版多 Runtime 能力的范围回退；Kernel 按 Session 隔离 Runtime、事件、provisional materialization、命名和 Conversation 投影，Renderer 允许运行中切换/新建并显示后台运行状态。166 项 core tests、`pnpm typecheck`、生产 build 与 `git diff --check` 通过 | S14 保持 In Progress；下一次 AppImage 候选将发布验证器的单 Runtime 断言升级为并行 Runtime 断言 |
| 2026-07-23 | S14 思考正文排版稳定 | 移除过程层对 commentary 和 thinking 正文的 `text-control/line-meta` 缩小覆盖，统一使用 `text-body/line-body`；流式正文被识别为过程内容后不再重新换行和跳动，完成态继续依靠低强调颜色与整体折叠收敛。生产 build 与定向 diff check 通过 | S14 保持 In Progress；用真实长段流式 commentary 复核完成瞬间的滚动与换行稳定性 |
| 2026-07-23 | S14 状态动效 | Project 摘要增加由真实多 Runtime context 派生的进行中 Session 数量，后台 Project 状态变化也会刷新前台；Session 无限转圈改为启动、处理、收尾三段轨迹，thinking 改为独立短波形呼吸，并补齐 reduced-motion 静态表现。69 项 Kernel 定向测试、`pnpm typecheck`、生产 build 与定向 diff check 通过 | S14 保持 In Progress；在后续真实长任务中观察多 Project 并行与 thinking 动效节奏 |
| 2026-07-23 | S14 Session 圆形动效纠正 | 按用户反馈撤回 Session 三段轨迹，恢复圆形轮廓；使用由弱到强的渐变弧、前端光点与带节奏变化的旋转替代单根边框匀速转圈。Project 活动数量和 thinking 短波形均未修改。`pnpm typecheck`、生产 build 与定向 diff check 通过 | S14 保持 In Progress；在真实并行对话中观察圆弧运动质感 |
| 2026-07-23 | S14 图片与文件输入 | 对照本机 Pi 0.80.10 TUI/RPC 源码补齐附件链路：系统多选由 Main 读取，拖放和剪贴板由 Renderer 显式读取；文件包装为 `<file name="…">…</file>`，图片经过尺寸/体积处理后以原生 `images` 发送，Conversation 恢复与运行中队列只投影附件摘要。173 项 core tests、`pnpm typecheck`、生产 build 与 `git diff --check` 通过 | S14 保持 In Progress；下一次 AppImage 候选从真实 Composer 复核选择、粘贴、拖放及支持图片的 Provider 请求 |
| 2026-07-23 | S14 运行状态归属 | 修复目标 Session 启动期间沿用旧 `activeSessionKey`，导致上一条 Session 错误显示转圈的问题；Kernel 按 Runtime context 重算 Session summary，生命周期变化发送完整状态，Renderer 不再用顶层 Runtime 覆盖单条状态，启动失败同步清理临时归属。175 项 core tests、`pnpm typecheck`、生产 build 与 `git diff --check` 通过 | S14 保持 In Progress；后台真实运行的 Session 继续独立显示状态 |
| 2026-07-24 | S14 文件引用语义纠正 | 进一步核查 Pi 0.80.10 交互式 TUI 后，确认输入框 `@文件` 只插入路径，CLI 启动参数 `pi @file` 才会预展开全文。GUI 普通文件改为 `@路径` 引用，选择与拖放不再读取全文；Agent 按需调用带 2,000 行/50 KiB 截断的原生 `read`。图片继续通过 RPC 原生 `ImageContent` 发送 | 完成全量 core tests、生产构建与 diff check；在真实 Composer 中复核选择、拖放和图片粘贴 |
| 2026-07-24 | S14 发送后交互锁定 | 修复发送动作沿用全局 `pendingAction`、导致 Pi prompt RPC 返回前 Session 按钮和 Composer 同时禁用的问题；发送类动作改为非全局互斥，Composer 乐观清空已提交草稿并保持焦点，异步失败只在原对话安全恢复。`pnpm typecheck`、生产 build 与 `git diff --check` 通过 | S14 保持 In Progress；后续真实使用中复核跨对话连续发送与失败恢复 |
| 2026-07-24 | S14 对话流时序与可读性 | 参考成熟 Agent 对话流的信息层级，保留标准档既定的双层阅读结构：commentary / 非摘要 thinking 进入主阅读线，摘要 thinking 与工具在同一个轮换状态中按原始顺序记录并可展开；成功工具不再显示逐项毫秒耗时，过程样式移除默认节点、竖线和紧凑卡片背景。`pnpm typecheck`、生产 build 与 `git diff --check` 通过 | S14 保持 In Progress；在真实长任务中观察过程正文、单行状态与最终回答的阅读节奏 |
| 2026-07-24 | S14 职责边界审计 | 按实际依赖图复核 Main、Runtime、Renderer 与文档边界；修正 Workbench composition ownership、跨 feature 密度定义和单消费者 Runtime 状态工具，并将 D-017 多 Runtime 当前规则与 S8–S13 历史证据分开。Kernel context 镜像和 Pi-specific RuntimeHost 经异步生命周期与调用面审计后保持现状，不为形式纯度扩大重构。`pnpm typecheck`、生产 build 与 `git diff --check` 通过 | S14 保持 In Progress；下一次候选发布时从真实 AppImage 重跑完整 gate |
| 2026-07-24 | S14 模型参数生效纠正 | 复核确认 CPA 的 Codex-client 目录把 Luna/Sol/Terra 报为 372K，但固定 Pi 0.80.10 的原生 OpenAI Provider 定义为 272K；Provider Store 改用标准 `/models` 的 `owned_by` 定位 Pi 原生模型定义，并把完整 Pi-compatible 参数同步进 `models.json`。详情收为一套参数；真实 `pi --list-models vvqq-cpa` 已显示 5.6 三模型 272K / 128K / 图片输入 | S14 保持 In Progress；运行中的旧 Pi 进程不热加载配置，新建 Runtime 使用同步后的模型参数 |
| 2026-07-24 | S15 Planning | 完成当前 GUI 与 Pi TUI 差距的逐项讨论；将确认纳入的 Session、输入、资源信任、认证、快捷键、统计和压缩状态能力收敛为六个有序阶段，并明确 Tree/Clone、CLI、工具控制、队列修改、Extension UI 和高保真压缩等非目标 | S14 仍为当前 Slice；完成 S14 收口后将 S15 改为 Ready，并按 S15-1 至 S15-6 实施 |
| 2026-07-24 | S15 Plan Audit | 复核固定 Pi 0.80.10 的公开 RPC、包根 SDK 与当前 Kernel/Renderer 边界；补齐 Fork 真实 entry/活动路径与 Runtime 迁移、归档撤销凭据、离线导出安全、搜索边界、trust 公开接口、credential 瞬时输入、统计口径、快捷键默认表、压缩 lifecycle 和验证隔离 | S15 保持 Pending；先完成 S14，再按调整后的 S15-1 至 S15-6 阶段出口实施，任何入口都不得早于真实 typed 执行链路出现 |
| 2026-07-24 | S14 Complete / S15 Start | S14 已实现的四十项优化通过当前 207 项 core tests、typecheck、生产 build 与 diff check；S14-13 因 Pi 0.80.10 缺少 typed queue mutation RPC 明确延期，Renderer 不伪造队列修改 | S14 完成；S15 进入 In Progress，先实施项目资源 trust 与当前 Session reload |
| 2026-07-24 | S15-1 Complete | Main 只从已验证 Pi 0.80.10 的 package root public export 使用 `ProjectTrustStore` 与资源检测；四种决定、取消、继承决定、并发 resolve、shutdown、一次性 argv 和隔离持久写入均有定向覆盖。当前 settled persisted Session 可原子 reload 目标 Runtime，失败保留旧 Conversation 与 pointer；`/reload` 只在链路可用时进入 catalog。Renderer 使用 feature-owned 可访问模态框承载决定，不建立 trust schema | 207 项 core tests、`pnpm typecheck`、生产 build、diff check 通过；真实包根只读探针确认 0.80.10 public exports 与 `--approve` / `--no-approve` 解析。S15-2 Ready |
| 2026-07-24 | S15-2 Complete | Fork 候选只来自 Pi `get_entries` 的 leaf-to-parent 活动路径和真实 entry ID，并排除带图片的用户消息；同一 Runtime 完成 fork 后校验全新 Session 身份、投影与 canonical pointer，再原子迁移 context，失败停止已重绑定 Runtime 并保留原会话事实。归档建立多个独立、单次、单调截止的 5 秒凭证，支持仅恢复导航的撤销与不启动 Runtime 的临时只读预览；Renderer 提供可访问选择器、Composer 草稿回填和多条 portal 通知 | Pi RPC、ProjectStore 与 Kernel 定向测试通过；独立 backend / Renderer 审计修正提交边界和 browser preview 多凭证合并问题。S15-3 Ready |
| 2026-07-24 | S15-3 Complete | Main 读取已校验 Session JSONL 的最终 leaf 活动分支并生成带严格 CSP 的离线 HTML，只序列化用户消息、Assistant 最终回答、安全 CommonMark/GFM、代码和合法 Pi 图片；系统保存路径不返回 Renderer。Assistant 每条已完成最终回答可复制原始 Markdown。Session tooltip 的生命周期统计由停机 JSONL 全 entry 扫描或活动 Pi `get_session_stats` 提供，上下文 tooltip 同步显示 Pi cost | HTML 安全、transcript/statistics、Runtime 转发和 Kernel 集成定向测试通过；统计不启动额外 Runtime、不保存第二份事实，导出不包含其他分支、过程消息、工具内容、项目路径或成本。S15-4 Ready |
| 2026-07-24 | S15-4 Complete | Main 通过窄 typed IPC 搜索当前 canonical Project 的相对文件/目录名，使用无跟随且固定的目录句柄消除外部 symlink 遍历窗口，排除 `.git` 并遵守分层 `.gitignore` / `.ignore`；Composer 以 100ms debounce 搜索、核对 Project/query/input/cursor 身份并丢弃过期响应，只插入安全路径引用。`/fork`、`/export`、`/copy` 由 Renderer 执行既有 GUI 链路，Kernel 对直调明确拒绝且不向 Pi 发送 slash 文本 | 233 项 core tests、5 项 HTML 导出测试、`pnpm typecheck`、生产 build 与 diff check 通过；三路只读终审覆盖路径安全、Composer 交互和 GUI 命令隔离，并据此修复目录校验与遍历间的 symlink 竞态。S15-5 Ready |
| 2026-07-24 | S15-5 Complete | 设置新增独立凭证页，只展示固定 Pi 包根 `ModelRuntime` 实际声明的认证方法与脱敏元数据；认证 prompt 通过窄 typed 事件交互，已有 secret 不回读 Renderer。登录或退出后刷新凭证与模型目录，只为正在使用对应 Provider 的 Session 建立内存“需重载”标记；当前生成不中断，标记只在用户显式 reload 完整成功后清除 | 241 项 core tests、`pnpm typecheck`、生产 build 与 diff check 通过；三路只读终审覆盖 SDK 边界、secret 脱敏、取消竞态、Renderer 可访问性和多 Runtime 标记。隔离临时 agent 目录使用一次性随机 QA 值验证公开 SDK 的 API-key 存取、元数据与退出闭环，未读取默认 `auth.json`、未请求外部 Provider API。S15-6 Ready |
| 2026-07-24 | S15-6 Complete / S15 Complete | 设置新增固定 11 个应用动作的快捷键页；完整 binding map 以 XDG config v9 持久化，`null` 明确表示未绑定，录入、冲突/保留组合拒绝、清除和恢复默认均复用同一 shared 校验。快捷键只在窗口聚焦且没有模态框、菜单、认证交互或 IME 组合输入时执行，文本控件只接受固定默认表中的已确认安全组合，不注册 `globalShortcut`。Pi `compaction_start` / `compaction_end` 按 Runtime context 归一化 reason、outcome 与 `willRetry`；成功后原子刷新 Timeline、usage 和生命周期 statistics，失败、取消、异常事件或 teardown 保留旧投影并显式收口等待 promise，不伪造 `agent_settled` | 254 项 core tests、`pnpm typecheck`、生产 build 与 diff check 通过；三路终审修复 nullable wire result、overflow `willRetry`、active-run 边界、通知叠放、异常/teardown promise 悬挂和 IME 229。隔离 XDG 与 `PI_CODING_AGENT_DIR` 的真实 Pi 0.80.10 Electron probe 通过；当前源码打入临时 AppImage 后再次通过同一隔离 probe，临时产物已清理且未覆盖仓库既有 release。S15 Complete |
| 2026-07-25 | Session 无感启动 | 纠正 S14-03 的“只读浏览、首次发送才激活”语义：侧栏单击历史 Session 立即投影历史并 `activate-session` 启动/恢复 Runtime；活动 stopped/crashed Session 再次点击也会恢复。发送时自动激活与 Composer 恢复按钮保留为失败回退 | 文档与实现同步；`pnpm typecheck`、生产 build 与 diff check 验证 |
| 2026-07-25 | Session 后台启动丝滑化 | 纠正“点击即启动”被做成全局 exclusive 等待的误解：点击当帧切换可见目标与历史预览；`activate-session`/`start-session` 走非阻塞 ensure 泵，不再锁死侧栏；历史 Session 以 120ms settle 合并快速连点，只启动最后停留目标；已有受管 Runtime 立即切换；提交/命令仍可 await 同一 ensure | Renderer 协调层改动；Kernel launch 单飞不变；见 `p2-workbench-structure.md` §6.2 |
| 2026-07-26 | S16 Complete | 对比 pi.dev 与上游源码后选择 `@mjakl/pi-subagent`；config v10 持久化最大深度和循环保护，Runtime 仅在 Package 已安装且 Extension 已开启时传入上游公开参数；新增独立 Subagent 页，并在拓展页复用同一真实开关。150 项定向 core tests、`pnpm typecheck`、生产 build 与 diff check 通过 | 保持显式安装和 reload 生效边界；后续只有在真实需求确认后再讨论 Agent definition 编辑或运行中任务视图 |
| 2026-07-26 | S16 Package 更正与迁移 | 更正首期固定 Package 为 `pi-subagents`；选择依据的数据快照为 pi.dev 128K/mo、GitHub 2.7k stars / 572 commits。Runtime 改由 `PI_SUBAGENT_MAX_DEPTH` 配置深度；config v11 从旧 v10 迁移最大深度并移除旧 Package 专属 cycle setting | 保持用户显式安装、Extension resource filter 启停和 reload 生效边界；不新增 Agent CRUD 或任务监控 |
| 2026-07-26 | S16 已适配拓展入口收口 | 默认 Pi 用户环境已从 `@mjakl/pi-subagent` 迁移为 `pi-subagents`；拓展页将固定适配项提到独立“已适配拓展”区域，负责安装与启停。Subagent 页删除重复安装/启停入口，只读取可用状态并修改最大嵌套层数 | 保持 Pi PackageSource 为安装与启停事实源；通用目录、本地路径与运行参数生效时机不变 |
| 2026-07-26 | S17 Complete | Subagent 页增加真实 Agent definition CRUD：内置 Package 文件保持只读，但界面可直接编辑并可删除同名覆盖恢复默认；自定义角色可新增、修改、重命名和删除；单 Agent 启停复用 `pi-subagents` 官方 disabled override；Agent 列表每页 6 项，支持作用域/启动状态筛选、跨分页多选与单字段批量修改，编辑器把常用内容与高级运行边界分开。Main 只管理固定 Agent 与 settings 路径，保存时保留未受 GUI 管理的 frontmatter 和其他 Pi 设置 | 保持拓展页为安装/启停唯一入口；新建或显式 reload 后加载定义和启停状态。运行任务、Chain、Watchdog 与 Profile 管理后续按真实需求单独规划 |
| 2026-07-26 | S18 Architecture Ready | 完成 OMP 固定基线、现有 Pi 单 Advisor 移植和当前 GUI 边界调查；接受“固定 Multi Advisor Pi Extension + GUI 特别适配”方案，并形成四种状态、三层开关、事实来源、WATCHDOG、typed 协议、Timeline 和五阶段验收文档 | S18 Ready；下一步只进入 S18-1，先冻结公开 Pi 能力、Package 和单 Advisor 协议，不并行铺设完整 GUI |
| 2026-07-26 | S17.1 Complete | 固定适配 `@cortexkit/pi-magic-context`；安装与启停复用 Pi PackageSource，scoped/version source 可安全匹配并保留其他 resource filter。界面明确区分 Package 开启与 setup/健康状态，配置、doctor 与 `/ctx-status` 继续使用上游真实入口 | 保持可选且不自动安装；后续只有上游提供稳定机器状态接口时才评估 GUI 内缓存指标，不读取私有 SQLite 或复制交互式 setup |
| 2026-07-26 | S18-1 In Progress | 建立独立 `pi-gui-multi-advisor` 0.1.0 Package：默认关闭、strict 原子 state、`/advisor on/off/status`、一个使用当前 Provider 中 `gpt-5.6-sol + medium` 并复用 Pi auth 的只读独立 Agent、有界 turn queue、protocol v1 capability/advisory、TUI renderer、冻结 WATCHDOG schema 和来源说明。7 项离线测试、独立 TypeScript 校验、npm pack dry-run 与隔离 Pi 0.80.10 本地安装/加载/命令/capability 探针通过；目标模型、reasoning 或 auth 缺失时明确暂停，不回退主模型 | 使用明确 QA/provider 凭证完成一轮真实 Advisor model review 和 advisory 持久化；通过前 S18-1 不标 Complete，也不进入 GUI S18-2 |
| 2026-07-26 | S18-1 Model Policy | 用户确认 Advisor 核心审查应优先保证推理质量；D-039 将首阶段模型从“跟随主模型 + low/off”改为当前 Provider 中的 `gpt-5.6-sol + medium`，缺失时 Fail Fast，不静默回退 | 完成离线测试、Extension 类型/加载校验和 diff 复核；真实 Provider turn 仍使用明确 QA 凭证，GUI 模型选择留在 S18-3 |
| 2026-07-26 | S18-1 Complete | 使用明确授权的现有 Provider 凭证完成真实计费验收：primary 为 `vvqq-cpa/gpt-5.6-terra + low`，独立 Advisor 为 `vvqq-cpa/gpt-5.6-sol + medium`。Advisor 发出 `blocker`，指出路径安全方案存在校验后再访问的 TOCTOU / 符号链接逃逸；实时 advisory 与临时 Session JSONL 各确认一次，Pi 退出码 0、stderr 为 0。认证由 Pi 读取，隔离 Agent dir 与 Session 验证后清理 | S18-1 Complete；S18-2 Ready，下一步实现严格历史/实时投影、typed control、拓展页固定项与 Timeline Advisor 卡片 |
| 2026-07-26 | S18-2 Complete | Main 增加 capability/advisory strict projector 和 per-Session Advisor state；Pi RPC 的固定 adapter allowlist 增加 Advisor capability；preload 增加 live system 与 Extension resource 两个窄命令。拓展页显示真实本地 Package resource 开关，Advisor 页显示协议/版本/当前 Session system，Timeline 在所属 turn 中显示审查卡 | 151 项后端定向测试、`pnpm typecheck`、`pnpm build` 与 diff check 通过；S18-3 Ready，下一步实现 WATCHDOG 发现/合并、多隔离 Advisor 与 roster typed CRUD |
| 2026-07-26 | S18-3 Complete | Package 升级为 0.2.0 / protocol v2；实现受 Project trust 约束的 WATCHDOG 发现、祖先到叶子合并、内建 Default 覆盖层和每 slug 独立 Agent/队列。Main 以 YAML AST 提供固定 user/project typed CRUD，Advisor 页显示 effective roster、来源、诊断并编辑模型、thinking、工具和指令 | 默认 `read/grep/find/ls`；D-041 允许单 Advisor 显式授权 `edit/write` 并持续告警，不开放原生 `bash`。285 项 core tests、15 项 Extension tests、typecheck、生产 build、diff check 与 pack dry-run 通过；S18-4 Ready |
| 2026-07-26 | Subagent 显示边界修正 | `pi-subagents` 适配补上 Conversation 显示面：前台工具运行默认按参与者显示紧凑任务胶囊和同行整体状态，点击后展开 Agent、当前活动、用量和结果；后台完成、控制、转向与 supervisor custom message 进入 Timeline 通知。Main 丢弃 child messages、recent output、transcript 与 artifact 等原始 details | 完成当前工作区 typecheck、生产 build 与 diff 复核；不增加任务中心、子会话浏览、artifact 读取或运行控制 |
| 2026-07-26 | S19 详情侧栏规划 | 用户确认 Subagent 胶囊的目标展开方式参考 Codex：主对话保留，右侧打开独立任务阅读面。当前 Workbench 没有右栏容器和交互协议，故不在 S18 中临时拼装 | S19 Pending，排在 S18 后实施；此前保留轻量行内 disclosure |
| 2026-07-26 | S19 Source Slice | Timeline participant 胶囊改为真实按钮并以 Conversation identity + toolCallId + participant.index 定位；Workbench 新增宽窗口第三列、较窄窗口详情面、关闭/返回/Escape/焦点恢复与 identity/目标消失关闭。详情只读归一化任务摘要并随 tool output patch 或完整 state 更新 | 初版 331 项 core tests、typecheck、生产 build 与 diff check 通过；review 后继续补强 Escape、焦点、patch 一致性与真实组件测试 |
| 2026-07-26 | S19 Review 修复 | Composer 全局 Escape abort 增加显式 enable/defaultPrevented 门禁，Workbench 以 capture 层级保持设置 > 详情 > abort；胶囊写入稳定 data identity，选中任务从 live 转为 completed 时自动保持对应过程展开，并从当前 DOM 恢复焦点；metadata-only message/thinking/tool 更新回退 full state，append patch 增加 toolCallId 校验并忽略旧 duplicate metadata；Subagent 胶囊、完成过程与详情改用 Vite SSR 真实渲染测试，test:core 纳入 Main export tests | 348 项 core tests、`pnpm typecheck`、生产 build 与 diff check 通过。S19 仍需真实 AppImage 交互与 clean release gate；S18 暂停至 S19 完成 |
| 2026-07-26 | S19 AppImage Source Snapshot Gate | 从 canonical 未提交源码快照建立临时隔离 git 候选并 frozen install/package，生成 SHA-256 `1a93ec51025950f62a9dab8bc5057b0223f00a2a5e10d5485c06bf684706894d` 的 AppImage。真实 Pi 0.80.10 中发起 3 路并行 worker，验证运行态 capsule、Escape 不 abort、live→completed 保持、1600px 第三列、1100px 详情替换、返回/关闭/Escape 焦点恢复与 reduced-motion；三张截图经确定性像素遮罩，报告记录最终哈希 | `source_snapshot` passed，证据位于 `release/evidence/2026-07-26T21-31-42-278Z-s19-source-snapshot/`。隔离 XDG/Agent dir，但只读使用默认 auth 且 canonical 不 clean；不算正式发布，S19 保持 In Progress，下一门槛为 clean canonical `pnpm verify:linux` |
| 2026-07-26 | S19 Official Verifier Ready | 唯一 `scripts/verify-linux-release.mjs` 兼容 provisional cold-start 自动启动，并在原 P1/P2 链路后加入 S19：Niri 精确宽/窄窗口、3 个 worker 同时 running、稳定 locator、Escape/关闭/返回焦点、live→completed identity 与 reduced-motion；schema v2 增加脱敏 `s19Summary` 和三张截图。review 发现并修复最终输出/error 遮罩、并行重叠断言、完成后 locator 复核和 failed report 虚列截图 | `node --check`、348 项 core tests、`pnpm typecheck`、生产 build 与全仓 diff check 通过；正式脚本尚未在 canonical clean commit 上执行，S19 继续保持 In Progress |
| 2026-07-27 | S19 Subagent 正文收敛 | 按用户确认移除普通 completion custom message 的正文结果预览；前台任务胶囊保持不变，后台 completion 形成独立轻量胶囊并复用任务详情，需要介入的控制、转向、supervisor 请求与 Watchdog 通知继续显示 | Main 按固定协议归一化 completion 详情，Renderer 以 notice identity 打开详情且不猜原 `toolCallId`；增加投影、locator 与 SSR 定向测试。S19 仍待 canonical clean `verify:linux` |
| 2026-07-27 | S19-1 Supervisor 协作收敛 | 将重复 attention、具体 request、reply 与 wait 从多段协议日志收敛为结构化生命周期；request 以稳定 ID 去重并替代同 run participant 的泛化 attention，成功 reply 原地更新为已处理 | Main 白名单投影协调 identity/reason/status，Renderer 将内部协作降级为 status，并为 wait/reply/status/steer/resume 使用简洁文案；只有 completion guard 与 Watchdog blocker 使用 alert，原始命令只在技术详情中出现 |
| 2026-07-27 | P2.1 Experience Refinement Planning | 用户确认下一阶段集中于动效与交互、Settings 优化与有限定制、Subagent/Magic Context 可解释性；接受四组设置导航、阅读宽度/Navigator 密度/动效偏好、Magic Context 安装与状态入口分离，以及 S19 → S18-4 → S20 的实施顺序 | 增加 S20–S25 与 D-047–D-050；当前唯一 In Progress 仍是 S19，规划不改变 dirty source snapshot，也不提前激活未具备真实协议的控制或健康 UI |
| 2026-07-28 | S19 Complete / S18-4 Resume | Canonical clean commit `b9562b4` 的 AppImage 正式通过 `pnpm verify:linux` 全部 18 步；P1/P2 回归、三路 worker 同时 running、Escape 优先级、live→completed、宽/窄任务详情、三种焦点恢复和 reduced-motion 全部通过。Gate 期间修复 crashed Context 显式恢复、managed Session active pointer 持久化、live completion notice 去重，并将官方 verifier 对齐当前 typed contract 和 DOM identity | S19 标记 Complete；S18 恢复 In Progress，S18-4 成为当前唯一实施阶段；正式证据位于 `release/evidence/2026-07-27T16-45-59-798Z-b9562b4ca6c3/` |
| 2026-07-28 | S18-4 Complete / S20-1 Start | `pi-gui-multi-advisor` 升级为 0.3.0：严重度驱动 aside/steer，真实 steer 后三轮禁止连续中断；每 Advisor backlog 只保留最新一项并在 30 秒过期；generation + run token 隔离 reset/compact 后旧 completion；context 预算包含 system/tools/provider usage，最多 fresh reset 一次；assistant `message_end` 在工具 dispatch 前 quarantine 未授权工具和无当前来源的危险输出；session dedupe、content-free 抑制、三次 transient 上限与 quota/permanent/paused 状态均有界 | 29 项 Extension 测试、独立 typecheck、453 项 core tests、0.3.0 pack dry-run 与隔离真实 Pi RPC 双轮 smoke 通过；根级 typecheck 被并行 Navigator `completionRevision` contract 修改阻断，非 Advisor 路径。S18 暂停并保留 S18-5 Pending；S20 进入 In Progress，S20-1 成为当前唯一实施阶段 |
| 2026-07-28 | S20-1 Motion Contract Complete | 复用现有四档 duration 与两类 easing；普通 transition 不允许 raw timing；移除 Workbench `grid-template-columns` 和 Todo `grid-template-rows` 插值，避免 Timeline 宽度与 measured Composer clearance 在动效窗口内持续重排；全局 loading 补显式静态 reduced-motion，Todo reduced 状态改为 transition none；持续 activity 保持 feature-local 周期并要求静态状态语义 | 5 项 motion contract tests、clean isolated typecheck/build、446 项 core tests、diff check 和隔离 browser preview 通过；侧栏切换后主区宽度一次提交并稳定，浅/深语义 token 可区分，五类 activity 在 reduced-motion 下 animation 均为 none。S20-2 随后开始实施 |
| 2026-07-28 | S26 Memory Diagnosis Start | 用户将内存列为最高优先级并要求立即诊断。Live PSS、`smaps`、Electron app metrics、Renderer CDP 和 source audit 已区分 Renderer native allocation、重复完整 state/IPC 和无 idle eviction 的多 Runtime 三条路径；对照 Chrome tab discard、Jupyter kernel culling、VS Code extension host 与 Electron profiling 原则后冻结“持久 Session 与执行 Runtime 分离、busy 保护、显式休眠、quiescence lease、保守 LRU”方向 | S20-2 暂停，S26 成为唯一 In Progress。同一诊断 AppImage 两次通过现有 18 步 gate并各记录 8 个内存点，第二轮绑定 `981282e`；80 秒 Subagent 场景稳定为 305–317 full state / 31–33 patch。Canonical 存在其他在途 writer 时不直接覆盖，详细证据见 `memory-diagnostics.md` |
| 2026-07-28 | S26 IPC containment / hibernation groundwork | Mutating IPC 改为 revision acknowledgement + Renderer applied-revision barrier，Subagent/Todo/attachment metadata 走 identity-safe patch；Kernel 增加非前台持久 Session 的显式休眠内部原语，并在 stop/launch cleanup 失败时保留 Runtime ownership | Rebased `p2` 隔离分支通过 typecheck、476 项 core tests、16 项 barrier/metrics 定向测试、verifier 语法与 diff check；该阶段休眠仍仅为 Kernel 内部 groundwork，Project/全局显式控制、quiescence lease、自动回收与 LRU 尚未交付 |
| 2026-07-28 | S26 Explicit Runtime Hibernation | 将 Session、Project 与全部空闲 Runtime 的用户显式休眠贯通 typed command、Main、preload 与 Navigator；单项执行时严格失败，批量执行时重检 gate、跳过仍 busy 的目标并反馈休眠/跳过数量；Session pointer 与 transcript identity 保留，重新打开恢复同一 Session | `pnpm typecheck`、生产 `pnpm build`、8 项 hibernation 定向测试、mutation ack/command validation 定向测试与 scoped diff check 通过；当前运行中的旧 Main/Renderer 需重启后才加载入口。Extension operation lease、自动回收与 LRU 仍为 S26 Pending |
| 2026-07-28 | S20-2 Timeline & Composer Stability Complete under S26 priority | 在独立 clean candidate 中完成显式 following/reading 状态、caret/turn 阅读锚点、canonical output sentinel、Composer measured layout event、window/sidebar/detail 同步稳定与窄屏隐藏恢复；没有修改 Kernel、IPC 或 S26 内存治理源码 | commit `22cf15c` 通过 isolated typecheck/build、457 项 core、11 项 contract tests、diff check 与 Electron 行为 probe，独立 review 无 blocker/high。S20-2 标记 Complete；S26 继续保持唯一 In Progress，S20 暂停于 S20-3，S21 保持 Planned |
| 2026-07-28 | S26 Manual Runtime Hibernation Removed | 按用户确认删除 Session、Project 与全局空闲 Runtime 的主动休眠按钮、通知、Renderer action、typed command、Main/preload API 和批量实现；Kernel 只保留不经 IPC 暴露的单 Runtime 回收原语，继续覆盖严格 gate、stop 失败 ownership、launch 串行化和同 identity 恢复 | 主动休眠不再是独立产品能力；D-058 替代 D-052 中对应产品面。自动 quiescence/operation lease、grace period、压力触发与 LRU 仍为 S26 Pending，现有 `ready/settled` 不能单独触发自动停止 |
| 2026-07-28 | Navigator 项目 / 任务分区 | Navigator 增加一级“项目 / 任务”Tab：Project 继续使用 Project→Session 层级，Task 使用独立 XDG Task registry、UUID owner 与隐藏工作目录，每个 Task 严格只拥有一个 Session。Tab 与各自最后目标持久恢复，切换只改变前台投影并保留后台 Runtime；空 Task 不在冷启动自动创建，重复新建复用当前空 provisional，首条 prompt 后再新建才创建独立 Task。任务模式关闭 Project trust、path search 与 fork，通知按 typed Task identity 跳转；Subagent 可见命名同步收敛为“子任务”。 | 当前 `source_snapshot` 通过 `pnpm typecheck`、生产 `pnpm build`、682 项 core tests 与 scoped diff check；独立 review 指出的通用 `start-session` 第二 Session 绕过已在 Kernel/Main/Composer 三层封堵，归档 Task identity 由持久化测试确认保留。未运行真实 AppImage 交互 gate，S26 仍为唯一 In Progress Slice。 |
| 2026-07-30 | P3-0 前置基础 / KISS 范围纠正 | 将已验收的 Pi typed RPC bridge、通用 Right Sidebar、历史 Prompt 原位编辑、Git Main/IPC 与离线 Capability Inventory 合入 canonical；历史编辑最终只使用原生 `navigate_tree → prompt → refresh`，停止 atomic navigate+prompt、projection watermark 与 heavyweight artifact admission 实验。Git 与 Inventory 仍无产品 UI，P3 不因此启动或完成 | canonical 合入后离线 frozen install、typecheck 和 856 项 core 测试为 855 pass / 0 fail / 1 built-worker skip；相同源码隔离 build 与 built-worker 测试已通过。下一步先建立 clean candidate 和正式 AppImage gate；S26 继续是唯一 In Progress，P3 继续 Pending |
| 2026-07-30 | S26 Main state delivery containment | Main 将连续 full-state/patch 以 8ms、最多 64 项 envelope 有界发送；新 full state 淘汰旧 pending state，compaction 等领域事件保持顺序屏障。Renderer 逐项复用 revision/ack/resync；active stderr diagnostic 改为窄 runtime patch；verifier 记录并校验 batch envelope/member/max-size | 基于最新 P3-0 dirty source snapshot 隔离实现；`pnpm typecheck`、865 项 core tests（864 pass / 1 built-worker skip）、verifier syntax 与 production build 通过。不修改视觉组件、Task Navigator、自动休眠或 Runtime ownership。该切片只约束 Main 发送前队列，不声称提供 Electron 下游字节级背压；正式结论仍需 canonical AppImage memory gate |
| 2026-07-30 | P2 / S26 Complete | canonical commit `152a9a3` 通过 19 步正式 AppImage + memory gate：P1/P2、两个 Project、三个物化 Session Runtime、slash command、三路 Subagent详情、五分钟自动休眠、显式恢复、对话保留和固定内存红线全部通过；峰值总 PSS 2.50 GiB、Renderer PSS 156.7 MiB、heap 25.9 MiB、state 98.2 KiB、swap 0，3→2→3 Runtime闭环成立 | P2与S26标记Complete；证据 `release/evidence/2026-07-29T18-48-57-827Z-152a9a3a0725/`，AppImage SHA-256 `114a7040a20cd21dd89dfe3de181334ef36d2d9698324ed3da76f0b8efd4e417`。P3改为Ready，下一 Slice为P3-1 Git Changes Sidebar |
| 2026-07-30 | P3 Planning | 用户确认 P3 顺序为 Changes → Commit & Push → History → Branches & Sync → Capability Center → Capability管理 → MCP；P3-1使用 Session Header单一入口、右侧栏 Git模块、单一 Uncommitted Changes列表、文件内 Working/Staged diff和文件级 Stage/Unstage | 计划版本更新为9.0；P3-1保持Ready。首个Slice明确排除commit/sync、watcher/polling、hunk/line staging、conflict resolver和占位Tab，下一步按现有typed Git foundation实现Changes UI |
| 2026-07-30 | P3 Parallelization | 固定“单一当前Slice、Slice内并行”的多Agent执行方式：Parent先冻结接口和文件ownership，每批最多两个隔离writer与一个只读reviewer，Parent作为唯一integrator和acceptance owner | 计划版本更新为9.1；P3-1拆为Right Sidebar shell与新Git Changes feature两条独立writer，现有Git contract安全复核只读并行。未来Slice只记录可拆边界，不在前序Slice验收前启动产品实现 |
| 2026-07-30 | P3-1 Complete | Parent 集成两条隔离 writer 结果并按只读安全复核收口 response identity、stale trust/diff/mutation、conflict、binary/oversized 与错误脱敏；未修改既有 Git contract/Main/preload | Renderer 52/52、Main Git 49/49、typecheck、production build 与 diff check 通过；P3 标记 In Progress，P3-2 Commit & Push 改为 Ready |
| 2026-07-30 | P3-1 Shell correction | 按用户复核将 Session Header 的 Git 一级图标改为通用右侧栏展开/收起控制；新增与左侧栏镜像的右栏图标，Git 与 Subagent 继续只作为栏内真实 Tab | 删除独立浮动 reopen 入口，统一 Header toggle、栏内 collapse、Escape/close 焦点和正式 verifier 的重开路径；不建立模块 registry 或未来占位 Tab |
| 2026-07-30 | P3-1 Changes density correction | 按用户实际使用反馈参考 Cursor 收敛大量文件时的信息层级；默认不展开 diff，增加可信 status 范围选择并压缩文件操作 | 单列表支持 Uncommitted/Unstaged/Staged；mixed 在过滤投影只显示对应 diff 与 mutation；文件操作改为图标，冲突说明不重复占高。DTO 未提供的总增删行、Last Turn、Branch Commits 不伪造；Renderer 54/54、typecheck、production build、verifier syntax 与 diff check 通过 |
| 2026-07-30 | P3-1 Diff folding correction | 按 Cursor 真实行为允许多个文件独立展开，增加标题区全部折叠，并显示 hunk 间被省略的未修改行 | per-file token 隔离并发 diff；canonical hunk range 生成 `N unmodified lines` 折叠条并移除 raw `@@`。省略文本与尾部行数不在 DTO 中，因此当前折叠条保持只读，真实上下文展开留给有界 Main/IPC 协议；Renderer 56/56、typecheck、production build、verifier syntax 与 diff check 通过 |
| 2026-07-30 | P3-1 Diff performance hardening | 按用户性能反馈加入 typed DTO 意图预取、snapshot-bound LRU、同 key single-flight 与大 diff 行虚拟化；独立只读审计覆盖 stale/trust、旧 callback、并发 mutation、DOM、水平滚动与可访问性 | 审计发现的 null-revision identity、exact displayed snapshot、同步 mutation gate、pointer/focus ownership、完整复制/连续阅读、稳定水平宽度和 panel 工作集上限均已修复并经 closure review 确认 Blocker/High 为 0；不修改 Main/IPC 或预渲染隐藏 DOM |


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
| 2026-07-21 | 1.1 | 明确新 Session 的 provisional/materialization 生命周期，并将单活动 Runtime 的进程内边界扩展为正常 GUI 单实例 ownership | Pi 0.80.10 在新 Session 首个 assistant 消息完成前不创建 JSONL；两个 Main 进程共享 XDG 会造成索引读改写丢失更新 | Kernel 只在文件真实落盘、canonical 校验和持久化成功后登记 Session；正常 GUI 第二实例退出并聚焦首实例，`probe-only` 保持无状态独立验证路径 |
| 2026-07-21 | 1.2 | 在 S13 前增加 S12.5 重复职责解耦，并固定“按重复与职责证据拆分，不按文件大小拆分”的规则 | 已完成较多 Main、Kernel、Project、Renderer 工作，需要在继续增加交互前消除真实重复与错误依赖方向，同时避免把单次逻辑过度抽象 | 只新增四个已被当前调用方使用的纯边界；不改变 contract、schema、Runtime 拓扑、视觉或交互；S12 仍按独立视觉证据维护状态 |
| 2026-07-22 | 1.3 | S13 增加首轮目的导向的 Session 语义命名，并记录隔离 Pi metadata 子进程边界 | 用户明确拒绝复制首条消息作为标题，要求像 GPT 一样按对话目的命名；Pi 0.80.10 RPC 又没有独立标题接口 | 单一活动 Runtime 与 Pi Session 事实源不变；名称生成复用 Pi provider/auth，不引入 SDK 或第二套 credential 配置，失败时保持未命名 |
| 2026-07-22 | 1.4 | 在 S13 后增加 S14“优化”，不预设具体事项清单 | 后续将处理零散交互优化，不适合提前固化为详细计划 | S13 仍为当前 Slice；S14 保持 Pending，具体事项在实际处理时记录 |
| 2026-07-22 | 1.5 | 自动命名改为授权目录内的低成本模型选择，并增加自动、关闭、指定模型设置 | 用户指出复用主对话模型成本过高，并要求覆盖 OAuth 登录用户与可修改界面 | 不硬编码 provider、不读取或保存凭据、不回退高成本主模型；Project config 升级为 v3 并保存非敏感命名偏好 |
| 2026-07-22 | 1.6 | S14 首批落地菜单外点收起、两类设置页、Session 无感浏览和导航拖拽排序 | 用户要求拉起现有服务后先处理已记录的四项实际体验问题 | 不新增 Extension 管理假能力，不改变 Pi session 事实源或单 Runtime ownership；浏览不触发 Runtime，实际操作时自动激活，排序仅改变持久化顺序 |
| 2026-07-22 | 1.7 | S14 接入运行中 `steer` / `follow_up` 输入 | 用户指出当前任务执行中 Composer 被锁定，与 Pi 原生消息队列能力不一致 | 扩展 typed Kernel/Runtime/Pi RPC 命令边界并投影队列数量；不改变单 Runtime ownership、Session 事实源或现有 abort 语义 |
| 2026-07-22 | 1.8 | S14 增加 Session 行内归档入口与持久化归档索引 | 用户要求鼠标悬浮 Session 时可在右侧直接归档对话 | XDG state 升级到 v4 并保留旧版本迁移；归档 Session 从普通导航隐藏但不删除 Pi 对话文件，不提前实现归档管理或批量能力 |
| 2026-07-22 | 1.9 | 将 Pi Extension 路径的列出、安装和卸载最小链路前移到 S14 | 用户明确要求 Extension 就是 Extension，不能借 Package 命令或 package 目录表达 | 只维护 Pi 用户设置的 `extensions` 字段；不调用 Package CLI，不接受 npm/Git 来源，卸载不删除源码；Package 仍是 P3 的独立范围 |
| 2026-07-22 | 2.0 | 将运行中普通输入固定为 `follow_up`，并将 `steer` 收敛为 Alt+Enter 特别提交 | 用户明确两者应分别作为默认输入与特别输入存在，不应作为右侧同级按钮 | 只调整 Composer 提交映射、提示和按钮呈现；Pi RPC、Kernel command、排队投影与中止语义不变 |
| 2026-07-22 | 2.1 | 将 Pi 原生运行中队列正文纳入 KernelState 与 Composer 展示 | 用户需要确认消息是否已排队、排队内容及 steer / follow_up 的真实处理时机 | 新增两组只读状态投影和限高队列面板；不改变 Pi 原生命令、队列顺序、Runtime ownership 或 Timeline 布局模型 |
| 2026-07-22 | 2.2 | 队列面板只显示排队正文，不显示 steer / follow_up 类型 | 用户明确不需要在队列内容旁展示“转向”或“跟进” | 只移除 Renderer 类型标签；Kernel 仍分别保留两类队列，Pi 原生时序不变 |
| 2026-07-22 | 2.3 | 工具过程增加紧凑、标准、详细三档展示密度，并默认采用低强调的标准档 | 当前工具时间线、徽标和详情容器过于突出，压过最终回答；用户要求先独立收敛工具展示，再处理 thinking | 仅改变 Renderer 展示与本机偏好；不修改 thinking、Pi RPC、Kernel conversation contract 或 Session 事实源 |
| 2026-07-22 | 2.4 | 将队列修改能力记录为后续协议适配项，不在当前 Renderer 伪实现 | Pi 0.80.10 RPC 缺少单条删除、重排、转换与替换命令；本机补丁无法直接成为可分发能力 | 保留当前只读队列内容展示；后续优先推动上游核心 RPC，并做显式 capability detection；不以默认 Extension 或静默补丁填补协议缺口 |
| 2026-07-22 | 2.5 | Session 切换与新建采用“先跳转、后补票”的 Renderer 导航时序 | preview 文件读取和 Runtime 完整启动此前都阻塞可见选中态，导致切换感知过强 | Renderer view target 立即提交，异步 preview 使用最新请求获胜；首次动作仍经过现有 Kernel 激活边界，不改变 Session 事实源或 Runtime ownership |
| 2026-07-22 | 2.6 | settled 工作过程改为极简外层 disclosure，并为每段 thinking 增加独立低强调折叠 | 用户确认结束后统一收起的结构保留，但旧卡片、状态点和统计串样式不符合目标；参考界面使用“已处理 / 思考了 + 耗时”的两层文档流 | 只改变 Renderer 展示与当前可观测耗时；工具密度、Conversation 顺序、Kernel/RPC contract 和历史事实源不变，缺少可靠历史耗时时不显示数字 |
| 2026-07-22 | 2.7 | 外观页改为分类标题、组内连续行与右侧紧凑控件的设置布局 | 用户提供成熟外观页作为视觉参考；当前四张独立卡片缺少同类设置的层级和密度 | 只重排已有 Renderer 设置；主题仍是只读状态，工具密度与字体持久化语义不变，不新增未接通功能 |
| 2026-07-22 | 2.8 | 冷启动默认创建新对话，不再把最近 Session 作为启动意图 | 用户明确认为每次进入应用应新建对话，恢复旧对话不应成为默认启动处理 | 只调整 Renderer 冷启动落点并复用现有后台启动链路；保留最近 Project、历史 Session、按需恢复、Project 切换和显式 crash resume |
| 2026-07-22 | 2.9 | 主题设置接通跟随系统、深色与浅色，并为工具密度三档补充真实差异图示 | 用户指出主题仍不可修改，并要求核查工具密度是否确有三档及其实际差异 | Appearance contract 增加严格 theme 字段并持久化；旧配置明确迁移为 system；Renderer 监听系统主题并提供浅色 token；工具密度实现不变，只补充与真实分支一致的说明图 |
| 2026-07-22 | 3.0 | 拓展页接入 pi.dev Extension 目录和 npm Package 安装/卸载 | 用户明确要求在拓展页直接发现并安装、卸载 pi.dev 拓展 | 固定使用 pi.dev Extension 目录和 Pi 0.80.10 用户级包管理命令；保留本地路径拓展，第三方代码仍需显式确认；不提前增加更新、Git 来源或通用 Package 管理 |
| 2026-07-22 | 3.1 | 技能页增加由 Pi 驱动的新建技能入口 | 用户明确要求技能部分可以调用 Pi 创建新技能 | 复用当前 Pi prompt 与 Session 激活链路；固定标准技能目录和名称规则，写入前必须展示并确认；不增加直接文件写入、技能编辑或删除能力 |
| 2026-07-22 | 3.2 | 收敛 pi.dev 目录展示密度并采用官方 Logo | 用户希望设置页一次只显示两三个拓展，并用 pi.dev 品牌标识替代文字标题 | 单次结果上限固定为 3；保留搜索与外部完整目录入口；复制官方 SVG 到本地构建资产，不增加远程图片依赖 |
| 2026-07-23 | 3.3 | 纠正 pi.dev 列表与完整品牌组合 | 用户澄清“最多三个”指滚动视窗的可见数量，不是截断结果；官方 SVG 只有 Pi 图形，界面仍需要完整的 `.dev` | 恢复 50 项目录数据并固定三行高滚动视窗；使用官方 Pi 标记加 `.dev` 组合，不依赖远程图片 |
| 2026-07-23 | 3.4 | 将 Package 与 Extension 拆为独立设置分类 | 用户明确 Package 是后续组合、适配和维护的独立边界，不能继续只作为拓展页中的 npm 来源呈现 | pi.dev/npm 安装目录进入 Package 页面；本地 Extension 路径继续由拓展页管理；当前 CLI、IPC 和 Pi 配置语义不变 |
| 2026-07-23 | 3.5 | 按 Pi 真实资源模型纠正 Package 与 Extension 页面职责 | 用户指出首轮把 Extension 目录整体移到 Package 页，混淆了安装单位与资源类型 | Package 页展示完整 Package 目录；拓展页保留 Extension 筛选目录和本地路径；两处 npm 操作均明确安装或卸载整个 Package，逐资源启停不在本项扩展 |
| 2026-07-23 | 3.6 | 将 Package 页面补为用户级管理入口 | 用户确认 GUI 必须管理 Package，但不另写安装引擎 | 复用 Pi 原生 list/settings、install、remove 和 update 语义，增加已安装列表、单项/全部更新与卸载；下载、依赖和持久化继续由 Pi 负责 |
| 2026-07-23 | 3.7 | 补齐桌面启动环境中的用户级 Pi 路径解析 | Package 操作在 Electron PATH 不含 `~/.local/bin` 时无法找到已安装的 Pi | 在现有解析器增加单一 Linux 用户级 fallback，并保留显式路径优先级、权限检查和固定版本约束 |
| 2026-07-23 | 3.8 | 模型复合菜单改用共享 viewport 定位和顶层 portal | 固定 620×420px 的 Composer 内绝对定位面板在实际窗口中过大，并会受到主工作区 overflow 裁剪 | 保留模型/思考强度双栏语义；浮层首选 520×360px，依据触发器与视口动态对齐、翻转和限高，不改变 Kernel/RPC contract |
| 2026-07-23 | 3.9 | 模型菜单从左右分类改为强度优先的上下单列 | 用户指出左右栏增加理解和操作成本；换模型是低频次级操作，思考强度应直接可见 | 主浮层上方展示全部可用强度，下方模型行展开紧凑列表；首选宽度收窄为 380px，保留 S14-24 的 viewport 与键盘边界 |
| 2026-07-23 | 4.0 | 思考强度支持完整 Pi 七档并采用稀疏 map 语义 | GUI 把 map 缺失键误判为不支持，导致只显示显式声明的 `xhigh/max`；Pi 实际仅以 `null` 禁用基础档位 | `off/minimal/low/medium/high` 默认可用且可被 `null` 禁用，`xhigh/max` 保持显式 opt-in；类型、IPC、slash 与 Renderer 使用同一七档集合 |
| 2026-07-23 | 4.1 | 模型列表改为优先向右展开的级联子菜单 | 用户指出向下展开难以显示，并要求点击模型后从右侧打开小菜单 | 模型列表脱离主面板高度并使用独立 viewport 定位；右侧空间不足时才向左避让，不改变模型或思考强度协议 |
| 2026-07-23 | 4.2 | 外观设置增加强调色与面板透明度 | 用户明确要求 UI 支持选择强调色和透明度 | Appearance contract 增加强调色与透明度枚举，config 升级为 v7；Renderer 只调整统一强调 token 和表面层 alpha，不降低文字及整个窗口的不透明度 |
| 2026-07-23 | 4.3 | 将工具过程三级扩展为统一工作过程三级 | 用户确认实时过程应按紧凑、标准、详细形成明确差异，并先按该方案实际观察 | 只改变 Renderer 活动态投影与设置文案；默认仍为标准，完成态、Kernel/RPC contract、Session 事实源和本机偏好存储不变 |
| 2026-07-23 | 4.4 | 标准档从“第一段 thinking”纠正为“非摘要正文” | 真实 Pi Session 证明截图中的短英文条目有明确 `thinkingSignature.summary`，而长段过程正文是签名为 commentary 的 text；按顺序无法表达用户要求 | KernelThinkingEntry 增加 summary 标记；Renderer 标准档保留 commentary 与非摘要 thinking，摘要仍可在完整过程里查看；Pi Session 原文和 RPC 事件不变 |
| 2026-07-23 | 4.5 | 恢复多个顶层对话并行 Runtime | 用户确认并行是旧 Pi GUI 已实现的核心工作台能力；新项目 S8–S10 的单 Runtime 收缩导致对话运行时无法继续下一个对话 | D-017 替代单活动 Runtime 限制；Kernel 按 Session 管理 Runtime context，切换不停止后台任务，归档定向停止，退出全量收口；不恢复旧 server/SQLite 拓扑 |
| 2026-07-23 | 4.6 | 思考过程正文在状态转换前后保持相同排版 | commentary/thinking 进入过程层后使用较小字号，导致完成瞬间重新换行、容器高度变化和滚动跳跃 | 过程正文统一使用正文 token；只保留动效、标题、颜色和折叠层级变化，不修改 conversation contract 或内容分类 |
| 2026-07-23 | 4.7 | 用真实阶段与项目汇总替代通用加载转圈 | 原 Session 圆环只能表达 `running`，Project 没有后台对话汇总，且导航与 thinking 动效缺少语义区分 | Project 增加非持久化 busy Session 计数；Session 展示 starting/running/stopping 生命周期阶段；thinking 保持消息级独立动效；不扩展百分比或预计完成时间 contract |
| 2026-07-23 | 4.8 | Session 运行指示恢复圆形并精修圆内运动 | 用户明确问题在原圆形动效的转动形态，不要求改成阶段轨迹；当前 thinking 动效可保持 | Session 仍使用圆形，但改为渐变弧与光点的节奏旋转；Project 汇总、thinking 与 Kernel activity contract 不变 |
| 2026-07-23 | 4.9 | Composer 原生接入图片与文件附件 | GUI 只有字符串 prompt，既没有 TUI 的文件上下文预处理，也丢弃 Pi RPC 已支持的 `images`，导致支持图片的模型仍只能收到文本 | 文件沿用 TUI 上下文包装；图片贯通 typed IPC、Kernel、Runtime 与 Pi RPC 原生 image block；不建立第二套上传服务、附件数据库或远程存储 |
| 2026-07-23 | 5.0 | Session 运行状态按 Runtime context 归属 | 启动目标 Session 时，顶层 Runtime 已切换但 `activeSessionKey` 仍按原子提交规则保留旧值，Renderer 因而把目标启动状态显示在上一条 Session 上 | Kernel summary 成为单条状态事实源并在生命周期变化时完整发布；Renderer 不再按旧活动身份覆盖；不改变并行 Runtime、Project 汇总或 Session identity 提交语义 |
| 2026-07-24 | 5.1 | 普通文件从 CLI `<file>` 全文内联改为交互式 TUI `@路径` 引用 | 前一实现参考了 `pi @file` 启动参数而非交互式输入框，导致大文本在首条 prompt 中占用完整上下文 | 文件正文不再进入附件 contract、IPC 或 RPC；Agent 通过原生 `read` 按需读取并受 2,000 行/50 KiB 输出边界约束；图片原生输入不变 |
| 2026-07-24 | 5.2 | 发送类动作从全局工作台互斥中解耦 | Pi prompt RPC 的响应等待被 Renderer 当作全局 busy，造成发送后短暂无法切换对话，Composer 也保留已提交文本并禁用输入 | prompt、steer、follow-up 可与其他对话导航并行等待；Project/Session 启动、激活、归档和设置动作仍保持原有互斥边界 |
| 2026-07-24 | 5.3 | 收敛标准工作过程的双层阅读结构 | 用户要求简单思考与工具继续折叠在同一个轮换内容中，不能因强调时序而让标准档退化成默认逐项展开 | commentary / 非摘要 thinking 保留主阅读线；摘要 thinking 与工具在单一状态 disclosure 内按原始顺序记录；compact 与 detailed 语义、完成态收起、最终回答层级和 Kernel/RPC contract 不变 |
| 2026-07-24 | 5.4 | 明确当前多 Runtime 与 Renderer composition 所有权 | 复审发现 P2 当前完成门槛和结构文档仍混用已被 D-017 替代的单 Runtime 约束，Workbench 装配也仍位于 Chat feature 内 | 保留 S8–S13 的历史验收记录；当前规则改为按 Session 隔离 Runtime、Renderer 单前台投影；只移动真实 composition owner 和共享纯定义，不改变 IPC/RPC contract、持久化 schema、视觉或交互 |
| 2026-07-24 | 5.5 | 自定义 Provider 模型改用 Pi-compatible 原生元数据并同步实际配置 | CPA 的 Codex-client 目录 `context_window` 与 Pi custom model 的 `contextWindow` 语义不一致，导致 GUI 展示 372K、Pi 实际退回 128K | 标准 `/models` 只负责模型身份与所有者；固定 Pi 版本的原生 Provider 定义负责 Pi 模型参数，完整值在 Runtime 启动前写入 `models.json`；运行中进程不伪装为已热更新 |
| 2026-07-24 | 5.6 | 增加 S15“TUI 日常能力补齐”并固定已逐项确认的范围与非目标 | GUI 已覆盖主体工作流，但仍缺 Session 派生、项目资源确认、认证和若干桌面效率能力；直接照搬全部 TUI/CLI 会混淆产品边界 | S15 以六个有序阶段补齐确认项；Pi Session、配置、trust 和 credential 继续作为事实源；Tree/Clone、CLI/headless、工具控制、Extension UI 与高保真压缩不进入本 Slice |
| 2026-07-24 | 5.7 | 按计划审计收紧 S15 的公开能力、状态机、安全和验收边界 | 原计划没有固定 Fork 活动路径 ID、Runtime 原子迁移、导出数据源、credential 瞬时输入、trust 公共 API、搜索 symlink、统计口径、快捷键默认值和外部状态隔离，且把 `/reload` 目录放在实现阶段之前 | Trust/reload 前移为第一阶段；六阶段各自先完成真实 typed 链路再暴露 UI；真实验证隔离 XDG 与 `PI_CODING_AGENT_DIR`，S15 仍待 S14 收口后才能 Ready |
| 2026-07-24 | 5.8 | 完成 S14 收口并实施 S15-1 项目资源 trust 与当前 Session reload | 用户要求以多 Agent 推进 S15；固定 Pi 的 package root public trust 能力与一次性启动参数已复核，现有多 Runtime Kernel 具备定向重启目标 context 的边界 | S15 进入 In Progress；S15-1 Complete、S15-2 Ready。持久决定只写 Pi `trust.json`，一次性决定只进入目标 argv；reload 不影响其他后台 Runtime |
| 2026-07-24 | 5.9 | 完成 S15-2 Session Fork 与归档即时补救 | Pi 0.80.10 已提供真实 entry/leaf 与同进程 fork，但 GUI 必须避免正文猜 ID、旧历史错标和归档撤销启动 Runtime；多个 5 秒动作也不能互相覆盖 | S15-2 Complete、S15-3 Ready。Fork 只认活动路径真实 ID并原子迁移 Runtime context；归档凭证按目标独立、单次、单调过期，撤销只恢复导航，临时预览保持归档且只读 |
| 2026-07-24 | 6.0 | 完成 S15-3 安全离线导出、最终回答复制和 Pi 生命周期统计 | 导出必须严格区别活动分支可分享内容与 JSONL 私有过程事实；停机 Session 又不能为 tooltip 启动 Runtime 或依赖第二份持久化统计 | S15-3 Complete、S15-4 Ready。Main 自行安全序列化活动分支并使用系统保存框；逐回答复制原始 Markdown；停机 JSONL 全 entry 扫描与活动 `get_session_stats` 使用同一 Pi 口径 |
| 2026-07-24 | 6.1 | 完成 S15-4 canonical Project `@` 路径搜索与 GUI typed 命令 | Composer 需要 TUI 同语义的路径引用入口，但 Renderer 不应获得任意文件读取；Fork、导出和最后回答复制又必须复用既有 GUI 动作而不是把 slash 文本送入 Pi | S15-4 Complete、S15-5 Ready。Main 只返回受 ignore/symlink/数量边界约束的相对名称，Composer 丢弃过期响应；`/fork`、`/export`、`/copy` 在 Renderer 截获，Kernel 直调 Fail Fast |
| 2026-07-24 | 6.2 | 完成 S15-5 公开 SDK 凭证交互与 Provider 定向 reload 标记 | OAuth、API Key 与设备码流程必须由固定 Pi 的公开 `ModelRuntime` 驱动，同时避免已有 secret 回流 Renderer、错误回显和认证变化静默打断正在运行的 Session | S15-5 Complete、S15-6 Ready。凭证页只消费脱敏元数据和受控 prompt；认证变化刷新 catalog，并只给使用对应 Provider 的 live Session 建立非持久化标记，显式 reload 完整成功后才清除 |
| 2026-07-24 | 6.3 | 完成 S15-6 窗口内快捷键与 Pi 压缩生命周期，并收口 S15 | 桌面快捷键需要有限、可持久化且不破坏文本/IME/模态交互；自动压缩又必须与 agent settled 分离，并在多 Runtime 下只刷新事件所属 Session | S15 Complete。快捷键使用严格 XDG config v9 完整表且不注册系统级热键；压缩事件按 context 归一化，成功原子刷新 Conversation/usage/statistics，失败、取消、异常和 teardown 保留旧投影并结束等待 |
| 2026-07-25 | 6.4 | Session 点击改为无感启动 Runtime | 用户要求点击 Session 即启动，而不是先只读预览再手动“启动 Pi”或等到首次发送 | Renderer 在选中历史 Session 时立即投影历史并调用 activate-session；保留发送时自动激活与 Composer 恢复按钮作失败回退；不改变 Kernel ownership 或 Session 事实源 |
| 2026-07-25 | 6.5 | 点击启动改为后台 settle/合并，不再锁导航 | 用户指出“点击即启动”不等于每次点击都阻塞等待 Runtime 完成 | 视图切换与历史预览当帧完成；activate/start 走非阻塞 ensure 泵；历史 Session 120ms settle 合并连点；已有 Runtime 立即切换；提交仍可 await 同一任务 |
| 2026-07-26 | 6.6 | 在拓展版基线上加入首个固定 Subagent Extension 适配 | 用户要求寻找 pi.dev 中成熟的 Subagent，并提供可关闭、可在独立导航页修改的 GUI | 固定 `@mjakl/pi-subagent`；安装与启停复用 Pi Package 事实源，GUI 只保存运行参数；当前 Runtime 不静默重启，Agent CRUD 与任务监控不进入首期 |
| 2026-07-26 | 6.7 | 将首期固定 Subagent Package 更正为 `pi-subagents`，并迁移其实际配置边界 | 2026-07-26 数据快照显示 pi.dev 128K/mo、GitHub 2.7k stars / 572 commits；该 Package 以环境变量公开最大深度配置，不使用旧 Package 专属 cycle setting | config v11 从 v10 保留最大深度并移除 cycle setting；Runtime 使用 `PI_SUBAGENT_MAX_DEPTH`；安装、启停和 reload 生效语义不变 |
| 2026-07-26 | 6.8 | 将已适配拓展的安装与启停统一收口到拓展页 | 用户要求 Subagent 功能页不再提供安装，并为已完成 GUI 适配的拓展建立独立安装区域 | 拓展页增加“已适配拓展”区域；Subagent 页只读取可用状态并修改运行参数；不建立第二套 Package 状态或通用适配注册中心 |
| 2026-07-26 | 6.9 | 增加 S17 Subagent Agent definition 管理 | 用户要求把 Subagent 内容设置和管理能力放入独立页面，并以基础/高级设置和分页控制复杂度 | Subagent 页管理真实 Markdown 定义；Main 固定目录、Renderer typed 字段、内置文件不改写、界面直接编辑并可恢复默认；不加入运行任务、Chain、Watchdog 或 Profile 管理 |
| 2026-07-26 | 7.0 | 增加 S18 OMP 多 Advisor Extension 与 GUI 特别适配 | 用户确认目标是逐步复刻完整多 Advisor 系统，并要求先固定文档、手动开关与 GUI 专门适配方向 | 新增 `advisor-system.md`、D-034 和五阶段实施顺序；S18 进入 Ready。Pi 仍是唯一 Runtime，首链路只读，不创建通用 adapter 或假 UI |
| 2026-07-26 | 7.1 | 增加 Magic Context 可选适配 | 用户确认引入 Magic Context 解决长任务上下文压缩，但要求避免无谓破坏 provider prompt cache | 拓展页管理真实 Package/Extension 状态；setup、doctor 和 `/ctx-status` 沿用上游入口；GUI 不把安装等同于健康，不内嵌配置器、私有 SQLite reader 或缓存指标推断 |
| 2026-07-26 | 7.2 | 实施 S18-1 独立单 Advisor Package 与 protocol v1 | Pi 0.80.10 公开 API 审计证明 Extension 内可运行独立 Advisor；需要先建立默认关闭、可手动验证的真实基线，再进入 GUI 和多 roster | 新增 `pi-gui-multi-advisor` Package 与 D-037；S18/S18-1 进入 In Progress。离线和真实加载已通过，真实 Provider advisory 仍是完成门槛 |
| 2026-07-26 | 7.3 | 将 Subagent 适配从管理面扩展到运行显示面 | 用户指出拉起 Subagent 后显示什么同样属于 GUI 适配，不能只完成设置管理页面 | 前台工具进度和结果进入当前 turn；固定后台通知进入 Timeline；Main 只投影归一化摘要，不增加任务数据库、child transcript 读取或文本状态推断 |
| 2026-07-26 | 7.4 | Advisor 首阶段模型固定为 Sol 中等推理 | 用户确认审查模型应优先使用 `gpt-5.6-sol` 或 `terra`，且核心审查对模型智力要求更高 | D-039 替代 D-037 的跟随主模型规则；S18-1 使用当前 Provider 中 `gpt-5.6-sol + medium`，不可用时明确暂停；GUI 可选 Terra/跟随主模型与 Sol 升级策略仍按后续阶段实施 |
| 2026-07-26 | 7.5 | 增加 S19 Subagent 任务详情侧栏 | 用户确认 Codex 的右侧任务阅读面是目标展开方式；当前 Workbench 只有两列且没有右栏状态、响应式与焦点边界 | S19 排在 S18 后；当前胶囊继续使用行内 disclosure 过渡，不提前增加半成品侧栏或通用 inspector |
| 2026-07-26 | 7.6 | S18-1 真实 Provider 闭环完成 | 用户明确授权使用当前 Provider 凭证执行计费验证；需要确认独立 Sol Advisor 不只可加载，而且能产生并持久化结构化建议 | `terra + low` primary 与 `sol + medium` Advisor 完成一轮真实审查，产生并持久化一条 `blocker`；S18-1 标记 Complete，S18-2 改为 Ready |
| 2026-07-26 | 7.7 | 完成 S18-2 Advisor GUI 投影与双层控制 | 用户确认继续以多 Agent 推进，并要求 Extension 可手动开关且 GUI 特别适配 | 固定 capability/advisory 进入 strict Kernel contract；拓展页管理 Extension resource，Advisor 页管理当前 Session system，Timeline 显示 turn 内审查卡；S18-2 Complete、S18-3 Ready |
| 2026-07-26 | 7.8 | 完成 S18-3 多 Advisor roster 与受控工具授权 | 用户要求推进 S18-3，并允许 Advisor 适当开放其他工具 | WATCHDOG 与 GUI roster 形成真实 typed 闭环；默认只读，`edit/write` 仅配置级显式授权，Project 未受信任时不加载项目定义，`bash` 因缺少命令级审批边界保持禁用；S18-3 Complete、S18-4 Ready |
| 2026-07-26 | 7.9 | 当前 Slice 切换到 S19 并暂停 S18 | S19 source slice 已进入独立 review 修复与验收，计划不能同时把 S18/S19 标为 In Progress | S19 成为唯一 In Progress；S18 标记 Paused，S18-4 保持 Ready，并在 S19 完成真实并行、响应式、reduced-motion 与 AppImage 验收后恢复 |
| 2026-07-27 | 8.0 | Subagent 完成结果从 Timeline 正文收敛到任务详情 | 用户确认子代理处理信息不必在正文重复展示，点击任务胶囊阅读即可 | 普通 completion 只显示轻量可点击胶囊并以 notice identity 打开详情；前台任务胶囊、控制、转向、supervisor 请求和 Watchdog 通知保持，不新增原 run 文本关联或后台任务数据库 |
| 2026-07-27 | 8.1 | Subagent supervisor 通知改为结构化内部协作生命周期 | 实际使用中同一请求重复展示 attention、request、reply 与 wait，且把主 Agent 可自行处理的事项误报为用户警报 | 新增 D-046；稳定 request identity、同目标语义合并、成功 reply 原地 handled、管理工具简洁文案。缺少结构化 details 的旧消息仅兼容显示，不靠 Markdown 猜关联 |
| 2026-07-27 | 8.2 | 增加 P2.1 Experience Refinement 与 S20–S25 | 用户确认下一阶段的三条主线及四项产品决策，需要在继续实现前固定依赖、范围、非目标和完成门槛 | S19 仍是唯一 In Progress，完成后恢复 S18-4，再进入 S20；Settings 分组和三个有限定制项、Subagent effective state、Magic Context 只读状态与后续结构化协议分别进入 Planned/Research |
| 2026-07-28 | 8.3 | S19 通过 canonical AppImage 正式 gate，并恢复 S18-4 | Source snapshot 只能提前发现交互问题；最终完成必须绑定 clean commit、真实 AppImage、完整 P1/P2 回归和 S19 专项摘要 | S19 标记 Complete；S18/S18-4 恢复 In Progress。证据绑定 `b9562b4`、AppImage SHA-256 和脱敏报告目录，S20 继续等待 S18-4 完成 |
| 2026-07-28 | 8.4 | 增加 S26 Memory Budget & Runtime Hibernation，并暂停 S20-2 | 实际运行出现约 5.4 GiB Renderer `PartitionAlloc`，重启后多个顶层 Pi Runtime 又快速恢复；只靠重启或 DOM 挂载窗口不能建立内存上限 | S26 成为唯一 In Progress；先建立脱敏诊断和预算，再消除重复 IPC、分页/驱逐 Conversation，并以显式休眠、operation lease、quiescence 和保守 LRU 回收空闲 Runtime；S20-2 在首个内存预算 gate 后恢复 |
| 2026-07-28 | 8.5 | 在不改变 S26 优先级的前提下完成 S20-2 | S20-2 已在独立 clean worktree 接近完成，继续收口不会触碰 S26 的 Kernel/IPC/Runtime owner；完成事实必须纳入最新计划，而不能把旧顺序误写成 S21 已开始 | S20-2 标记 Complete，S20 继续 Paused 于 S20-3；S26 保持唯一 In Progress，首个预算 gate 后进入 S21-1 |
| 2026-07-28 | 8.6 | 增加 P4 Cross-platform Desktop，并明确当前继续专注 Linux GUI | 用户确认先完成当前 GUI，macOS、Windows 和 WSL 移植后置 | P4 状态为 Deferred；未来顺序固定为 macOS → Windows 原生 → 按需评估 WSL。当前不提前增加未被 Linux 主路径使用的兼容层，S26 与既有 Linux 路线优先级不变 |
| 2026-07-28 | 8.7 | 删除主动 Runtime 休眠产品面并并入自动休眠基础设施 | 用户确认 Session、Project 与全局主动休眠没有独立作用，不应作为单独功能保留 | 删除完整 UI/IPC/API/批量链路；Main/Kernel 仅保留单 Runtime 回收原语和 stop/recovery 安全测试。自动 operation lease、quiescence、压力回收与 LRU 继续作为 S26 未完成项 |
| 2026-07-30 | 8.8 | 记录 P3-0 前置基础并纠正历史 Prompt 的过度设计 | Pi TUI Tree 已提供真实分支语义；继续设计 atomic navigate+prompt、projection watermark 和第二套 artifact admission 违反 KISS/YAGNI，也不是当前 GUI 适配的必要条件 | 历史编辑固定为受控 `navigate_tree` 后复用现有 `prompt`；Git/Inventory 只作为未接 UI 的窄基础。P3 保持 Pending、S26 保持唯一 In Progress；后续没有真实失败证据不得恢复第二套协议 |
| 2026-07-30 | 8.9 | 完成 P2/S26 并开放 P3-1 Git Changes Sidebar | commit `152a9a3` 的 19 步正式 AppImage memory gate通过预算、五分钟自动休眠、显式恢复、对话保留、三路Subagent和完整P2回归；用户要求完成P2并继续遵守KISS/Fail Fast | P2与S26标记Complete，P3改为Ready；20 Session/三个父Runtime同时busy/30分钟slope等泛化压力不再阻塞P2，只在真实回归时恢复。P3-1只接现有Git typed foundation到Changes UI，不扩commit/sync或第二套协议 |
| 2026-07-30 | 9.0 | 固定 P3-1至P3-7任务线和 Git Changes交互合同 | 用户确认先完整推进Git工作台，再进入Capability Center与MCP；P3-1只做Changes，入口位于Session Header，使用单一Uncommitted Changes列表 | P3按 Changes → Commit & Push → History → Branches & Sync → Capability Center → Capability管理 → MCP实施；后续Slice保持Planned，不把未来能力或空Tab写成现有实现 |
| 2026-07-30 | 9.1 | 固定P3的安全并行与文件ownership模型 | 用户要求梳理可并行任务，同时项目规则要求主动多Agent但保持共享worktree单一writer和Parent最终验收 | 顶层Slice继续串行；当前Slice内可按Main/Renderer或shell/feature拆成两个隔离writer，第三槽位只读review。共享contract、composition、Settings导航和config writer保持单一owner，正式gate只跑集成候选 |
| 2026-07-30 | 9.2 | 完成 P3-1 Git Changes Sidebar 并开放 P3-2 | 现有 typed Git foundation 已通过真实 Renderer 接线证明 Project identity、ancestor trust、diff、Stage/Unstage 和 stale mutation 产品链路，且最小 gate 明确无需启动 Electron | P3-1 标记 Complete；P3 标记 In Progress；P3-2 Commit & Push 改为 Ready。后续继续复用同一 repository snapshot，不把 commit/push 提前混入 Changes feature |
| 2026-07-30 | 9.3 | 将右侧栏一级入口从 Git 领域图标纠正为通用壳层 toggle | 用户确认右侧栏后续承载多个系统，一级入口必须表达容器展开/收起而非当前首个模块；左侧栏已有镜像图标语义可直接复用 | 新增 right-sidebar open/close 图标；Header、栏内 collapse 和 verifier 统一消费壳层语义，Git/Subagent 继续只在栏内按真实可用性出现 |
| 2026-07-30 | 9.4 | 参考 Cursor 收敛 Git Changes 大量文件场景 | 用户实际打开后确认全量平铺缺少层次，要求默认不展开并参考 Cursor 的范围选择与紧凑行设计 | 默认 Uncommitted 且 diff 全折叠；新增 Uncommitted/Unstaged/Staged 可信过滤、文件 disclosure 和图标 mutation。协议未提供的总行统计、Last Turn 与 Branch Commits 保持不显示 |
| 2026-07-30 | 9.5 | 补齐 Cursor 式全部折叠与未修改区域折叠层级 | 用户补充截图确认多个文件可同时展开，标题区提供全部折叠，diff 内的大段未修改内容以折叠条呈现 | diff 状态改为 per-file map 与独立 token；hunk range 精确生成未修改行折叠条。当前 DTO 未携带省略文本，故不伪造展开箭头；真实上下文按需展开需后续有界 Main/IPC contract |
| 2026-07-30 | 9.6 | 增加正常重启后一次性继续全部精确运行中 Session 的调试开关 | 用户需要 GUI 重启后可选择自动继续所有当时仍在执行的前台/后台对话，同时要求不能把历史 `crashed` 或不完整 transcript 猜成运行事实 | config v14 默认关闭；Kernel shutdown 精确快照，XDG state 使用 boot-scoped claim-before-send；恢复不改前台选择、不绕过 Project trust，Ask/compaction/provisional/异常退出均不自动继续。P3 当前 Slice 状态不变 |
| 2026-07-30 | 9.7 | 加固 P3-1 diff 首开等待与大型 DOM 性能，并完成独立审计闭环 | 用户要求避免自研 diff 在大量文件/大 patch 下卡顿，并要求完成后独立审计 | hover/focus 只预取有界 typed DTO；snapshot-bound 8 条/8 MiB LRU、single-flight、最多 8 个展开文件和 300 行虚拟化阈值进入当前合同。大型 diff 保留完整文本/复制路径；trust/repository identity、exact snapshot ownership、mutation gate、意图 ownership、稳定宽度与可访问性 findings 已全部修复，最终 closure review 为 Blocker/High 0 |
