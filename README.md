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

S0 只建立事实源和可复现依赖基线；Electron 应用入口将在 S1 落地，因此 `pnpm dev` 从 S1 开始可运行。

产品范围、架构、发布门槛和决策分别见 `docs/product-boundary.md`、`docs/architecture.md`、`docs/release-gate.md` 和 `docs/decisions.md`。
