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
- 决策：自定义模型的输入、输出、缓存读取与缓存写入单价使用 Pi 原生 `models.json` `cost` 字段，单位为 USD/百万 token。用户可手动编辑，或显式通过 Electron Main 一键拉取当前 Provider 全部模型的价格；Main 只请求一次 LiteLLM 公开价格目录，按模型 ID、Provider/模型 ID 和稳定的 Provider 优先后缀规则逐项匹配，只把每个命中模型的匹配键、经校验的四项单价及未命中模型列表经窄 typed IPC 返回。Renderer 不直接联网。
- 原因：缺少 `cost` 会让 Pi 已记录的 token 无法形成正确费用；复制公开目录的单价比要求用户逐项查找可靠，同时仍需展示匹配键并允许手动修正，避免同名代理模型被静默误价。
- 影响：拉价不读取 Provider 凭据，不建立 GUI 价格数据库、后台自动刷新或第二套 usage 事实源。公开目录缺失缓存价格时按 0 写入；单项未命中不阻断其他模型回填，非法价格则 Fail Fast。保存后的价格由下一次新建或显式重载的 Runtime 使用，只影响 Pi 后续生成的费用记录，不追溯改写既有 Session cost。

## D-030 — 首个 Subagent 适配固定复用 Pi Package 与 Extension 资源过滤

- 日期：2026-07-26
- 状态：Accepted；扩展 D-016 的 Pi 官方配置事实边界与 P3 Extension 适配方向
- 决策：首期固定适配 `@mjakl/pi-subagent`，由用户通过 Pi 原生 Package 命令显式安装。启停不建立 GUI 插件注册表，也不卸载 Package；GUI 只修改 Pi `settings.json` 中该 Package 的 Extension resource filter。最大嵌套深度和循环保护作为 GUI 配置写入 XDG，并且只在 Package 已安装且 Extension 已开启时，通过上游公开 CLI 参数进入新建或显式重载的 Pi Runtime。
- 原因：该 Extension 已提供独立子进程、并行委派、持久会话、实时进度和递归保护，并明确兼容当前 Pi 0.80.10。复用 Pi 的 PackageSource 能让“关闭”对应真实加载状态；把开关仅保存在 Renderer 或私有 Extension 列表会形成第二份事实并可能继续执行代码。
- 影响：设置新增独立 Subagent 页面，拓展页同时提供同一真实开关。安装、启停和参数变化不静默重启已有 Runtime；新建或显式 reload 后生效。首期不提供 Agent definition CRUD、任务监控、通用 Package resource 管理或内建 Subagent Runtime。

## D-031 — 首个 Subagent 适配更正为 pi-subagents

- 日期：2026-07-26
- 状态：Accepted；替代 D-030 中固定 Package、运行参数和 cycle setting 的决定
- 决策：首期固定适配 `pi-subagents`。安装与启停继续复用 Pi PackageSource 和 Extension resource filter；GUI 只保存最大嵌套深度，并在 Package 已安装且 Extension 已开启时通过 `PI_SUBAGENT_MAX_DEPTH` 环境变量将其传给新建或显式重载的 Runtime。`pi-subagents` 通过深度上限限制嵌套委派，不保留旧 Package 专属的 cycle setting。
- 原因：截至 2026-07-26 的数据快照，`pi-subagents` 在 pi.dev 为 128K/mo，GitHub 仓库为 2.7k stars、572 commits；其采用环境变量的公开配置边界也与当前按 Runtime 注入设置的架构一致。
- 影响：XDG config 升级为 v11；读取旧 v10 时迁移最大深度并移除 `@mjakl/pi-subagent` 专属的 cycle setting。用户需要安装并启用 `pi-subagents`；既有 Runtime 不静默重启。Agent definition CRUD、任务监控、通用 Package resource 管理和内建 Subagent Runtime 仍不进入首期。

## D-032 — 已适配拓展统一在拓展页安装和启停

- 日期：2026-07-26
- 状态：Accepted；收紧 D-031 的 Renderer 入口职责
- 决策：拓展页新增独立“已适配拓展”区域，首项为 `pi-subagents`，并唯一承载其安装与 Extension resource 启停。Subagent 页只读取 Package 状态并修改最大嵌套层数；未安装或已关闭时禁用参数控件并指向拓展页，不重复安装或启停入口。
- 原因：安装和 Extension 启停属于拓展管理职责；在功能设置页重复入口会形成两个操作位置，也不利于后续把其他已完成 GUI 适配的拓展集中呈现。
- 影响：通用 pi.dev Extension 目录和本地路径入口保持不变；“已适配拓展”只是固定适配项的小区域，不建立通用插件注册中心。Package 安装、资源过滤和状态仍以 Pi 用户设置为事实源。

## D-033 — Subagent 页管理真实 Agent Markdown 定义

- 日期：2026-07-26
- 状态：Accepted；扩展 D-031，并替代 D-032 中“Subagent 页只修改最大嵌套层数”的限制；拓展页仍唯一负责 Package 安装与启停
- 决策：Subagent 页增加 Agent definition 管理。Electron Main 只在 `pi-subagents` 的真实用户级与当前 canonical Project 发现目录中列出、新增、修改和删除 Markdown frontmatter 定义；Renderer 只通过窄 typed IPC 接收规范化字段。内置 Package 文件保持只读，但界面允许直接编辑；首次保存写入用户级或项目级同名覆盖，“恢复默认”删除同名覆盖，不修改 npm Package。编辑器使用可按作用域筛选的分页 Agent 列表，并把名称、作用域、用途、提示词、模型和思考强度放入基础设置；工具、Skills、上下文继承、前后台、超时、轮次、回退模型和单 Agent 嵌套限制放入高级设置。多选模式一次只统一修改一个公共字段，避免复制完整编辑表单。
- 原因：用户需要在独立 Subagent 页面直接理解和管理角色内容；把全部 frontmatter 平铺在同一页面会降低可读性，把管理动作交给模型 prompt 又无法提供确定的保存、删除与作用域反馈。固定目录与 typed 字段可以复用 `pi-subagents` 事实源，同时不向 Renderer 暴露任意文件能力。
- 影响：用户级定义写入 `~/.agents/`，项目级定义写入 `.pi/agents/`；同时读取旧用户 Agent 目录和项目 legacy 目录以展示运行时可发现内容。保存受管字段时保留 GUI 未管理的 frontmatter。Agent 定义、Package 状态和全局嵌套深度都不热改已有 Runtime，仍需新建或显式 reload Session；首版不加入运行任务监控、Chain 编辑器、Watchdog/Profile 管理或通用 Package Agent 注册中心。

## D-034 — 多 Advisor 采用固定 Pi Extension 与 GUI 特别适配

