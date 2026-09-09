# 私有远程访问（Remote v2）

> 适用：可选的个人远程呈现面。默认关闭，不是第二 control plane，也不是公网多用户服务。

## 定位

Remote v2 在**同一 Electron Main / 同一 WorkbenchKernel** 上增加手机浏览器呈现与有限命令入口：

- 桌面 Renderer 与手机共享同一 Kernel 状态、revision、事件流和 Session Runtime。
- 不引入 daemon、第二 Kernel、数据库、WebSocket、Renderer 中继或独立 GUI server。
- 传输为 Node `http`：`GET /api/session`、`GET /api/state`、`GET /api/events`（SSE），以及 `POST /api/session/pair`、`POST /api/session/logout`、`POST /api/command`（JSON）。
- 静态前端是独立 remote Vite 产物 `out/remote`，由 Electron Main 托管。**禁止**把 electron-vite 开发服务器暴露到 LAN 或 WAN。
- 远程命令 allowlist 以 [`src/shared/remote-contract.ts`](../src/shared/remote-contract.ts) 为准；附件、任务工作区、Git、设置、Provider、Package、原生路径和 shell 不在远程面暴露。

这是个人设备使用的受控远程入口，不是 SaaS、账户系统或多租户运维入口。

## 一键联网（默认入口）

设置页 **远程访问 → 一键联网** 默认把“任意浏览器”作为主操作：

- **任意浏览器**使用 Tailscale Funnel，在 Tailscale HTTPS 443 上公开当前节点的 `https://<node>.<tailnet>.ts.net` 地址；手机只需要普通浏览器，仍必须通过 Pi GUI 的 6 位配对码和设备 Cookie。
- **仅我的设备**使用 Tailscale Serve，入口只允许同一 Tailnet 中获准的设备访问。
- 两种模式都让 Electron Main 的 Remote Gateway 只监听动态选择并持久化的 `127.0.0.1:<port>`；Tailscale 是唯一受信 loopback 代理，不需要固定 LAN IP、Lucky、路由器端口映射或 PC 入站防火墙规则。
- Main 通过固定 argv 调用 `tailscale status --json`、`tailscale serve/funnel ...` 和 `tailscale serve status --json`，不暴露通用命令执行接口。
- 一键配置、内部机器密钥与设备记录写入 Electron `userData` 目录中的 `tailscale-remote.json`、`tailscale-remote.token` 和相邻 `.device` 文件；配置与密钥严格为本人所有、常规非 symlink、模式 `0600`。
- Pi GUI 只占用当前 Tailscale 节点 HTTPS 443 的根 handler。若该槽位已有非本应用管理的 Serve/Funnel 配置，必须 Fail Fast，不覆盖、不执行 `reset`。
- Funnel 与 Serve 可以显式切换；切换时只移除 Pi GUI 精确拥有的旧 443 根 handler，再写入新模式。显式“停用一键访问”先撤销手机设备，再移除精确 Tailscale handler、停止本地 Gateway 并删除 managed config/token。
- `--bg` 配置由 Tailscale daemon 持久化。普通退出 Pi GUI 只停止本地 Gateway，不删除用户明确启用的一键模式；下次启动使用持久化的 exact port/origin/token 恢复 Gateway。应用未运行期间，Tailscale 入口没有可连接的本地后端。

启用前提是系统已经安装 Tailscale，并且 `BackendState` 为 `Running`、`Self.DNSName` 非空。设置页会显示未安装、未登录、现有路由冲突或 managed route 缺失；`AuthURL` 存在时可打开官方登录页面。Pi GUI 不安装 Tailscale、不保存 Tailscale 账户凭据，也不绕过 Tailnet 的 HTTPS/Funnel 授权。

一键模式与下面的手动环境变量模式互斥；检测到双方同时启用时 Main 必须拒绝启动，不能猜测应由哪一方接管 public origin。

## 手动 Lucky / 受信反代模式

只有显式设置：

```bash
PI_GUI_REMOTE_ENABLED=1
```

并同时提供以下变量时，Main 才会绑定监听：

| 变量 | 含义 |
| --- | --- |
| `PI_GUI_REMOTE_BIND_HOST` | PC 的精确固定 IPv4；拒绝 `0.0.0.0`、IPv6、hostname 与 CIDR |
| `PI_GUI_REMOTE_PORT` | PC 后端端口；示例使用 `18787` |
| `PI_GUI_REMOTE_PUBLIC_ORIGIN` | 手机看到的精确 `https://` origin，端口非 443 时必须包含端口，无路径/尾斜杠/query/fragment |
| `PI_GUI_REMOTE_TRUSTED_PROXY` | Lucky 请求到达 PC 时使用的唯一源 IPv4；Lucky 在 NAS 上时填写 NAS 地址，不是路由器地址 |
| `PI_GUI_REMOTE_TOKEN_FILE` | **仅供 Main 内部使用的机器密钥**；常规非 symlink、属主本人、严格 `0600`、单行 32–4096 字符 |

