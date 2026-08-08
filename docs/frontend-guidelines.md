# Pi GUI 前端规范

> 本文是 Pi GUI **当前前端规范与前端库事实源**。它约束 `src/renderer/` 内的新代码、修改和评审；现有实现与本文冲突时，应先确认是实现缺陷还是规范需要变更，不得在功能提交中静默创造第二套规则。

## 1. 原则、效力与变更

- 遵循 KISS、YAGNI、Fail Fast、SOLID 和 DRY：只实现已由真实产品流程、typed contract 或当前调用方证明需要的能力。
- 前端体系分为四层：`Foundation（tokens.css + styles.css）→ Shared primitives（components/）→ Feature patterns（features/）→ Workbench composition（App/composition）`。下层不读取上层领域事实；“前端库”不等同于把所有界面都搬进 `components/`。
- 本文负责前端目录、依赖、token、组件库、布局、交互、安全和性能规则。运行拓扑与事实源以 `architecture.md`、已生效且未被替代的 `decisions.md` 为准；阶段范围与状态以 `development-plan.md` 为准；Workbench 信息架构以 `p2-workbench-structure.md` 及其后续替代决策为准。
- 文档只描述当前已实现或已明确生效的边界，不把计划、候选接口、空菜单或视觉占位写成现有能力。
- 规则变化必须与对应实现一起评审，并显式更新本文；涉及架构决策时追加 ADR 并写明替代关系，不覆盖历史结论。只改实现而不改规范，或只改规范而没有实现证据，都不能视为边界已经改变。
- 旧 Pi GUI 的信息架构、token、组件和交互经验只能逐项提取并重新验证；不得复制旧 `App.tsx`、全局 reducer、整套 CSS、runtime/application layer 或授权未确认的资产。

## 2. 单 package、目录与依赖方向

项目保持单 package；只有出现第二个真实 package ownership 边界后才讨论 workspace。Renderer 内采用以下单向依赖：

```text
App / composition
  → features
    → components + renderer shared utilities
```

- `App.tsx`、`composition/` 和入口负责装配、顶层状态投影及跨 feature 协调，不承载可下沉的 feature 业务实现。
- `features/<domain>/` 拥有领域 UI、局部状态和仅供该功能使用的样式/纯逻辑；feature 可以依赖 `components/` 和 renderer 共享纯工具。
- `components/` 只放无领域事实、可跨功能复用的 UI 原语；不得反向依赖 `features/` 或 `App`。
- `tokens.css` 只拥有跨功能稳定的语义视觉值；`styles.css` 只拥有 HTML/应用级基础排版、原生控件最低交互基线和全局 reduced-motion 兜底。领域布局、状态与局部变体由对应 feature CSS 拥有，不得借全局 selector 隐式改变其他 feature。
- renderer 共享纯工具不得依赖具体 feature。跨层引用必须保持上述方向，禁止为绕过边界建立循环依赖。
- Renderer 只能通过 preload 暴露的窄 typed IPC 消费 normalized state、发送 typed command。禁止引用 `src/main/`、`src/main/pi-rpc/`、Linux runtime、Node 文件系统/子进程或 raw Pi event；共享 contract 也不得把 Pi RPC 原始类型泄漏给 Renderer。
- 不为一个调用方建立 barrel export、独立 package、组件 registry、插件注册中心、基类或兼容层。直接从 owner 文件导入；只有真实重复或 ownership 边界证明抽象能减少复杂度时才增加边界。

## 3. 事实源、typed IPC 与 Fail Fast

- Pi session 文件是 Conversation 事实源；Renderer state 只是当前展示投影，不建立第二份对话数据库。
- Project、Session identity、Runtime context、Conversation 投影和状态转换由 Electron Main 的 Workbench Kernel 拥有。Renderer 不自行推断后台真实状态，也不以本地 UI 状态覆盖 Kernel summary。
- Pi credential/provider auth 由 Pi 管理；Pi 官方配置是自定义 Provider/Model 的事实源。Renderer 不回读或持久化密钥。
- Advisor 的安装、启停和 roster 控制面已退出当前产品；Renderer 不再展示 Advisor 设置或
  已适配拓展入口。既有 Session 中合法的历史 advisory 仍由 Main strict projector 归一化，
  Renderer 只负责只读展示，不解析 raw custom entry/message。
- 所有跨进程操作必须是窄的 typed IPC：明确命令、明确 payload、明确返回和错误。动态 slash command 必须先存在于当前 normalized catalog；禁止“执行任意命令”、任意路径读取或 raw RPC passthrough。
- UI 只展示真实能力和真实状态。没有后端能力时隐藏入口或显示明确空态，不伪造队列重排、百分比、剩余时间、阶段、成功结果或可用命令。
- 未知 schema、未知 command、非法 identity、非前缀增量 patch、无效路径或不支持状态应 Fail Fast，保留明确错误；不得静默 fallback、新建 ghost Session 或把旧 Conversation 标成新目标。

