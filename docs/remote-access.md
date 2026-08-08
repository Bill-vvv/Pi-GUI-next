# 私有远程访问（Remote v2）

> 适用：可选的个人远程呈现面。默认关闭，不是第二 control plane，也不是公网多用户服务。

## 定位

Remote v2 在**同一 Electron Main / 同一 WorkbenchKernel** 上增加手机浏览器呈现与有限命令入口：

- 桌面 Renderer 与手机共享同一 Kernel 状态、revision、事件流和 Session Runtime。
- 不引入 daemon、第二 Kernel、数据库、WebSocket、Renderer 中继或独立 GUI server。
- 传输为 Node `http`：`GET /api/session`、`GET /api/state`、`GET /api/events`（SSE），以及 `POST /api/session/pair`、`POST /api/session/logout`、`POST /api/command`（JSON）。
- 静态前端是独立 remote Vite 产物 `out/remote`，由 Electron Main 托管。**禁止**把 electron-vite 开发服务器暴露到 LAN 或 WAN。
- 远程命令 allowlist 以 [`src/shared/remote-contract.ts`](../src/shared/remote-contract.ts) 为准；附件、任务工作区、Git、设置、Provider、Package、原生路径和 shell 不在远程面暴露。

这是家庭网络出口上的私有控制面，不是 SaaS、账户系统或多租户运维入口。

## 默认关闭与启用条件

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

## 前台启动与 Main 重启

Remote 监听、配对、设备存储和静态托管属于 Electron Main。环境或 Main/shared/remote 代码变化后：

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

生产验证优先通过 Lucky 的 public origin。若 Lucky 启用了 Basic Auth，给下列 curl 额外添加对应 `-u`，但不要把凭据粘贴到共享日志。

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

## 相关文档

- 架构总览：[`architecture.md`](architecture.md)
- 产品边界：[`product-boundary.md`](product-boundary.md)
- 决策记录：[`decisions.md`](decisions.md)（D-065、D-066）
- 传输 allowlist：[`../src/shared/remote-contract.ts`](../src/shared/remote-contract.ts)
