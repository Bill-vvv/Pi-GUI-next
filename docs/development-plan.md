# Pi GUI 开发计划

> 当前阶段：P1 — Linux Core Chain / v0.0.1
> 计划版本：0.2
> 最后更新：2026-07-20
> 总体状态：Ready
> 当前 Slice：S5 — 对话闭环

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
- 同时实现 Pi RPC 与直接 SDK 两套主集成。
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
| RPC 探针 | `--mode rpc --no-session --offline --no-approve` 下 `get_state` 成功 |

P1 固定支持 Pi 0.80.10，不在本阶段设计宽松版本兼容。

## 5. 长期产品方向与当前范围

长期产品方向：Linux、Windows、macOS 桌面工作台；Windows 最终支持原生 Pi 与 WSL Pi 两种后端。

这些跨平台能力属于非常后期范围。当前代码只实现 Linux 本地 Pi，但不得让 Linux 的 PATH、XDG、进程和权限逻辑渗入 renderer 或会话模型。

P1 必须包含：

- Linux Electron 应用启动与退出。
- Pi executable 配置、版本检查和能力探针。
- 单 Project、单 Runtime、单 Session。
- 显式项目路径和项目信任选择。
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
| S4 | 实现 Project 选择、显式信任和带明确 cwd 的 Pi runtime 启动 | `Complete` | 2026-07-20 | 审计修复后 41 项当前 core tests、`pnpm typecheck`、`pnpm build`、`pnpm smoke:pi` 通过；覆盖 start/stop 竞态、版本检查期取消、XDG 并发保存与 renderer origin；trusted/untrusted 真实 Pi 0.80.10 probe 均通过；构建版在继承错误 `ELECTRON_RENDERER_URL` 时仍加载 bundled renderer，IPC 可用且外部导航/新窗口被拒绝 |
| S5 | 实现 prompt、streaming、thinking、tool card、abort 和 settled 状态 | `Ready` | — | — |
| S6 | 实现 crash 检测、session 指针持久化、用户显式 restart 和 resume | `Pending` | — | — |
| S7 | 构建唯一 Linux 产物并从产物完成真实核心链路，生成发布证据 | `Pending` | — | — |

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

### S4 — Project 与信任

工作内容：

- 选择一个本地目录作为 Project。
- 显式展示并保存 trusted/untrusted 选择。
- 每次启动明确传递 `--approve` 或 `--no-approve`，不依赖全局隐式值。
- 使用 XDG config/state 保存 GUI 项目设置和最近 session 指针。
- 凭证继续由 Pi 管理，GUI 不读取或复制 API key。

验收：

- trusted 与 untrusted 启动路径均可解释、可复现。
- cwd、Pi executable 和信任状态在诊断中可见，但不泄露凭证。
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
- 检测 Pi 意外退出，保留退出码与裁剪后的 stderr 摘要。
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
3. 用户能明确选择项目是否可信。
4. 能完成真实 prompt、streaming 和工具调用。
5. abort 行为正确。
6. Pi 被终止后 GUI 不会继续假装其正在运行。
7. 能重新启动并恢复原 session。
8. 打包产物通过同一条真实链路。
9. 工作区干净，计划、commit 和证据一致。
10. 新项目没有依赖或复制旧项目 application layer。

P1 完成后，才进入多 Project、多 Session 和第一个独立 Workbench Module 的讨论。

## 15. 进展日志

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

## 16. 计划变更记录

| 日期 | 版本 | 变更 | 原因 | 影响 |
| --- | --- | --- | --- | --- |
| 2026-07-20 | 0.1 | 建立 P1 Linux Core Chain 计划 | 新项目决定从零构建，并吸取旧 Pi GUI 的结项经验 | 当前只实现 Linux Local Pi；跨平台后端延后 |
| 2026-07-20 | 0.2 | 明确旧资产特指旧项目前端资产；复用从 S3 可视界面开始，S2 保持纯 Main/RPC 边界 | 用户澄清资产含义；需要同时保留视觉积累与 Slice 边界 | S2 不增加 renderer 功能；S3 起逐项提取 IA、token、组件和展示经验，授权未确认资产继续阻塞发布 |