## 4. Foundation：Design token 与 CSS 基线

`src/renderer/src/tokens.css` 是共享视觉语义的代码事实源，`src/renderer/src/styles.css` 是全局 HTML 与原生控件基线。Token 只表达稳定、跨功能、可命名的语义，不要求把每个局部几何数值都做成全局变量；feature 不得复制接近值、另建配色/字号/图标等级，或把一次性布局数字伪装成通用 token。

### 4.1 字体与文字层级

- 字体族只有三类：`--font-display` 用于页面级标题和正文中的展示标题；`--font-ui` 用于界面标题、正文、控件、列表与元信息；`--font-code` 只用于代码、命令、路径和原始工具输入/输出。
- 页面标题：`--text-page-title` + `--line-title`，使用 display family。
- 区块标题：`--text-section-title` + `--line-heading`，表达页面内主要分组。
- 正文：`--text-body` / `--text-body-sm` + 对应 body line-height，用于需要持续阅读的内容；thinking/commentary 状态变化前后保持正文排版，避免换行跳动。
- 控件：`--text-control` + `--line-control`，用于按钮、输入、选择器和紧凑标签。
- 列表：`--text-list-item` + `--line-control`，用于 Navigator、菜单和结果行。
- 元信息：`--text-meta` + `--line-meta`，用于状态、时间、路径摘要等次级信息。
- 图注/辅助说明：`--text-caption` + `--line-caption`，不得代替必要的可读正文。
- 代码：`--font-code` + `--line-code`；inline code 可继承所在语境字号，代码块使用 code 行高。

### 4.2 Icon 尺寸

- `--icon-size-sm`（15px）：行尾提示、chevron、check 等次级图标。
- `--icon-size-control`（18px）：标准按钮、导航和控件图标；`Icon` 默认使用此尺寸。
- `--icon-size-lg`（21px）：确有更高视觉层级的主入口；不得靠任意宽高制造新的 icon 等级。
- 图标尺寸通过 `Icon` 的 `size="sm|control|lg"` 消费上述 token；保持 24×24 viewBox 和 `currentColor`，装饰性 SVG 使用 `aria-hidden`，可操作图标由按钮提供可读名称。

### 4.3 颜色、圆角、空间与动效

- 颜色按语义使用：app/background、surface/input/popover/tooltip、text primary/body/soft/muted、border/focus/divider、hover/list state、status/error/warning、accent。禁止把某个深浅主题的十六进制值直接写进 feature。
- 主题、accent 和面板透明度只通过根节点属性及统一 token 改变；透明度作用于表面层，不降低正文和整个窗口的不透明度。
- 有表面语义的圆角使用 `--radius-sm`、`--radius-tooltip`、`--radius-control`、`--radius-popover`、`--radius-panel`、`--radius-composer`、`--radius-pill`；按对象语义选择，不因局部观感增加相邻新值。`0`、`inherit`、圆形 `50%`、mask/SVG/进度环等纯几何值可以保留直接值；其他例外必须由 owner 附近的注释解释，不能静默绕开 token。
- 当前没有全局 spacing scale。跨 feature 稳定的壳层间距可进入 token；单个 feature 的网格、文字间隙、命中区和响应式几何继续由 owner CSS 直接表达。相同数字不自动代表相同语义，不得为了消灭数字而建立无意义的 `--space-*` 序列。
- 动效使用 `--motion-duration-tooltip/fast/control/layout` 与既有 easing。持续性状态动画可拥有 feature-local 周期，但进入/退出、hover、展开和布局过渡不得重新硬编码相邻时长。动效只解释状态变化或空间关系，不伪造进度；布局动效避免引起正文重排和滚动锚点跳跃。
- 所有非必要 animation/transition 必须提供 `@media (prefers-reduced-motion: reduce)` 的静态或近即时表现（项目检索关键字统一使用 `reduced-motion` 作为检查语义）。

### 4.4 全局基线与 feature 覆盖

- 原生 `button`、`input`、`textarea` 优先；`styles.css` 只提供字体继承、最低可辨识 hover/focus-visible/disabled 及基础表面，不定义产品级 button variant。
- feature 可以覆盖尺寸、布局和语义颜色，但不得重新发明焦点可见性、disabled 禁止动作、reduced-motion 或相同 portal 关闭协议。重复的是行为协议时优先抽无领域 hook；重复的只是外观且仍属同一 feature 时先合并 feature-local selector。
- 公共组件 CSS 与组件同目录；feature CSS 不得按公共组件内部 DOM 结构做跨目录覆盖。确需扩展时通过组件现有 props/className 边界，并由调用方拥有外层布局。

## 5. 当前前端库

当前库由两部分组成：Foundation 提供稳定语义，`components/` 提供无领域事实的共享交互原语。Feature pattern 即使被多个页面复用，只要仍携带同一领域事实，也继续留在 owner feature。

