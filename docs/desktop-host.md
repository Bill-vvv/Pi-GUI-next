# Desktop Host over SSH（P4-1）

> 当前状态：P4-1 Linux Host 协议与设置入口已完成并通过独立安全 closure；P4-2A 首轮安全 findings 已修复并通过正式 gate，当前等待独立 closure，通过前不能进入 P4-2B；P4-3 真实 Windows gate 前不能宣称 Windows 已受支持。

## 定位

Desktop Host 是 Pi GUI 完整桌面客户端使用的 loopback-only 远程入口：

```text
Windows Pi GUI Main（后续 P4-2）
    -> system OpenSSH local port forward
Linux 127.0.0.1:<port>
    -> Desktop Host Gateway
    -> same WorkbenchKernel / Pi Runtime
```

它与 [`remote-access.md`](remote-access.md) 的 Web Remote 是同一产品下的两个独立入口：

- Desktop Host 不托管 `out/remote`，不嵌入 Web Remote UI。
- Desktop Host 不接受 Public Origin、Trusted Proxy 或浏览器 Cookie。
- Desktop Host 只监听精确 `127.0.0.1`，不得映射到 LAN 或 WAN。
- SSH 负责主机身份、Linux 用户认证、加密与 `ProxyJump`；Pi GUI 仍通过一次性配对码签发独立桌面设备凭证。
- Linux Main / WorkbenchKernel 始终是唯一 control plane；客户端不得创建第二 Kernel。

## 启用条件

Desktop Host 默认关闭。只有同时设置以下变量时才启动：

| 变量 | 含义 |
| --- | --- |
| `PI_GUI_DESKTOP_HOST_ENABLED=1` | 显式启用 Desktop Host |
| `PI_GUI_DESKTOP_HOST_PORT` | Linux loopback 监听端口，例如 `18788` |
| `PI_GUI_DESKTOP_HOST_TOKEN_FILE` | Main 内部机器密钥；绝对路径、本人所有、常规非 symlink、严格 `0600`、单行 32–4096 字符 |
| `PI_GUI_BUILD_COMMIT` | Host 构建标识；未提供时 Host 可启动并报告 `null`，但 P4-2 Windows client 必须拒绝连接，只有双方非空且完全一致时才进入设备凭证流程 |

绑定地址不是配置项，固定为 `127.0.0.1`。设备记录写入 `${PI_GUI_DESKTOP_HOST_TOKEN_FILE}.desktop-device`，只保存桌面设备凭证的 SHA-256 哈希与配对/到期时间；原始凭证只在首次配对响应中返回。

任一启用配置或文件权限非法时 Main 必须 Fail Fast，不得改绑 wildcard、退回 Web Remote 或跳过设备认证。

## 创建机器密钥与环境文件

```bash
install -d -m 700 "$HOME/.config/pi-gui-next"
umask 077
node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex') + '\n')" \
  > "$HOME/.config/pi-gui-next/desktop-host.token"
chmod 600 "$HOME/.config/pi-gui-next/desktop-host.token"

cat > "$HOME/.config/pi-gui-next/desktop-host.env" <<'EOF'
PI_GUI_DESKTOP_HOST_ENABLED=1
PI_GUI_DESKTOP_HOST_PORT=18788
PI_GUI_DESKTOP_HOST_TOKEN_FILE=/home/REPLACE_ME/.config/pi-gui-next/desktop-host.token
EOF
chmod 600 "$HOME/.config/pi-gui-next/desktop-host.env"
```

将 `REPLACE_ME` 替换为实际 Linux 用户名。环境文件只引用机器密钥路径，不包含密钥正文。

完整退出 Pi GUI 后，在启动 GUI 的同一 shell 中加载：

```bash
set -a
source "$HOME/.config/pi-gui-next/desktop-host.env"
set +a
pnpm dev
```

设置页 **远程访问 → Desktop Host（SSH）** 应显示 `已启用` 和 loopback 端点。Main/shared/remote 或环境变化后必须完整重启 Electron Main，不能依赖 Renderer HMR。

## SSH 隧道

Windows 后续客户端将使用用户现有 OpenSSH host alias。等价命令为：

```bash
ssh -N -T \
  -o BatchMode=yes \
  -o ExitOnForwardFailure=yes \
  -o ConnectTimeout=10 \
  -o ConnectionAttempts=1 \
  -o ServerAliveInterval=15 \
  -o ServerAliveCountMax=3 \
  -L 127.0.0.1:18788:127.0.0.1:18788 \
  pi-linux
```

