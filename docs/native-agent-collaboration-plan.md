# 内建子智能体与对话协作迁移

2026-09-30，用户确认迁移 Pi Desktop 内建 Subagent 的前后端，并以当前 Pi 0.99.0 为基线，多 Agent 并行实施。

## 范围与不变量

- 初始保存含 Pi 0.99 升级的源码快照，实施过程中接入最新主线 da226d4（后端拆分与 S21-3），原工作目录不承载本任务开发修改。
- 保留 Workbench Kernel、Pi Runtime 子进程及原生 Pi Session 事实源。提取 Pi Desktop 的行为，不引入 Rust Host、SQLite 或另一套 Agent 引擎。
- 内建 Task / TaskWait / TaskList / TaskStop 支持后台执行、结果回传、同任务继续、明确停止与完整子任务历史。
- 独立对话通过 SessionTask 的 list / spawn / send / status / result / cancel 协作。发送身份由所属 RuntimeContext 确定，不能从模型参数取得。后台操作不改变前台选择。
- 普通消息默认排队，完成通知不生成另一层自动完成通知；结果绑定投递，不借用旧最后回答。
- 不引入持久化发送队列或自动重发（沿用 D-099）。进程退出后的在途工作明确中断，历史仍可读。
- 子任务执行状态由执行 owner 管理，Kernel 归一化，Renderer 只消费 typed DTO。运行子任务必须阻止父 Runtime 的休眠并由生命周期 owner 收尾。
- 保留现有 Agent Markdown、模型和工具限制；内建路径接通后移除 pi-subagents 的执行依赖和专属安装入口。历史 pi-subagents 投影保留。

## 并行分工

1. Runtime Agent：适配 Pi 0.99 SDK，实现内建子任务、Task 系列、SessionTask 工具与身份绑定请求桥，提供任务历史和控制命令；只负责 src/main/runtime 与新执行 owner。
2. Kernel Agent：实现对话协作 coordinator、后台精确 Session 路由、排队与完成回调、任务历史规范化和 typed commands；负责 Kernel 与共享 Kernel contract，不修改 Runtime 实现和 Renderer。
3. Frontend Agent：将任务详情扩展为连续子任务对话与实际控制，迁移内建定义设置，复用当前右栏、Markdown 和前端组件；负责 Renderer 与 definition store，不修改 Kernel/Runtime 或 main/index。
4. 主 Agent：先固定共享协作契约，再负责 main/index、公共分发与传输接线、文档和集成审阅，处理并行交界。

## 契约

- Runtime 向 Kernel 发出 `agent-collaboration-request`，携带 requestId 与 AgentCollaborationOperation；RuntimeCommand `agent_collaboration_response` 返回同请求的 typed result 或明确 error。
- RuntimeCommand `get_subagent_transcript` / `control_subagent` 以 taskId 定位；Kernel 暴露 `kernel.get-subagent-transcript` / `kernel.control-subagent`，并核对 expectedSessionKey。
- Native 任务使用现有 Subagent projector 可理解的结构化进度和完成通知；participant 增加可选 nativeTaskId，历史项不伪造身份。
- 共享对话 DTO 位于 src/shared/agent-collaboration-contract.ts；Subagent 领域 DTO 集中于 src/shared/subagent-contract.ts，并由 kernel-contract 兼容导出。

## 验收与交付

先完成三个模块，再串行运行平台缓存入口的 typecheck / check:size / build、git diff --check 和必要的已有定向验证。使用离线 SDK/工具路径核对前后台身份、排队、停止和历史；涉及新增交互时运行现有 Chromium fixture。真实收费模型验证、Windows安装与生产部署属于另外的交付边界，本次不自动发布。

## 进度

- 计划与共享契约：已建立
- Runtime / Kernel / Frontend：已完成；三个 Agent 并行，公共边界由主 Agent 集成
- 最新主线接入：已完成；保留后端拆分与 S21-3 反馈，D-098 行数约束通过
- 集成与验证：已完成；最终 typecheck / check:size / build / git diff --check 通过，432 项相关检查通过（无跳过）

## 最终验证记录

- 基线：`da226d4`，包含 Pi 0.99、后端领域拆分与 S21-3。分支：`codex/native-agent-collaboration`。
- 使用 Node 26.4.0 / pnpm 11.9.0 的 Linux 平台缓存，未复用 Windows node_modules。
- 既有定向检查 432 项通过，覆盖 Kernel/投影、Runtime、定义管理、前端、设置反馈、Host/Remote 命令边界、preload 与休眠协议。
- 真实 Pi 0.99 SDK + 本地 SSE 模型实际执行工具：3 次 child/grandchild 文件读取、完整嵌套报告回传、同任务继续与停止、另一父会话的任务身份拒绝、JSONL 恢复，以及 SessionTask 请求 ID 的实际工具回应。旧执行器负向 fixture 同时覆盖 global/project packages 和 extensions，原配置文件字节保持不变。
- Chromium 复用现有 fixture，验证任务阅读、外部续跑刷新、停止、连续历史、切换任务后的迟到回应拒绝与不可用历史反馈。
- 构建包含 Main、Runtime 子进程、preload、桌面 Renderer 与 Web Remote；源码摘要 `2453dc0415461f16b9608f8a9e0bd992b7fbcd70b8452b760940d0f9d1f65107`。
- 子任务历史本轮只提供文字，不沿用父对话图片读取接口；旧 `async:false` 需要显式保存为后台执行。Web Remote 接入新命令契约，现有远程页面的任务详情 UI 不在本轮扩展。
- 未调用真实收费模型，未发布安装包、部署 Host 或进行 Windows 人工验收。原工作目录在本轮开发期间由其他任务继续更新，本任务只修改隔离 worktree。