- 日期：2026-07-26
- 状态：Accepted；扩展 D-032 的“已适配拓展”模式，不替代现有 Pi RPC 主拓扑
- 决策：以固定审计版本的 OMP Advisor / Watchdog 行为作为复刻基线，开发一个可独立安装和手动开关的 Pi Multi Advisor Extension。多 Advisor 的模型、上下文、工具、调度、transcript 与可靠性由 Extension 在 Pi 进程内拥有；Electron Main 不嵌入 `AgentSession` 或第二套 Advisor Runtime，只提供固定 WATCHDOG 配置适配、窄 typed control 和严格归一化的 advisory/status 事件。拓展页唯一负责 Package 安装和 Extension resource 总开关；Advisor 专页负责 Extension 已加载后的系统启停、单 Advisor 启停、roster 配置与真实状态。
- 原因：OMP 的价值来自多独立审阅者、严重度分流、WATCHDOG 配置和上下文/健康管理，而不是某个特定桌面壳。把引擎放进 Pi Extension 能复用当前固定 Pi 的 Session、Provider、认证和工具边界；GUI 特别适配又能提供比通用 custom message 更清晰的开关、配置和 Timeline 体验，同时避免 Electron Main 出现第二条 Agent 运行拓扑。
- 影响：新增 [`advisor-system.md`](advisor-system.md) 和 S18 分阶段实施计划。Package 安装、Extension 加载、Advisor 系统暂停和单 Advisor 启停保持四种可区分状态；设置变化不静默重启 Session。首条链路默认只读，未知 raw custom event 不进入 Renderer；写入/Shell 等有副作用工具必须另行安全决策。S18 不建立通用 adapter registry、Conversation 数据库、OMP backend 或任意 Extension RPC。

## D-035 — Magic Context 作为可选上下文引擎适配

- 日期：2026-07-26
- 状态：Accepted；扩展 D-027 的压缩生命周期边界与 D-032 的已适配拓展入口
- 决策：固定适配 `@cortexkit/pi-magic-context`，安装与启停复用 Pi PackageSource 和 Extension resource filter，默认不安装、不启用。GUI 只报告 Package 是否存在及其 Extension 是否开启；不把“已开启”解释为配置或健康检查通过，不解析 Magic Context SQLite，也不复制上游交互式 setup。配置继续使用官方 `setup --harness pi`，健康检查使用 `doctor --harness pi`，运行态由 Pi 命令目录中的 `/ctx-status` 查看。
- 原因：Magic Context 会在每次模型调用前管理上下文，并在启用时取消 Pi 原生自动压缩，能够覆盖长任务内部的多次模型/工具往返；但其 setup 需要选择 historian、dreamer、sidekick 和 embedding，且当前没有稳定的机器 health API。GUI 若从 Package 存在推断健康，或直接读取私有数据库，会建立错误且脆弱的第二套状态协议。
- 影响：安装、启停和配置变化都只在新建或显式 reload Session 后生效。Magic Context 接管时，现有 Pi `compaction_start` / `compaction_end` 不再是其后台 Historian、SOFT/HARD materialization 或缓存状态的事实源；Renderer 不伪造对应进度。首期不内嵌 setup/doctor、不编辑 `magic-context.jsonc`、不读取缓存 token 指标，也不自动选择或消费额外模型。

## D-036 — Agent 启停复用 pi-subagents 官方 disabled override

- 日期：2026-07-26
- 状态：Accepted；扩展 D-033 的 Agent 管理字段
- 决策：Subagent 页通过窄 typed IPC 读取并修改 `settings.subagents.agentOverrides.<name>.disabled`。用户级状态写入 Pi 用户 `settings.json`，项目级状态写入当前 canonical Project 的 `.pi/settings.json`，项目级覆盖优先；关闭只从 `pi-subagents` Runtime 发现与可执行列表移除 Agent，不删除 Markdown 定义。列表支持“已启动 / 未启动”筛选，单项与多选批量修改复用同一真实状态。
- 原因：`pi-subagents` 已公开 `disable` / `enable` 管理动作和同一 settings schema；复用它能让 GUI、Agent 管理工具与 Runtime 看到一致结果。只在 Renderer 保存开关会产生第二份状态且不会阻止实际执行。
- 影响：Main 只读写固定用户与项目 settings 路径中的单个 `disabled` 字段，严格保留其他 Pi 设置；非法 JSON 或非法 override 结构 Fail Fast。启停不静默重启已有 Session，恢复默认或删除 GUI 管理的定义时同步清理对应 disabled 字段。

## D-037 — S18-1 固定独立 Package、默认关闭与 protocol v1

- 日期：2026-07-26
- 状态：Accepted；落实 D-034 的第一阶段
- 决策：首个实现 Package 固定命名为 `pi-gui-multi-advisor` 0.1.0，作为 `extensions/pi-gui-multi-advisor/` 下可被 Pi 独立安装的 Package，不把主应用改成 workspace。系统默认关闭，唯一启用事实为 `${PI_CODING_AGENT_DIR || ~/.pi/agent}/pi-gui-multi-advisor.json` 的 strict v1 JSON；`/advisor on|off|status` 复用同一状态。protocol v1 以 `pi-gui.multi-advisor/capabilities` custom entry 发布能力，以 `pi-gui.multi-advisor/advisory` custom message 保存结构化建议。首版 Advisor 复用当前 Pi model/modelRegistry auth，只拥有 `advise` 与 Pi 公开 `read`、`grep`、`find`、`ls` 工具。
- 原因：Pi 0.80.10 的公开 Package root 已验证可提供独立 `Agent`、`turn_end`、只读工具、custom entry/message、命令和 TUI renderer；不需要 private deep import、OMP backend 或 Main 内第二 Runtime。独立 Package 既能脱离 GUI 手动使用，也给后续多 roster 留出真实发布边界。默认关闭和单一 strict state 避免第三方模型调用被安装动作隐式激活。
- 影响：S18-1 当前只完成单 Advisor 引擎与协议基线；WATCHDOG schema 已冻结但 YAML 发现/合并、多 Advisor、严重度策略、usage/dump/subagents 和 GUI projector 仍按后续阶段实施。当前 Main 忽略 custom role，真实 GUI 卡片与 typed control 必须等 S18-2；S18-1 只有通过真实 Provider turn 后才能标记 Complete。

## D-038 — Subagent 适配同时覆盖运行显示

