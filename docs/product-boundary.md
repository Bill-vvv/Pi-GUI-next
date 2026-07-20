# 产品边界

> 适用阶段：P1 — Linux Core Chain / v0.0.1

## 产品目标

Pi GUI 的长期方向是桌面 Agent Workbench。P1 只建立第一条可发布的 Linux 本地核心链路：一个 GUI Project 对应一个 Pi Runtime 和一个 Pi Session，用户能完成对话、观察工具执行、终止当前轮次，并在 Pi 异常退出后显式恢复会话。

## P1 范围内

- Linux Electron 应用的启动、关闭和进程收口。
- 显式配置 Pi executable，严格支持 Pi Coding Agent 0.80.10。
- 单 Project、单 Runtime、单 Session。
- 显式项目目录和 trusted/untrusted 选择。
- prompt、assistant streaming、thinking、tool call/result 和 abort。
- Pi 异常退出诊断，以及基于 `sessionFile`、`sessionId` 的显式 restart/resume。
- 一个 Linux 打包产物及其真实核心链路证据。

## P1 范围外

- 多 Project 或多 Session 并行。
- Files、Git、Terminal、Browser、Activity Bar、Work Item、Plan 或 Kanban。
- 插件管理 UI、动态后端发现和远程 transport。
- Windows、WSL、macOS、SSH 或远程后端。
- SQLite、Fastify、WebSocket、自动更新、远程访问和外部通知。
- 自动重启、无限重试、静默 fallback 或替用户推断信任状态。

范围外能力不得通过空接口、占位模块或兼容层提前进入 P1。

## 旧项目边界

旧 Pi GUI 仓库和结项资源包均为只读参考，不是本项目依赖。禁止整仓迁移，也禁止复制旧 `App.tsx`、`RuntimeSupervisor`、global reducer、SQLite schema、launcher/mirror 拓扑或整套 CSS。

只允许在当前边界下逐项重新实现经过选择的协议规则、纯函数、生命周期策略和验证思路。资产在来源与授权确认前不得进入发布包。

## 完成口径

功能存在不等于完成。P1 只有在干净 checkout 可重复安装和构建、打包产物完成真实 prompt/tool/abort/crash/resume 链路、工作区与计划证据一致时才完成。详细门槛见 `release-gate.md`。