| 层 | 当前 owner | 边界 |
| --- | --- | --- |
| Foundation | `tokens.css` | 字体、文字层级、语义颜色、icon 尺寸、圆角、动效、壳层视觉值。 |
| Global baseline | `styles.css` | HTML 尺寸、box sizing、原生控件最低基线、focus-visible、disabled、全局 reduced-motion。 |
| Shared primitives | `components/` | 无领域事实、跨功能复用且具有稳定交互/ARIA contract 的组件或 hook。 |
| Feature patterns | `features/<domain>/` | 领域菜单、卡片、状态、表单组合、灯箱内容与局部样式；不是公共库。 |

`src/renderer/src/components/` 当前只有以下公共能力；未列出的 feature UI 不属于共享库。

| 能力 | 当前边界 |
| --- | --- |
| `Icon` | 内联 SVG 图标集合，使用 `IconName` 限定名称、`currentColor` 和 `sm/control/lg` 三档语义尺寸。新增图标必须服务真实入口，不建立外部 icon registry。 |
| `IconButton` | 无文字图标按钮；强制 `label`，写入 `aria-label` 和 `data-tooltip`，并通过 `iconSize` 透传三档图标尺寸，默认 `type="button"`。有常驻文字或复杂内容时使用普通 button。 |
| `Select` | 已知有限选项的共享 listbox；支持分组、禁用、选中态、外点关闭以及 Arrow/Home/End/Enter/Space/Escape/Tab。模型级联菜单、slash 命令菜单等不同语义不得强塞进它。 |
| `FontSelect` | 系统字体专用的可搜索 listbox，支持 UI/code 预览、不可用当前值和键盘选择；不是通用 searchable select。 |
| `TooltipProvider` | 顶层统一 tooltip：读取 `data-tooltip`，hover 延迟、focus 立即显示，自动视口避让，Escape/滚动/缩放关闭，通过 portal 渲染并维护 `aria-describedby`。tooltip 只放补充说明，不能承载完成任务所必需的信息或操作。 |
| `useViewportPopoverPosition` | 为 portal popover 计算 fixed 定位、视口边距、上下翻转或左右级联、限宽限高，并监听 viewport resize、scroll 和触发器尺寸变化；它只解决定位，不替调用方实现焦点、外点、Escape、ARIA 或选择语义。 |
| `useModalDialog` | 管理当前最上层 modal 的初始焦点、可见可聚焦项、Tab/Shift+Tab 环、Escape、busy 时关闭阻断和关闭后的焦点恢复。调用方继续拥有 portal、dialog label/description、`aria-busy`、可聚焦 root、backdrop 点击策略、视觉壳与领域异步状态。 |

新代码优先复用上述真实边界；语义不相同时保留在 feature 内，避免为了表面样式相似制造万能组件。

`Select` 与 `FontSelect` 的触发器、popover、option、check 外观基线由 `selection-control.css` 共同拥有；搜索、字体预览、分组等语义仍由各自组件和专用样式拥有，不复制基础状态，也不抽成万能选择器。

### 5.1 公共原语 contract

每个公共原语都必须能回答四个问题：真实调用点在哪里、键盘/ARIA contract 是什么、明确不支持什么、如何验证。新增 prop 只能服务现有 contract 的共同部分，不能把某个 feature 的 loading、identity、IPC 或文案状态下沉进公共组件。

- `Icon` / `IconButton` 统一图标名称、尺寸和可读名称；它们不拥有业务 tooltip 文案、确认流程或异步状态。
- `Select` / `FontSelect` 拥有各自完整的选择语义；全 disabled 或空结果时仍必须保持可关闭、可离开的焦点路径，不伪造可选项。
- `TooltipProvider` 处理普通补充说明。只有必须和领域内连续指针轨迹、预览定位或专用 disclosure 紧耦合的 tooltip 才允许 feature-local；此类实现仍要自行满足 hover/focus、Escape、视口避让和可读名称。
- `useViewportPopoverPosition` 只拥有几何定位。调用方继续拥有 portal identity、外点、键盘、焦点恢复和选择行为。
- `useModalDialog` 只拥有跨 feature 的 modal 焦点和关闭协议；`dismissDisabled` 会消费但不执行 Escape，避免 busy modal 泄漏到外层。嵌套 modal 只有栈顶实例处理键盘，feature 必须给 dialog root 提供 `tabIndex={-1}` 作为无可用控件时的焦点兜底。

### 5.2 当前明确不进入公共库的能力

