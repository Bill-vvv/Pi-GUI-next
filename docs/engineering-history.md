# 工程历史与已修复问题

本文按时间倒序记录已经落地的能力、已修复问题和可复用工程经验，兼具 release note 与工程沉淀用途。

- 当前进度、下一 Slice 和计划变更以 [`development-plan.md`](development-plan.md) 为准。
- 长期架构约束和决策分别以 [`architecture.md`](architecture.md) 与 [`decisions.md`](decisions.md) 为准。
- 这里只记录有实现和验证证据的结果；候选方案、失败候选和未完成计划不写成已交付能力。

## 2026-07-23 — S14 多对话并行 Runtime 恢复

**状态：** 已验证源码链路。**交付：** 多个顶层 Session 各自拥有独立 Pi Runtime；一个对话运行时可以新建或切换到另一个对话，后台任务继续运行。

| 已修复问题 | 根因 | 修复与工程价值 |
| --- | --- | --- |
| 一个对话运行期间无法开始下一个对话 | 新项目从零重建时明确采用单全局 `RuntimeHost`，Renderer 和 Kernel 同时拒绝运行中切换；旧版多 `runtimeId` 能力没有迁移 | Workbench Kernel 改为按 Project/Session 管理 `RuntimeContext`，每个 context 独立拥有 RuntimeHost、订阅、状态、Conversation、provisional commit 和命名生命周期 |
| 仅放开按钮会让后台事件污染当前对话 | 原事件、命令和增量 patch 都隐式指向唯一活动 Runtime | 命令路由当前 context；后台事件写回所属 context，切回时恢复其最新投影；Session summary 独立展示运行状态 |
| 并行后归档、崩溃或退出可能误停其他任务或泄漏进程 | 原 stop/cleanup 只处理单一 runtime | 归档只停止目标 context；失败启动恢复前一投影并保留可重试清理所有权；应用退出遍历收口全部 context |

**验证：** 68 项 Kernel 定向测试与 166 项 core tests全部通过；`pnpm typecheck`、生产 build 和 `git diff --check` 通过。未启动真实 Electron 或执行 AppImage 验证。

**可复用规则：** 并行会话必须隔离完整生命周期与状态投影，不能只解除 UI 锁；单 control plane 与多 Runtime 并不冲突，关键是所有命令、事件和清理都带明确 context ownership。

## 2026-07-22 — S14 Pi 驱动的新建技能入口

**状态：** 已验证源码链路。**交付：** 技能页增加“新建技能”入口，可填写技能名称、用途并选择用户级或当前项目范围，随后由当前 Pi 会话完成内容设计与受控写入。

| 已修复问题 | 根因 | 修复与工程价值 |
| --- | --- | --- |
| 技能页只能列出已发现的 Skill 命令，无法开始创建新技能 | Pi 0.80.10 没有新建技能 RPC、独立命令或内置 creator；官方入口是直接要求 agent 为用例创建技能 | Renderer 增加最小表单并复用现有 Session 激活与 prompt 链路，不为一次自然语言能力增加伪 RPC 或旁路文件 API |
| 自由描述创建任务会让目标目录和覆盖行为不确定 | Pi 支持多个全局/项目发现目录，agent 自行决定路径时结果不可依赖 | 用户级固定到 `~/.pi/agent/skills/<name>/SKILL.md`，项目级固定到 `<project>/.pi/skills/<name>/SKILL.md`；名称按 Pi 的 1–64 位小写字母、数字和连字符规则在提交前校验 |
| Skill 可包含执行脚本，直接写入会绕过内容审查 | Pi 与用户权限运行，Skill 内容可指导模型执行任意操作 | 创建 prompt 强制先检查目标冲突、展示全部拟创建文件和完整内容，并在用户明确确认前禁止调用写入工具；界面同步提示审查可执行代码 |

**验证：** 156 项 core tests、`pnpm typecheck`、生产 build 与 `git diff --check` 通过；未实际创建技能或写入用户/项目技能目录。

**可复用规则：** 外部 Agent 只提供自然语言创建能力时，GUI 应提供确定目标与审查门槛，而不是伪造专用协议；生成可执行资源必须保留“预览—用户确认—写入”边界。