`pi-linux` 应由用户自己的 `~/.ssh/config` 定义。Desktop Host 不管理 SSH 密码，不关闭 Host Key 校验，也不解析 `ProxyJump`；这些都由系统 OpenSSH 负责。P4-2A 客户端启动前使用有界 `ssh -G <alias>` 检查 resolved config，并在 alias 已定义额外 LocalForward、RemoteForward 或 DynamicForward 时 Fail Fast，避免 `-N` 会话意外承载其他转发。

## 配对与设备凭证

1. SSH 进程成功启动后，Windows client 必须先不携带设备凭证请求握手，并要求 protocol、product version 与非空 build commit 完全一致。
2. 兼容性通过后，才可在 Linux Pi GUI 设置页生成并由 Windows client 提交 6 位桌面配对码；client 在握手前必须本地拒绝配对。
3. 配对请求再次携带预期 product/build，Host 必须在替换已有设备前复核，避免 Host 重启或版本变化后先撤销旧设备再由 client 报 mismatch。配对码 5 分钟、一次有效；重新生成替代旧码，连续错误和每分钟尝试均有界。
4. `POST /api/desktop-host/pair` 成功后只返回一次高熵桌面设备凭证。
5. 后续客户端通过 `Authorization: Bearer <credential>` 认证；不得把凭证放入 URL、Renderer、日志或浏览器存储。已有凭证也只能在新隧道完成无凭证兼容性握手后装载进 client。
6. Linux 设置页撤销设备或客户端 logout 后，凭证和活动 SSE 立即失效。
7. 当前只记住一个 Windows Desktop 设备；Web Remote 手机设备存储独立，双方不会互相替换。

正式 Windows 客户端必须把原始凭证保存在 Windows Credential Manager。P4-2A 的 `src/main/remote/desktop-host-client.ts` 只实现进程内凭证与 Host transport，尚未接入 Windows Main，也不写文件、环境变量或 Renderer；持久化属于 P4-2C。

## 协议与控制权

握手 `GET /api/desktop-host/session` 返回：

- Desktop Host protocol version；
- Pi GUI product version；
- build commit 或 `null`；
- 当前认证状态；
- Host 明确允许的 Kernel command types。

首版客户端必须要求 protocol version、product version 和非空 build commit 完全一致，不猜测兼容或自动降级。JSON/SSE 的大小、UTF-8、versioned envelope 与 discriminator 在 client 边界校验；握手通过后，Kernel DTO 内部结构作为同 build shared contract 使用，不在 transport 中复制第二套完整 Kernel schema validator。

认证后的 API 为：

- `GET /api/desktop-host/events`：SSE KernelEvent；
- `GET /api/desktop-host/state`：权威 KernelSnapshot；
- `POST /api/desktop-host/command`：allowlist 内的 typed KernelCommand；
- `POST /api/desktop-host/logout`：撤销当前桌面设备。

客户端先以随机 UUID 放入 `X-Pi-Gui-Controller-Id` 并建立 SSE。Host 同一时刻只接受一个活动 controller；没有活动事件流、controller identity 缺失或另一 controller 已占用时，state/command 必须明确拒绝。每个 command 还必须携带客户端当前观察到的 `projectKey + sessionKey` control identity；Host 在 policy、dispatch 和异步准备边界重复核对，Linux 本地状态变化后以 typed `409 conflict` 拒绝 stale command，不能让旧 `steer`、`follow-up`、`abort` 或设置命令落入另一 Session。断线后客户端应先重建事件流并获取 snapshot，不自动重放未确认 mutation。

## 当前命令边界

P4-1 暂时沿用既有受限核心命令集合：Project/Session 激活、Conversation 分页与图片读取、Prompt/Ask/Steer/Follow-up/Abort、模型与 Thinking 设置。附件、Task workspace、Git、Provider、Package、设置、原生路径、任意 Shell 和文件上传仍不经 Desktop Host 暴露。

后续能力只能通过 shared contract、Host allowlist、Windows client 和同 commit 测试一起增加；完整桌面界面存在不代表所有本地功能自动成为远程功能。

## 明确不做

- LAN/WAN 直接监听或端口映射。
- 云端 relay、账户体系或自动主机发现。
- Web Remote Cookie/Origin/Trusted Proxy 兼容分支。
- SSH 密码保存、自动接受 Host Key 或关闭 SSH 检查。
- Windows 本地 Pi、路径翻译、文件同步或多 Host。
- 网络失败后的 mutation 自动重试。

## 相关文档

- 产品边界：[`product-boundary.md`](product-boundary.md)
- 架构：[`architecture.md`](architecture.md)
- 决策：[`decisions.md`](decisions.md)（D-067）
- Web Remote：[`remote-access.md`](remote-access.md)
- Shared contract：[`../src/shared/desktop-host-contract.ts`](../src/shared/desktop-host-contract.ts)
