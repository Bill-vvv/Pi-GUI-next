# OMP 多 Advisor 系统设计

> 状态：Retired；用户级 Package 已卸载，GUI 控制面已移除，仅保留历史 advisory 只读兼容
> 原目标 Slice：S18 — OMP 多 Advisor Extension 与 GUI 适配
> 最后更新：2026-07-28

## 1. 文档用途

本文固定 Pi GUI 复刻 Oh My Pi（OMP）多 Advisor 系统时的产品目标、事实来源、
运行边界、GUI 适配方式和分阶段验收。本文所称“OMP Advisor”指
[Oh My Pi](https://github.com/can1357/oh-my-pi) 的 Advisor / Watchdog 能力，
不宣称它是 OpenAI 产品内置功能。

本文同时记录已经落地的 S18-1 Package 基线与 S18-2 GUI 投影/控制；多 roster、
韧性与可观测性仍只作为后续阶段目标，不提前展示入口。

## 2. 参考基线与复刻口径

行为基线固定为 OMP commit
[`667111575ebba136dadfd6989379e7f67e0d40d9`](https://github.com/can1357/oh-my-pi/tree/667111575ebba136dadfd6989379e7f67e0d40d9)
及其
[`advisor-watchdog.md`](https://github.com/can1357/oh-my-pi/blob/667111575ebba136dadfd6989379e7f67e0d40d9/docs/advisor-watchdog.md)。
实现阶段如需改用更新基线，必须重新审计并追加 ADR，不能静默追随上游。

“复刻”采用以下口径：

- 对齐用户可感知的多 Advisor 行为、配置模型、交付语义和可观测性。
- 复用固定 Pi 0.80.10 的 Package、Extension、Session、Provider、工具和认证能力。
- 不复制 OMP 的完整 coding-agent Runtime，也不把 OMP executable 作为第二后端。
- OMP 源码采用 MIT License；如果实现移植了源码而不只是行为，需要保留许可证和来源说明。

现有 [`pi-omplike-advisor`](https://github.com/pasky/pi-omplike-advisor)
证明 Pi Extension 内可以运行一个具备独立上下文、只读工具和 `advise` 输出的 Advisor，
但它当前是单 Advisor，不提供完整 WATCHDOG roster、严重度交付、状态矩阵和 GUI 协议。
它只作为实现参考，不直接等同于 S18 目标。

## 3. 产品目标

完成后的系统应当具备：

1. 主 Agent 每轮运行后，由一个或多个已启用 Advisor 独立审阅新增对话与工具过程。
2. 每个 Advisor 拥有独立模型、thinking、上下文、工具范围、指令、健康状态和用量。
3. Advisor 通过 `nit`、`concern`、`blocker` 三种严重度给出建议；建议是供主 Agent
   权衡的 advisory，不是自动审批或无条件覆盖主 Agent。
4. 用户级与 Project 级 `WATCHDOG.yml` 组成可发现、可覆盖的 Advisor roster；
   `WATCHDOG.md` 提供项目指导。
5. GUI 在对话时间线中显示结构化 Advisor 卡片，并在专页提供系统状态、roster 配置和
   每个 Advisor 的运行信息。
6. Advisor 的失败、配额耗尽或无可用模型不会伪装成正常，也不会破坏主 Agent 已完成的回答。
7. Package、Extension resource、Advisor 系统和单个 Advisor 的状态彼此可区分、可解释。

## 4. 运行拓扑与所有权

```text
Electron Renderer
    -> typed preload IPC
Workbench Kernel (Electron Main)
    -> Pi RPC process
       -> fixed Multi Advisor Pi Extension
          -> Advisor runtime A
          -> Advisor runtime B
          -> Advisor runtime N
```

- 多 Advisor 的模型调用、上下文、工具、重试、压缩和 transcript 都由固定 Pi Extension
  在 Pi 进程内拥有。
- Electron Main 继续只拥有 Pi 子进程 lifecycle、固定路径配置适配、严格事件归一化和
  Renderer control plane。
- Electron Main 不嵌入第二套 `AgentSession`，不直接调用 Advisor 模型，也不维护
  Advisor prompt、上下文或调度器。
- Renderer 不解析 raw Pi event、raw custom message 或 YAML，不获得任意文件访问能力。
- Extension 必须能脱离 Pi GUI 被 Pi 手动加载；GUI 适配不能成为它运行的前置条件。

Extension 是第二个真实发布边界。S18-1 已固定 Package 名称为
`pi-gui-multi-advisor`，源码位于 `extensions/pi-gui-multi-advisor/`，由 Pi 直接加载
`src/index.ts`。它与主应用共仓但保持独立 `package.json`，当前不把主应用改成 workspace；
发布前再使用同一 Package manifest 生成 npm 分发物。S18-2 的拓展页只识别已经存在的
bare、npm 或 local PackageSource，并提供真实 Extension resource 开关；未安装时只给出
手动安装说明，不添加无法执行的假安装动作。

## 5. 四种状态与三层开关

| 层级 | 含义 | 唯一入口 | 生效语义 |
| --- | --- | --- | --- |
| Package installed | Advisor Package 已由 Pi 安装 | Package / 拓展管理 | 安装或卸载整个分发单位 |
| Extension resource enabled | Advisor Extension 代码是否由 Pi 加载 | 拓展页“已适配拓展” | 保留 Package，仅修改 Pi PackageSource resource filter；新建或显式 reload 后生效 |
| Advisor system enabled | 已加载 Extension 是否为当前 Session 运行 Advisor | Advisor 专页或真实 `/advisor on/off` | 只有 Extension 明确声明 live control 时才即时生效，否则提示 reload |
| Advisor enabled | roster 中某个 Advisor 是否参与后续审阅 | Advisor 专页 | 首版保存配置后由新建或显式 reload 使用 |

拓展页是 Package 安装与 Extension resource 总开关的唯一入口。Advisor 专页不得重复安装或
加载开关；Extension 未安装或未加载时，专页只显示真实状态、禁用运行配置并指向拓展页。

“关闭 Extension”与“暂停 Advisor 系统”必须使用不同文案。前者阻止代码加载，后者保留
Extension 与配置，只停止 Advisor 审阅。任何设置变化都不得静默重启正在运行的 Session。

## 6. 事实来源与持久化

| 数据 | 事实来源 | GUI 职责 |
| --- | --- | --- |
| Package 安装与 Extension resource filter | Pi 用户 `settings.json` `packages` | 读取真实状态并调用现有 Pi Package 能力 |
| Advisor 系统启用状态 | `PI_CODING_AGENT_DIR/pi-gui-multi-advisor.json` strict v1 state | `/advisor on/off/status` 与后续 GUI typed control 共用；不复制进 GUI XDG |
| Advisor roster 与共享指令 | 用户级 / Project 级 `WATCHDOG.yml` | Main 只对固定发现路径提供 typed CRUD |
| Project 指导 | 发现链中的 `WATCHDOG.md` | Main 只返回来源和规范化摘要；正文编辑是否接入由独立阶段决定 |
| 模型与 credential | Pi Provider / auth | GUI 复用现有模型目录；不读取 secret |
| Advisor live status、health、usage、context | Extension live state | Kernel 内存投影，不写 GUI 数据库 |
| Advisory message | Pi Session 中的 versioned custom entry | 历史和实时走同一严格归一化路径 |
| Advisor transcript | Extension 管理的 Advisor artifact | GUI 不复制；只有显式 dump 才读取或导出 |

状态文件缺失表示关闭；未知 version、额外字段或非法值 Fail Fast。保存使用同目录临时文件与
原子 rename，失败时不先改变内存状态。GUI 后续只通过已验证的 Extension control/capability
读取与修改，不在 XDG config 建立镜像。

## 7. WATCHDOG 配置

### 7.1 发现与合并

冻结语义与 OMP commit `667111575ebba136dadfd6989379e7f67e0d40d9` 对齐：

1. 用户级读取 Agent dir 下的 `WATCHDOG.yml` / `WATCHDOG.yaml`。
2. Project 级从 cwd 向 Git root（无 Git 时向 home）遍历，同时探测每层根目录与
   `.omp/` 下的 `WATCHDOG.yml` / `WATCHDOG.yaml` / `WATCHDOG.md`。
3. 合并顺序固定为用户级、Project 祖先到叶子；后出现的同 slug Advisor 整项替换前项，
   顶层 `instructions` 按该顺序连接，指令支持 OMP `@import` 展开。
4. slug 由 name 小写、非字母数字串折叠为 `-`、裁掉首尾 `-`；空结果回退为 `advisor`。
5. 非法 YAML/schema 产生明确诊断并跳过该文件，不终止 Session；GUI 必须展示诊断，
   不能把被跳过的内容表现为保存成功。

GUI 首版只编辑用户 Agent dir 与 canonical Project 根目录的文件；遍历发现的其他继承文件
显示来源但保持只读，避免 Renderer 获得任意祖先路径写入能力。S18-3 已在 Extension
实现该发现/合并，并由 Main 以 YAML AST 保存用户级与 canonical Project 根配置；未知合法
字段和注释保持不变，alias、自定义 tag、双扩展歧义或不安全结构 Fail Fast。

### 7.2 目标规范化字段

| 字段 | 含义 |
| --- | --- |
| `slug` | 稳定 identity；重命名显示名称不改变历史归属 |
| `name` | GUI 与 Timeline 展示名称 |
| `enabled` | 是否参与后续审阅 |
| `model` | Pi 可用 Provider / model selector，可带 OMP `:thinking` suffix |
| `thinking` | 该模型真实支持的 thinking level |
| `tools` | Advisor 可调用的工具集合 |
| `instructions` | 单 Advisor 指令 |
| shared instructions | roster 共享的审阅目标与输出约束 |

### 7.3 模型策略

- S18-1 的单 Advisor 默认使用当前主会话 Provider 中的 `gpt-5.6-sol`，thinking 固定为
  `medium`。它复用 Pi ModelRegistry 的模型与认证事实，但不复用主 Agent 当前选中的模型。
- 当前 Provider 不提供 `gpt-5.6-sol`、模型不支持 reasoning 或认证不可用时，Advisor 明确
  进入暂停状态；不静默回退到主模型、`terra` 或弱模型。
- S18-3 的 Advisor 专页允许逐项选择 Pi 目录模型，并提供 `gpt-5.6-terra` 与“跟随主模型”
  作为显式选项；选择结果进入 WATCHDOG roster，不建立 GUI 私有模型配置。
- 后续运行策略以 `terra + medium` 作为常驻审查候选，以 `sol + high` 作为高风险升级审查
  候选；是否自动升级必须在有真实成本、质量和状态证据后另行决策，S18-1 不预实现。

默认工具固定为 `read`、`grep`、`find`、`ls`。D-041 完成副作用工具审计后，S18-3 允许在
单个 Advisor 的 WATCHDOG 定义中显式增加 `edit` / `write`；GUI 必须持续提示这些工具由
独立 Advisor 直接执行，不经过主 Agent 审批。原生 `bash`、browser 和任意 Extension tool
仍不开放；Pi 0.80.10 的公开 Shell 工具没有命令级 allowlist / sandbox / primary approval
回调。Project 未受信任时，Extension 只加载用户级 WATCHDOG。

保存受管字段时，Main 必须保留 GUI 未管理的合法 YAML 字段；如果无法安全 round-trip，
应 Fail Fast 并要求用户手动处理，不能重写或吞掉未知配置。

## 8. 每轮运行与交付语义

### 8.1 输入

每个 Advisor 只消费上次已确认位置之后的 transcript delta，内容可包括：

- user / assistant 新消息；
- assistant thinking 或 commentary；
- 工具调用意图、参数、结果和错误；
- 主 Agent 本轮展开获得的上下文；
- 必要的 Session identity 与上下文占用信息。

Advisor 必须过滤自身和其他 Advisor 已写入的 advisory，避免互相递归审阅。发送给模型前执行
secret obfuscation；工具输出和不可信项目内容按数据而非高优先级指令处理。

### 8.2 严重度

| 严重度 | 默认交付 |
| --- | --- |
| `nit` | 低打扰 aside；不改变主 Agent 当前路线 |
| `concern` | 下一安全边界 steer；如果主 Agent 已终止则保留为该轮建议 |
| `blocker` | 高优先级；允许在主 Agent 已终止后仍追加可见建议，但不自动执行修改 |

每条建议必须带固定语义：这是需要权衡的建议，不应盲目遵从。Advisor 只能通过结构化
`advise` 工具产生建议；普通文本、思考过程或工具输出不得直接进入主对话。

### 8.3 上下文与可靠性

目标能力包括：

- Advisor system 默认关闭；Advisor subagents 默认关闭。
- 每个 Advisor 独立 maintain、promote、compact、reprime。
- `immuneTurns` 默认 3，用于防止建议刚交付就被自身上下文策略反复放大。
- `syncBacklog` 默认关闭，只允许 1/3/5 等有界档位；单次追赶最多 30 秒，不形成无限积压。
- 内容为空、重复、超出单次 emission 限额的建议被 emission guard 拒绝。
- 临时错误有界重试；quota、no-model 和持久错误进入明确暂停状态。
- Advisor 输出先进入 quarantine/校验，再成为 Session advisory。
- 每个 Advisor 使用独立 transcript artifact，文件名可稳定关联 slug。

## 9. Extension 与 GUI 的 typed 协议

### 9.1 能力握手

Extension 必须暴露带 schema version 的 capability，至少说明：

- Extension identity 与版本；
- protocol version；
- multi-advisor、live toggle、roster、status、usage、dump、subagents 等能力是否可用；
- 支持的严重度、delivery 和只读工具集合。

Main 只适配明确支持的 protocol version。缺少握手、版本未知或字段非法时显示
“已安装但 GUI 适配不可用”，不能把未知事件当成普通消息透传。

### 9.2 规范化事件

逻辑事件至少包括：

```text
advisor.capabilities
advisor.roster
advisor.status
advisor.advisory
advisor.usage
advisor.notice
```

S18-3 将 capability 升级为 protocol v2，严格声明 multi-advisor、roster、四个默认只读工具
与两个可选写工具；历史 protocol v1 advisory 和新的 v2 advisory 因字段形状相同，继续共用
同一个 strict projector。配置通过固定 typed IPC 读写 WATCHDOG，不透传 raw YAML。当前
capability 已将 `usage` 置为 true；每次 review 通过 Pi shared event bus 发布版本化的
`pi-gui.multi-advisor/usage`，只含 Advisor/model identity、结果、耗时、token/cache/reasoning
和 provider-reported cost，不含 prompt、transcript、advice 或 tool output。该事件不持久化到
Session，也尚未进入 Renderer；当前没有常驻调试聚合器，只有未来接入正式 GUI 可观测性时
才消费该旁路事件。status/notice 同样不会提前进入 Renderer。其中 advisory 投影只保留：

```text
id
advisorSlug
advisorName
severity
guidance
content
delivery
timestamp
turnIdentity
```

所有字段由 Main 校验长度、枚举和 identity 后，转换为 `KernelAdvisorEntry`。Renderer
不得接收 Extension 原始 payload。历史 `get_messages` 与实时事件使用同一个 projector；
advisory 插入对应 turn group，并遵守现有 patch 顺序、60 轮渐进挂载和 Session identity。

### 9.3 控制命令

GUI 只增加已经有真实 Extension handler 的窄命令，例如：

```text
kernel.get-advisor-state
kernel.set-advisor-system-enabled
kernel.reload-advisor-config
kernel.dump-advisor
```

Main 可以把这些命令映射到经过 capability 验证的 Extension command，但不得建立
“执行任意 Extension command”或“发送任意 custom RPC”IPC。单 Advisor 配置首版通过
固定 `WATCHDOG.yml` 保存和显式 reload 生效，不伪造热更新。

Extension 自身同时保留可脱离 GUI 使用的 `/advisor on`、`/advisor off`、
`/advisor status`、`/advisor dump [raw]` 和 `/advisor configure`；GUI 对应动作必须复用
同一 handler 或事实来源，不能形成一套命令状态和一套界面状态。

## 10. GUI 特别适配

### 10.1 拓展页

- 在“已适配拓展”区域加入固定 Advisor 项。
- 唯一承载 Extension resource 开关；当前 local Package 尚无 GUI 安装动作，未安装时明确
  指向手动安装。
- Package version 与 protocol 兼容状态由当前 Session 的 capability 握手进入 Advisor 页，
  不从 PackageSource 推断。
- 关闭时明确说明 Package 保留、已有 Session 不被静默重启。
- 不扩展为通用 GUI adapter registry。

### 10.2 Advisor 专页

- S18-2 首版只展示 protocol 兼容状态、Extension version、当前 Session 的 Advisor system
  总开关和配置生效提示。
- S18-3 已扩展为用户级 / Project 级 roster，并明确每项最终来源与覆盖关系。
- 编辑 name、enabled、model、thinking、固定 tools 与单 Advisor instructions；shared
  instructions 与 `WATCHDOG.md` 当前显示来源和摘要，正文仍由文件维护。
- 展示每个 Advisor 的 running、paused、quota exhausted、error、no model 等真实状态；
  只有 Extension 提供时才展示 usage、cost、context 和 backlog。
- 状态、配置和说明使用同一设置页 token、行模式、`Select`、tooltip 和响应式边界，
  不建立第二套视觉系统。

### 10.3 Conversation Timeline

- Advisory 是新的 normalized conversation entry，不伪装成 Assistant 回答、thinking 或 error。
- 卡片展示 Advisor identity、严重度、正文和交付方式；默认层级低于最终回答，
  `blocker` 可以提高强调度，但不能遮挡或改写主回答。
- 同一轮多个 Advisor 建议按真实时间排序；不合并不同 identity，也不伪造共识。
- 历史恢复与实时到达视觉一致；切换 Session 后不得复用上一 Session 的展开或状态。

## 11. 安全与失败边界

- 第三方代码安装和 Extension 加载始终由用户显式操作。
- GUI 不自动安装、自动开启、自动 reload 或自动批准工具权限。
- Advisor 默认只读；扩大工具范围必须单独决策并显示真实风险。
- Advisor 不获得 Pi credential 原文，GUI 也不代理或记录 credential。
- Main 固定 WATCHDOG 发现路径、canonical Project 和 schema；Renderer 无任意路径能力。
- advisory、状态和错误都限制字段与长度；未知 custom message 不进入 Timeline。
- Advisor 失败不能令主 Runtime 进入假 `crashed`，但必须在 Advisor 状态中可见。
- 日志和发布证据不记录完整 prompt、工具输出、Advisor transcript 或 secret。

## 12. 分阶段实施

| 阶段 | 目标 | 出口 |
| --- | --- | --- |
| S18-1 协议与单 Advisor 基线 | 审计固定 Pi 0.80.10 Extension API；冻结 Package、WATCHDOG schema、capability 和 advisory transport；实现一个默认关闭、只读、使用 `gpt-5.6-sol + medium` 的独立上下文 Advisor | 手动安装/启用后可在真实 Pi turn 后生成一条经 schema 校验的 advisory；目标模型不可用时明确暂停；关闭后不运行 |
| S18-2 GUI 投影与控制 | Main 严格归一化历史/实时 advisory；增加 typed control、拓展页适配项、最小 Advisor 状态页和 Timeline Advisor 卡片 | `Complete`：历史与实时共用 strict projector；capability、Extension resource 与 live system 状态分离；Renderer 不接触 raw event |
| S18-3 多 Advisor roster | `Complete`：实现 WATCHDOG 发现/合并、多个隔离 Advisor、protocol v2 与 Advisor 专页 typed CRUD | 用户级与 Project 级覆盖可解释；单项启停、模型、thinking、固定 tools 和指令在 reload 后真实生效；`edit/write` 显式授权，`bash` 不开放 |
| S18-4 交付与韧性 | 实现 nit/concern/blocker、immune turns、有界 backlog、上下文维护、dedupe、quarantine、重试与错误/配额状态 | 多 Advisor 并行时无递归建议、无限积压或重复 emission；主 Agent 失败边界独立 |
| S18-5 可观测性与发布 | 接入 status、usage/cost/context、dump、独立 transcript 和可选 Advisor subagents；完成打包验证与来源声明 | 只有真实能力可见；AppImage 核心链路和多 Advisor 链路通过脱敏验证 |

每个阶段完成真实 typed 链路后再显示对应 GUI。S18-5 的 Advisor subagents 只有在 Pi 公开
Extension API 能保持独立预算、深度和权限边界时才实施；缺少证据时保持未提供，不做 fallback。

## 13. 明确不做

- 不将 OMP executable 或 coding-agent Runtime 作为第二主后端。
- 不在 Electron Main 中实现 Advisor 模型调度器或第二套 Agent Session。
- 不建立 Conversation、Advisor transcript、模型或 usage 的 GUI 数据库。
- 不创建通用 Package adapter registry、raw Extension event bus 或任意命令 IPC。
- 不默认开放写入、Shell、浏览器或自动批准能力。
- 不把 Package 安装、Extension 加载和 Advisor 暂停合并成一个含糊开关。
- 不为了兼容未知 OMP/Pi 版本加入静默 fallback；固定基线不满足时 Fail Fast。

## 14. S18-1 完成证据与下一步

已经冻结：

1. Pi 0.80.10 Package root 的公开 `Agent`、`createReadOnlyTools`、`turn_end`、
   `sendMessage`、`appendEntry`、command 与 renderer 足以实现基线，不使用 private deep import。
2. WATCHDOG 精确 schema、slug、发现与覆盖规则按冻结 OMP commit 记录，并以 JSON schema
   随 Package 发布。
3. Package 固定为 `pi-gui-multi-advisor` 0.1.0，共仓独立 manifest，首期通过 local
   PackageSource 手动安装。
4. system enabled 唯一事实固定为 Agent dir 下 strict v1 state；默认关闭，命令可 live toggle。
5. protocol v1 使用 capability custom entry 和 advisory custom message；advisory 包含
   identity、severity、guidance、真实 `aside|steer` delivery 与 timestamp。
6. 单 Advisor 默认模型固定为当前 Provider 中的 `gpt-5.6-sol`，thinking 为 `medium`；
   模型、reasoning 或 auth 不满足时明确暂停且不做静默 fallback。

已通过 7 项纯逻辑测试、独立 TypeScript 校验、npm pack dry-run，以及隔离
`PI_CODING_AGENT_DIR` 的 Pi 0.80.10 本地安装、Extension 加载、`/advisor` command 和
capability 探针。

真实 Provider 验收使用 `vvqq-cpa/gpt-5.6-terra + low` 作为 primary、使用
`vvqq-cpa/gpt-5.6-sol + medium` 作为独立 Advisor。Advisor 对路径安全边界方案产生一条
`blocker`，指出校验与实际访问之间的 TOCTOU / 符号链接逃逸风险；protocol v1 advisory 在
实时 RPC 中可见，并在临时 Pi Session JSONL 中出现一次。Pi 正常退出、stderr 为 0，临时
Agent dir 与 Session 已清理，默认用户开关和既有 Session 未修改。S18-1 因而完成，下一步
进入 S18-2 GUI 投影与控制。

S18-2 以固定 protocol v1 完成 GUI 接入：Pi RPC 对固定 GUI adapter custom entry 使用
allowlist，其中为 `pi-gui.multi-advisor/capabilities` 保留 capability 数据，非 allowlist
custom entry payload 继续被剥离；Kernel 把 capability 归一化为
unavailable / ready / incompatible 状态，把历史
与实时 advisory 归一化为 `KernelAdvisorEntry`。拓展页只控制已安装 Package 的 Extension
resource，Advisor 页只控制当前 ready Session 的 `/advisor on|off`，并在命令后重新读取
capability 确认状态。Timeline 卡片留在对应 turn 中，显示名称、严重度、正文和 guidance，
未知或非法 custom message 不进入 Renderer。151 项后端定向测试、`pnpm typecheck`、
生产 build 与 diff check 通过；S18-2 完成。

S18-3 将 Package 升级为 0.2.0 / protocol v2。Extension 读取用户 Agent dir 与受信任
Project 的 `WATCHDOG.md` / `WATCHDOG.yml` / `WATCHDOG.yaml`，按 user、祖先到叶子顺序合并，
同 slug 整项覆盖，shared instructions 顺序连接并有界展开 `@` import；内建 Default Advisor
始终作为第一层，可被同 slug 定义覆盖或停用。每个 enabled slug 拥有独立 `Agent`、一项
有界队列和 emission guard。Main 通过固定 user / canonical Project 路径提供 typed
list/save/remove，使用 YAML AST 保留注释和 GUI 未管理字段；Renderer 只接收规范化 roster、
来源和诊断。模型支持跟随 Primary 或 Pi 目录中的 `provider/model`，thinking 支持继承或七档。
工具默认 `read/grep/find/ls`，仅显式配置可增加 `edit/write`，原生 `bash` 不开放。配置在
新建或显式 reload Session 后生效。285 项 core tests、15 项 Extension tests、
`pnpm typecheck`、生产 build、diff check 与 npm pack dry-run 通过；S18-4 下一步处理更完整的
交付、backlog、重试与健康状态。

S18-5 的第一条调试遥测生产端已局部接通：protocol v2 `usage:true`，每个 Advisor review
发布 prompt-free realtime usage event。临时项目级聚合探针已在完成链路验证后移除；完整 GUI
usage/context/backlog 投影、dump、独立 transcript、发布与 AppImage 验证仍未完成，因此
S18-5 整体继续保持 Pending。