机器密钥不再是手机密码，也不应展示、复制或输入浏览器。任一配置缺失、非法或密钥文件不安全时，Remote 必须 Fail Fast，不得半开或降级。

## 配对与 30 天设备凭证

1. 在 PC 的 Pi GUI 打开 **设置 → 远程访问**，点击“生成配对码”。
2. Main 使用密码学随机数生成 6 位数字码；配对码只存在 Main 内存中：
   - 5 分钟有效；
   - 一次性；
   - 重新生成会使旧码失效；
   - 连续 5 次错误尝试会消耗当前码；
   - Main 重启后失效。
3. 手机打开 `PI_GUI_REMOTE_PUBLIC_ORIGIN`，输入 6 位配对码。成功后服务端签发至少 32 字节随机设备凭证，并写入：
   - `HttpOnly`；
   - `Secure`；
   - `SameSite=Strict`；
   - `Path=/`；
   - `__Host-` cookie；
   - 绝对 30 天 `Max-Age` / `Expires`。
4. Main 只把设备凭证的 SHA-256 哈希、配对时间和到期时间写入 `${PI_GUI_REMOTE_TOKEN_FILE}.device`；原始 cookie、配对码和机器密钥不会写入该文件。文件严格校验为本人所有、常规非 symlink、模式 `0600` 的有界 JSON；损坏或权限不安全会使 Remote 启动失败。
5. v2 只记住一部手机。新配对会替换旧设备并立即关闭旧 SSE；旧 cookie 随即失效。
6. 手机“退出登录”或 PC“撤销已配对手机”都会先持久化撤销，再清 cookie/关闭 SSE。到期设备也不能再认证。

不要把配对码或设备 cookie 放入 URL、localStorage、sessionStorage、日志、截图或工单。配对码虽短，但只应在 PC 与正在配对的手机之间临时使用。

## 与本地 GUI 的协作边界

Remote 与桌面 Renderer 连接的是同一个 Electron Main / WorkbenchKernel，不会创建第二 Runtime、Session 真相或状态数据库。Project/Session 切换、Timeline 和运行状态继续通过同一 revision/event 流同步。

Remote v2 仍不提供跨桌面/手机的控制权租约。为避免两个终端语义交错，同一时刻只把一个终端当作交互控制器；切换前等待当前操作收到 revision ack 并确认 Project/Session 已同步。`prompt` 额外校验 `expectedSessionKey`，但 steer/follow-up/abort/model 等命令没有抢占式所有权。

## Lucky 位于 NAS 时的拓扑

```text
Phone / browser
  --HTTPS-->  public DDNS origin / router port forwarding
                 --> NAS 上的 Lucky
                       --HTTP--> http://<PC 固定 LAN IP>:18787
                                   Electron Main Remote
```

### Lucky / NAS

- 使用专用 HTTPS origin；上游指向 `http://<PC 固定 LAN IP>:18787`。
- 将 `X-Forwarded-Proto` 精确设为 `https`。
- 保留浏览器入口的 `X-Forwarded-Host`，或精确写成 public origin 的 host（含非默认端口）。
- 对 `text/event-stream` 关闭响应缓冲、缓存和会聚合事件的压缩；读超时建议至少 `3600s`。
- Lucky 主机连接 PC 时的源地址必须等于 `PI_GUI_REMOTE_TRUSTED_PROXY`。
- 路由器只把公网 HTTPS 端口转发给 NAS/Lucky；**不要**把 PC 的 `18787` 直接映射到 WAN。
- 可以保留 Lucky 外层 Basic Auth；它与 Pi GUI 的一次性配对是两道独立边界。

### PC

- 固定 DHCP/静态 LAN 地址，并与 Lucky 上游一致。
- 防火墙只允许 Lucky/NAS 的精确 IP 访问 `18787`。
- 不允许其他 LAN 主机或 WAN 直连 `18787`。

## 生成内部机器密钥与环境文件

仓库提供辅助脚本；它不修改防火墙、Lucky、systemd，也不启动或重启 GUI：

```bash
./scripts/setup-remote-access.sh \
  --public-origin 'https://pi-gui.example.com' \
  --trusted-proxy '192.168.1.241' \
  --bind-host '192.168.1.50' \
  --port '18787' \
  --write-env "$HOME/.config/pi-gui-next/remote.env"
```

脚本会：

- 以 `umask 077` 创建/验证内部机器密钥文件；新密钥是 32 字节随机值的 64 字符十六进制编码；
- 生成模式 `0600` 的非秘密 env 文件；env 只引用机器密钥路径，不包含密钥正文；
- 不创建设备记录；`${PI_GUI_REMOTE_TOKEN_FILE}.device` 只会在首次成功配对后由 Main 原子创建。

**不要执行 `cat "$PI_GUI_REMOTE_TOKEN_FILE"` 给手机登录。** 手机只使用桌面设置页生成的 6 位配对码。

## 启动与 Main 生命周期

