# Pi GUI

Pi GUI 是面向本地 Pi Coding Agent 的 Linux 桌面工作台。当前开发阶段为 P1（Linux Core Chain / v0.0.1），执行事实以 [`docs/development-plan.md`](docs/development-plan.md) 为准。

## 工具链

- Node.js 26.4.0
- pnpm 11.9.0
- Pi Coding Agent 0.80.10

安装依赖：

```bash
pnpm install --frozen-lockfile
```

唯一开发入口：

```bash
pnpm dev
```

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

产品范围、架构、发布门槛和决策分别见 `docs/product-boundary.md`、`docs/architecture.md`、`docs/release-gate.md` 和 `docs/decisions.md`。