## 2026-07-22 — S14 pi.dev 拓展目录接入

**状态：** 已验证源码链路。**交付：** 拓展页在保留本地文件/目录入口的同时，增加 pi.dev Extension 目录、搜索、详情、安装状态及用户级安装/卸载。

| 已修复问题 | 根因 | 修复与工程价值 |
| --- | --- | --- |
| 拓展页只能选择本机路径，无法直接发现 pi.dev 上的拓展 | 首期只维护 Pi 用户设置的 `extensions` 路径，没有接入 pi.dev 的 npm Package 分发链路 | Main 通过固定 pi.dev Extension 目录读取服务端 package card 元数据，Renderer 展示名称、说明、下载量、详情和安装状态；目录结构变化、非 HTML、超时或超限响应直接报错，不静默切换数据源 |
| 用户无法从 GUI 安装或卸载目录中的拓展 | 本地路径增删与 Pi Package 管理是两套不同语义，不能继续写 `extensions` 数组模拟 npm 安装 | 新增窄 typed IPC；只接受严格合法的 npm 包名，并以参数数组调用 Pi 0.80.10 的用户级 `install/remove npm:<name> --no-approve`；设置页安装前明确提示第三方拓展拥有完整系统权限 |
| scoped 包、版本化已安装项和本机代理网络容易造成目录或安装状态误判 | pi.dev 的 scoped 详情路径包含额外 `/`，Pi 设置又允许字符串或 `{source}` 以及版本/tag | 解析优先使用 `data-package-name` / `data-package-downloads`，支持 scoped 详情路径；安装状态按 npm identity 去除版本/tag；Electron Main 使用 Chromium `net.fetch` 继承桌面网络栈 |
| 真实 Electron 请求报 `Attempted to redirect, but redirect policy was 'error'` | pi.dev 会把冗余默认 `sort=downloads` 和非规范查询参数顺序以 302 归一化，而目录请求按安全边界禁止重定向 | 请求直接生成 pi.dev 当前规范 URL：搜索条件先于 `type=extension`，并省略默认排序参数；继续保留 `redirect: error`，不为站点规范化放宽到任意跳转 |
| 目录读取错误或状态句位于卡片末尾时贴近底边 | 状态样式只有顶部 padding，后面没有列表时缺少容器收尾空间 | 仅为目录卡片中的末尾 notice/status/error/empty 增加 16px 底部 padding；有结果列表时仍保持原有列表间距 |
| pi.dev 目录需要保留滚动，但首屏不应超过约 3 个条目；官方 SVG 单独使用时又只显示 Pi 图形 | 首轮把“最多展示三个”误解为截断数据并删除滚动；pi.dev 官网导航和 Press Kit 的 SVG 本身都是 Pi mark，不包含 `.dev` 字样 | Main 恢复最多 50 项解析；Renderer 使用 288px 高、最多约 3 行的滚动视窗。品牌头保留官方 Pi SVG 本地副本，并追加 `.dev` 形成完整组合，继续适配应用明暗主题 |

**验证：** 真实 pi.dev `name=pi-web&type=extension` HTML 成功解析 50 项并识别 scoped 包；156 项 core tests、`pnpm typecheck`、生产 build 与 `git diff --check` 通过。未实际选择第三方包执行安装，以免在验证阶段运行未审查代码；命令参数、用户级 agent 目录和非法包名拒绝由定向测试覆盖。

**后续修复验证：** 真实响应头确认旧 URL 返回 302、规范目录与搜索 URL 返回 200；3 项目录服务定向测试、`pnpm typecheck`、生产 build 与 `git diff --check` 通过。

**密度与品牌纠正验证：** 3 项目录服务定向测试、生产 build 与 `git diff --check` 通过；Logo mark 来源为 `https://pi.dev/logo.svg`，构建不依赖运行时远程图片。全量 `pnpm typecheck` 当前被并行 provider 管理改动中 preview fixture 缺少 `listProviders`、`saveProvider`、`removeProvider`、`testProvider` 阻断，本项未越界修改。

