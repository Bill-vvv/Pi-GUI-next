# 架构决策记录

本文件只记录已经生效的架构决策。新决策追加，不覆盖旧结论；改变既有决策时必须写明替代关系。

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

## D-012 — Pi 官方 SDK / `RpcClient` 是受控迁移候选

- 日期：2026-07-21
- 状态：Accepted；澄清 D-003 中“不并行建立直接 SDK”的边界
- 决策：P1 不在 Electron Main 内嵌入 Pi `AgentSession`，也不将 Pi 0.80.10 官方 `RpcClient` 原样替换 `LinuxLocalRuntime + PiRpcClient`。官方 RPC command/response/event 类型可作为优先评估的复用边界；官方 `RpcClient` 作为后续唯一 RPC 客户端的受控迁移候选。
- 原因：进程内 `AgentSession` 不满足当前 Pi 运行时隔离目标；官方 `RpcClient` 会自行通过 `node` 启动 CLI，完整累计并输出 stderr，且对 executable 版本、异常退出证据和分阶段停止的公开控制不足；这些语义是当前 crash/restart/resume 与脱敏发布证据的前提。
- 影响：P1 拓扑、`RuntimeHost` 接口和六项 RPC 命令范围不变；不引入第二条集成路径。完整替换前，候选官方客户端必须保留或允许注入等价的 lifecycle/诊断语义，通过当时全部 release gate，并在同一变更中删除自有客户端；不长期双路径共存。

## D-013 — Slash command 使用 normalized catalog 和受控分路径执行

- 日期：2026-07-21
- 状态：Accepted
- 决策：Workbench Kernel 在活动 Runtime 启动时通过 Pi `get_commands` 建立 normalized command catalog，并与有限的 GUI/typed RPC 命令合并。Renderer 只搜索、补全并提交当前 catalog 中的 command ID 和参数；Kernel 校验 ID 后，分别执行 GUI 行为、typed RPC 或 Pi 明确支持的 extension/prompt/skill prompt 语义。
- 原因：Pi TUI builtin slash command 是交互界面命令，不是通用 RPC 文本协议；同时 extension、prompt template 和 skill 的确由 RPC `get_commands` 发现并经 Pi prompt 入口调用。把所有 `/...` 文本盲传会混淆 owner、绕过 typed boundary，并可能把未知命令送给模型。
- 影响：S11 只实现 `/new`、`/model`、`/thinking`、`/compact`、`/name` 五项明确内建映射和 Pi 动态目录；未知命令 Fail Fast。IPC 不接收任意 raw command 或执行路径，动态命令必须先存在于当前 Runtime catalog；TUI 的 settings、login/logout、share、reload、quit、tree 等界面命令不自动进入 GUI。

## D-014 — 首轮语义名称使用隔离的 Pi metadata 请求

- 日期：2026-07-22
- 状态：Accepted；澄清 D-003 和 D-012 的外部 Pi Runtime 集成边界
- 决策：新 Session 的首轮进入 `agent_settled` 且 canonical pointer 已落盘后，由 Electron Main 启动一次短生命周期的 `pi --print --no-session` 请求，使用活动 Session 的 provider/model 与 Pi 已有认证生成目的导向的名称。该请求禁用 tools、extension、skill、prompt template、theme 和项目 context，不创建或恢复 Session；结果只通过现有 typed `set_session_name` 路径写回。切换、停止、崩溃或用户手动 `/name` 时取消请求。
- 原因：Pi 0.80.10 RPC 没有独立的标题接口；复用活动 `prompt` 会污染对话事实源，内嵌 `AgentSession` SDK 会建立第二套 provider/auth 与生命周期边界。隔离的无 Session CLI 请求可以复用 Pi 管理的认证，同时不改写对话。
- 影响：D-003 的 Electron Main 单一 control plane 与外部 Pi RPC 集成路径保持不变；D-017 生效后，每个 Session Runtime context 各自拥有 `RuntimeHost`。D-012 的“不内嵌 AgentSession、不并行 RPC client”继续成立。Electron Main 额外拥有一个有界、可取消、仅生成 metadata 的 Pi 子进程。生成失败时 Session 保持未命名，不复制首条消息做伪语义 fallback；已有未命名 Session 在下次恢复时补生成。

## D-015 — 自动命名模型按授权目录选择并允许用户覆盖

