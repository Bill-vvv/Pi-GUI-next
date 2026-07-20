# 架构决策记录

本文件只记录已经生效的 P1 决策。新决策追加，不覆盖旧结论；改变既有决策时必须写明替代关系。

## D-001 — 新 canonical repository

- 日期：2026-07-20
- 状态：Accepted
- 决策：`/home/vvv/Projects/pi-gui-next` 是新项目唯一 canonical repository。旧仓库与结项资源包只读。
- 原因：旧实现存在两套拓扑和无法由单一 commit 回答的状态，不能作为可复现基线。
- 影响：不整仓迁移；选中的规则和思路在新边界下重新实现与验证。

## D-002 — 单 package 与 pnpm

- 日期：2026-07-20
- 状态：Accepted
- 决策：P1 使用单 package 和 pnpm 11.9.0；只有出现第二个真实 package ownership 边界后才讨论 workspace。
- 原因：当前 Electron Main、preload、renderer 和 shared contract 尚不需要独立发布单元。
- 影响：唯一开发入口是 `pnpm dev`，依赖通过 frozen lockfile 安装。

## D-003 — Electron Main 单一 control plane

- 日期：2026-07-20
- 状态：Accepted
- 决策：Electron Main 是唯一 control plane 和 Pi 子进程 owner；P1 只通过外部 Pi RPC 集成。
- 原因：单一 owner 能让 lifecycle、退出和恢复证据可归因。
- 影响：不并行建立直接 SDK、GUI server、WebSocket 或 launcher/mirror 路径。

## D-004 — Pi session 是 Conversation 事实源

- 日期：2026-07-20
- 状态：Accepted
- 决策：Pi session 文件保存对话事实；GUI 只持久化项目设置、信任选择和最近 session 指针。
- 原因：避免 Pi session、renderer 投影和 GUI 数据库成为竞争事实源。
- 影响：P1 不使用 SQLite；credential 与 provider auth 始终由 Pi 管理。

## D-005 — P1 版本基线

- 日期：2026-07-20
- 状态：Accepted
- 决策：固定 Node 26.4.0、pnpm 11.9.0、Electron 43.1.1、React/React DOM 19.2.7、TypeScript 7.0.2、electron-vite 5.0.0、Vite 7.3.6 和 Pi Coding Agent 0.80.10。
- 原因：建立无隐式 `latest` 的可复现起点；electron-vite 5 的 peer 范围不包含 Vite 8，因此固定 Vite 7。
- 影响：版本升级必须作为显式决策，重新生成 lockfile 并通过当前 release gate。

## 待决策

- S7 选择唯一 Linux 产物格式；在真实机器验证约束已知后决定，不在 S0 提前引入打包依赖。