- 普通文字按钮继续使用原生 `button` 与 owner 样式；当前不建立只有视觉 variant 的通用 `Button` 包装层。
- Project/Session hover card 仍属于 `project` feature；共同外观在 feature 内合并，不建立通用 `HoverCard`。
- Composer 模型级联、slash/project path 建议面、Timeline Prompt 预览等拥有不同 role、焦点和关闭语义，不抽成万能 `Popover` / `Menu`。
- status、empty、error block 的文案、生命周期和布局属于领域状态，不因都使用 `role="status"` / `role="alert"` 就抽成共享组件。
- modal 的视觉壳、标题/描述、按钮、backdrop 是否关闭以及领域 busy 状态仍由各 feature 拥有。共享 `useModalDialog` 不构成通用 `Dialog` 组件，也不得向其中加入业务文案、portal DOM 或统一按钮布局。

## 6. Workbench 四区布局

当前 Workbench 使用四区：`Navigator / Header / Timeline / Composer`。

- Navigator 顶层同时展示“项目”和“任务”两个独立 disclosure 分组：每次 Renderer 生命周期开始时都默认展开，可分别收起且互不联动，展开状态不持久化也不进入 Kernel；两组按项目在上、任务在下共享现有单一滚动区。分组标题以 `aria-expanded` / `aria-controls` 控制本组显隐，独立 `＋` 分别添加 Project 与创建 Task；当前类别只保留活动强调和真实运行数量，不恢复 Tab 式切换。Navigator 继续展示 Project 与所属 Session、选择态、真实运行摘要和已接通的行内操作。Project 行负责 Project 选择与该 Project 的新建 Session；Session 行打开对应 Conversation。点击新建后尚未提交任何 prompt 的空 provisional Session 只作为工作区 identity 存在，不显示、不计入 Project Session 数量；首条 prompt 被 Runtime 接受后，同一 provisional identity 才进入 Navigator。每个 Project 的普通历史默认显示 5 个并按 5 个继续展开；当前展示项、已进入列表的 provisional / 非空闲 Runtime，以及后台刚完成但尚未查看的 Session 可作为分页外保留项，避免运行结束重排后从导航消失，查看并切走后再恢复普通分页。Header 展示当前 Project、Session、Runtime 和进入正常布局流的诊断。
- Timeline 是可滚动正文区；Header 和 Composer 不得以未计入布局的浮层遮住消息。活动 run 与 settled 工作过程保持同一 turn group。紧凑工作过程的单行状态以及活动 ThinkingStep 标题，在没有更高优先级的活动工具或 commentary 时，优先显示最新一条非空 thinking 摘要的最后一个语义行，并去除整行 Markdown 包裹；只有确实没有可用摘要时才回退“正在思考/正在继续”。标准工作过程保留 commentary / 非摘要 thinking 主阅读线，并把相邻主阅读段之间连续发生的普通工具调用合并为一条可展开汇总：读取与修改按不同文件路径计数，bash 按调用计数，运行中批次原地增长，失败在汇总中显式可见；下一段主阅读内容或 Ask、Subagent、协调工具会封口当前批次并保持独立展示。工具汇总正文与主阅读内容保持同一左边线，并采用编辑式叙事层级：动作词使用较清晰的次级正文色，文件名、数量等目标使用更轻的元信息色；同类文件不超过 2 个且 basename 无冲突时直接列名，更多时回退数量。运行状态直接由“正在读取/修改/运行/调用”表达，成功后不常驻勾选或“完成”文字，失败只在右侧保留明确数量且不添加独立失败标点，disclosure 箭头仅在 hover、focus 或展开时显现。普通工具批次只有一个 entry 时继续保留稳定的外层汇总 identity，但展开后直接显示该工具的输入、输出或错误，不再嵌套一条相同工具标题；没有真实详情时不显示 disclosure。Renderer 将同一 turn 中连续的 thinking entry 合为一个视觉阶段，任何 commentary、tool、Ask、Subagent、协调或其他非-thinking 过程项都会封口；底层 Kernel entry identity 与顺序保持不变。若 error 或其他 content entry 将活动 run 切成多个过程 chunk，后续 chunk 出现新的 thinking 后，活动 Timeline 只保留最新含 thinking chunk 的 thinking；更早 thinking 仍留在事实投影，并在 run settled 后的“已处理”展开中按原始顺序恢复，跨 chunk 的工具、commentary 与错误内容不得随之隐藏。活动阶段标题使用最新摘要的最后一个语义行，展开正文按原顺序连接并移除标题所消费的那一行；完成阶段仅有一个非空源码行的短思考直接显示正文，多行或多段内容才保留一个“思考” disclosure。组耗时只在每条 thinking 都有现场观测时显示，并取重叠观测中的最长跨度而不是相加。完成态 disclosure 左侧固定显示“已处理”，右侧显示本轮真实耗时；Renderer 现场计时不可用时使用 canonical turn transcript 时间跨度，不静默省略时间。长对话滚动时，Timeline 只根据顶部阅读轮次更新 Prompt 导航轨高亮，不在 Header 下粘着用户 prompt。Navigator 完全展开时，Timeline 左缘可显示 Prompt 导航轨：短标记与真实用户轮次一一对应，默认只显示以当前阅读轮次为中心、最多 7 条的局部窗口；首次悬浮延迟后，轨道扩为连续命中带，滚轮与键盘可跨窗口浏览其余 Prompt，点击后定位，离轨收起后重新围绕当前阅读轮次。当前标记与邻近标记保持固定线高和矩形端点，宽度使用有界离散层级并只在相邻层级间按整数像素插值，同轨切换立即响应，短暂离轨延迟收起以避免斜向挑选时意外隐身；窄窗口和折叠 Navigator 下不显示。
- `pi-subagents` 的前台运行作为当前 turn 的专用工具过程展示：Subagent 一旦进入唤起或运行状态，其任务胶囊必须直接出现在 Timeline，不能藏在“思考”或通用工具详情 disclosure 内；默认以每个参与者一个紧凑、可聚焦的任务胶囊呈现摘要，整体状态放在同一行；胶囊选择只由“当前展示 Conversation identity + Subagent toolCallId + participant.index”定位。点击后打开 composition-owned 的共享右侧模块栏；当前真实顶层 Tab 为按实际可用性出现的“Git”和“子任务”，`SubagentTaskDetail` 继续拥有任务标题、状态、活动、结果、输出引用与运行摘要，不把领域实现搬进 composition。Session Header 的一级入口只代表通用右侧栏壳层，使用与左侧栏镜像的展开/收起图标与 `aria-expanded`，不得把 Git 或其他领域模块图标提升为壳层入口；模块只在栏内作为真实 Tab 出现。宽窗口中右侧栏占据真实第三列并保留 Conversation，支持有界指针/键盘调宽、收起与关闭；较窄窗口沿用同一模块栏 contract 替换主工作区并提供“返回对话”，不维护第二条 Subagent 专用布局。右侧栏 API 可承载多个已接通的具体 Tab，但当前不显示 Browser、Terminal 或其他占位模块，也不建立 registry。详情按状态组织：运行中以当前活动为主，完成态直接显示结果或输出文件，失败态优先显示错误，暂停态显示已有输出与最后活动；不得保留无意义的完成态“当前活动”或重复 completion envelope。实际模型、input/output/cache read/cache write token、费用、轮次、工具数与耗时随归一化 patch 原地刷新；任务胶囊在实际模型已报告时于主标签后显示模型 ID 的最后一段，完整 provider/model 保留在 tooltip 与运行摘要，未报告时不显示模型占位且不从配置猜测。后台 completion 协议完全未提供模型、usage 或执行统计时不渲染空的“运行摘要”分区，任一实际摘要字段存在时才展示该分区并将其余缺失项标为“尚未报告”，不以 0 或配置值冒充实际消耗。合法 file-only output reference 只显示 basename、Agent、大小和行数，并可由用户显式打开；GUI 不读取文件正文。关闭、返回和 Escape 尝试恢复胶囊焦点；Project/Session/新对话/归档预览 identity 变化、目标消失或设置页打开时关闭旧详情。Renderer 不解析 `details` JSON，不读取 child transcript 或普通 artifact，也不建立任务数据库或运行控制。后台启动保留真实 async identity；普通 completion custom message 在 Timeline 只形成轻量、可点击的完成任务胶囊，胶囊继续使用通知协议中的原始 Agent 名称而不是“后台任务结果”等通用文案；正文不渲染结果预览，点击后用同一任务详情阅读归一化结果。`subagent list/status`、`subagent_wait` 以及 supervisor/intercom 的 pending/status/list 属于主 Agent 内部发现或轮询，不占用 Timeline，也不得用多行普通工具状态代替任务胶囊。控制、转向、暂停、停止、回复和 Watchdog 警告仍以独立通知显示；结构化 supervisor request 属于主 Agent 内部协作状态，同一 run participant 的具体 request 替代泛化 attention，成功 reply 仍原地更新为已处理，但 pending/handled 均不渲染到 Timeline；若确需用户决策，由主 Agent 在普通 Assistant 对话中提出。只有 completion guard 与 Watchdog blocker 使用 alert；Main 只按固定协议归一化详情与协调 identity，Renderer 不按 Markdown 文案反推状态或关联原 run。
- Git Changes 采用紧凑的单列表投影：默认范围为 `Uncommitted` 且所有文件 diff 默认折叠；每个文件独立展开/折叠并可同时保留多个展开项，列表标题区提供真实“全部折叠”控制。顶部范围选择只提供现有 status DTO 能精确表达的 `Uncommitted / Unstaged / Staged`，mixed 文件可进入 unstaged 与 staged 投影，但同一列表中不得重复。选择 unstaged 或 staged 后，diff 与 Stage/Unstage 操作必须收窄到该投影对应的一侧；切换范围、Project 或刷新状态会关闭旧 diff。文件行使用明确 disclosure 与紧凑图标操作，冲突说明不为每个文件重复占据常驻高度。diff hunk 前和 hunk 间由 canonical old/new range 精确显示 `N unmodified lines` 折叠条，不显示 raw `@@` header；当前 DTO 未携带被省略的源码文本或文件尾总行数，因此折叠条不得伪装成可展开内容。若后续增加按需上下文，必须通过有界、stale-safe 的 Git Main/IPC request 获取。现有 DTO 未提供 repository 总增删行、Last Turn 或 Branch Commits 时不得扫描全部 diff、猜测统计或显示不可用占位项。Git diff 性能使用“有界数据预取而非隐藏 DOM 预渲染”：pointer/focus 意图经过短延迟只预取 exact Project/repository/status/file/kind snapshot 对应的 typed DTO，同 key 请求 single-flight，只有稳定展示结果进入最多 8 条、估算 8 MiB 的 LRU；Project identity 变化清空缓存，trust/not-repository/stale 或 repository identity 变化强制刷新且不缓存。最多同时展开 8 个文件；单个 diff 不超过 300 个 render row 时直接挂载，超过阈值时由 feature-local `@tanstack/react-virtual` 只挂载可视窗口和 overscan，固定 32px 行高并根据全量 row model 建立稳定水平宽度。大型 diff 必须同时提供完整文本模式与“复制全部”，避免虚拟 DOM 破坏连续阅读和完整复制；这一路径只服务 Git viewer，不改变 D-010 的 Timeline 60-turn 有界挂载决策。
- 既有 Session 中的 Advisor advisory 作为对应 turn 内的只读审查卡展示名称、严重度、正文
  和 guidance；blocker 可以使用更强错误语义，但不得遮盖或替代 Assistant 最终回答。
  Renderer 不解析 advisory XML，也不提供新的 Advisor 控制入口。