- 日期：2026-07-22
- 状态：Accepted；替代 D-014 中“使用活动 Session 的 provider/model”的模型选择规则；2026-07-24 修订写回所有权与候选顺序
- 决策：自动模式只在 Pi `get_available_models` 返回的目录中、当前活动 provider 内按 `gpt-5.4-nano`、`gpt-5.4-mini`、`gpt-5.3-codex-spark`、`gpt-5.6-luna` 的顺序选择低成本模型，并使用 `--thinking off`；没有这些模型时保持未命名，不回退到活动的高成本模型。用户可在设置中选择自动、关闭或指定目录中的任一已授权 provider/model。自动命名请求归属于对应 Session 的 Runtime context：切换前台对话不得取消或丢弃已发起的命名结果，成功后仍通过 `set_session_name` 与导航指针持久化写回。
- 原因：标题生成是短文本目的归纳，不需要主对话模型的能力和 reasoning 成本；同时 OAuth 与 API key 用户可用的 provider/model 不同，不能硬编码本机 provider，也不能要求第二份凭据。多 Runtime 并行后，若仍把“保持前台 active”作为写回条件，会在用户切换对话时静默丢掉标题。
- 影响：Pi 继续独占 OAuth token、API key 与刷新流程；GUI config v3 只保存命名模式及可选 provider/model ID，不保存认证材料。指定模型在当前目录不可用时 Fail Fast；运行期间修改设置会取消旧命名请求，失败或无低成本候选时 Session 保持未命名。

## D-016 — 自定义 Provider/Model 直接编辑 Pi 官方配置并显式测试

- 日期：2026-07-22
- 状态：Accepted；澄清 D-004、D-015 的 Provider 配置边界
- 决策：GUI 通过 typed Main IPC 编辑 Pi 用户目录中的 `models.json`，支持新增、编辑、删除自定义 Provider 与 Model。API key 可使用字面值、环境变量引用或命令引用；Renderer 只提交用户本次输入并接收“是否已配置”，不回读原值，也不写入 GUI config。连接测试使用隔离的 `pi --print --no-session` 短请求，只允许测试当前已配置的自定义 Provider/Model，并禁用工具、Extension、Skill、Prompt Template、Theme 与项目 context。
- 原因：Pi 0.80.10 RPC 只有 `get_available_models` 与 `set_model`，没有 Provider 配置或连通性测试命令；`models.json` 是 Pi 官方的自定义 Provider/Model 事实源。目录刷新只能证明配置可发现，不能证明端点、鉴权和模型实际可调用。
- 影响：Pi 仍负责解析凭据、发起 Provider 请求和使用配置；GUI 不建立第二份 Provider 数据库。写入时保留未知配置字段并以 `0600` 原子替换；测试会产生一次最小实际模型请求，失败信息不返回 stdout、stderr 正文或密钥。活动 RPC Runtime 不支持热重载配置，新配置在下一次新建或重新打开对话时进入模型目录。

## D-017 — 恢复按 Session 隔离的多 Runtime 并行

- 日期：2026-07-23
- 状态：Accepted；替代 D-014、P2 S8–S10 中“单一活动 Runtime”的所有权限制，不改变 D-003 的 Electron Main 单一 control plane
- 决策：Workbench Kernel 按 Project/Session 管理独立 `RuntimeContext`。多个 Pi RPC Runtime 可以同时运行；Renderer 继续只展示当前 Session 的完整投影，并通过 Session summary 展示后台 `starting/ready/running/stopping/crashed` 状态。
- 原因：旧 Pi GUI 已具备多个 `runtimeId` 共存的 RuntimeSupervisor；新项目从零重建时把多 Project/Session 收缩为只可切换，造成用户在一个对话运行时无法继续下一个对话。这是核心工作台能力回退，不应继续作为产品边界。
- 影响：切换 Project/Session 或新建对话不再停止其他 Runtime；命令与事件必须按 context 路由；归档只停止目标 Session；应用退出必须尝试收口全部 Runtime。Pi session 文件仍是 Conversation 事实源，Electron Main 仍是唯一子进程 owner，不恢复旧 GUI server、WebSocket、SQLite 或 launcher/mirror 拓扑。

## D-018 — 文件使用 TUI 上下文语义，图片使用 Pi RPC 原生内容块

