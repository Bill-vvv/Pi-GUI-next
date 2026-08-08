# 发布门槛

## 唯一 lifecycle

项目只有一条开发与发布路径，不建立 stable/dev/canary、多 checkout、镜像目录或旁路 launcher：

```text
canonical Git checkout
  -> pnpm install --frozen-lockfile
  -> pnpm dev（唯一开发入口）
  -> typecheck / 三组定向 core tests / real Pi smoke / build
  -> 单一 Linux 产物
  -> 产物上的真实核心链路验证
  -> 脱敏 JSON 报告与截图证据
  -> 计划、commit、证据一致后发布
```

具体脚本在对应 Slice 实现后加入 `package.json`；不得用尚未实现的占位脚本制造已具备发布能力的假象。S7 唯一 Linux 产物是 `release/pi-gui-next-0.0.1-x86_64.AppImage`，选择依据见 `decisions.md` 的 D-008。

## S0 gate

- Git repository 是本项目唯一源码事实源；旧仓库保持只读。
- Node、pnpm、Electron、React、TypeScript 和 Pi 支持版本均为精确版本。
- `pnpm-lock.yaml` 由 pnpm 11.9.0 生成。
- 干净 checkout 可执行 `pnpm install --frozen-lockfile`。
- 文档明确当前范围、进程 owner、状态来源和 P1 发布门槛。

## 统一自动验证

对应 Slice 落地后，统一命令为：

```bash
pnpm install --frozen-lockfile
(cd extensions/pi-gui-ask && pnpm install --ignore-workspace --frozen-lockfile --config.strict-dep-builds=false)
pnpm typecheck
pnpm test:core
pnpm smoke:pi
pnpm build
pnpm package:linux
pnpm verify:linux
# S26 在同一个真实 UI verifier 上增加内存证据
pnpm verify:linux -- --memory-diagnostics
```

`pi-gui-ask` 是拥有独立 frozen lock 的本地 Package；根 `tsconfig` 会检查其源码，因此 clean clone 必须先按该 Package 自己的 lock 安装 peer/type 依赖。该安装显式保持传递依赖 build scripts 禁用；`strict-dep-builds=false` 只把已知 ignored-build 状态从安装错误降为警告，不执行 `@google/genai` 或 `protobufjs` 脚本。`pnpm test:core` 已包含仓库内 ask、runtime-quiescence、task-notify 与历史 multi-advisor quiescence 合同测试。Magic Context 与 pi-subagents 的当前安装版本由真实 AppImage Gate 通过 Pi Runtime 加载并验证；不得依赖已退役的项目 `node_modules/@aliou/pi-subagents` 或 npm 产物未发布的测试目录。自动测试保持定向，不设置覆盖率目标。

## P1 真实产物回归

必须从打包产物而非开发服务器执行并记录：

1. launch 与干净退出；
2. Pi 0.83.0 probe；
3. project 路径选择与明确 cwd 启动；
4. prompt、streaming、thinking 和真实 tool execution；
5. abort 后 runtime/UI 状态一致；
6. 强制终止 Pi 后进入 crashed；
7. 用户显式 restart/resume，并在应用重启后恢复最近 session。

验证报告必须记录 app、Node/Electron、Pi、平台、commit、产物和各步骤结果；JSON 与截图均不得包含 prompt 正文、敏感 tool output、credential 或完整环境变量。截图保留状态与流程结构，但在捕获前临时遮罩会话正文、工具详情与会话标题。

## P2 真实产物 gate

P2 在完整保留上述 P1 链路的基础上，还必须从同一 AppImage 验证：

1. 两个 Project 可发现、切换和恢复，切换过程中最多存在一个活动 Pi Runtime；
2. 同一 Project 下两个 Session 可真实落盘、列出、切换和恢复；
3. slash command 可发现来源，可通过 Arrow/Tab 补全并执行 typed command，未知命令明确 Fail Fast；
4. 空对话、Project/Session 切换反馈和切换后的 Composer 焦点恢复可观察；
5. P2 新增步骤与 P1 回归使用同一隔离 XDG、清理和脱敏边界。

`pnpm verify:linux` 只在干净工作区执行；它从 AppImage 的真实 renderer UI 完成 P1 回归、当前 P2 链路与 S19 Subagent 任务详情 gate，并将 schema v2 的脱敏 `report.json` 与九张关键截图写入 `release/evidence/<UTC>-<commit>/`。P2/S19 摘要只记录计数、角色集合和布尔结果，不记录完整 Project 路径、Session 标题、prompt、tool output 或 credential；S19 截图还必须遮罩 participant 任务标签、详情活动与最终输出。验证器不得向生产代码加入测试后门。

真实 UI gate 独占工作站窗口：同一用户同时只能运行一个 `pnpm verify:linux`。canonical `pnpm dev` 仍在运行时，验证器必须在启动 AppImage 前以 `E_DEV_GUI_RUNNING` Fail Fast，防止后台 Agent 反复打开或聚焦测试 GUI；正式验收应先关闭开发实例。只有人工监督且明确接受窗口抢占时，才可显式设置 `PI_GUI_VERIFY_ALLOW_ACTIVE_DEV=1` 覆盖该保护，跨进程互斥仍然生效。异常退出遗留的 verifier lock 只能在 owner 进程已不存在后回收。

## S26 内存诊断模式

内存诊断继续扩展同一个正式 verifier，不建立第二个 launcher：

```bash
pnpm verify:linux -- --memory-diagnostics
# 等价：PI_GUI_VERIFY_MEMORY_DIAGNOSTICS=1 pnpm verify:linux
```

该模式默认关闭；启用后，在单 Runtime ready、工具 turn 完成、重开恢复、两个 Project Runtime、三个 Session Runtime、三路 Subagent running/completed 和最终关闭前采样。`report.json.memoryDiagnostics` 只记录：

- AppImage 后代进程按 `app-root`、Electron Main/Renderer/GPU/Utility、顶层 Pi Runtime、Pi child 等角色聚合后的进程数与 RSS/PSS/private/anonymous/swap bytes；
- Renderer 的 V8 heap、DOM counter、完整 KernelState/Conversation/Navigation JSON bytes、entry 数量与 runtime status；额外的只读 event listener 只累计 full-state/patch 次数、patch 结构和追加字符数，不保存 payload；
- 所有样本的有界列表和峰值，不保存进程命令行、Project/Session identity、路径、prompt、output、tool content、credential 或 Extension 私有内容。

诊断字段首期只建立基线，不自动把观察值当发布预算；预算必须由相同 AppImage 场景重复采样后冻结。诊断仍服从 clean worktree、单 verifier lock、真实 AppImage、隔离 XDG、截图脱敏和 active-dev guard。首轮 live/isolated 证据、根因排序和预算草案见 [`memory-diagnostics.md`](memory-diagnostics.md)。

## Fail Fast

任一必需命令失败、版本不匹配、工作区不干净、证据与 commit 不一致，或只能从开发服务器完成链路时，发布停止；不得静默 fallback 到另一套 runtime、checkout 或产物。