- 已完成 turn 的复制、导出与分叉操作使用常驻同高的内联操作槽；默认只隐藏图标绘制和指针命中，悬停 turn 或键盘聚焦按钮时显现，不得因操作行挂载/卸载推动后续 Timeline 内容。操作反馈归属于发起操作的 turn，并在槽内单行省略，不能因 hover 转移或换行改变槽高；无 turn 来源的快捷键反馈使用时间线末尾的稳定位置。只为当前真实可用的操作预留槽，不补假能力。
- Composer 是底部输入与命令面，支持普通 prompt、运行中 follow-up/steer、slash、附件和 abort 的现有语义。新对话或已选历史 Session 的 Runtime 尚在启动时，Composer 可先接受一条普通 prompt，并复用该精确 Session 已在进行的启动任务，准备完成后提交；slash 命令仍等待目标 Runtime 的命令目录可用。GUI / typed Pi RPC 命令成功后在 Timeline 显示本地-only 的 command 回声（不写进 Pi session）；extension / prompt / skill 仍以用户消息进入对话事实源。
- 当前用户轮次存在合法 `todowrite` 列表时，Composer 上方显示比输入框更窄的轻量任务托盘；工具 leaf name 对 `.`、`:`、`/` namespace 分隔保持一致识别，不能因 provider 命名形式退回普通 Timeline 工具卡；标题栏默认收起，用户可按需展开或再次收起，收起态保留完成数、当前步骤和真实状态。新用户轮次、空列表或 Conversation identity 变化时不得沿用旧任务；专用托盘出现后 Timeline 不重复显示普通 `todowrite` 工具卡。托盘高度必须由现有 Composer 测量进入 Timeline clearance，窄窗口占满可用宽度，并保留 disclosure ARIA、键盘焦点和 reduced-motion 行为。
- Composer、队列面板和其他底部层的实际高度必须参与动态 clearance；通过测量后的 reserved space/offset 让 Timeline 末尾始终可见，不能依赖固定输入框高度猜测。
- 窄窗口优先保持主任务可用：Navigator 可按现有入口折叠；主区不得横向溢出；popover 依据 viewport 翻转并限宽限高；长标题、路径和选择值使用可控换行或 ellipsis。
- 设置页沿用 Navigator + 内容区结构。设置行在宽窗口采用左侧标签/说明、右侧紧凑控件；窄窗口改为上下排列，控件占可用宽度。只重排已接通设置，不补无后端语义的占位选项。影响自动执行或外部副作用的调试开关必须默认关闭，并在同一设置行明确正常退出/异常退出、一次性语义和重复副作用风险；依赖另一项设置时必须真实 disabled，而不是保存一个当前不会生效的隐藏组合。