- 日期：2026-07-23
- 状态：Accepted；扩展 D-003 的 typed RPC 映射和 D-004 的 Conversation 事实源边界
- 决策：Composer 选择、拖放或粘贴的普通文件按 Pi 0.80.10 TUI 的 `<file name="…">…</file>` 语义加入消息文本；图片经过与 TUI 相同的尺寸和 inline payload 边界处理后，作为 `prompt`、`steer`、`follow_up` 的原生 `images?: ImageContent[]` 发送。GUI 不把图片伪装为路径文本，也不建立独立上传服务。
- 原因：Pi RPC 已原生接受 `{ type: "image", mimeType, data }`，当前 GUI 的 string-only adapter 丢失了这一能力；RPC server 又不会自动展开 `@文件`，因此普通文件必须由 GUI 在明确文件访问边界内预处理。
- 影响：Main 原生选择器拥有按用户选择读取文件和处理图片的权限；Renderer 仅可处理用户显式拖放或粘贴得到的 DOM `File`。Pi session 保存完整消息与图片块，Kernel/Renderer 只展示不含正文和 base64 的附件摘要；不新增附件数据库、云存储、任意路径读取或第二条 runtime。

## D-019 — 普通文件采用交互式 TUI 的路径引用语义

- 日期：2026-07-24
- 状态：Accepted；替代 D-018 中普通文件内联 `<file>` 正文的决定，图片原生 `ImageContent` 决定不变
- 决策：Composer 选择或拖放的普通文件只在消息前加入交互式 TUI 同语义的 `@路径`；GUI 不读取、复制或发送文件全文。Agent 需要内容时使用 Pi 原生 `read` 工具，文本输出按 2,000 行或 50 KiB 截断，并可按 offset/limit 继续。图片仍经过尺寸和 inline payload 边界处理后作为 `prompt`、`steer`、`follow_up` 的原生 `images?: ImageContent[]` 发送。
- 原因：Pi 的 CLI 启动参数 `pi @file` 会预展开全文，但交互式 TUI 的 `@` 补全只插入路径，提交时不读取文件。GUI 面向交互输入，应参考后者；复制 CLI 启动参数语义会让大文本在首条消息中占满上下文。
- 影响：普通文件不经过 Renderer/IPC/RPC 正文传输，附件 chip 与历史投影只是路径引用摘要；Main 文件选择和 Renderer 拖放只读取用于图片区分的小段签名头。模型按需读取的片段仍进入上下文，但不会默认一次注入整个文件；图片保持原生多模态输入，不增加上传服务或附件存储。

## D-020 — GUI 承载 Pi 原生项目资源信任，不定义工具权限

- 日期：2026-07-24
- 状态：Accepted；替代 D-006 中“GUI 不传递或承载任何 Project trust 决定”的部分，保留“不定义项目执行信任等级”的原则
- 决策：当 Project 存在 Pi 项目级设置、Package、Extension、Skill、Prompt、Theme、系统提示或 `.agents/skills`，且 Pi 没有可继承的既有决定时，GUI 在首个 Runtime 启动前承载与 Pi TUI 相同的项目资源信任提示。持久决定只由 Pi 的 `ProjectTrustStore` 写入 `trust.json`；仅本次决定只作为该 Runtime 的启动输入。GUI 不建立 trust schema，不把决定解释成文件、Shell 或工具执行权限。
- 原因：非交互 RPC 无法显示 TUI 提示；在默认 `ask` 且没有既有决定时会静默忽略项目资源。完全不承载提示会让项目 Extension、Skill 和配置在 GUI 中无解释地失效，而重新引入自有 trusted/untrusted 等级又会重复 D-006 已纠正的语义错误。
- 影响：Renderer 只接收项目路径、风险说明和可选动作，不直接读写 `trust.json`。取消提示即取消 Runtime 启动；已有决定和父目录决定不重复询问。决定变化只对新建或手动 reload 的 Runtime 生效，不静默重启正在运行的 Session，也不显示常驻“可信/受限”徽标。

## D-021 — 登录退出复用已验证 Pi 安装的公开认证 SDK

