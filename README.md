# Pi GUI

Pi GUI 是面向本地 Pi Coding Agent 的 Linux 桌面工作台。P1 Linux Core Chain / v0.0.1 已完成，P2（Workbench Foundation）已完成 S10 多 Session，下一 Slice 为 S11 Pi 基础命令与 slash command，执行事实以 [`docs/development-plan.md`](docs/development-plan.md) 为准。

## 工具链

- Node.js 26.4.0
- pnpm 11.9.0
- Pi Coding Agent 0.83.0

安装依赖：

```bash
pnpm install --frozen-lockfile
```

唯一开发入口：

```bash
pnpm dev
```

Windows 源码启动（已通过本地离线 Pi RPC 探针；部分桌面功能仍以 Linux 为准）：

```powershell
cd D:\Projects\pi-gui-next
fnm exec --using 26.4.0 cmd /c pnpm dev
```

通过 pnpm 启动会使用项目锁定的 Pi 0.83.0。Windows 的 npm/pnpm shim 会解析到实际的 `dist/cli.js`，由 Node 执行；Electron 子进程使用 Node 模式，不经过 shell。Windows 冷启动的版本检查和 RPC 超时为 30 秒。系统字体枚举、桌面通知等 Linux 专用功能尚未完成 Windows 适配。

启动时，Electron Main 会先检查 Pi 版本并执行离线、无 session 的 `get_state` 探针。默认从当前 `PATH` 解析 `pi`；需要显式指定时使用：

```bash
PI_GUI_PI_EXECUTABLE=/absolute/path/to/pi pnpm dev
```

当前统一验证入口：

```bash
pnpm typecheck
pnpm test:core
pnpm smoke:pi
pnpm build
pnpm package:linux
pnpm verify:linux
```

P1 只生成 `release/pi-gui-next-0.0.1-x86_64.AppImage`。`verify:linux` 必须在干净工作区运行，并从该 AppImage 执行真实核心链路；脱敏报告和截图写入被 Git 忽略的 `release/evidence/`。

产品范围、架构、发布门槛和决策分别见 `docs/product-boundary.md`、`docs/architecture.md`、`docs/release-gate.md` 和 `docs/decisions.md`；P2 Workbench 结构见 `docs/p2-workbench-structure.md`；已交付能力、历史修复与工程经验见 `docs/engineering-history.md`。可选的私有 Web Remote（默认关闭，SSE + JSON POST；设置页默认一键使用 Tailscale Funnel/Serve，Lucky 作为高级手动反代）见 `docs/remote-access.md`；P4-1 Linux loopback Desktop Host over SSH 见 `docs/desktop-host.md`。P4-2A Windows Host connection foundation 已修复首轮安全 findings并通过正式 gate，当前等待独立安全 closure；Windows Desktop Client 尚不可用。
