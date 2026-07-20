# P1 架构

## 唯一运行拓扑

```text
Electron Renderer
    -> typed preload IPC
Workbench Kernel (Electron Main)
    -> RuntimeHost
LinuxLocalRuntime
    -> PiRpcClient / strict LF JSONL
pi --mode rpc
```

P1 不建立 GUI server、WebSocket、SQLite、launcher/mirror 或直接 Pi SDK 的第二条主路径。

## 所有权

| 组件 | 唯一职责 | 明确不拥有 |
| --- | --- | --- |
| Electron Renderer | 展示 normalized state；发出 typed command | 子进程、文件系统、raw Pi event |
| Preload | 暴露窄的 typed IPC API | 业务状态、Pi 协议 |
| Workbench Kernel | Project、Runtime、Session、Conversation 的 GUI identity 与状态转换 | Linux spawn 细节、JSONL framing |
| LinuxLocalRuntime | executable、cwd、spawn、signal 和退出语义 | renderer 状态、Pi message 解释 |
| PiRpcClient | LF JSONL framing、request/response correlation、RPC 事件接收 | GUI identity、重启策略 |

Electron Main 是唯一 control plane 和 Pi 子进程 owner。Renderer 不启动进程、不读取 Pi stdout，也不解析 raw Pi event。

## RuntimeHost 最小接口

P1 只实现实际使用的五项能力：

```text
start
send
stop
getState
subscribe
```

出现第二个真实后端之前，不增加注册中心、插件发现或 transport 抽象。

## 状态来源

| 状态 | 事实来源 | 持久化位置 |
| --- | --- | --- |
| Conversation 内容 | Pi session 文件 | 由 Pi 管理 |
| Pi credential/provider auth | Pi | GUI 不读取或复制 |
| Project 设置与信任选择 | Workbench Kernel | XDG config |
| 最近 session 指针与非敏感启动证据 | Workbench Kernel | XDG state |
| Runtime 瞬时状态 | Workbench Kernel | 仅内存 |

GUI 不建立 Conversation 数据库，也不把 renderer 投影当作对话事实来源。

## Runtime 状态机

```text
stopped -> starting -> ready -> running -> ready -> stopping -> stopped
任何运行状态 -> crashed -> 用户显式 restart -> starting -> resume session
```

状态变化只有 Workbench Kernel 一个 owner。Pi 非正常退出必须进入 `crashed`；不自动无限重启。完整一轮以 `agent_settled` 为稳定点，不把中间的 retry、compaction 或 continuation 误判为结束。

## 安全边界

- Pi 使用参数数组、`shell: false` 和显式 cwd 启动。
- stdout 只承载 strict LF JSONL；stderr 单独诊断，不能污染 framing。
- 诊断默认不记录完整 prompt、tool output、环境变量或 credential。
- Linux PATH、XDG、进程和权限逻辑只能存在于 runtime/main 边界，不进入 renderer 或会话模型。