## 7. 交互与可访问性

### 7.1 控件状态与命中

- 每个交互控件都必须定义 hover、键盘 focus-visible、selected/expanded 和 disabled 状态；这些状态使用语义 token，并保证深浅主题可辨识。disabled 同时禁止动作，不能只降低透明度。
- 原生 button/input 优先。自定义 listbox/combobox/menu 必须提供匹配的 role、`aria-expanded`、`aria-controls`、选择/活动语义和完整键盘路径；打开后焦点进入有效目标，Escape 关闭并按语义恢复触发器焦点，Tab 不形成焦点陷阱。
- 只有 mouse hover 才出现的操作，也必须能在行内键盘聚焦时发现并执行；触控/键盘不能依赖 tooltip 才理解主要动作。
- Project 导航拖拽必须遵守 hit testing：只在 Project 主行主键按下后临时武装，`pointerup`、`pointercancel`、`dragend` 均解除；action slot 不得武装拖拽。隐藏层除 `opacity: 0` 外还要正确设置 `pointer-events: none`、禁止文本选择并核对 stacking order。Project 排序只改变持久化顺序，不得改变活动身份或 Runtime ownership。Session 不提供手动拖拽，统一消费 Kernel 的运行状态与最近活动时间排序。

### 7.2 Portal、popover 与 modal

