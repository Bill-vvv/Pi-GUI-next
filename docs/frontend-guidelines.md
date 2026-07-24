# Pi GUI 前端规范

> 本文是 Pi GUI **当前前端规范与前端库事实源**。它约束 `src/renderer/` 内的新代码、修改和评审；现有实现与本文冲突时，应先确认是实现缺陷还是规范需要变更，不得在功能提交中静默创造第二套规则。

## 1. 原则、效力与变更

- 遵循 KISS、YAGNI、Fail Fast、SOLID 和 DRY：只实现已由真实产品流程、typed contract 或当前调用方证明需要的能力。
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
- renderer 共享纯工具不得依赖具体 feature。跨层引用必须保持上述方向，禁止为绕过边界建立循环依赖。
- Renderer 只能通过 preload 暴露的窄 typed IPC 消费 normalized state、发送 typed command。禁止引用 `src/main/`、`src/main/pi-rpc/`、Linux runtime、Node 文件系统/子进程或 raw Pi event；共享 contract 也不得把 Pi RPC 原始类型泄漏给 Renderer。
- 不为一个调用方建立 barrel export、独立 package、组件 registry、插件注册中心、基类或兼容层。直接从 owner 文件导入；只有真实重复或 ownership 边界证明抽象能减少复杂度时才增加边界。

## 3. 事实源、typed IPC 与 Fail Fast

- Pi session 文件是 Conversation 事实源；Renderer state 只是当前展示投影，不建立第二份对话数据库。
- Project、Session identity、Runtime context、Conversation 投影和状态转换由 Electron Main 的 Workbench Kernel 拥有。Renderer 不自行推断后台真实状态，也不以本地 UI 状态覆盖 Kernel summary。
- Pi credential/provider auth 由 Pi 管理；Pi 官方配置是自定义 Provider/Model 的事实源。Renderer 不回读或持久化密钥。
- 所有跨进程操作必须是窄的 typed IPC：明确命令、明确 payload、明确返回和错误。动态 slash command 必须先存在于当前 normalized catalog；禁止“执行任意命令”、任意路径读取或 raw RPC passthrough。
- UI 只展示真实能力和真实状态。没有后端能力时隐藏入口或显示明确空态，不伪造队列重排、百分比、剩余时间、阶段、成功结果或可用命令。
- 未知 schema、未知 command、非法 identity、非前缀增量 patch、无效路径或不支持状态应 Fail Fast，保留明确错误；不得静默 fallback、新建 ghost Session 或把旧 Conversation 标成新目标。

## 4. Design token

`src/renderer/src/tokens.css` 是前端 token 的代码事实源。组件样式优先消费语义 token，不在 feature 中复制接近值或按单个页面另建配色体系。

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

### 4.3 颜色、圆角与动效

- 颜色按语义使用：app/background、surface/input/popover/tooltip、text primary/body/soft/muted、border/focus/divider、hover/list state、status/error/warning、accent。禁止把某个深浅主题的十六进制值直接写进 feature。
- 主题、accent 和面板透明度只通过根节点属性及统一 token 改变；透明度作用于表面层，不降低正文和整个窗口的不透明度。
- 圆角只使用 `--radius-sm`、`--radius-tooltip`、`--radius-control`、`--radius-popover`、`--radius-panel`、`--radius-composer`、`--radius-pill`；按对象语义选择，不因局部观感增加相邻新值。
- 动效使用 `--motion-duration-tooltip/fast/control/layout` 与既有 easing。动效只解释状态变化或空间关系，不伪造进度；布局动效避免引起正文重排和滚动锚点跳跃。
- 所有非必要 animation/transition 必须提供 `@media (prefers-reduced-motion: reduce)` 的静态或近即时表现（项目检索关键字统一使用 `reduced-motion` 作为检查语义）。

## 5. 当前前端库

`src/renderer/src/components/` 当前只有以下公共能力；未列出的 feature UI 不属于共享库。

