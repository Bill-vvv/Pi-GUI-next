# 产品边界

> 适用阶段：P1 — Linux Core Chain / v0.0.1

## 产品目标

Pi GUI 的长期方向是桌面 Agent Workbench。P1 只建立第一条可发布的 Linux 本地核心链路：一个 GUI Project 对应一个 Pi Runtime 和一个 Pi Session，用户能完成对话、观察工具执行、终止当前轮次，并在 Pi 异常退出后显式恢复会话。

## P1 范围内

- Linux Electron 应用的启动、关闭和进程收口。
- 显式配置 Pi executable，严格支持 Pi Coding Agent 0.83.0。
- 单 Project、单 Runtime、单 Session。
- 显式项目目录；选择后直接启动 Pi，不增加 GUI 自定义的信任等级。
- prompt、assistant streaming、thinking、tool call/result 和 abort。
- Pi 异常退出诊断，以及基于 `sessionFile`、`sessionId` 的显式 restart/resume。
- 一个 Linux 打包产物及其真实核心链路证据。

## P1 范围外

- 多 Project 或多 Session 并行。
- Files、Git、Terminal、Browser、Activity Bar、Work Item、Plan 或 Kanban。
- 插件管理 UI、动态后端发现和作为第二 control plane 的远程后端。
- Windows、WSL、macOS、SSH 或远程后端。
- SQLite、Fastify、WebSocket、自动更新和公网多用户远程服务。
- 自动重启、无限重试或静默 fallback。

范围外能力不得通过空接口、占位模块或兼容层提前进入 P1。

## 私有远程呈现面（opt-in，非 P1 必达）

在桌面核心链路之外，产品允许一个**默认关闭**的私有远程呈现面：设置页默认由 Electron Main 一键配置系统 Tailscale Funnel（任意浏览器）或 Serve（仅 Tailnet 设备），Gateway 只监听 loopback；现有 Lucky/受信 HTTPS 反代继续作为互斥的高级手动入口。两种入口都访问同一 Electron Main / WorkbenchKernel，传输为 SSE 事件流 + JSON 命令 POST，而不是 WebSocket 或第二套 Kernel/daemon。它只服务个人/家庭场景下的受控手机或浏览器查看与有限操作，不是公网多用户服务器，也不替代桌面 control plane。启用条件、鉴权、反代与验证见 [`remote-access.md`](remote-access.md) 与决策 D-065、D-066、D-074。

## 统一远程产品方向（P4-1 Host 已完成，P4-2 Windows Client 实施中）

Pi GUI 后续统一为一个产品下的三种角色：Linux Desktop 同时承载完整界面和唯一 Pi Host；Windows Desktop 第一版作为通过系统 OpenSSH 连接 Linux Host 的 remote-only 完整桌面客户端；现有浏览器 Remote App 继续作为由 Linux Host 托管的轻量 Web Remote。三者共享版本化 contract 和 Linux Main 的同一 `WorkbenchKernel`，不复制 Session、Runtime 或 control plane。

该方向不把 Web Remote 嵌入 Windows Electron，也不把浏览器 Public Origin、Trusted Proxy 与 Secure Cookie 直接复用于 SSH。P4-1 已完成 Linux loopback Desktop Gateway、独立桌面设备配对、Bearer credential、单活动 controller 和 Kernel SSE/command 入口；启用与协议见 [`desktop-host.md`](desktop-host.md)。P4-2A 已建立严格 Host config、系统 OpenSSH tunnel owner 和 Node Desktop Host transport；首轮安全 findings 已修复并通过正式 gate，但独立 closure 前保持不可用；它尚未接入 Windows remote-only Main/preload/Renderer，也未实现凭证持久化。Windows remote-only 模式不得要求本地 Pi，也不得在本机创建第二 Kernel；SSH 负责主机身份、用户认证、加密和跳板连接。完整边界见决策 D-067；Windows 产物和真实 Windows→Linux 发布 gate 落地前，不得宣称 Windows 已受支持。

## 旧项目边界

旧 Pi GUI 仓库和结项资源包均为只读参考，不是本项目依赖。禁止整仓迁移，也禁止复制旧 `App.tsx`、`RuntimeSupervisor`、global reducer、SQLite schema、launcher/mirror 拓扑或整套 CSS。

只允许在当前边界下逐项重新实现经过选择的协议规则、纯函数、生命周期策略和验证思路。资产在来源与授权确认前不得进入发布包。

## 完成口径

功能存在不等于完成。P1 只有在干净 checkout 可重复安装和构建、打包产物完成真实 prompt/tool/abort/crash/resume 链路、工作区与计划证据一致时才完成。详细门槛见 `release-gate.md`。