- portal 内容必须纳入外点判断、Escape 层级、焦点管理和视口变化处理；不能因为 DOM 脱离触发器就提前关闭或泄漏点击。
- Escape 按最内层活动表面优先：modal / 级联菜单 / popover / tooltip 只在自己实际处理时 `preventDefault`，需要阻止外层继续关闭时再 `stopPropagation`。Workbench 的设置页、任务详情和 Composer abort 只能在没有更高优先级活动表面时响应。
- modal 必须具有唯一 label，按内容需要提供 description / busy 状态；当前 Renderer modal 使用 `useModalDialog` 把焦点送入有效目标，Tab/Shift+Tab 保持在栈顶 modal 内，并在关闭后尽力恢复到仍连接且仍代表同一操作的触发器。dialog root 必须可由脚本聚焦；busy 状态是否允许 Escape、关闭按钮和 backdrop 关闭必须显式定义，不能因实现差异偶然决定。
- popover/menu 的 z-index 只解决与相邻已知层的关系；不得用任意更大的数字掩盖 portal、窗口边缘命中层或嵌套菜单问题。新增层必须说明它位于普通内容、Composer/Header、hover preview、级联菜单、modal 中的哪一层。
- tooltip 支持 hover 与 focus、使用 `role="tooltip"`/`aria-describedby`，并可用 Escape 关闭；按钮的 `aria-label` 不能由 tooltip 代替。

### 7.3 响应式与动效

- 当前结构断点以真实布局责任为准：`1280px` 以上可显示 Subagent 第三列；`700px` 及以下进入紧凑 Workbench/Navigator/Composer；`620px`、`500px`、`32rem` 等只用于对应表单或 modal 的局部重排。CSS custom property 不能用于 media query，不建立不可执行的“断点 token”。
- 新断点必须解决现有内容溢出、焦点路径或可用宽度问题；优先复用 owner 已有断点，不为单个像素观感增加相邻断点。
- reduced motion 偏好下，Session/thinking 等状态仍要通过形状、文字或静态颜色可理解，不能只靠旋转、呼吸或闪烁表达。

## 8. 内容安全与长对话性能

### 8.1 Markdown、附件与外链

- 正文与 thinking 使用同一无 raw HTML 的 CommonMark/GFM + math 管线；`$...$`、`$$...$$`、`\\(...\\)`、`\\[...\\]` 与 `math` code fence 由本地 KaTeX 渲染，KaTeX `trust` 固定关闭，CSS/字体随应用打包，不加载远程脚本或样式。任何长度的 streaming 与 settled 都保持同一 Markdown/数学 renderer，不建立完成态专用路径或纯文本 fallback；块级公式在窄窗口内允许自身横向滚动。
- Markdown 图片不自动加载远程内容。链接只由用户点击触发并经过受信 IPC sender 校验：`http:`、`https:`、`mailto:` 交给系统外部 URL handler；Linux 绝对路径与无远程 host 的 `file:` URL 交给 Main 使用 `shell.openPath` 打开。Renderer 不直接导航、不读取目标文件，也不接受相对路径或其他 URL scheme。
- 普通附件采用交互式 TUI 的 `@路径` 引用，GUI 不读取、复制或经 IPC/RPC 发送全文；Agent 通过 Pi 原生 `read` 按需读取。图片使用 Pi RPC 原生 `ImageContent`，遵守当前 2000×2000 与 4.5 MiB base64 边界。
- 工具结果图片与用户消息图片共用灯箱语义（loading/error/ready、Escape、外点关闭、Tab/focus restoration），但走独立 `getToolImage(sessionKey, toolCallId, contentIndex)`；普通工具详情在展开后显示图片附件入口，无文本但有图片时不得显示“等待工具输出”。每次异步读取必须用 request token 联同 Session、Tool 与 `contentIndex` 核对完成结果；identity 变化要关闭 viewer，多个实例的 dialog title 必须使用唯一 id。Subagent 专用工具不使用该通用图片 UI。Renderer 不得按路径读取工具图片，也不得把 base64 写入常驻 state。
- Renderer 不接受任意路径读取。系统选择由 Main 返回明确路径；拖放使用 Electron `webUtils.getPathForFile`；剪贴板/DOM File 只处理用户显式提供的内容。KernelState 与历史投影只含附件摘要，不含文件正文或图片 base64。