- 日期：2026-07-26
- 状态：Accepted；扩展 D-031 与 D-033，替代其中“运行任务不进入首版”的显示限制，不改变拓展页和 Subagent 管理页职责
- 决策：`pi-subagents` 的 GUI 适配必须同时覆盖管理面与 Conversation 显示面。Agent 定义和运行参数继续由 Subagent 设置页管理；实际拉起后，前台 `subagent` 工具从结构化 details 归一化参与 Agent、任务、状态、当前工具/路径、轮次、工具数、token、耗时、错误和最终输出，并在当前 turn 的工作过程中显示。默认显示密度采用“每个参与者一个任务胶囊 + 同行整体状态”，点击摘要后才展开完整运行详情，运行中不自动展开。后台完成、控制、转向和 supervisor 请求只接受固定 custom type，作为独立 Timeline 通知；其中 supervisor/control 的结构化协调生命周期由 D-046 进一步收敛。Renderer 不解析 raw details 或通知 Markdown 来推断状态。
- 原因：只提供定义 CRUD 和 Package 开关无法回答“已经拉起谁、正在做什么、是否完成、产出了什么”；同时直接展示原始 details、child transcript 或临时 artifact 会泄漏实现细节、放大状态体积并建立第二份运行事实。
- 影响：shared contract 增加归一化 Subagent 运行摘要与通知 entry，工具增量 patch 原子携带该摘要；历史恢复与实时事件共用 Main projector。当前 S19 source slice 已由 participant 胶囊打开 Workbench 真实第三列任务阅读面，窄窗口切换为同工作区完整详情面，并以稳定 locator 恢复焦点；原行内完整 disclosure 已移除。首期不增加独立任务数据库、全局任务中心、子 Session transcript 浏览、artifact 文件读取、运行控制按钮或靠文本猜测的后台任务关联。

## D-039 — Advisor 首阶段使用 Sol 中等推理

- 日期：2026-07-26
- 状态：Accepted；替代 D-037 中“首版 Advisor 复用当前 Pi model”的模型选择规则
- 决策：S18-1 的单 Advisor 在主会话当前 Provider 内固定选择 `gpt-5.6-sol`，thinking 固定为 `medium`，并继续复用 Pi ModelRegistry 的认证事实。目标 Provider 不提供该模型、模型不支持 reasoning 或认证不可用时，Advisor 明确暂停且不静默回退。S18-3 GUI 再提供逐 Advisor 模型配置，至少允许显式选择 `gpt-5.6-terra`、跟随主模型或 Pi 目录中的其他模型；长期候选是 `terra + medium` 常驻审查、`sol + high` 高风险升级审查，自动升级不在 S18-1 实现。
- 原因：Advisor 需要发现主 Agent 已接受方案中的隐含错误，核心审查对推理能力的要求不低；首阶段优先建立高质量基线，再用真实质量、延迟与成本证据决定常驻模型。显式失败比无提示降级更能保持审查结果可信。
- 影响：S18-1 不再随主会话模型 ID 切换，只借用当前 Provider 来确定 Sol 的模型条目和认证；当前 Provider 没有 Sol 时该轮不审查。GUI 模型选择、Terra 常驻和 Sol 升级仍按后续阶段进入真实 WATCHDOG 配置，不在 Renderer 建立提前生效的假设置。

## D-040 — S18-2 分离 Advisor Extension resource 与 Session system 控制

- 日期：2026-07-26
- 状态：Accepted；落实 D-034 的 GUI 投影与控制阶段
- 决策：拓展页只识别真实存在的 `pi-gui-multi-advisor` bare、npm 或 local PackageSource，并通过 Pi resource filter 控制 Extension 是否在新建或显式重载 Session 中加载；没有可执行的 GUI 安装来源时只提示手动安装。Advisor 页只显示 strict capability 握手得到的兼容性、版本与当前 Session system 状态，并通过唯一的 `/advisor on|off` Extension command 实时切换后重新读取 capability 确认。历史和实时 advisory 共用 Main strict projector，Renderer 只接收 `KernelAdvisorEntry` 并在对应 turn 内显示。
- 原因：Package 存在、Extension resource 开启、protocol 兼容与 Advisor system 开启是四个不同事实。把它们合并为一个界面开关会伪造热加载和健康状态；透传任意 custom payload 或命令则会突破现有窄 IPC 边界。
- 影响：Pi RPC 只为固定 GUI adapter allowlist 中的 custom type 保留数据，S18-2 在该 allowlist 增加 Advisor capability；其他非消息 entry 继续清洗。未知/非法 capability 显示 unavailable 或 incompatible，未知/非法 advisory 被丢弃。S18-2 不实现 roster、usage、dump、配置编辑、自动安装或通用 Extension adapter，这些能力按 S18-3 以后逐项接入。

## D-041 — S18-3 采用固定 Advisor 工具允许表与配置级显式授权

- 日期：2026-07-26
- 状态：Accepted；落实 D-034 中“扩大工具范围必须单独决策”的安全门
- 决策：protocol v2 的 Advisor roster 只接受 `read`、`grep`、`find`、`ls`、`edit`、`write` 六个公开 Pi 工具；省略或空 `tools` 继续得到四个只读工具。`edit` / `write` 必须在单个 Advisor 的 WATCHDOG 定义中显式列出，GUI 勾选时持续显示“独立 Advisor 直接执行且不经过主 Agent 审批”的告警。原生 `bash`、browser 和任意 Extension tool 不进入允许表，因为 Pi 0.80.10 的公开 `createBashTool` 没有命令级 allowlist、sandbox 或主 Agent 审批回调。Project 未受信任时，Extension 只读取用户级 WATCHDOG，不发现或执行任何项目级 Advisor 定义。
- 原因：独立 Advisor `Agent` 不复用 primary tool approval wrapper；直接开放 OMP 的任意 built-in 会把配置文件变成隐式任意执行入口。固定允许表、默认只读、配置级逐项授权和 Project trust gate 能满足“适当开放写工具”，同时保留可审计边界。验证执行若后续确有需求，应实现固定 argv、cwd、timeout 和环境的专用 wrapper，不能把任意 Shell 字符串伪装成受控验证。
- 影响：Extension Package 升至 0.2.0 / protocol v2，capability 明确报告 `readOnlyTools` 与 `optionalTools`；Main 和 Renderer 不提供 `bash` 选项，也不接受未知工具名。保存 WATCHDOG 不会自动 reload 当前 Session；新建或显式 reload 后，配置授权才进入独立 Advisor Runtime。该决定不提供逐次工具确认，用户对 `edit` / `write` 的持久化勾选就是该 Advisor 的明确授权。

## D-042 — Subagent 结果只在任务详情阅读