**可复用规则：** 本地 Extension 路径与可分发 Pi Package 必须保留不同身份和卸载语义；第三方目录没有公开 JSON API 时，只能绑定明确、可验证的服务端元数据并在变化时 Fail Fast，不能把网页抓取失败悄悄降级为另一来源。

## 2026-07-22 — S14 三态主题与工具密度图示

**状态：** 已验证。**交付：** 主题设置支持跟随系统、深色和浅色三项下拉选择；跟随系统实时响应系统明暗变化，浅色使用完整界面 token，选择经 Kernel 与 XDG config 持久化。工具过程三档经实现复核后增加对应的极简图示。

| 已修复问题 | 根因 | 修复与工程价值 |
| --- | --- | --- |
| 外观页主题只显示“深色”状态，无法选择系统或浅色 | Appearance contract 只有字体字段，Renderer 也只有一套深色 token | contract 增加严格的 `system / dark / light`；共享 Select 提供三项选择；system 监听 `prefers-color-scheme`，light 覆盖背景、表面、文字、边框、状态色和阴影 token |
| 主题选择若只存在 Renderer 会在重启后丢失 | 现有字体设置由 Kernel / ProjectStore 持久化，主题尚未进入同一事实源 | 将 theme 纳入 IPC guard、Kernel copy/equality/assert 与 ProjectStore；当前 config v6 保存完整 Appearance，旧 v4 缺少主题时明确迁移为 system，未知值 Fail Fast |
| 滑杆虽标注紧凑、标准、详细，但用户无法直接判断三档是否真实存在及差异 | 设置页只显示档位名称，没有映射 Timeline 的实际分支 | 复核确认 compact 聚合全部工具为一条数量摘要，standard 逐条显示操作、目标和耗时，detailed 额外显示工具名、输入与输出；设置页使用与三者结构一致的 CSS 小图示，不改动原渲染语义 |

**验证：** 153 项 core tests、`pnpm typecheck`、生产 build 与定向 `git diff --check` 通过；未启动应用或进行截图验收。

**可复用规则：** 外观偏好必须同时具备可选控件、即时 Renderer 行为、系统变化监听和持久化事实源；设置说明应直接对应真实渲染分支，不能用仅有名称的选项暗示不存在的差异。

## 2026-07-22 — S14 外观设置页分组收敛

**状态：** 已验证。**交付：** 外观页将已有主题状态、工具过程密度、界面字体和代码字体整理为主题、Agent 对话、字体三组，并使用组内连续设置行和右侧紧凑控件。

| 已修复问题 | 根因 | 修复与工程价值 |
| --- | --- | --- |
| 四项设置各占一张独立卡片，同类字体设置缺少视觉归属，滑杆与字体下拉占满整行 | 首期设置页沿用通用卡片容器，没有为外观页建立分类与行级控件布局 | 增加轻量分类标题和组容器；组内用分隔线连接设置行，说明留在左侧、真实控件固定在右侧；窄窗口统一切换为上下布局 |
| 参考页包含换行、色调、透明度和字号等当前产品尚未接通的能力 | 直接照搬视觉参考会制造不能持久化或没有实际效果的假设置 | 只迁移信息层级和密度，保留现有主题状态、工具密度与字体设置语义，不扩展 contract 或持久化 schema |

**验证：** `pnpm typecheck`、生产 build 与定向 `git diff --check` 通过；按优化阶段规则未启动应用或进行截图验收。

**可复用规则：** 设置页视觉参考应先提取分组、间距与控件层级，再映射当前真实能力；没有业务与持久化闭环的参考控件不应仅为视觉完整而出现。

## 2026-07-22 — S14 对话过程与 thinking 层级收敛

**状态：** 已验证。**交付：** settled 工作过程改为“已处理 + 可观测耗时”的极简折叠标题；展开后每段 thinking 可独立收起，并以低强调正文呈现，工具过程与最终回答保持既有时序和层级。