| 能力 | 当前边界 |
| --- | --- |
| `Icon` | 内联 SVG 图标集合，使用 `IconName` 限定名称、`currentColor` 和 `sm/control/lg` 三档语义尺寸。新增图标必须服务真实入口，不建立外部 icon registry。 |
| `IconButton` | 无文字图标按钮；强制 `label`，写入 `aria-label` 和 `data-tooltip`，并通过 `iconSize` 透传三档图标尺寸，默认 `type="button"`。有常驻文字或复杂内容时使用普通 button。 |
| `Select` | 已知有限选项的共享 listbox；支持分组、禁用、选中态、外点关闭以及 Arrow/Home/End/Enter/Space/Escape/Tab。模型级联菜单、slash 命令菜单等不同语义不得强塞进它。 |
| `FontSelect` | 系统字体专用的可搜索 listbox，支持 UI/code 预览、不可用当前值和键盘选择；不是通用 searchable select。 |
| `TooltipProvider` | 顶层统一 tooltip：读取 `data-tooltip`，hover 延迟、focus 立即显示，自动视口避让，Escape/滚动/缩放关闭，通过 portal 渲染并维护 `aria-describedby`。tooltip 只放补充说明，不能承载完成任务所必需的信息或操作。 |
| `useViewportPopoverPosition` | 为 portal popover 计算 fixed 定位、视口边距、上下翻转或左右级联、限宽限高，并监听 resize/scroll；它只解决定位，不替调用方实现焦点、外点、Escape、ARIA 或选择语义。 |

新代码优先复用上述真实边界；语义不相同时保留在 feature 内，避免为了表面样式相似制造万能组件。

`Select` 与 `FontSelect` 的触发器、popover、option、check 外观基线由 `selection-control.css` 共同拥有；搜索、字体预览、分组等语义仍由各自组件和专用样式拥有，不复制基础状态，也不抽成万能选择器。

## 6. Workbench 四区布局

当前 Workbench 使用四区：`Navigator / Header / Timeline / Composer`。

- Navigator 展示 Project 与所属 Session、选择态、真实运行摘要和已接通的行内操作。Project 行负责 Project 选择；Session 行打开对应 Conversation。Header 展示当前 Project、Session、Runtime 和进入正常布局流的诊断。
- Timeline 是可滚动正文区；Header 和 Composer 不得以未计入布局的浮层遮住消息。活动 run 与 settled 工作过程保持同一 turn group。长对话滚动时，Timeline 可在 Header 下粘着当前顶部阅读轮次的用户 prompt；原 prompt 仍可见时不重复展示，切换轮次时自动更新，长内容可展开，实际高度必须计入顶部安全区而不能覆盖正文。
- Composer 是底部输入与命令面，支持普通 prompt、运行中 follow-up/steer、slash、附件和 abort 的现有语义。
- Composer、队列面板和其他底部层的实际高度必须参与动态 clearance；通过测量后的 reserved space/offset 让 Timeline 末尾始终可见，不能依赖固定输入框高度猜测。
- 窄窗口优先保持主任务可用：Navigator 可按现有入口折叠；主区不得横向溢出；popover 依据 viewport 翻转并限宽限高；长标题、路径和选择值使用可控换行或 ellipsis。
- 设置页沿用 Navigator + 内容区结构。设置行在宽窗口采用左侧标签/说明、右侧紧凑控件；窄窗口改为上下排列，控件占可用宽度。只重排已接通设置，不补无后端语义的占位选项。

## 7. 交互与可访问性