- 日期：2026-07-27
- 状态：Accepted；收紧 D-038 中后台 completion 通知的 Renderer 展示规则
- 决策：Timeline 继续直接展示可点击的 Subagent 任务胶囊、参与者状态，以及控制、转向、supervisor 协作与 Watchdog 通知；普通 `completion` custom message 只形成轻量、可点击的完成任务胶囊，不在对话正文渲染结果预览。任务处理内容与最终输出以同一 Workbench 任务详情为阅读面。具体 supervisor/control 是否构成用户警报由 D-046 的结构化原因和生命周期决定，不再一概视为用户介入。
- 原因：Subagent 结果正文会与任务详情及主 Agent 的最终回答形成重复阅读流，放大对话长度并削弱主回答层级；同时后台 completion 未必能稳定关联回原 `toolCallId`，因此不能简单隐藏唯一结果入口。
- 影响：Main 严格归一化固定 completion custom type，并为通知建立独立、稳定的详情目标；Renderer 只显示胶囊与终态，点击后展示已归一化的完整通知内容。该变更不新增任务数据库、原 run 文本关联、child transcript/artifact 读取或运行控制；无法稳定关联原任务时仍以 notice identity 打开详情，不靠 Markdown 猜测 `toolCallId`。

## D-043 — Todo 使用当前轮次的 Composer 专用投影

- 日期：2026-07-27
- 状态：Accepted；扩展 D-009 的工具展示与 Composer clearance 边界
- 决策：固定识别 `todowrite` 工具，由 Electron Main 对每个完整列表严格投影 `id`、`content`、`status` 与 `priority`，并清除该专用工具 entry 的原始 args/details。Renderer 只使用最后一个用户轮次内最新的非失败列表；新用户轮次尚未调用 Todo、空列表或 Conversation identity 变化时旧列表退出。Todo 在 Composer 上方显示为比输入框更窄的轻量 disclosure 托盘，普通 Timeline 不重复展示同一工具卡。
- 原因：Todo 是当前执行计划，不应埋在通用工具日志，也不应由 Renderer 解析字符串化参数；同时把整个 Session 最后一次列表永久固定会让已完成旧任务污染后续无 Todo 的轮次。当前轮次选择既保留 settled 后的完成回顾，也在下一条用户消息出现时自然收口。
- 影响：Pi session 和 Conversation tool entry 继续是事实来源，不新增 Todo 数据库、Renderer 持久化或独立 IPC。面板展开状态只属于当前展示 identity；列表高度由既有 Composer `ResizeObserver` 计入 Timeline clearance，窄窗口改为可用宽度，键盘、ARIA 与 reduced-motion 继续遵循前端规范。

## D-044 — 工具结果图片走 metadata 投影与按需 IPC

- 日期：2026-07-27
- 状态：Accepted；扩展 D-018/D-019 的 ImageContent 边界与 D-004 的 Conversation 事实源
- 决策：Pi `tool_execution_update` / `tool_execution_end` 与历史 `toolResult` 的混合 `TextContent`/`ImageContent` 统一投影为同一 `KernelToolEntry`。文本进入 `output`；图片只进入 metadata-only `attachments`（`type`、`name`、`mimeType`、`byteLength`、稳定 `contentIndex`），base64 永不进入 KernelState、patch、日志或 Renderer 常驻 state。支持 PNG/JPEG/GIF/WebP，复用 4.5 MiB base64 上限，并在 Main 校验 canonical base64 与 MIME/signature 匹配；非法块静默忽略且不破坏同结果合法文本/图片。Renderer 通过窄 typed `getToolImage(sessionKey, toolCallId, contentIndex)` 按需读取：历史以 active branch transcript 为事实源；只有 terminal end 可写入实时兜底 cache，cache 必须绑定 `projectPath + sessionId + sessionKey + Runtime generation + toolCallId + contentIndex`，仅在同一 displayed Runtime 仍投影该附件且消息列表尚无 toolResult 时读取，并受 60 秒 TTL、8 条目及 24 MiB base64 总预算约束；权威消息命中、terminal 替换、identity 迁移、归档、停止时清理相应内容。terminal tool 忽略晚到 start/update；Renderer 异步结果必须核对 request token、Session、Tool 与 contentIndex。图片 metadata 变化不走 append-only 文本 patch，退回 `kernel.state-changed`。本决定不扩展 Session HTML export，不提供保存/下载入口，不为 Subagent 专用工具显示通用图片 UI，也不允许 Renderer 按路径读图。
- 原因：图片生成工具已成功返回 image content，但 projection 只保留 text 导致 Timeline 无法展示；复用 message image 身份会混淆 user message 与 toolResult 校验，把 base64 塞进 KernelState 又会破坏 patch/性能/安全边界。
- 影响：新增 `KernelToolImageAttachment` 与 `kernel.get-tool-image`；普通工具详情显示图片入口并复用现有灯箱交互；空文本但有图片时不显示“等待工具输出”。验证覆盖 projection 混合内容、非法图片、state/patch 无 base64、typed IPC 校验与历史/实时隔离。

## D-045 — Session 活动时间只由对话消息推进

- 日期：2026-07-27
- 状态：Accepted；收紧 D-028 中 JSONL `lastActivityAt` 的事实口径
- 决策：持久化 Session 的 `lastActivityAt` 取 Pi transcript 内最新 `type: "message"` entry 的时间。文件 mtime、最后一条任意 JSONL entry、Session 激活/恢复，以及启动时追加的 capability、`session_info`、模型或其他运行元数据都不得推进活动时间。新对话在尚未持久化时继续使用 provisional 活动时间；真实 prompt/run 完成后 Kernel 可即时推进内存活动时间，后续 transcript 扫描必须收敛到对应 message 时间。
- 原因：加载 Extension 时可以在没有新对话内容的情况下追加 capability custom entry 并改写 JSONL mtime；若把文件或任意尾 entry 当成活动事实，单击历史 Session 就会刷新时间并改变排序，把“最近打开”错误伪装成“最近对话活动”。
- 影响：Session 点击、恢复、能力握手和重命名不再改变时间或排序；用户/Assistant/toolResult/custom message 等真实 message entry 仍推进最近活动。活动时间读取是只读 metadata 投影，不建立第二份访问时间或持久化排序事实。Pi 顶层 Session entry timestamp 只接受 `Date#toISOString()` 产生的 canonical UTC 字符串；数字秒、数字毫秒、相对时钟及可被 `Date.parse` 模糊解释的非 canonical 字符串不得进入 `lastActivityAt`。嵌套 message payload 自身的数字 timestamp 属于另一协议字段，不参与该边界。

## D-046 — Subagent supervisor 协作使用结构化生命周期