| 已修复问题 | 根因 | 修复与工程价值 |
| --- | --- | --- |
| 完成后的工作过程使用带边框、底色、绿色状态点和长统计串的大卡片，视觉上压过最终回答 | 原折叠摘要同时承担完成状态、次数统计和文件汇总，收起动作被表现成独立状态面板 | 外层 disclosure 只保留“已处理”、可用时的真实耗时、紧邻文字的箭头和下方细分隔线；展开内容直接进入文档流，不再套卡片或重复文件汇总 |
| thinking 始终作为静态过程项展开，正文与工具步骤缺少独立层级 | thinking 没有自己的 disclosure，旧时间线圆点和详情容器延续了高强调活动流样式 | 每段 thinking 使用独立“正在思考 / 思考了”折叠；实时段默认展开，settled 后重新展开外层时默认收起，正文使用低强调 Markdown，标准/详细工具密度下不显示 thinking 时间线圆点 |
| Pi 事件和历史消息没有可靠的整轮及 thinking 起止时间 | 现有 contract 只有消息时间戳和单工具耗时，不能把工具耗时或历史时间戳冒充处理时长 | Renderer 只对当前实际观察到的 active→settled、thinking streaming→completed 区间计时；Session remount 后自然清空，历史或未完整观察的过程只显示“已处理 / 思考”，不伪造数字 |

**验证：** `pnpm typecheck`、生产 build 与定向 `git diff --check` 通过；未启动应用或进行截图验收。

**可复用规则：** 折叠只降低过程信息密度，不应把完成状态包装成压过答案的卡片；外部协议没有可靠 duration 时，UI 可以展示本地实际观测值，但必须将未观测历史明确保留为空值。

## 2026-07-22 — S14 导航拖拽命中修复

**状态：** 已验证。**交付：** Project / Session 排序只在主行按下期间启用原生拖拽，行内操作保持独立点击边界。

| 已修复问题 | 根因 | 修复与工程价值 |
| --- | --- | --- |
| Session 悬浮后虽显示归档入口，但整行拖拽或底层文字命中会遮挡按钮点击 | Project / Session 行常驻 `draggable`，且与归档按钮共用 Grid 单元的时间文字在透明后仍可接收指针和文本选择 | 主行内容收到主键 pointer down 后才武装对应行，pointer up、pointer cancel 或 drag end 立即解除；归档按钮显式置于上层，时间与运行指示永久退出指针命中和文本选择，归档、新建与排序手势互不竞争 |

**验证：** `pnpm typecheck` 与定向 `git diff --check` 通过。

