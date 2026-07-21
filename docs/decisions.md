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

## D-006 — GUI 不定义项目执行信任等级

- 日期：2026-07-20
- 状态：Accepted；替代 D-004 中“持久化信任选择”的部分。
- 决策：GUI 只保存项目路径，不展示或持久化 trusted/untrusted，也不向 Pi 传递 `--approve` 或 `--no-approve`。
- 原因：Pi 的工具执行默认不逐次审批；上述参数控制项目本地资源加载，不是工具执行权限等级。将其包装成“可信/受限项目”会误导用户。
- 影响：选择项目后即可启动；Pi RPC 使用自身默认行为；config 只接受并保存项目路径，旧 trust schema 直接判为无效。

## D-007 — 对话使用安全、流式优化的 CommonMark/GFM 渲染

- 日期：2026-07-20
- 状态：Accepted
- 决策：正文和 thinking 统一使用 `react-markdown@10.1.0`、`remark-gfm@4.0.1`、`remark-parse@11.0.0` 与 `unified@11.0.5`；禁用 raw HTML。流式期间按动画帧合并更新，并按同一 GFM AST 的顶层边界复用稳定块；未稳定 tail 超过 16,384 字符时改为 React 转义的纯文本流式展示，消息 settled 后执行一次完整文档解析并恢复完整 GFM 效果。
- 原因：完整 Markdown 是 S5 对话体验的基础，但对每个 token 重解析整条长消息会阻塞 renderer；手写 HTML 或允许 raw HTML 会扩大 Electron 攻击面。
- 影响：历史消息不随当前流重复解析；列表、blockquote、CommonMark 围栏和 GFM table 不由手写规则切分；引用/脚注定义在预算内保持整篇文档解析，超预算后只在 streaming 期间使用安全纯文本，settled 后完整解析；外链只通过 Main 的协议白名单打开；Markdown 图片在 P1 只显示为安全外链，不自动加载远程内容；不引入语法高亮、Mermaid、数学公式或第二套完成态 renderer。

## D-008 — P1 唯一 Linux 产物为 x86_64 AppImage

- 日期：2026-07-21
- 状态：Accepted
- 决策：P1 只生成一个 x86_64 AppImage，使用精确固定的 `electron-builder@26.15.3`；不并行生成 pacman、deb、rpm、tar 或 unpacked 发布格式。
- 原因：当前 P1 需要单文件、无需 root 安装且能在真实 Arch Linux/Wayland/Niri 机器直接执行的产物；本机 FUSE 已验证可用。AppImage 满足该约束，同时不把发布生命周期绑定到单一发行版包管理器。
- 影响：统一入口为 `pnpm package:linux` 和 `pnpm verify:linux`；产物固定为 `release/pi-gui-next-0.0.1-x86_64.AppImage`，验证只接受这一份 AppImage，并从产物生成脱敏 JSON 报告与截图证据。

## D-009 — 对话过程按 run 线性展示并在 settled 后折叠

- 日期：2026-07-21
- 状态：Accepted
- 决策：活动 run 中按原始顺序展示 thinking 与工具项；同一 `toolCallId` 只占一个工具项，并从“正在调用”原地更新为完成或失败。`agent_settled` 后将 thinking 和工具过程折叠到该轮最终回答上方，展开后恢复原顺序。读取和修改文件从 `read`、`edit`、`write` 等结构化参数提取；修改 diff 延后实现。
- 原因：原扁平 Timeline 将 thinking 塞入 assistant message，并把工具当作独立日志卡，无法稳定表达“思考 → 工具 → 继续思考 → 回答”，完成后也没有清晰的信息主次。
- 影响：Kernel contract 增加独立 thinking entry 与活动 run 起点；tool result 不产生第二个 entry；Renderer 增加完成过程摘要、文件清单及基础悬浮信息，不跟踪或猜测 `bash` 的隐式文件副作用。

## D-010 — 高频 Conversation 更新使用增量 patch 与有界挂载

- 日期：2026-07-21
- 状态：Accepted
- 决策：Pi 高频事件使用带 index 的 `kernel.state-patched`；append-only message、thinking 和 tool output 只传新增后缀，非前缀变化 Fail Fast 回退全量快照。Renderer 每动画帧最多提交一次 patch 结果，Timeline 初始只挂载最近 60 个 settled turn，折叠过程正文延迟到展开时挂载。
- 原因：完整状态快照会让增长中的回复和全部历史在每个 update 上反复跨 IPC；全部历史与折叠正文常驻 DOM 会让长 session 的 reconcile、layout 和内存随轮数持续增长。
- 影响：未变化 entry 保持对象 identity；低频生命周期与恢复仍使用全量事实快照；用户可显式向前展开完整历史；不引入状态数据库、第三方虚拟列表或第二套 transport。

## D-011 — 流式 Markdown 不降级为纯文本

- 日期：2026-07-21
- 状态：Accepted；替代 D-007 中“未稳定 tail 超过 16,384 字符时使用纯文本”的部分。
- 决策：16,384 字符只作为顶层块分区预解析预算。未稳定 tail 超过预算后，停止额外的分区解析，改为使用同一 `react-markdown` 管线整篇实时渲染 GFM；streaming 与 settled 均不使用纯文本 fallback。
- 原因：用户要求流式阶段保持实际 Markdown 效果，不能在结束时出现一次“格式就位”。当前 unified/remark 没有增量 MDAST API，固定窗口切片会破坏跨边界的围栏、列表、表格、强调和引用定义语义；整篇 GFM 是当前依赖下最小且语义正确的实现。
- 影响：常规多段回复继续复用稳定顶层块；超长单一活动块或 document-wide definition 每帧需要一次 O(n) GFM 渲染，但不会再发生同帧的分区预解析加 React 渲染双重解析。106,500 字符、300 次渲染帧的基准中，单段平均 12.81ms、P95 22.41ms，document definition 平均 12.84ms、P95 24.03ms；不引入第二套 renderer、Worker 协议或不精确的 Markdown 切分器。