- 日期：2026-07-27
- 状态：Accepted；收紧 D-038/D-042 的控制与 supervisor 通知展示语义；内部发现/轮询可见性已由 D-056 收紧
- 决策：固定 `subagent_control_notice` 与 `subagent_supervisor_request` 继续进入 Conversation，但 Main 必须只从白名单 details 投影 `runId`、Agent、participant index、request ID、reason、是否需要 supervisor 回复及 `pending/handled` 生命周期。具体 request 使用稳定 request identity；同一 `runId + participant index` 的 supervisor request 替代泛化 `needs_attention`，重复事件原地 upsert。成功的 `subagent_supervisor` / `intercom` reply tool result 将对应 request 原地标为 handled，失败不得伪装已处理。Renderer 将该状态解释为主 Agent 内部协作而非默认用户警报；只有结构化 `completion_guard` 与 Watchdog blocker 使用 alert。`subagent_wait`、supervisor reply、status/steer/resume 等管理工具使用简洁状态文案，原始参数与输出只在展开的技术详情中出现。
- 原因：同一个 supervisor 请求过去会同时产生泛化 attention、具体 request、reply 工具与 wait 工具，并把 Run ID、intercom target 和可执行命令直接堆入主阅读流；这既重复，也把“主 Agent 可自行处理”误报为“用户必须处理”。上游 custom message 已提供稳定结构化 identity，没有必要靠 Markdown 命令文本关联。
- 影响：历史恢复与实时消息继续共用同一 projector；旧版缺少结构化 details 的通知保留兼容降级，但不获得跨消息关联。GUI 不建立任务数据库、不直接绕过主 Agent 回复子代理，也不从通知正文猜 `runId`。若主 Agent 真正需要产品选择或授权，仍通过正常 Assistant 对话向用户提问。

## D-047 — P2.1 按收口门槛和单活动 Slice 推进三条体验线

- 日期：2026-07-27
- 状态：Accepted；扩展 P2 Workbench Foundation，不改变 P3 通用生态边界
- 决策：下一阶段定义为 P2.1 Experience Refinement，集中推进动效与交互、Settings 优化与有限定制、Subagent/Magic Context 可解释性。S19 必须先在 canonical clean commit/worktree 上通过正式 `pnpm verify:linux`；随后恢复并完成 S18-4，之后按 S20 Motion Contract、Timeline/Composer 稳定性和 Settings Workspace 的依赖顺序实施。任一时刻仍只允许一个 Slice 为 `In Progress`；如果改变 S18-4 优先级，必须显式把它改为 Paused，而不是保持 Ready 却长期跳过。
- 原因：当前 S19 dirty source snapshot 同时触及 Timeline、Workbench、Composer、Navigator 与 Settings，继续叠加体验改动会扩大冲突并破坏正式验收边界；三个新方向又共享 motion、设置生命周期和 typed status 基础，必须先固定依赖而不能作为互不相干的零散补丁并行写入同一工作树。
- 影响：开发计划增加 S20–S25。设计调查和只读审计可以并行，source 实现保持单一 writer 和单活动 Slice；S18-5 继续 Pending，其中共享 status/usage 基础可在 S24/S25 重新利用，但 Advisor 专属范围不自动并入 Magic Context。

## D-048 — Settings 使用四组导航并显式表达事实来源与生效时机

- 日期：2026-07-27
- 状态：Accepted；扩展 S14-02/S14-16 与 D-032/D-040 的设置入口边界
- 决策：Settings Workspace 按“应用：常规/外观/快捷键”“模型：模型/凭证”“Agent：Subagent/Advisor/Context”“生态：Package/拓展/技能”分组；自动对话命名并入常规，删除单项偏好分类。导航允许收起，并以窄 typed section/group metadata 提供只索引真实设置的应用内搜索和 deep link。重要设置必须能区分 application/user/project/session 作用域、GUI/Pi/Extension 事实来源，以及 immediate/next-session/reload 生效时机；持久化 saved config 与当前 Runtime loaded config 不得混为一体。
- 原因：当前设置能力已较完整，但 Package 安装、Extension resource、当前 Session 加载和配置健康仍主要靠分散说明文字区分；用户难以判断修改影响范围和是否已经作用于当前 Runtime。分组、搜索和统一 lifecycle 语义比继续堆叠新控件更能改善可理解性。
- 影响：Package 安装与 Extension 启停继续由拓展页拥有；Subagent、Advisor 与 Context 专页只管理各自功能和真实状态。设置保存不静默 reload，reload 失败不伪装已应用。`settings-redesign-preview.html` 只是交互参考，不是生产状态或未接通选项的事实源；本决定不建立通用插件设置 registry 或 OS URL protocol。

## D-049 — Personalization v1 只开放三个有限语义设置

- 日期：2026-07-27
- 状态：Accepted；扩展现有 AppearanceSettings 的有限 token 配置方向
- 决策：第一批新增用户级 `conversationWidth: compact | standard | wide`、`navigatorDensity: comfortable | compact` 与 `motionPreference: system | reduced | minimal`。阅读宽度通过语义化 Conversation max-width 控制，窄窗口服从可用空间；Navigator 密度只调整视觉行高、组间距与辅助信息，不改变每页 5 个 Session、分页外保留项或最小交互命中；动效偏好只能在 OS 能力之上进一步减少动效，不能覆盖 `prefers-reduced-motion` 强制恢复完整动画。
- 原因：这三项分别覆盖阅读、导航和状态变化的高频差异，同时可以落在统一 token 与有限枚举上，不需要把产品变成任意 CSS 编辑器。连续像素、颜色和布局参数会扩大验证组合并破坏响应式与无障碍边界。
- 影响：配置需要明确 schema migration、非法值回退和首帧尽早应用。首批不加入任意 CSS、像素宽度、颜色、圆角、间距、代码字号比例、默认 Sidebar 状态、代码换行或详情宽度；后续选项必须基于真实使用反馈另行决策。

## D-050 — Subagent 与 Magic Context 优化以 typed effective/status 投影为边界

- 日期：2026-07-27
- 状态：Accepted；扩展 D-033/D-035/D-038/D-042，不放宽现有文件与运行控制边界
- 决策：Subagent 下一阶段由 Main 投影 effective Agent definition、builtin/user/project 覆盖来源、最终 enabled/depth、Package/Extension 状态、当前 Runtime 是否发现 Agent，以及 reload 差异；Renderer 不解析 Markdown frontmatter、Pi settings 或名称。任务详情可以消费现有 run/participant 摘要增加同 run 切换、真实状态汇总和实时到历史的一致性，但不读取 child transcript/artifact。Magic Context 安装与 Extension 启停继续留在拓展页；独立 Context 页只读展示 Package、Extension、当前 Session loaded、真实 `/ctx-status`、状态时间与 stale 语义，并提供复制官方 setup/doctor 命令和文档入口。更深 usage/health UI 必须等待上游版本化 capability/status/usage 协议。
- 原因：用户当前最缺少的是“为什么不可用、当前到底加载了什么”的解释，而不是另一套 Agent/Context Runtime。Renderer 直接读取 Agent 文件、Magic Context SQLite 或 debug telemetry 会建立第二份事实；凭文本拼接 stop/steer/setup/doctor 又会突破 typed IPC 和父 Agent 协调所有权。
- 影响：Magic Context 的 Package installed、Extension enabled、Session loaded 与 health verified 保持四个不同事实；没有结构化 doctor 证据时健康为 unknown，Runtime reload 后旧状态立即失效。GUI 不执行任意 Shell、不编辑 `magic-context.jsonc`、不解析私有数据库、不从 Pi compaction 推断后台状态，也不在 `pi-subagents` 提供稳定 typed capability 前加入 stop/interrupt/resume/steer/supervisor reply 控制。后续公开协议不得包含 prompt、output、memory 内容、embedding、credential、数据库路径或私有 schema。

