# Pi GUI

Windows GUI + WSL2 体验版安装及打包说明见 [Windows + WSL 安装版](docs/windows-wsl-install.md)。

Pi GUI 是面向本地 Pi Coding Agent 的 Linux 桌面工作台。P1 Linux Core Chain / v0.0.1 已完成，P2（Workbench Foundation）已完成 S10 多 Session，下一 Slice 为 S11 Pi 基础命令与 slash command，执行事实以 [`docs/development-plan.md`](docs/development-plan.md) 为准。

## 工具链

- Node.js 26.4.0
- pnpm 11.9.0
- Pi Coding Agent 0.83.0

安装依赖：

```bash
pnpm install --frozen-lockfile
```

单平台独立 checkout 的开发入口：

```bash
pnpm dev
```

Windows 首次启动 SSH Desktop Client，通过系统 OpenSSH 连接 Linux Host；之后恢复上次成功选择的 WSL/SSH 环境，生产窗口在连接页或设置常规页提供重启切换。双方使用实际源码内容摘要校验构建身份，无需设置 `PI_GUI_BUILD_COMMIT`。连接界面可保存和切换多套 SSH Host 配置，每套配置独立保存设备凭证；新主机先保存配置，再使用 Linux 设置页生成的 6 位配对码连接。关闭窗口或普通断开保留配对；通过“管理 Host 连接”中的“取消配对”才撤销设备。

Linux Host 可用 `node scripts/desktop-host.mjs configure --port 18788` 准备私有配置，再用 `check` / `start --build-root /absolute/prepared-linux-build` 校验或前台启动已有 Linux 构建（两者都需 `--build-root`）。入口保留既有配对，握手通过才报告就绪；需要图形会话。`deploy` 支持独立发行目录、升级、同版本复用和 `rollback`；`pack` 可生成携带 Node 和精简运行依赖的 Linux 归档，解压后通过 `install.sh` 首次安装，无需原源码或预装 Node。详见 [Host 配置与启动](docs/desktop-host.md#统一配置与启动命令r11) 和 [可分发包与首次安装](docs/desktop-host.md#可分发包与首次安装r11)。

Windows 与 WSL 共同开发时使用隔离入口，避免两端覆盖同一个 `node_modules`：

```text
node scripts/workspace.mjs doctor
node scripts/workspace.mjs typecheck
node scripts/workspace.mjs test-platform
node scripts/workspace.mjs dev
```

Windows 界面连接本机 WSL 的完整构建、同步和启动入口：

```powershell
node scripts/workspace.mjs wsl
```

需先启用 Node 26.4.0，并把 pnpm/Git 加入 PATH。入口自动准备各平台独立开发目录。WSL 后端更新成功后才切换版本；运行中会明确拒绝更新。项目、Session 和 Pi 仍在 Linux Host。高级发行版选择、目录规则和验证范围见 [Windows / WSL 共同开发](docs/cross-platform-development.md)。P4-3 真实 SSH 发布 gate 与 P4-4 交互 gate 完成前，不宣称 Windows 正式支持。

`PI_GUI_PROBE_ONLY=1` 仍走离线 Pi RPC 探针并立即退出，不进入 remote-only GUI。

通过 pnpm 启动会使用项目锁定的 Pi 0.83.0。Linux 上 Electron Main 会先检查 Pi 版本并执行离线、无 session 的 `get_state` 探针。默认从当前 `PATH` 解析 `pi`；需要显式指定时使用：

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

产品范围、架构、发布门槛和决策分别见 `docs/product-boundary.md`、`docs/architecture.md`、`docs/release-gate.md` 和 `docs/decisions.md`；P2 Workbench 结构见 `docs/p2-workbench-structure.md`；已交付能力、历史修复与工程经验见 `docs/engineering-history.md`。可选的私有 Web Remote（默认关闭，SSE + JSON POST；设置页默认一键使用 Tailscale Funnel/Serve，Lucky 作为高级手动反代）见 `docs/remote-access.md`；Linux loopback Desktop Host 与 Windows remote-only 客户端见 `docs/desktop-host.md`。P4-2 source 已接通系统 OpenSSH、Credential Manager 与连接界面；P4-3 真实 Windows 发布 gate 前不得宣称 Windows 已受支持。