**可复用规则：** 同一导航行同时承载排序与行内操作时，不应让整个容器常驻原生 draggable；拖拽资格应绑定明确的按下手势，并在所有结束路径统一清理。长期前端约束见 [`p2-workbench-structure.md`](p2-workbench-structure.md#311-导航行命中与拖拽要求)。

## 2026-07-22 — S14 运行中队列可见性与时序澄清

**状态：** 已验证。**交付：** Kernel 保留 Pi `queue_update` 的 steering / followUp 正文，Composer 在输入框上方只展示实际排队内容，不显示队列类型。

| 已修复问题 | 根因 | 修复与工程价值 |
| --- | --- | --- |
| 只有排队总数，无法确认具体消息是否进入队列 | Kernel 校验 `queue_update` 后只保存两组数组的长度，直接丢弃了正文 | `KernelSessionState` 分别保存 steering 与 follow-up 字符串数组；状态复制和 settled 清理同步覆盖正文，并用回归测试锁定投影与清空行为 |
| Steer 容易被理解为仅仅排在 Follow up 前面 | 首次说明没有明确其原生投递时机 | 按 Pi 0.80.10 定义，steer 在当前 assistant turn 完成工具调用后、下一次 LLM 调用前送达；follow_up 只在 agent 停止后送达；Renderer 保留时序但不展示类型标签 |
| 队列放在 Composer 上方可能遮挡 Timeline 或随消息数无限增高 | 浮层式实现会绕过现有 Composer clearance | 队列面板留在 Composer 正常布局中，由既有 ResizeObserver 自动更新 Timeline 底部空间；面板使用视口相关最大高度和内部滚动，窄屏切换单列 |

**验证：** 149 项 core tests、`pnpm typecheck` 与 `git diff --check` 通过。

**可复用规则：** 外部 Runtime 已提供有序队列事实时，GUI 应投影原始分类与内容，不能只显示派生计数；底部输入区新增持久内容必须参与同一 clearance 测量并设置高度上限。

## 2026-07-22 — S14 运行中输入语义收敛

**状态：** 已验证。**交付：** Pi 运行时普通输入默认作为 `follow_up`，Alt+Enter 作为 `steer` 特别提交；Composer 右侧不再并列展示两种队列动作，只保留中止入口。

| 已修复问题 | 根因 | 修复与工程价值 |
| --- | --- | --- |
| Follow up 与 Steer 同时作为右侧按钮，且普通 Enter 默认 Steer，弱化了“继续输入”的主次关系 | 首次接入原生队列协议时按能力并列暴露，没有区分日常输入与特别干预 | 普通 Enter 与表单提交统一走 `follow_up`；Alt+Enter 明确走 `steer`；占位提示同步更新，并删除只服务于两个文字按钮的样式 |

**验证：** `pnpm typecheck` 与 `git diff --check` 通过。

**可复用规则：** 同一输入区存在常规消息和干预型消息时，默认提交承载常规语义，干预语义使用明确的特别操作，不把两者长期并列成同级主按钮。

## 2026-07-22 — S14 下拉组件视觉收敛

**状态：** 已验证。**交付：** 偏好设置中的系统原生下拉替换为 Renderer 共享 `Select` 组件，展开后的菜单与 Workbench 现有 popover、文字、边框、hover 和 focus 风格一致。

| 已修复问题 | 根因 | 修复与工程价值 |
| --- | --- | --- |
| 收起状态只有基础边框样式，展开菜单仍呈现系统原生外观 | 原生 `<select>` 的弹出菜单由平台绘制，现有 CSS 不能让选项面板遵循项目 token | 共享组件用 button/listbox 语义实现触发器和面板，支持选项分组、不可用模型、选中态、外点收起及键盘导航；设置页只负责提供业务选项与保存回调 |

**验证：** `pnpm typecheck`、生产 build 与定向 diff check 通过。

**可复用规则：** 视觉和交互语义相同的普通单选下拉统一接入共享 `Select`；二维模型面板和 slash command surface 保持各自领域组件，不为了形式统一而合并不同交互。

## 2026-07-22 — S14 Session 归档

**状态：** 已验证。**交付：** Session 行在鼠标悬浮或键盘聚焦时显示右侧归档入口；归档贯通 typed Renderer / preload / Main / Kernel / ProjectStore，并将 XDG session state 升级到 v4。

| 已修复问题 | 根因 | 修复与工程价值 |
| --- | --- | --- |
| Session 导航没有归档入口，旧对话只能持续堆积在普通列表 | 现有 UI 只有可复用的 archive icon，Kernel contract 与持久化 schema 没有归档语义 | 行内按钮复用现有 action slot，默认保留活动时间或运行指示，悬浮/聚焦时原位切换为归档；按钮阻断 draggable 行的事件传播 |
| 仅在 Renderer 隐藏会导致重启后重新出现，直接删除 pointer 又会失去归档语义 | XDG state v3 只有 Session pointer 与活动选择，无法区分可见和已归档 | state v4 增加独立 `archivedSessionKeys`，v1/v2/v3 自动迁移；普通 registry 过滤归档项，pointer 与 Pi JSONL 原样保留 |
| 归档当前活动 Session 可能留下不可见但仍持有 Runtime 的错位状态 | Session 导航选择与单活动 Runtime ownership 需要由 Kernel 原子协调 | 运行中/启动中/停止中 Fail Fast；活动 ready Session 先受控停止，再持久化归档并清空活动投影；非活动 Session 归档不触碰 Runtime 或当前 Conversation |

**验证：** 142 项 core tests、`pnpm typecheck`、生产 build 与 `git diff --check` 通过；测试覆盖 v3→v4 迁移、归档不删除 JSONL、可见排序保留归档 pointer、非活动归档不影响 Runtime、活动归档受控停止和 running 状态拒绝。

**可复用规则：** “归档”应是可持久化的索引状态，不应偷换成删除事实源；当导航对象同时拥有活动 Runtime 时，先收口 owner，再隐藏 identity。

## 2026-07-22 — S14 运行中 Steer / Follow up

**状态：** 已验证。**交付：** Runtime 执行当前任务时 Composer 保持可编辑，贯通 Pi 0.80.10 原生 `steer`、`follow_up` 和 `queue_update`；Enter 转向、Alt+Enter 完成后跟进，两个动作均提供显式按钮，现有 abort 保持不变。

| 已修复问题 | 根因 | 修复与工程价值 |
| --- | --- | --- |
| 当前任务执行时无法继续输入，只能中止 | Composer 把 `ready` 当成唯一 editable 状态，Kernel 与自有 Pi RPC adapter 也只映射了首条 `prompt` / `abort`，遗漏固定 Pi 版本已有的消息队列协议 | Renderer 运行中开放编辑并区分 Steer / Follow up；typed preload、IPC、Kernel、RuntimeHost 和 Pi RPC 使用独立命令贯通，不把运行中消息误送到只接受 `ready` 的普通 prompt |
| 消息已经排队但 GUI 没有状态反馈 | `queue_update` 未进入 normalized Kernel state，`pendingMessageCount` 只在启动探针和 settled 清零时更新 | Kernel 严格读取 steering / follow-up 队列数组并投影总排队数；不复制队列正文或建立 Renderer 侧第二事实源 |

**验证：** 136 项 core tests、`pnpm typecheck`、生产 build 与 `git diff --check` 通过；新增定向测试锁定 `steer` / `follow_up` 的精确 JSONL payload。

**可复用规则：** 外部 Runtime 已有原生运行中消息语义时，应通过独立 typed command 保留其时序差异；开放输入框之前先接通真正接受该状态的后端路径，不能把 UI 可编辑误当成功能完成。

## 2026-07-22 — S13 交互收敛与 P2 AppImage 发布证据

**状态：** 已通过发布门槛。**交付：** 低成本可配置的 Session 语义命名、键盘与焦点收尾、Project/Session 切换反馈、slash command 补全、加载/错误/空状态，以及覆盖 P1 回归和 P2 新链路的真实 AppImage 验证器。

| 已修复问题 | 根因 | 修复与工程价值 |
| --- | --- | --- |
| Runtime context action 完成后输入焦点停留在导航控件，slash 建议不能用 Tab 补全 | Composer 只在 prompt/command 完成后恢复焦点，slash keydown 未处理 Tab，combobox ARIA 关系也不完整 | 只在 Project/Session/start/resume 成功且 Composer 重新 editable 后恢复焦点；Tab/Arrow/Enter/Escape 保持明确语义并补齐 listbox 关系 |
| 切换期间只禁用按钮，空对话完全空白，Kernel 初始连接失败没有恢复入口 | Renderer 有 pending/error 事实但缺少最小可见投影 | 增加 `role=status`/`aria-live` 切换反馈、空对话和 crash fallback，并允许用户显式重试 Kernel 连接，不新增 IPC 或状态框架 |
| 旧发布验证器在 S10–S13 后读取失效 DOM 和 v1 `recentSession`，并把异步条件的 Promise 直接转成 true | 验证器依赖 P1 展示节点，未随 typed state 与 XDG state v3 演进；`Boolean(Promise)` 造成瞬时状态误判 | 运行身份、状态和恢复改读 typed KernelState 与 `sessions[]`/`activeSessionKeys[]`；异步条件先 await 再布尔化，受控输入准备不再依赖不稳定的 CDP Ctrl+A |
| 自动命名 metadata Pi 被进程探针误判成第二个 Runtime | metadata 请求与 RPC Runtime 共享 executable/cwd，但前者按架构不属于 Runtime | 发布验证显式关闭自动命名，独立验证单 Runtime 主链路；自动命名继续由定向测试覆盖，不削弱 Runtime ownership 断言 |

**验证：** 候选 `fe1e559` 的 AppImage 报告 17 步全部通过；P2 摘要确认 2/2 Project、2/2 Session、5 个命令、2 类来源、typed command、未知命令拒绝、空态、切换反馈、焦点恢复和单 Runtime。`release/evidence/2026-07-22T03-37-46-614Z-fe1e559bca43/report.json` 为 schema v2 passed，六张截图均非空并已脱敏；119 项 core tests、`pnpm typecheck`、生产 build、真实 Pi 0.80.10 smoke 和 AppImage package 通过。

**可复用规则：** 发布验证应等待用户可操作的稳定点，而不是瞬时 Kernel 状态；允许存在的辅助进程不能被误算为 Runtime；验证器的持久化读取必须与当前 schema 同步，异步浏览器条件必须先解析 Promise 再判断。

## 2026-07-22 — GPT 思考强度与模型选择器修正

**状态：** 已验证。**交付：** 模型选择器、`/thinking` 命令与 Kernel contract 统一使用 `low`、`medium`、`high`、`xhigh`、`max` 五档，并分别显示为“低、中、高、极高、最高”；Composer 设置弹层改为“模型 / 思考强度”左侧一级入口与右侧选项面板。

| 已修复问题 | 根因 | 修复与工程价值 |
| --- | --- | --- |
| 模型选择器展示“关闭、极低、低、中、高、很高、最高”，与 GPT effort 不一致 | Renderer、共享类型、IPC guard 与命令目录共同沿用了 Pi 的七档 thinking 枚举，并将 `xhigh` 误译为“很高” | 删除产品 contract 中的 `off` / `minimal`，统一五档校验、命令提示和中文标签；旧值按未知状态投影为 `null`，不增加兼容分支 |
| 模型和思考强度选项同时纵向堆叠在窄弹层中，层级不清且模型名称拥挤 | 两组内容被实现成不可交互的 section 标题，没有一级导航与选项层级 | 保留单一设置入口，左侧只展示“模型”“思考强度”及当前值；点击一级项后在右侧展示对应选项，并补充模型 ID、effort 原值和窄屏双列布局 |

**验证：** `pnpm typecheck` 与定向 `git diff --check` 通过；源码中不再存在作为思考强度值或文案的 `off`、`minimal`、“极低”、“很高”。

**可复用规则：** OpenAI 官方 [`reasoning.effort` 文档](https://developers.openai.com/api/docs/guides/reasoning#reasoning-effort) 明确支持值依赖具体模型；新增或调整档位前必须核对对应模型页，不从其他模型或通用枚举推断。

## 2026-07-21 — P2 Workbench Foundation：S8–S10

**状态：** 已验证。**交付：** Workbench Navigator、多 Project、多 Session、单活动 Runtime 切换、XDG state v3 与 v1/v2 迁移、真实 Session 恢复和正常 GUI 单实例 ownership。

| 已修复问题 | 根因 | 修复与工程价值 |
| --- | --- | --- |
| Project 激活持久化期间仍可启动旧 Project | Project 变更与 runtime launch 缺少同一同步生命周期门 | Kernel 对 Project 变更和 launch 统一 Fail Fast；运行中拒绝切换，ready/crashed 先受控停止旧 Runtime，再提交新 Project |
| 同一路径并发添加会破坏内存 registry | canonical path 校验与读改写之间存在竞态 | 使用串行持久化队列和 canonical key 去重；失败不提前发布内存投影 |
| Session 切换持久化期间 Pi 退出后，UI 错误回到 `ready` 并显示目标 identity | 异步切换结果覆盖了进程退出产生的 `crashed` 状态 | 提交前重新核对 launch/runtime 状态；失败或退出保留 crash 事实，不把旧 Conversation 标成目标 Session |
| 新 Session 被过早加入索引，随后因 JSONL 尚不存在而无法恢复 | Pi 0.80.10 在首个 assistant 消息完成前延迟创建 session 文件 | 引入只存在于内存的 provisional Session；文件落盘、canonical 校验和指针持久化成功后再一次性提交正式 identity |
| 两个 GUI Main 进程共享 XDG state 时会丢失 Session 索引更新 | 跨进程读改写没有共同 owner | 正常 GUI 增加 Electron 单实例锁，第二实例聚焦首窗口；无状态 `probe-only` 保持独立 |
| Workbench 暗示尚不存在的 slash command，并出现重复“添加项目”入口 | 低保真结构把未来能力画成了当前可用功能 | 未接入命令时显示明确空态，只保留一个添加入口；S11 仍由独立验收决定是否完成 |

**验证：** 94 项 core tests、`pnpm typecheck` 和生产 build 通过；真实 Pi 0.80.10 无状态 smoke、隔离 XDG 双 Session 创建/切换/重建恢复，以及单实例锁 smoke 均通过。结构与事实源见 [`p2-workbench-structure.md`](p2-workbench-structure.md)。

**可复用规则：** GUI identity 必须晚于外部事实落地；异步持久化成功不代表 runtime 仍健康；单活动 Runtime 若依赖共享状态，ownership 必须同时覆盖进程内和正常 GUI 进程边界。

## 2026-07-21 — P1 Linux Core Chain / v0.0.1

**状态：** 已发布门槛验证。**交付：** Linux Electron 工作台、Pi 0.80.10 RPC、Project、prompt/streaming/tool/abort、crash/restart/resume，以及唯一 x86_64 AppImage 产物。

| 已修复问题 | 根因 | 修复与证据 |
| --- | --- | --- |
| abort 后 tool card 永久停留在 `pending` / `running` | Pi 成功响应 abort 时不保证补发 `tool_execution_end` | Kernel 在统一 settle 边界仅将当前 run 的遗留 tool 归一化为 error；回归提交 `bd6158c` |
| 发布验证器找不到打包后的 Pi 进程 | AppImage launcher 不是稳定祖先，且 Pi 会把 process title 改为 `pi`、覆盖原始 cmdline | 先以唯一 project cwd 与精确 RPC 参数定位，最终以 cwd 加 `/proc/<pid>/comm` 唯一定位；提交 `64b4534`、`0f76f1e` |
| abort 验收依赖特定 UI 终态，真实成功仍被误判失败 | Pi 的终态投影可能是 failed tool、`stopReason=aborted`，也可能只有 RPC success 且无运行中 tool | 验证器等待 preload abort 成功响应，并核对终态没有活动 tool；提交 `e278359`、`10319b0` |
| 发布验证读取到旧 Conversation 投影 | 验证脚本按不稳定的展示节点判断当前轮次 | 改为核对 typed kernel state 中的当前 Conversation 与 tool 状态；提交 `a2e5c28` |
| 发布截图可能保留 prompt、thinking 或 tool 细节 | 截图证据缺少与 JSON 报告相同的脱敏边界 | 截图在保存前执行脱敏，并逐张检查非空与尺寸；提交 `8a63c29` |
| 超长 streaming Markdown 在完成前退化成纯文本 | 16,384 字符解析预算被误用成渲染 fallback | 预算只停止分块预解析，超限后仍通过同一 React Markdown/GFM 管线整篇实时渲染；提交 `3ce9fff`、`6fa9047` |
| crash/resume 期间出现旧 launch 复活、并发恢复泄漏或历史消息 identity 碰撞 | 启动、停止、恢复验证和历史重建缺少单一 operation owner 与稳定 identity | 建立单一 launch operation、取消/关停边界、`sessionId` 核对和确定性历史 identity；提交 `29d24dc`、`ec330cc` |
| inherited renderer URL 可绕过预期页面边界，start/stop 与 XDG 保存存在竞态 | 开发 origin、IPC sender、导航策略和原子写入边界不完整 | Main 只接受 electron-vite 开发模式的 loopback origin，拒绝外部导航/窗口；启动与保存使用取消检查和唯一临时文件 |

**验证：** 候选 `0f76f1e` 的 AppImage 报告 13 个步骤全部通过，覆盖 launch、runtime identity、project/cwd、probe、真实 tool、abort、SIGKILL crash、restart/resume、继续对话、关闭重开恢复和最终进程收口；80 项 core tests 与 `pnpm typecheck` 通过。

**可复用规则：** 发布验证应观察稳定事实而不是 DOM 结构或父子 PID 假设；外部进程的成功响应、事件投影和 GUI settled 状态是三个需要分别核对的边界；脱敏必须覆盖报告与截图两种证据。