## D-051 — 任务完成通知点击使用 Main 私有 Broker 激活精确 Session

- 日期：2026-07-28
- 状态：Accepted；扩展 D-003/D-017 的 Main control plane 与多 Session 激活边界，不建立通用 GUI server
- 决策：`pi-gui-task-notify` 在交互任务达到 `agent_settled` 后向 Electron Main 的私有 Unix-domain socket 发送 strict v1 通知请求；Main 独占 `notify-send` 和默认点击动作，并以 `--print-id` 的服务端 ID 回执确认动作通知已经创建，而不把进程 spawn 当作成功。每个 GUI Pi RPC 子进程只通过环境获得该 socket 路径与随机 capability token；Main 对请求限长、拒绝额外字段并使用参数数组，不接受命令、URL 或 Shell 字符串。点击时 Main 重新读取 Project/Session registry，要求 Project canonical 且已注册、Session 未归档、canonical 且为可读普通文件；首轮 provisional Session 只允许对同一精确 identity 做最多约一秒的 bounded registry/ENOENT 重试。验证完成后 Main 恢复和聚焦窗口，再按 Project→Session 顺序调用既有 Kernel 激活方法，成功后再次聚焦。
- 原因：单独调用 `notify-send` 只能得到桌面动作 ID，无法安全进入 Electron control plane 或选择对应 Session；模拟鼠标、远程调试和 OS 级通用 deep link 都会扩大不稳定或可滥用边界。窄的本地 capability broker 可以保留多 Runtime 身份，同时不把 Renderer、Pi stdout 或通用网络服务变成控制入口。
- 影响：Broker 目录固定为 `0700`、socket 为 `0600`，请求只允许一条 bounded JSON line；Broker 在 Kernel shutdown 前停止接收、销毁等待中的通知动作并 drain 已开始的激活。Package/TUI、动作能力或 Broker 不可用时扩展只回退普通桌面通知，不伪装可跳转。协议不携带回答正文、credential、工具输出或任意文件读取能力；Session 切换继续以 Pi session 和 ProjectStore registry 为事实源。

## D-052 — 内存治理分离持久 Session、执行 Runtime 与 Renderer 工作集

- 日期：2026-07-28
- 状态：Accepted；扩展 D-004/D-010/D-017，并将 S26 提升为当前最高优先级；其中用户显式休眠部分由 D-058 替代
- 决策：Pi Session 文件继续是持久 Conversation 事实源，但 managed `RuntimeContext`、Pi RPC 进程和 Renderer Conversation 不再与每个已访问 Session 同生命周期。内存治理固定采用三层边界：Main/Renderer IPC 必须有 revision、合并与字节/队列上限；Renderer 只持有活动 Conversation 的有界页面工作集；自动判定非前台 Runtime 为 quiescent 时，只有已持久化、非 provisional、非 busy 且 Kernel 与已加载 Extension 明确释放全部 operation lease 才能休眠。首期用户显式休眠属于用户授权的 Runtime 终止操作，仍重检 Kernel-owned busy gate，但不伪称已经获得 Extension quiescence；自动回收采用前台保护、保守 warm set、grace period、内存压力与 LRU，未知 Extension 状态 fail-closed。
- 原因：实际运行证明两个独立放大器同时存在：Renderer 在约 1 小时 52 分后达到约 5.4 GiB RSS，其中约 4.98 GiB 为 Chromium `PartitionAlloc`；Workbench Kernel 又为每个 managed Session 保留完整 `KernelState` 与 Pi Runtime，没有 idle eviction。重启只能暂时释放内存，不能阻止多个 Runtime 和 native allocation 再次增长。`runtime=ready`、`agent_settled` 和零在途 RPC 也不能证明 Magic Context、Subagent、Advisor、compaction、命名或其他 Extension 后台工作已完成。
- 影响：大量 mutating IPC 不再同时通过 event 与 invoke return 传输两份完整 `KernelState`；Navigation、active Session 与 Conversation 逐步拆分。Timeline 的“最近 60 turn”从仅限制 DOM 挂载演进为可分页、可驱逐的数据工作集。自动休眠不得停止 running、starting、stopping、provisional、存在 operation lease 或 quiescence 未知的 Runtime；并行 busy Runtime 不设硬数量上限。诊断默认关闭、输出有界且只记录角色、状态、计数、字节、duration、PSS/RSS/private/anonymous、DOM/V8/native 指标，不记录 prompt、output、Session identity、路径、credential 或私有 Extension 内容。

## D-053 — 对话 Markdown 允许用户点击打开本地绝对路径

- 日期：2026-07-28
- 状态：Accepted；替代 D-007 中“Markdown 链接只允许外部协议”的部分，不改变 Renderer 文件读取边界
- 决策：对话 Markdown 链接除 `http:`、`https:`、`mailto:` 外，允许 Linux 绝对路径与无远程 host 的 `file:` URL。Renderer 只把归一化目标通过现有受信 typed IPC 交给 Main；Main 对 web/mail 使用 `shell.openExternal`，对本地文件使用 `fileURLToPath` 与 `shell.openPath`，不让 BrowserWindow 导航，也不把文件内容读入 Renderer。相对路径、远程 file host、`javascript:`、`data:` 和其他 scheme 继续拒绝。
- 原因：Pi 的默认执行模型允许 Agent 直接使用本地工具；本地链接仍需用户明确点击，因此把 Assistant 生成的 Project 报告路径降级为不可点击文字，与产品的默认 YOLO 交互边界不一致。专门允许本地绝对目标即可恢复报告、日志和源码引用的直接打开，不需要建立 artifact registry、文件预览器或任意文件读取 IPC。
- 影响：`[REPORT.md](/absolute/path/REPORT.md)` 与等价 `file:` 链接会渲染为真实 anchor 并调用系统默认应用。此能力是打开动作而非内容投影；KernelState、Conversation、附件、导出和 Renderer 文件读取边界不变。Markdown 图片仍不自动加载本地或远程资源。

## D-054 — Advisor 当前控制面退役，历史审查记录保持可读

