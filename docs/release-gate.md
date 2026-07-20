# 发布门槛

## 唯一 lifecycle

P1 只有一条开发与发布路径，不建立 stable/dev/canary、多 checkout、镜像目录或旁路 launcher：

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

具体脚本在对应 Slice 实现后加入 `package.json`；不得用尚未实现的占位脚本制造已具备发布能力的假象。S7 只选择一种 Linux 产物格式，并把该选择追加到 `decisions.md`。

## S0 gate

- Git repository 是本项目唯一源码事实源；旧仓库保持只读。
- Node、pnpm、Electron、React、TypeScript 和 Pi 支持版本均为精确版本。
- `pnpm-lock.yaml` 由 pnpm 11.9.0 生成。
- 干净 checkout 可执行 `pnpm install --frozen-lockfile`。
- 文档明确当前范围、进程 owner、状态来源和 P1 发布门槛。

## P1 自动验证

对应 Slice 落地后，统一命令为：

```bash
pnpm typecheck
pnpm test:core
pnpm smoke:pi
pnpm build
pnpm package:linux
pnpm verify:linux
```

自动测试只覆盖三组高价值边界：LF JSONL framing、RPC request/response correlation、Runtime lifecycle/crash transition。不设置覆盖率目标。

## P1 真实产物 gate

必须从打包产物而非开发服务器执行并记录：

1. launch 与干净退出；
2. Pi 0.80.10 probe；
3. project 路径与 trusted/untrusted 选择；
4. prompt、streaming、thinking 和真实 tool execution；
5. abort 后 runtime/UI 状态一致；
6. 强制终止 Pi 后进入 crashed；
7. 用户显式 restart/resume，并在应用重启后恢复最近 session。

验证报告必须记录 app、Node/Electron、Pi、平台、commit、产物和各步骤结果，不得包含 prompt 正文、敏感 tool output、credential 或完整环境变量。

## Fail Fast

任一必需命令失败、版本不匹配、工作区不干净、证据与 commit 不一致，或只能从开发服务器完成链路时，发布停止；不得静默 fallback 到另一套 runtime、checkout 或产物。