- 日期：2026-07-24
- 状态：Accepted；澄清 D-003、D-012 和 D-016 的 SDK、credential 与 Runtime 边界
- 决策：S15 的 Provider login/logout 由 Electron Main 动态加载当前已通过精确版本校验的 Pi 安装所公开的认证 SDK；只调用 Provider 发现、登录、退出和凭证状态接口，不创建进程内 `AgentSession`，不替换外部 Pi RPC Runtime，也不把完整 Pi Coding Agent 或 Provider SDK 复制进 AppImage。无法从当前 Pi 安装加载公开接口时明确报告认证能力不可用，不使用私有 deep import 或直接改写 `auth.json`。
- 原因：不同 Provider 的 OAuth、设备码、授权码和 API Key 流程由 Pi 统一实现，GUI 自行复制会产生第二套认证逻辑和凭据风险；把完整 SDK 依赖闭包打入 Electron 又会显著增加产物并可能与系统 Pi 版本漂移。认证控制操作不需要改变现有 Session Runtime 拓扑。
- 影响：token、refresh token 和 API Key 原文始终由 Pi 管理，不进入 Renderer、Kernel state、日志或 GUI config。Renderer 只显示 Provider、认证来源、设备码/授权说明和成功失败状态。认证变化后刷新凭证与模型目录，但不静默切换模型或重启 Session；受影响的 Session 需要用户显式 reload 后才使用新凭证。

## D-022 — S15 外部 Pi 状态只走公开接口并隔离验证

- 日期：2026-07-24
- 状态：Accepted；澄清 D-016、D-020 和 D-021 的 credential、trust 与验证边界
- 决策：S15 只使用固定 Pi 0.80.10 包根公开导出、外部 RPC 和明确 CLI 参数。Trust 首期通过包根导出的资源检测与 `ProjectTrustStore` 提供当前 Project 的持久信任/不信任，并通过 `--approve` / `--no-approve` 提供仅本次信任/不信任；识别继承的父目录决定，但不复制未公开的 TUI option helper，也不提供写入父目录的快捷项。认证只展示包根 `ModelRuntime` 实际声明且 GUI 已实现完整交互的类型；已有 credential 原文绝不回读 Renderer。用户本次主动键入的 API Key 可以在受控输入中瞬时经过 Renderer 和窄 typed IPC，但不得进入 Kernel state、事件、日志、错误或 GUI config。
- 原因：Pi 的 package exports 只保证包根和 `rpc-entry`，私有 deep import 会使打包与版本边界不可复现；同时 D-016 已允许用户本次输入自定义 Provider API Key，D-021 的“API Key 原文不进入 Renderer”必须解释为不回读已有值、不进入状态或持久化，而不是否定受控输入本身。Trust、认证和真实 login/logout 会修改 Pi agent 目录，沿用默认用户目录会污染真实外部状态。
- 影响：缺少公开接口时对应入口明确不可用，不复制 Pi 内部实现作为 fallback。所有 trust、credential 和发布验证使用临时 Project、隔离 XDG 与隔离 `PI_CODING_AGENT_DIR`；真实认证只使用明确选择的 QA/provider 账户，不读写默认用户 `auth.json` 或 `trust.json`。认证变化继续不静默切模或重启 Session，只有用户显式 reload 后才进入目标 Runtime。

## D-023 — Session Fork 迁移现有 Runtime，归档补救不恢复 Runtime

- 日期：2026-07-24
- 状态：Accepted；扩展 D-004 与 D-017 的 Session identity 和 Runtime context 边界
- 决策：Fork 候选只从 Pi `get_entries` 的 `leafId` 沿 `parentId` 得到的当前活动路径产生，并只使用其中不含 `ImageContent` 的用户消息真实 entry ID。Pi 在同一 RPC 进程完成 fork 后，Kernel 校验全新的 canonical `sessionFile` / `sessionId`、完整刷新投影并保存新 pointer，再把原 Runtime context 从旧 Session key 原子迁移到新 key；原 pointer 和文件不变。归档撤销由 Main 的单次、目标绑定、单调过期凭证驱动，只恢复导航索引；临时查看消费同一类凭证并读取保持归档的静态事实，两者都不启动 Runtime。
- 原因：按正文或 Timeline 下标猜 entry 会误选废弃分支；fork 后继续把同一进程挂在旧 key 会让事件和 Conversation identity 错配。归档后的短时后悔操作若自动恢复 Runtime，会把轻量导航补救变成有副作用的后台进程操作。
- 影响：带图片的历史消息首期不提供 Fork；fork 后投影或持久化失败时停止已重绑定的 Runtime，不能把旧历史标成新 Session。撤销凭证不持久化，过期、重复、目标不匹配或应用重启后 Fail Fast；完整 Session tree、Clone、归档中心、永久删除和批量操作继续不进入 S15。

## D-024 — Session 导出与统计留在 Main 的 Pi 事实边界