- 日期：2026-07-28
- 状态：Accepted；替代 D-034/D-040/D-048 中 Advisor 作为当前 Settings 功能和已适配拓展的部分，不改变 Pi Session 事实源
- 决策：用户级 Pi 环境卸载 `pi-gui-multi-advisor`，Settings 删除 Advisor 分类、Extension resource 控制和 roster 编辑器。当前产品不再提供 Advisor 安装、启停、配置或运行状态入口；仓库中的独立 Package 源码只作为历史 source snapshot 保留。既有 Session 中符合固定 schema 的 `pi-gui.multi-advisor/advisory` 继续由 Main strict projector 投影为只读 Timeline 卡片。
- 原因：Advisor 不再是当前工作流依赖，继续常驻设置入口会把已卸载能力伪装成可用产品面；直接删除历史 projector 又会让旧 Session 丢失已保存的审查上下文。移除控制面并保留只读历史兼容是最小且可逆的退役边界。
- 影响：新建或重载 Session 不再从用户 Package 设置加载 Advisor；GUI 不提示重新安装，也不编辑 WATCHDOG。历史卡片不具备重新运行、修改或启停能力。未来若重新引入 Advisor，必须重新建立真实 Package、版本化 capability、typed control 和独立验收，而不能仅恢复旧导航入口。

## D-055 — Subagent 详情按状态组织并投影实际模型、消耗与输出引用

- 日期：2026-07-28
- 状态：Accepted；扩展 D-038/D-042/D-050，不建立 child transcript 或 artifact 阅读器
- 决策：Subagent 任务详情不再用同一固定分区平铺全部状态。运行中以当前活动为主，完成态直接显示结果或输出文件，失败态优先显示错误，暂停态显示已有输出与最后活动；完成态不保留空“当前活动”或重复 completion envelope。Main 从前台结构化 `results[]` 投影 child 实际报告的 model，以及 canonical input/output/cache read/cache write token、USD cost、turn/tool count 和 duration；缺失值保持 unavailable，不从 Agent definition、调用参数、名称或 child Session 推断。显式 file-only `outputReference` 与固定 completion `Output saved to` 行只投影 Agent、绝对路径、展示大小和行数 metadata，Renderer 可在用户点击后复用受信本地路径打开边界，但不读取或缓存文件正文。后台 completion custom message 未携带实际 model/usage 时详情明确说明不可用，并移除 Session file 行和重复英文包装。
- 原因：旧详情把后台完成通知伪装成单个运行 participant，连续重复“后台任务结果/完成/任务状态/Background task completed”，同时把 Session 路径与输出引用混入“最终输出”；固定用量框又无法区分真实 0 与协议未提供。状态驱动层级和 typed usage 能让用户先阅读任务结果，并准确理解模型、成本与执行规模，而不扩大 Renderer 对 child 工作区的读取权限。
- 影响：`KernelSubagentParticipant` 增加 nullable model、nullable canonical usage 和 metadata-only output references；Kernel state copy/patch 继续保持嵌套值隔离。Timeline completion 胶囊仍保留通知协议中的原始 Agent 名称与独立 notice identity；详情可把已知 `parallel:` 标签压缩为可读的 Agent 计数，并在折叠技术信息中保留原始标识。未来若要让后台通知显示实际 model/usage，必须由 `pi-subagents` 在版本化 completion 协议中直接携带这些字段，不能由 GUI 扫描 child transcript 补齐。

## D-056 — 内部工具发现与轮询不占用 Timeline

- 日期：2026-07-28
- 状态：Accepted；收紧 D-046 的 Subagent 管理工具可见性，不改变任务胶囊与协调通知协议
- 决策：`subagent list/status`、`subagent_wait` 以及 `subagent_supervisor`/`intercom` 的 pending/status/list 只用于主 Agent 的发现、等待与轮询，不形成 Timeline 过程行，也不进入普通工具汇总。真实 Subagent 运行继续按 participant 显示任务胶囊；steer/resume/interrupt/stop、supervisor reply 与 Watchdog 等有用户意义的控制或异常状态继续使用专用协作展示。`todowrite` 的 Main/Renderer leaf-name 识别统一接受 `.`、`:`、`/` namespace 分隔，避免专用 Todo 托盘因工具命名形式退回普通工具卡。
- 原因：等待、状态查询和委派前强制 discovery 会在任务胶囊旁重复产生“等待结束”“已检查状态”或普通“调用工具”行，把实现细节误作用户过程；专用工具的 namespace 解析不一致也可能造成同类回退。
- 影响：过滤同时作用于 completed 与 live process 构建，隐藏条目不会封口相邻 thinking/普通工具分组；有意义的控制动作仍保留状态和技术详情。Renderer 不根据输出文本推断动作，Main 不删除 transcript 事实，只收敛可见投影。

## D-057 — 空 provisional Session 只存在于新对话工作区

- 日期：2026-07-28
- 状态：Accepted；收紧 P2 Session identity 与 Navigator 投影边界，不改变 Pi Session 事实源
- 决策：点击新建后，Kernel 仍可启动并保留一个进程内 provisional Session，供 Composer、模型选择和首条消息使用；但在首条 prompt 被 Runtime 接受前，该 identity 不进入 Project 的 Navigator Session 列表，也不计入 Project Session 数量。首条 prompt 成功提交后，同一 provisional identity 立即进入列表；发送失败则恢复为空白隐藏状态。用户在空白阶段切换 Project 或 Session 时停止并移除该不可持久化 Runtime context。
- 原因：空白编辑器需要即时可用和 Runtime 预热，但尚无用户消息的占位项不是对话历史。把它展示为“新对话”会污染 Navigator、数量和最近活动，同时切走后保留不可见 provisional Runtime 会造成无法重新访问的后台资源。
- 影响：活动工作区的 `state.sessions` 可继续包含空 provisional summary，以维持 typed identity 与草稿迁移；Project 导航使用 `projects[].sessions` 的可见投影。重复新建在当前空白 provisional 上保持幂等；首条 prompt 后再次新建才创建下一条并行 Runtime。空 provisional 不可 resume、archive、export，也不得成为 Runtime 自动回收候选或写入 XDG Session index。

## D-058 — 主动 Runtime 休眠不作为独立用户功能