### 8.2 增量更新与 60 turn

- 高频 message/thinking/tool update 使用 `kernel.state-patched`：entry patch index 与 `activeRunStartIndex` 使用完整 Conversation 的绝对 index，Renderer 依据权威窗口 `startIndex` 转为本地 index；新增 entry 按绝对 index 插入，append-only 文本和工具输出只传起始长度与后缀。patch 落在未加载范围、边界不连续或无法证明是安全前缀增量时必须 Fail Fast，并由既有 revision resync 取得新的权威窗口，不得静默丢弃或猜测位置。
- Renderer 按事件顺序应用 patch，每动画帧最多提交一次 React state；未变化 entry 保持对象 identity。消息附件与工具图片 metadata 变化不得误走纯文本/工具输出 append patch，必须回退 `kernel.state-changed`。
- Subagent 工具 patch 必须随普通工具状态原子更新归一化运行摘要；原始 `pi-subagents` details、child messages、artifact/transcript 路径不作为 Renderer 状态。历史恢复与实时事件使用同一 projector，只显示 `display: true` 且属于固定适配 custom type 的通知。
- 合法的历史 Advisor advisory 继续进入统一 Conversation patch；非法 advisory、capability
  metadata 或非固定 custom type 不得以普通消息 fallback。
- 流式 Markdown 复用稳定顶层块；16,384 字符只限制额外分块预解析，超限后仍由同一 React Markdown 管线整篇实时渲染。
- Main 内部保留完整 active-branch Conversation；Renderer 的权威工作窗口初始只接收最近 **60 turn** 的 settled 历史与完整 active run。用户到达窗口顶部后，通过 Project、Session、Session ID、边界 index 与边界 entry ID 绑定的窄 typed IPC 每次前置最多 60 轮，并复用现有 reading anchor / scrollHeight 补偿保持滚动位置。该读取不推进 Kernel revision，也不允许 Main 后续 snapshot 随已加载页增长；Renderer 仅在新权威尾窗与当前窗口存在连续 entry identity 重叠时保留本地旧页。分页 loading/error 只属于 Timeline 顶部控制，不覆盖已加载内容。
- Timeline 只挂载当前已加载窗口中允许显示的 turn；折叠过程的 thinking、工具参数与输出只在展开时挂载。Project/Session identity 变化时丢弃旧分页窗口、请求状态、滚动和 disclosure，不复用上一 Conversation。完整导出、fork、图片读取与最后回答选择继续由 Main 的完整事实执行。
- 用户离开底部后停止自动跟随。

## 9. 新组件进入库的证据门槛

组件或 hook 进入 `components/` 必须满足以下至少一项：

1. 已有至少两个真实、独立调用点，并且交互、状态和可访问性语义一致；或
2. 存在明确的跨模块语义与唯一 ownership，把它放入共享库能消除实际重复或阻止依赖倒置。

抽取按以下顺序完成：

1. **观察重复**：列出真实调用方与当前差异，区分领域状态、布局外观和行为协议。
2. **固定共同 contract**：明确 props、ARIA、键盘、焦点、外点/Escape、disabled/busy、窄窗口和 reduced-motion；无法统一的部分继续由 feature 拥有。
3. **抽最小原语**：优先抽纯行为 hook 或无领域 primitive，不把调用方文案、identity、IPC、loading 状态塞入共享层。
4. **一次迁移**：删除调用方重复路径；不长期保留新旧实现、兼容 wrapper 或双重 CSS。
5. **补证据**：更新本文件的当前库表，并运行最小验证与相关定向测试。

单次功能、单消费者布局协议、feature 专用菜单、一次性格式化和视觉原子留在所属 feature。不得以“以后可能复用”、文件较长、相同像素值或 CSS 相似作为抽取证据。

## 10. 最小验证

常规前端修改的最小验证为：

```bash
pnpm typecheck
pnpm build
git diff --check
```

评审 touched CSS 时额外核对：是否新增可映射到现有 token 的 raw color/radius/motion，是否复制了已有 focus/disabled/portal 协议，是否在 feature 外覆盖公共组件内部结构。仓库中尚存的历史直接值属于后续清理清单，不能成为新增偏离的理由，也不把一次功能修改扩大成无关的全库重绘。

按风险补充已有定向测试即可；公共交互原语变更应覆盖其键盘/ARIA contract 或至少覆盖可纯函数化的行为。除非变更本身需要真实运行证据或用户明确要求，不要求启动应用或截图。