- 每个交互控件都必须定义 hover、键盘 focus-visible、selected/expanded 和 disabled 状态；这些状态使用语义 token，并保证深浅主题可辨识。disabled 同时禁止动作，不能只降低透明度。
- 原生 button/input 优先。自定义 listbox/combobox/menu 必须提供匹配的 role、`aria-expanded`、`aria-controls`、选择/活动语义和完整键盘路径；打开后焦点进入有效目标，Escape 关闭并按语义恢复触发器焦点，Tab 不形成焦点陷阱。
- 只有 mouse hover 才出现的操作，也必须能在行内键盘聚焦时发现并执行；触控/键盘不能依赖 tooltip 才理解主要动作。
- 导航拖拽必须遵守 hit testing：Project / Session 只在主行主键按下后临时武装，`pointerup`、`pointercancel`、`dragend` 均解除；action slot 不得武装拖拽。隐藏层除 `opacity: 0` 外还要正确设置 `pointer-events: none`、禁止文本选择并核对 stacking order。排序只改变持久化顺序，不得改变活动身份或 Runtime ownership。
- portal 内容必须纳入外点判断、Escape 层级、焦点管理和视口变化处理；不能因为 DOM 脱离触发器就提前关闭或泄漏点击。
- reduced motion 偏好下，Session/thinking 等状态仍要通过形状、文字或静态颜色可理解，不能只靠旋转、呼吸或闪烁表达。
- tooltip 支持 hover 与 focus、使用 `role="tooltip"`/`aria-describedby`，并可用 Escape 关闭；按钮的 `aria-label` 不能由 tooltip 代替。

## 8. 内容安全与长对话性能

### 8.1 Markdown、附件与外链

- 正文与 thinking 使用同一 CommonMark/GFM 管线，禁用 raw HTML；任何长度的 streaming 与 settled 都保持 Markdown，不建立第二套 renderer 或纯文本 fallback。
- Markdown 图片不自动加载远程内容。外链只由用户点击触发，经受信 IPC sender 校验和 `http:`、`https:`、`mailto:` 白名单后交给系统打开；Renderer 不直接导航或任意打开 URL。
- 普通附件采用交互式 TUI 的 `@路径` 引用，GUI 不读取、复制或经 IPC/RPC 发送全文；Agent 通过 Pi 原生 `read` 按需读取。图片使用 Pi RPC 原生 `ImageContent`，遵守当前 2000×2000 与 4.5 MiB base64 边界。
- Renderer 不接受任意路径读取。系统选择由 Main 返回明确路径；拖放使用 Electron `webUtils.getPathForFile`；剪贴板/DOM File 只处理用户显式提供的内容。KernelState 与历史投影只含附件摘要，不含文件正文或图片 base64。

### 8.2 增量更新与 60 turn

- 高频 message/thinking/tool update 使用 `kernel.state-patched`：新增 entry 按 index 插入，append-only 文本和工具输出只传起始长度与后缀；无法证明是安全前缀增量时 Fail Fast 回退完整 `kernel.state-changed`。
- Renderer 按事件顺序应用 patch，每动画帧最多提交一次 React state；未变化 entry 保持对象 identity。附件变化不得误走纯文本 append patch。
- 流式 Markdown 复用稳定顶层块；16,384 字符只限制额外分块预解析，超限后仍由同一 React Markdown 管线整篇实时渲染。
- Timeline 初始只挂载最近 **60 turn** 的 settled 历史，用户每次再向前展开 60 轮并保持滚动锚点；折叠过程的 thinking、工具参数与输出只在展开时挂载。
- 用户离开底部后停止自动跟随；Project/Session identity 变化时重置对应 Timeline 局部状态，不复用上一 Conversation 的滚动、粘着 prompt 和 disclosure 状态。

## 9. 新组件进入库的证据门槛

组件进入 `components/` 必须满足以下至少一项：

1. 已有至少两个真实、独立调用点，并且交互、状态和可访问性语义一致；或
2. 存在明确的跨模块语义与唯一 ownership，把它放入共享库能消除实际重复或阻止依赖倒置。

单次功能、单消费者布局协议、feature 专用菜单、一次性格式化和视觉原子留在所属 feature。不得以“以后可能复用”、文件较长或 CSS 相似作为抽取证据。抽取后调用方应删除重复实现，不长期保留两条路径。

## 10. 最小验证

常规前端修改的最小验证为：

```bash
pnpm typecheck
pnpm build
git diff --check
```

按风险补充已有定向测试即可；除非变更本身需要真实运行证据或用户明确要求，不要求启动应用或截图。