一键 Tailscale 模式可在设置页运行时启用、切换和停用，不需要手工编写 env；启用后的 exact loopback port、public origin 和内部密钥会在下次 Main 启动时恢复。Tailscale 未安装、未运行、DNS identity 变化、443 handler 冲突或持久化文件不安全时，操作必须显示原始错误，不切换到 LAN 监听。

手动 Lucky 模式的监听、配对、设备存储和静态托管属于 Electron Main。环境或 Main/shared/remote 代码变化后：

1. 完整退出 Pi GUI；不能依赖 HMR 或只刷新 Renderer。
2. 构建：生产路径运行 `pnpm build`；开发路径至少先运行 `pnpm build:remote`。
3. 在启动 GUI 的同一 shell 中加载环境并前台启动：

```bash
cd /path/to/pi-gui-next
set -a
source "$HOME/.config/pi-gui-next/remote.env"
set +a
pnpm dev
```

4. 在桌面 **设置 → 远程访问** 确认状态为“已启用”，再生成配对码。

## curl 定向验证

生产验证使用当前设置页显示的 public origin：一键模式使用 Tailscale `ts.net` origin，手动模式使用 Lucky origin。若 Lucky 启用了 Basic Auth，给下列 curl 额外添加对应 `-u`，但不要把凭据粘贴到共享日志。

```bash
ORIGIN='https://pi-gui.example.com'
COOKIE_JAR="$(mktemp)"
trap 'rm -f "$COOKIE_JAR"' EXIT

# 先在桌面设置页生成配对码，再在当前 shell 临时输入；read 输入不会写入 shell history。
read -r -p '6-digit pairing code: ' PAIR_CODE
printf '{"code":"%s"}' "$PAIR_CODE" | curl -sS -D- -o /dev/null \
  -c "$COOKIE_JAR" -b "$COOKIE_JAR" \
  -H "Origin: ${ORIGIN}" \
  -H 'Content-Type: application/json' \
  --data-binary @- \
  "${ORIGIN}/api/session/pair"
unset PAIR_CODE

curl -sS -c "$COOKIE_JAR" -b "$COOKIE_JAR" "${ORIGIN}/api/session"
curl -sS -c "$COOKIE_JAR" -b "$COOKIE_JAR" "${ORIGIN}/api/state"

# SSE；应保持 text/event-stream，Ctrl+C 结束。
curl -sS -N -c "$COOKIE_JAR" -b "$COOKIE_JAR" \
  -H 'Accept: text/event-stream' \
  "${ORIGIN}/api/events"

# 示例只读命令；协议版本为 2。
curl -sS -c "$COOKIE_JAR" -b "$COOKIE_JAR" \
  -H "Origin: ${ORIGIN}" \
  -H 'Content-Type: application/json' \
  --data '{"protocolVersion":2,"requestId":"00000000-0000-4000-8000-000000000001","command":{"type":"kernel.get-state"}}' \
  "${ORIGIN}/api/command"

# 退出会同时撤销当前记住的手机。
curl -sS -c "$COOKIE_JAR" -b "$COOKIE_JAR" \
  -H "Origin: ${ORIGIN}" \
  -X POST "${ORIGIN}/api/session/logout"
```

必须失败的路径：

- `POST /api/session/login`（v1 token 入口已移除，应为 404）；
- 无 cookie 的 `/api/state`、`/api/events`、`/api/command`；
- 错误 `Origin` 的 POST；
- 缺少/伪造 forwarded proto 或 host；
- TCP peer 不是 `PI_GUI_REMOTE_TRUSTED_PROXY`；
- 已使用、已过期、错误五次或被重新生成替代的配对码；
- 被新配对、手机退出或桌面撤销替代的旧 cookie。

## 明确不做

- 公网多用户、账户体系、OAuth 或第三方 IdP。
- WebSocket 第二传输、Renderer 反代、暴露 dev server。
- WAN 映射 `18787`、关闭认证的调试模式、短固定密码、长期机器密钥人工登录。
- 远程 Git/设置/Provider/Package/原生对话框/任意路径搜索/host shell。
- setup 脚本修改 firewall、Lucky、systemd 或自动重启 GUI。
- 自动安装 Tailscale、保存 Tailscale 账户凭据、覆盖已有 Serve/Funnel handler、调用 `serve reset` / `funnel reset`，或在 Funnel 不可用时静默降级为 LAN/WAN 监听。
- Pi GUI 自建 NAT rendezvous、云端 relay 或账户服务；一键模式显式复用系统 Tailscale daemon。

## 相关文档

- 架构总览：[`architecture.md`](architecture.md)
- 产品边界：[`product-boundary.md`](product-boundary.md)
- 决策记录：[`decisions.md`](decisions.md)（D-065、D-066）
- 传输 allowlist：[`../src/shared/remote-contract.ts`](../src/shared/remote-contract.ts)
- 独立的 Desktop Host over SSH：[`desktop-host.md`](desktop-host.md)