- 日期：2026-07-24
- 状态：Accepted；扩展 D-003 与 D-004 的 IPC、Conversation 和 Session 事实边界
- 决策：离线 HTML 由 Main 读取并校验当前活动 Session 的最终 leaf 分支后自行安全序列化，只输出用户消息、Assistant 最终回答、安全 CommonMark/GFM、代码和合法 Pi `ImageContent`；Renderer 只触发系统保存框，不接收原始 Pi 消息、JSONL 或保存路径。停机 Session 的 tooltip 统计由 Main 扫描已校验 JSONL 的全部 message entry，活动 Session 则读取 Pi `get_session_stats`；两者使用 Pi 全生命周期口径且不持久化副本。
- 原因：Renderer 若取得 JSONL 或原始导出正文，会扩大任意会话读取与隐藏过程数据泄漏面；直接采用 Pi 通用 HTML 导出又会包含超出本阶段分享边界的内容。停机 Session 为统计启动 Runtime 会把只读导航元数据变成昂贵且有副作用的进程操作。
- 影响：导出明确排除废弃分支、thinking/commentary、工具参数与输出、diff、system prompt、工具定义、完整项目路径、cost 统计和隐藏 JSON；raw HTML、脚本与远程资源不可执行或加载，远程 Markdown 图片只成为安全链接或占位。Session 行可显示文件、ID、消息、Token 与累计成本，但统计失败只暴露固定诊断，不回显 transcript 内容；复制按钮直接复制每条已完成最终回答在 Kernel projection 中保留的原始 Markdown。

## D-025 — Project 路径搜索只返回固定目录句柄内的相对名称

- 日期：2026-07-24
- 状态：Accepted；扩展 D-003 与 D-019 的 Renderer 文件访问和路径引用边界
- 决策：Composer 的 `@` 搜索通过窄 typed IPC 请求当前 canonical Project。Main 使用 `O_DIRECTORY` / `O_NOFOLLOW` 打开并固定目录句柄，再从该句柄枚举相对文件和目录名；排除 `.git`，按层读取 `.gitignore` 与 `.ignore`，跳过 symlink 和不可安全引用的控制字符路径，最多返回 100 项。Renderer 只按 Project、query、输入、光标和请求 revision 接受当前结果，并用共享路径引用格式插入文本。`/fork`、`/export`、`/copy` 复用 Renderer 已有 GUI 动作，Kernel 对这些 GUI-only command 的直接调用 Fail Fast。
- 原因：把任意路径读取或普通文件正文交给 Renderer 会扩大文件访问面；先校验路径再按路径名遍历仍存在目录被替换为外部 symlink 的竞态。GUI 动作若退化成 Pi prompt 文本，也会绕过已有的选择器、保存框、Clipboard 和状态门禁。
- 影响：搜索只读取目录项和 ignore 文件，不读取普通文件正文，也不把绝对 Project 路径作为结果返回；目录句柄实现属于当前 Linux 产品边界。`@` 菜单内可用 Arrow、Enter 或 Tab 选择候选，但普通文本不获得 shell 风格路径 Tab 补全；不增加 `!` / `!!` Shell、外部编辑器或通用文件 API。

## D-026 — Provider 认证事件脱敏，凭证变化只建立内存 reload 标记

- 日期：2026-07-24
- 状态：Accepted；扩展 D-017、D-021 与 D-022 的多 Runtime、secret 和公开 Pi 能力边界
- 决策：Provider 认证只从已验证固定 Pi 包根的公开 `ModelRuntime` 获取方法、状态并执行 login/logout；GUI 只接收经过清洗的 prompt、notice 与 credential metadata，用户回答经窄 typed IPC 回传，已有 key、token、refresh token 和 SDK 原始错误不进入 Kernel state、事件、日志或 GUI config。认证变化后刷新凭证与模型目录，并为所有 live Runtime context 中实际使用对应 Provider 的 Session 建立非持久化 `requiresReload` 标记；不停止、切换或重启 Session。标记只在用户显式 reload 且完整投影成功后清除，失败时保留，Fork 时迁移，归档时删除。
- 原因：复制 Provider SDK 流程、私有 deep import 或直接读写 `auth.json` 都会建立第二套认证事实与脆弱版本边界；认证变化后自动重启会打断正在生成的回复，而全局 reload 标记又会误导使用其他 Provider 的 Session。
- 影响：凭证页只显示 SDK 实际声明且 GUI 已完整支持的方法，不支持的动作不出现。应用重启后内存标记自然消失，同时原 Runtime 进程也已结束；重新启动 Session 会读取最新凭证。真实验证必须使用隔离 `PI_CODING_AGENT_DIR` 与明确的 QA/provider 输入，不读取默认用户认证文件，也不将任何 secret 输出到测试结果。