- 日期：2026-07-28
- 状态：Accepted；替代 D-052 中首期用户显式休眠的产品面，不改变自动休眠目标
- 决策：删除 Session、Project 与全部空闲 Runtime 的用户主动休眠入口，以及对应 `KernelCommand`、Main dispatch、preload/`KernelApi`、Renderer action/通知和 Project/全局批量实现。Main/Kernel 只保留不经 IPC 暴露的单 Runtime 回收原语，复用持久 Session 校验、前台与 busy gate、launch/stop 串行化、stop 失败 ownership 和同 Session identity 恢复；候选选择、grace period、压力触发、warm set 与 LRU 统一归未来自动休眠策略所有。
- 原因：主动休眠把 Runtime 生命周期实现细节变成三个独立操作，却没有稳定、必要的用户工作流；Project/全局批量按钮还容易让“当前 `ready`”被误解为已证明 Extension quiescence。把停止与恢复能力收回 Kernel 内部，可以避免重复产品面和策略分叉，同时保留自动休眠真正需要的底层能力。
- 影响：Navigator 不再显示月亮按钮或“休眠全部”，也不返回休眠/跳过数量；普通选择仍不会停止后台 Runtime，归档、显式 reload/stop、异常恢复和应用退出继续使用既有生命周期路径。自动休眠、operation lease、内存压力回收与 LRU 仍为 S26 Pending；在这些事实完备前不得根据 `ready`、`settled` 或零在途 RPC 自动停止 Runtime。

## D-059 — Navigator 顶层区分项目与任务

- 日期：2026-07-28
- 状态：Accepted
- 决策：Navigator 顶层使用“项目 / 任务”两个可访问 Tab。项目继续保持 `Project → Session` 层级；任务是扁平的独立工作，一个任务严格对应一个持久 Session，并使用独立、应用私有的隐藏 Runtime 工作目录。Renderer 只消费显式 `workspaceKind: project | task` 与稳定 `taskKey`，不得把隐藏路径渲染为 Project 或通过路径前缀猜作用域。Tab 切换恢复各类别最后目标，已运行 Runtime 保持后台 ownership；任务中的 `Ctrl+N` 创建新任务，项目中的 `Ctrl+N` 仍在当前 Project 新建对话。
- 原因：系统操作、跨项目工作和普通查询若强行归入某个真实 Project，会加载并可能污染无关的项目级 Agent、Skill、Extension、设置与长期上下文；若把隐藏目录伪装成特殊 Project，又会错误继承路径、排序、置顶、trust 与 `@` 文件索引等产品语义。
- 影响：Task registry 独立持久化于 XDG state，Project config 仍只记录用户添加的真实 Project。任务首条 prompt 前继续使用不可见 provisional identity，重复新建保持幂等；首条 prompt 被 Runtime 接受后才进入任务列表。Task Runtime 使用显式应用信任，不触发 Project resource trust；Project `@` 搜索、Project scope 设置/Agent/Skill 和同目录 Fork 在任务中不可用。用户级 Package、Agent、Skill、附件、绝对路径、模型、Subagent、归档与导出继续可用。为避免顶层“任务”与 Agent 内部运行混淆，Subagent 可见文案统一称“子任务”。

## D-060 — 缺少全部后台统计时省略空运行摘要

- 日期：2026-07-29
- 状态：Accepted；替代 D-055 中“后台 completion 缺少 model/usage 时始终显示 unavailable 分区”的 Renderer 展示规则，不改变 Main 投影和禁止推断边界
- 决策：后台 completion 通知同时没有实际 model、canonical usage、token、turn/tool count 和 duration 时，Subagent 详情不渲染只有缺失说明的“运行摘要”分区。只要任一实际摘要字段存在，分区仍显示，并将其余缺失项标为“尚未报告”。前台 `subagent` 工具详情继续始终保留运行摘要。
- 原因：完全无统计的后台通知已经通过结果与状态表达其可用内容，额外空分区只重复协议限制并占据阅读层级；但部分字段存在时隐藏整个分区又会丢失真实信息。
- 影响：Renderer 不再显示“该后台完成通知未携带模型与消耗信息”文案。Main 仍保留 nullable typed 字段；GUI 不从 Agent definition、调用参数、名称、配置或 child Session 猜测 model/usage，也不把缺失值伪装为 0。未来版本化 completion 协议提供真实字段后，现有分区会自动恢复显示。

## D-061 — P3 适配优先复用 Pi 原生能力并保持薄桥接

- 日期：2026-07-30
- 状态：Accepted；纠正历史 Prompt 分支与生态接入中的过度设计，不改变 Pi Session 事实源或 P3 阶段状态
- 决策：历史 Prompt 编辑直接复用 Pi Tree：GUI 只解析当前可见活动路径上的 user turn，调用受控 `navigate_tree`，再复用现有 `prompt` 并刷新真实 Tree；失败时保留草稿，导航已经成功则只重试 prompt。不得为该交互恢复 atomic navigate+prompt、projection watermark、第二份 Conversation projection stream 或另一套 Session 数据库。Package、Extension、Skill、MCP 和 Git 也优先复用固定 Pi 版本、成熟依赖或已安装 Package 的真实能力；GUI 只增加实际界面所需的 typed bridge 和状态投影。
- 原因：Pi TUI 已经证明 Tree 分支语义可用。此前为假设性的并发边界设计新的原子协议、watermark 和 artifact admission，扩大了实现、验证与打包面，却没有真实产品失败证明这些机制必要，违反 KISS、YAGNI 和 Fail Fast。
- 影响：没有可复现失败证据时，不增加第二套协议、capability 自证明或平行事实源。当前 Git Main/IPC、Capability Inventory 和通用 Right Sidebar 只是 P3 前置基础，不表示 Git 工作台、Capability Center、MCP 管理或 P3 已完成；各产品面只有在真实调用链和对应 UI 落地后才能单独验收。

## D-062 — S26 以真实 AppImage预算和自动恢复闭环完成

- 日期：2026-07-30
- 状态：Accepted；完成 D-052/D-058 的自动休眠目标，并将 P2 推进到 Complete
- 决策：S26 的 P2完成门槛固定为唯一 Linux verifier中的真实 AppImage链路：3 个已物化 Runtime经生产五分钟 grace和自动 sweep降到2个，用户通过现有“恢复对话”恢复被回收 Session后回到3个且对话保留；同一 Gate必须通过总 PSS、Renderer PSS/V8、KernelState大小、swap、busy后回落、恢复后总量和 Main state batch上限。自动候选继续对 busy、前台、provisional、pending ask/queue、compaction、active lease和未知 quiescence fail-closed。
- 原因：此前的采样只证明诊断存在，没有证明自动回收和恢复在正式包中闭环；另一方面，把20 Session浏览、三个父Runtime同时busy、内存压力触发和30分钟slope全部设为P2前置，会把真实问题扩大为长期压力平台，违反KISS/YAGNI。真实五分钟生命周期与固定红线足以证明当前P2预算边界。
- 影响：P2/S26可在对应正式证据通过后标记Complete。20 Session、三个busy父Runtime、pressure reclaim、Timeline分页和30分钟slope只作为真实回归触发的专项，不冒充已验证，也不阻塞P3。诊断继续默认关闭、脱敏、无正文/身份，并禁止GC/purge作为通过手段。
