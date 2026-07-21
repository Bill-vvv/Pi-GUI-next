# 工程历史与已修复问题

本文按时间倒序记录已经落地的能力、已修复问题和可复用工程经验，兼具 release note 与工程沉淀用途。

- 当前进度、下一 Slice 和计划变更以 [`development-plan.md`](development-plan.md) 为准。
- 长期架构约束和决策分别以 [`architecture.md`](architecture.md) 与 [`decisions.md`](decisions.md) 为准。
- 这里只记录有实现和验证证据的结果；候选方案、失败候选和未完成计划不写成已交付能力。

## 2026-07-21 — P2 Workbench Foundation：S8–S10

**状态：** 已验证。**交付：** Workbench Navigator、多 Project、多 Session、单活动 Runtime 切换、XDG state v3 与 v1/v2 迁移、真实 Session 恢复和正常 GUI 单实例 ownership。

| 已修复问题 | 根因 | 修复与工程价值 |
| --- | --- | --- |
| Project 激活持久化期间仍可启动旧 Project | Project 变更与 runtime launch 缺少同一同步生命周期门 | Kernel 对 Project 变更和 launch 统一 Fail Fast；运行中拒绝切换，ready/crashed 先受控停止旧 Runtime，再提交新 Project |
| 同一路径并发添加会破坏内存 registry | canonical path 校验与读改写之间存在竞态 | 使用串行持久化队列和 canonical key 去重；失败不提前发布内存投影 |
| Session 切换持久化期间 Pi 退出后，UI 错误回到 `ready` 并显示目标 identity | 异步切换结果覆盖了进程退出产生的 `crashed` 状态 | 提交前重新核对 launch/runtime 状态；失败或退出保留 crash 事实，不把旧 Conversation 标成目标 Session |
| 新 Session 被过早加入索引，随后因 JSONL 尚不存在而无法恢复 | Pi 0.80.10 在首个 assistant 消息完成前延迟创建 session 文件 | 引入只存在于内存的 provisional Session；文件落盘、canonical 校验和指针持久化成功后再一次性提交正式 identity |
| 两个 GUI Main 进程共享 XDG state 时会丢失 Session 索引更新 | 跨进程读改写没有共同 owner | 正常 GUI 增加 Electron 单实例锁，第二实例聚焦首窗口；无状态 `probe-only` 保持独立 |
| Workbench 暗示尚不存在的 slash command，并出现重复“添加项目”入口 | 低保真结构把未来能力画成了当前可用功能 | 未接入命令时显示明确空态，只保留一个添加入口；S11 仍由独立验收决定是否完成 |

**验证：** 94 项 core tests、`pnpm typecheck` 和生产 build 通过；真实 Pi 0.80.10 无状态 smoke、隔离 XDG 双 Session 创建/切换/重建恢复，以及单实例锁 smoke 均通过。结构与事实源见 [`p2-workbench-structure.md`](p2-workbench-structure.md)。

**可复用规则：** GUI identity 必须晚于外部事实落地；异步持久化成功不代表 runtime 仍健康；单活动 Runtime 若依赖共享状态，ownership 必须同时覆盖进程内和正常 GUI 进程边界。

## 2026-07-21 — P1 Linux Core Chain / v0.0.1

**状态：** 已发布门槛验证。**交付：** Linux Electron 工作台、Pi 0.80.10 RPC、Project、prompt/streaming/tool/abort、crash/restart/resume，以及唯一 x86_64 AppImage 产物。

| 已修复问题 | 根因 | 修复与证据 |
| --- | --- | --- |
| abort 后 tool card 永久停留在 `pending` / `running` | Pi 成功响应 abort 时不保证补发 `tool_execution_end` | Kernel 在统一 settle 边界仅将当前 run 的遗留 tool 归一化为 error；回归提交 `bd6158c` |
| 发布验证器找不到打包后的 Pi 进程 | AppImage launcher 不是稳定祖先，且 Pi 会把 process title 改为 `pi`、覆盖原始 cmdline | 先以唯一 project cwd 与精确 RPC 参数定位，最终以 cwd 加 `/proc/<pid>/comm` 唯一定位；提交 `64b4534`、`0f76f1e` |
| abort 验收依赖特定 UI 终态，真实成功仍被误判失败 | Pi 的终态投影可能是 failed tool、`stopReason=aborted`，也可能只有 RPC success 且无运行中 tool | 验证器等待 preload abort 成功响应，并核对终态没有活动 tool；提交 `e278359`、`10319b0` |
| 发布验证读取到旧 Conversation 投影 | 验证脚本按不稳定的展示节点判断当前轮次 | 改为核对 typed kernel state 中的当前 Conversation 与 tool 状态；提交 `a2e5c28` |
| 发布截图可能保留 prompt、thinking 或 tool 细节 | 截图证据缺少与 JSON 报告相同的脱敏边界 | 截图在保存前执行脱敏，并逐张检查非空与尺寸；提交 `8a63c29` |
| 超长 streaming Markdown 在完成前退化成纯文本 | 16,384 字符解析预算被误用成渲染 fallback | 预算只停止分块预解析，超限后仍通过同一 React Markdown/GFM 管线整篇实时渲染；提交 `3ce9fff`、`6fa9047` |
| crash/resume 期间出现旧 launch 复活、并发恢复泄漏或历史消息 identity 碰撞 | 启动、停止、恢复验证和历史重建缺少单一 operation owner 与稳定 identity | 建立单一 launch operation、取消/关停边界、`sessionId` 核对和确定性历史 identity；提交 `29d24dc`、`ec330cc` |
| inherited renderer URL 可绕过预期页面边界，start/stop 与 XDG 保存存在竞态 | 开发 origin、IPC sender、导航策略和原子写入边界不完整 | Main 只接受 electron-vite 开发模式的 loopback origin，拒绝外部导航/窗口；启动与保存使用取消检查和唯一临时文件 |

**验证：** 候选 `0f76f1e` 的 AppImage 报告 13 个步骤全部通过，覆盖 launch、runtime identity、project/cwd、probe、真实 tool、abort、SIGKILL crash、restart/resume、继续对话、关闭重开恢复和最终进程收口；80 项 core tests 与 `pnpm typecheck` 通过。

**可复用规则：** 发布验证应观察稳定事实而不是 DOM 结构或父子 PID 假设；外部进程的成功响应、事件投影和 GUI settled 状态是三个需要分别核对的边界；脱敏必须覆盖报告与截图两种证据。