## D-027 — 快捷键是有限 GUI 配置，压缩是独立 Runtime 生命周期

- 日期：2026-07-24
- 状态：Accepted；扩展 D-003、D-017 与 D-019 的 typed IPC、多 Runtime 和桌面交互边界
- 决策：GUI 快捷键只覆盖计划固定的 11 个应用动作，以严格完整 binding map 写入 XDG config v9，`null` 表示未绑定；shared 校验同时拒绝重复、文本编辑和已知 Electron/系统保留组合。Renderer 只在窗口聚焦且没有模态框、菜单、认证交互、快捷键录入或 IME composing 时分发，不注册 Electron `globalShortcut`，文本控件中只允许固定默认表内已确认不改变编辑语义的组合。Pi `compaction_start` / `compaction_end` 由 Kernel 按事件所属 Runtime context 归一化为独立 start/end lifecycle；保留 reason、outcome 与 `willRetry`，不转发 summary 或原始错误。成功后核对 Session identity 并一次提交 Conversation、usage 和生命周期 statistics；失败、取消、协议异常或 context teardown 保留旧投影并显式结束等待，不产生伪 `agent_settled`。
- 原因：直接复用 TUI `keybindings.json` 会混合两套动作和焦点语义，系统级快捷键又会越出当前窗口范围；仅监听 compact 命令响应无法覆盖 threshold/overflow 自动压缩，也无法在并行 Runtime 中保证事件归属和投影原子性。
- 影响：恢复默认、清除和重启后的结果都由同一 XDG 配置事实决定，未绑定动作没有隐藏组合；破坏性归档默认保持未绑定。压缩继续使用 Pi 默认模型、提示词与参数，GUI 只展示“正在整理上下文”和固定失败/取消提示；高保真压缩、独立压缩模型、二次审查与测评工具继续不进入 S15。

## D-028 — Session 统一按运行状态与最近活动排序

- 日期：2026-07-25
- 状态：Accepted；替代 S14-04、S14-12 与 S14-39 中 Session 手动拖拽和持久化手动顺序的部分，Project 手动排序不变
- 决策：每个 Project 的 Session 由 Workbench Kernel 统一排序：`running` 项优先，其余按 JSONL `lastActivityAt` 倒序，无时间项置后，同状态同时间保持稳定。Session 不再提供拖拽排序，也不保存第二套手动顺序。
- 原因：原实现把首次拖拽隐式变成不可见且不可恢复的永久模式；后续新 Session 又追加到指针数组末尾，导致最近活动排序在单个 Project 内永久失效，并让完成运行的 Session 从临时置顶位置跳回历史数组位置。
- 影响：XDG session state 升级为 v6 并删除 `manuallyOrderedProjectPaths`；读取 v5 时校验旧字段后丢弃该标记。Renderer、preload 与 Kernel 删除 Session reorder command 和拖拽交互；Project 拖拽、Session identity、Runtime ownership、归档与活动时间事实来源不变。

## D-029 — 自定义模型单价保存于 Pi 配置并按需从 LiteLLM 拉取

- 日期：2026-07-25
- 状态：Accepted；扩展 D-016 的自定义 Model 配置边界
- 决策：自定义模型的输入、输出、缓存读取与缓存写入单价使用 Pi 原生 `models.json` `cost` 字段，单位为 USD/百万 token。用户可手动编辑，或显式通过 Electron Main 从 LiteLLM 公开价格目录拉取；Main 按模型 ID、Provider/模型 ID 和稳定的 Provider 优先后缀规则匹配，只把匹配键和经校验的四项单价经窄 typed IPC 返回。Renderer 不直接联网。
- 原因：缺少 `cost` 会让 Pi 已记录的 token 无法形成正确费用；复制公开目录的单价比要求用户逐项查找可靠，同时仍需展示匹配键并允许手动修正，避免同名代理模型被静默误价。
- 影响：拉价不读取 Provider 凭据，不建立 GUI 价格数据库、后台自动刷新或第二套 usage 事实源。公开目录缺失缓存价格时按 0 写入；未命中或返回非法价格时 Fail Fast。保存后的价格只影响 Pi 后续生成的费用记录，不追溯改写既有 Session cost。
