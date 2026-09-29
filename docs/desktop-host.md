# Desktop Host over SSH（P4-1）

> 当前状态：P4-1 Linux Host 协议与设置入口已完成并通过独立安全 closure；P4-2 Windows remote-only client source 已完成（含 Credential Manager、断线重连与 capability gating）；P4-3 已打出并安装 Windows 包，真实 SSH gate 由用户暂缓，完成前不能宣称 Windows 已受支持。

2026-09-15 用户确认按 [SSH 远程开发计划](remote-development-plan.md) 先完善连接可靠性，再逐项补齐开发闭环；真实 Linux Host 尚未准备，先实施和自动化验证。R1 已增加有限重连与错误诊断，R3 已接通远程项目目录选择与注册，P4-3 真实验收继续开放。

## 定位

Desktop Host 是 Pi GUI 完整桌面客户端使用的 loopback-only 远程入口：

```text
Windows Pi GUI Main（P4-2 remote-only）
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
| 构建身份 | 自动从内容清单取得源码摘要；开发模式计算当前源码摘要。旧 `PI_GUI_BUILD_COMMIT` 环境覆盖已退出，双方摘要必须非空且完全一致 |

绑定地址不是配置项，固定为 `127.0.0.1`。设备记录写入 `${PI_GUI_DESKTOP_HOST_TOKEN_FILE}.desktop-device`，R12 起为最多 8 台设备的版本 2 集合，每条只保存桌面设备凭证的 SHA-256 哈希、配对/到期时间和可空的设备名称（Windows 计算机名）；原始凭证只在首次配对响应中返回。

任一启用配置或文件权限非法时 Main 必须 Fail Fast，不得改绑 wildcard、退回 Web Remote 或跳过设备认证。

## 统一配置与启动命令（R11）

Linux 上使用与工作区 `package.json` 匹配的 Node。默认配置目录为 `${XDG_CONFIG_HOME:-$HOME/.config}/pi-gui-next`，要求本人所有、非符号链接、权限 `0700`。也可为每个命令显式传入 `--config-dir /absolute/directory`。

```bash
node scripts/desktop-host.mjs configure --port 18788
node scripts/desktop-host.mjs check --build-root /absolute/prepared-linux-build
node scripts/desktop-host.mjs start --build-root /absolute/prepared-linux-build
```

- `configure` 创建一次随机机器密钥，随后复用；原子保存不含密钥的 `desktop-host.json`。已有 `desktop-host.token` 和 `.desktop-device` 保留，可复用下方旧手动配置创建的配对。修改端口只影响下一次启动；不解析或执行旧 `.env` 文件。已配置后密钥丢失、配置损坏或权限异常均明确失败，不生成替代密钥或重置配置。
- `check` 读取准备状态，校验完整构建产物清单、Node 版本、Pi 依赖版本和 Node Host 入口 `out/main/pi-host.js`。输出源码与产物摘要；不打印密钥，不代表 Host 已在线或 SSH 已连通。
- `start` 使用同一配置校验，以该 Linux 构建为 cwd，用启动器已校验的 Node 运行 Node Host：`node --use-env-proxy out/main/pi-host.js desktop-host`（D-095）。它与 Linux 桌面运行同一套 Host 组装，不需要 Electron、显示器或图形会话；`--use-env-proxy` 让网络请求像原 Electron 一样遵循 `HTTP(S)_PROXY`。清理继承的 WSL、开发预览、探针和 Node 注入模式；不安装依赖。端口空闲后才启动，最多等待 60 秒无凭证兼容性握手，成功才输出 `ready: true`。同一用户的数据目录同时只能由一个 Host 使用：Linux 桌面、WSL 后端或另一个 Desktop Host 已在运行时明确报错退出（D-099）。
- 启动命令保持前台运行；中断启动命令时退出。中断使 Host 完整停机，最多等待 15 秒，超时强制终止会明确报错。配置与启动持有同一系统 `flock`，运行中拒绝另一启动或配置操作；不会把遗留锁文件本身当作进程仍在运行。
- 不需要图形会话。Host 运行期间，在同一 Linux 用户下执行 `devices` 列出已配对设备，`pair` 打印 5 分钟有效的 6 位配对码，`revoke --device <设备编号>` 撤销一台设备；它们经数据目录中只有本人可访问的 `host.sock` 调用与 Linux 设置页 **远程访问 → Desktop Host（SSH）** 相同的管理函数。独立发行目录部署与回退见下文；启动命令本身仍在前台运行，不注册系统服务。

`--build-root` 必须是已完成生产构建且装有冻结依赖的 Linux 目录，不能指向 Windows `node_modules`。共同开发场景先运行 `node scripts/workspace.mjs build`，再使用其输出的 Linux development workspace 路径。Windows 客户端必须来自相同源码摘要。

## 部署、升级与回退（R11）

先准备配置与一个已完成生产构建、装有固定 Linux 依赖的目录，然后部署：

```bash
node scripts/desktop-host.mjs configure --port 18788
node scripts/desktop-host.mjs deploy --build-root /absolute/prepared-linux-build
node "$HOME/.local/share/pi-gui-next-host/host.mjs" check
node "$HOME/.local/share/pi-gui-next-host/host.mjs" start
```

默认安装目录是 `${XDG_DATA_HOME:-$HOME/.local/share}/pi-gui-next-host`；可显式指定 `--install-dir`。部署输出实际 `launcher` 路径，使用该路径执行后续命令。安装绑定首次部署时的配置目录，不会将同一发行目录配给另一套密钥配置。源构建目录与安装目录不能重叠。

- 候选目录复制生产产物、扩展及现有 Linux `node_modules`，另保存当前已验证的 Node 可执行文件，并包含打包后的 Host CLI。依赖版本仍由原锁文件及构建检查约束，不运行安装脚本或网络下载。部署输入必须可信且已准备好依赖；这个命令不负责从 Windows 上传或在远端安装系统依赖。
- 复制前后比较全部文件与链接的摘要；链接必须留在发行目录内，文件树有数量、深度与总字节上限。包含依赖及 Node 的完整摘要保存到安装记录，启动与回退重新核验。部署后的运行文件不依赖原构建目录；直接部署开发构建会保留其全部依赖，使用下方可分发包则只携带选出的运行依赖。CLI 在 stderr 显示阶段，stdout 最后输出结果 JSON。
- `installation.json` 在一次原子替换中同时记录当前与上一发行版。只有候选校验完成后才更新；更新失败保留原选择。部署同一完整版本会复用当前发行版，不把重复副本覆盖到回退位置。
- 启动、部署与回退复用配置进程锁，部署另持有安装目录锁；受管理 Host 正在运行时拒绝升级或回退。先正常关闭 Host，再操作。不会中断正在执行的任务来强行升级。
- 部署进程异常退出后，下一次部署持锁检查并删除 `.candidate-<uuid>` 未完成目录，再开始新候选。已经选中或完成的发行目录不自动删除；更早的完整版本也保留，避免清理步骤改变部署结果。此处的恢复验证覆盖部署进程中断。

升级、复用和回退使用同一个安装入口：

```bash
node "$HOME/.local/share/pi-gui-next-host/host.mjs" deploy --build-root /absolute/new-linux-build
node "$HOME/.local/share/pi-gui-next-host/host.mjs" rollback
node "$HOME/.local/share/pi-gui-next-host/host.mjs" start
```

回退先核验上一发行版及其对当前配对数据的读取能力，再交换当前与上一记录；目标损坏、缺失或格式不兼容时保留当前选择并报错。当前发行版文件损坏时，先显式回退到仍完整且兼容的上一版或恢复文件，再继续部署。配置、机器密钥、配对设备、项目和任务数据不放进发行目录，不随版本切换或回退复制、重建或删除。客户端仍需与所选 Host 的源码摘要一致。

### 配对数据格式兼容检查（R12）

- 构建的 `package.json.desktopHost.deviceStoreVersions` 声明该程序可读取的配对文件版本，属于产物校验范围。没有该字段的历史构建按其实际的版本 1 读取能力处理；显式但非法的声明会报错。R12 起 Main 使用版本 2 设备集合（首次启动时原子迁移版本 1 文件），声明为 `[1, 2]`；迁移后只声明 `[1]` 的发行版会被拒绝启动和回退。
- 当前管理入口在 `check`、`start`、部署目标与回退目标检查中，只读校验配对文件的完整格式、私有权限、大小及目标读取能力。检查不会触发旧数据迁移，也不会生成或删除配对记录。复制和完整摘要校验结束后、选择候选前再次检查。
- 已经存在的新格式数据会阻止选择只认识旧格式的发行版，即使新文件中的设备列表为空也一样。保留现有配对数据，使用可读取该格式的版本继续运行。
- 当前发行版的文件完整性与它能否读取数据分别检查。因此，如果文件完整但已不兼容当前数据，仍允许部署可读取数据的新版；回退时再判断保留的上一版是否兼容。
- 这些检查由当前构建的管理入口执行，历史包中的旧工具没有被改写。版本声明需要与实际读取代码同步更新；更改声明本身不会为旧程序增加新格式支持。

稳定入口 `host.mjs` 由 Node 引导，随后运行所选发行版自己的 Node 与打包 CLI；可使用系统 Node，也可使用安装结果中的 `nodeExecutable`。后者不要求预装 Node。完整发行目录会保留，升级后仍可用原 Node 路径引导当前版本。Linux 图形会话、系统 Git、OpenSSH 及其他操作系统依赖仍需具备。真实 Windows→SSH→Linux gate 继续独立开放。

## 可分发包与首次安装（R11）

构建机器上先完成 Linux 生产构建，再运行打包命令；输出目录须已存在且位于构建目录之外：

```bash
node scripts/desktop-host.mjs pack --build-root /absolute/prepared-linux-build --output /absolute/dist/pi-gui-host.tar.gz
```

输出归档及同名 `.sha256` 文件。包中包含生产产物、随附扩展、Node、Electron 和应用声明的运行依赖；按实际 Node 解析路径遍历直接、间接、可选与 peer 依赖，保留包内完整文件及链接关系。不会带入仅用于构建的 Electron Builder、TypeScript、Vite 或 Windows 安装器。未安装的可选依赖逐项记入 `host-bundle.json`；必需依赖缺失则打包失败。保留原 `package.json` 与锁文件，以维持构建身份。

将归档与校验文件移交到相同架构的 Linux 主机，在空目录中校验和解压：

```bash
sha256sum --check pi-gui-host.tar.gz.sha256
tar -xzf pi-gui-host.tar.gz
./pi-gui-host/install.sh
```

- `install.sh` 直接使用包内 Node，不需要原源码、开发依赖、npm/pnpm 或预装 Node，也不运行联网依赖安装。归档校验值用于核对移交内容。
- Linux 仍需具备 `/bin/sh`、`dirname`、`flock`、Git 和 Node 对应的系统运行库；解压需 `tar`/`gzip`，校验需 `sha256sum`。安装包不再包含 Electron，Host 启动不需要图形会话（D-095）。SSH 登录与端口转发仍需在主机配置好 OpenSSH；本安装器不安装操作系统软件，也不设置 SSH 服务。
- 可以传入 `--config-dir`、`--install-dir`、`--port`。默认首次端口为 `18788`；重新安装省略端口时保留现有值。显式传入与现有值不同的端口会报错，先通过 `configure` 修改。密钥、配对和用户数据继续使用原目录。
- 安装前核对平台、架构、版本、产物清单、完整 payload 摘要、安装脚本及运行依赖清单。损坏包在创建 Host 配置前拒绝；候选还须匹配已核验的包摘要，才能切换当前版本。
- 安装输出 `nodeExecutable` 与 `launcher` 两个实际绝对路径。用它们执行 `check` / `start` / `rollback`；例如 `/absolute/installation/releases/RELEASE_ID/runtime/node /absolute/installation/host.mjs start`。不要手工删除仍在使用的完整发行目录。安装后可移除解压目录。
- 升级时校验、解压新版并再次运行其 `install.sh`，指向相同配置和安装目录；先关闭正在运行的 Host。同版安装复用当前发行版并保留原回退目标。Windows 客户端需同步至匹配的源码摘要。

此流程不创建无桌面后台服务。真实 Windows→SSH→Linux 的配对与日常使用验收继续独立进行。

## 手动创建机器密钥与环境文件

以下保留手动启用方式；已有机器密钥时不要覆盖生成，应复用原文件。统一命令与手动环境方式择一启动。

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

Windows 客户端使用用户现有 OpenSSH host alias。Windows 上固定调用 `%SystemRoot%\System32\OpenSSH\ssh.exe`，不从 `PATH` 解析 `ssh`；可执行文件缺失则 Fail Fast。等价命令为：

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

Windows 源码客户端首次进入 SSH 模式，之后恢复上次成功选择的 WSL/SSH 环境；生产窗口提供明确重启切换。SSH Settings 只开放本机外观、快捷键与窗口行为，不扩大 Host 管理命令。`pnpm build` / `pnpm package:win` 写入包含源码和产物摘要的清单；运行时校验清单。源码开发模式自动计算当前源码摘要，同一 Git HEAD 上的不同未提交修改不会被视作同一 build。共同开发与启动命令见 [cross-platform-development.md](cross-platform-development.md)。

连接界面填写 SSH alias、本机端口、Host 端口；首次配对需要 Host 生成的 6 位配对码（Linux 设置页或 Host 上的 `pair` 命令）。成功后原始凭证写入 Windows Credential Manager，alias/端口写入 userData JSON。已保存凭证时配对码可选。关闭窗口或普通断开只释放连接并保留凭证；Workbench 的“管理 Host 连接”提供独立“取消配对”，仅此动作请求 Host logout 并在确认后清除存储的凭证。隧道或 SSE 意外断开后自动重建隧道、无凭证握手、已存凭证、新 controller SSE 与 snapshot，不重放未确认 mutation。Workbench 只展示 Host 已接通的能力：远程项目选择和 Git 只读审阅按 capability 开放；附件按独立完整 capability 开放；Git 暂存、取消暂存和普通提交在写能力齐全时开放，Host 管理设置仍隐藏，本机外观和快捷键设置可用。

### 有界恢复与错误反馈

- 已建立连接后发生网络中断，每轮恢复最多尝试 5 次：立即尝试一次，后续尝试前分别等待 1、2、4、8 秒。等待时间不包含 SSH 启动与 HTTP 请求自身的超时。
- 仅对明确的网络类错误自动重试。SSH 登录失败、Host Key 校验失败、设备认证失败、协议/构建不一致、配置问题、未知错误和资源清理失败均停止；原始错误保留在连接页。401 会清除已失效的设备凭证。
- 连接页显示实际尝试次数与等待间隔；耗尽后保留最近错误及处理建议，用户可显式点击“重试连接”。未登录 SSH 与设备配对失效使用不同提示。
- 检测到断线立即关闭命令入口并清空 capability；新事件流、完整 snapshot 与配置持久化完成且连接仍有效时，才发布 connected。同步期间的事件流失败会被及时接收，不形成未处理的 Promise rejection。
- 已结束事件流的原始错误由 `closed` 报告一次，随后释放该流不把同一错误误报成第二次清理失败。实际 SSH 进程清理失败仍停止恢复并保留进程所有权。
- 关闭客户端或显式断开会取消退避等待；迟到的握手/快照不能重新打开连接。恢复只重建连接和读取状态，不重放 prompt、steer、follow-up、abort 等未确认操作。

本地验证使用真实 HTTP/SSE Gateway 和隔离设备存储，覆盖 Host 重启后恢复、重新读取持久化配对、已认证请求被撤销后的 401，以及恢复握手时发现配对消失。后者不发送已存凭证，也不删除本地凭证；该测试中的 SSH 隧道为 fixture，不能替代真实 Windows OpenSSH 与 Linux Host 验收。

## 配对与设备凭证

1. SSH 进程成功启动后，Windows client 必须先不携带设备凭证请求握手，并要求 protocol、product version 与非空 build commit 完全一致。
2. 兼容性通过后，才可在 Linux Pi GUI 设置页或 Host 的 `pair` 命令生成、并由 Windows client 提交 6 位桌面配对码；client 在握手前必须本地拒绝配对。
3. 配对请求再次携带预期 product/build，Host 必须在写入新设备前复核。R12 起新设备与已有设备并存，不替换、也不断开当前控制连接；已有 8 台有效设备时拒绝生成配对码，并发配对也会被拒绝。配对请求可带 Windows 计算机名作为设备名称，Host 规范化后保存，名称不合格时按未命名保存，不因名称拒绝配对。配对码 5 分钟、一次有效；重新生成替代旧码，连续错误和每分钟尝试均有界。
4. `POST /api/desktop-host/pair` 成功后只返回一次高熵桌面设备凭证。
5. 后续客户端通过 `Authorization: Bearer <credential>` 认证；不得把凭证放入 URL、Renderer、日志或浏览器存储。已有凭证只能在新隧道完成无凭证兼容性握手后，再用 `x-pi-gui-pairing-id` 请求头发送本地凭证派生的公开配对身份，且 Host 回答 `pairingKnown: true` 时才装载进 client。回答不是 `true`（已撤销、已过期或目标 Host 不同）时报告 `credential-target` 并停止恢复，凭证未发送，本地凭证保留，供用户核对主机或重新配对。
6. Linux 设置页逐台撤销设备，或客户端 logout 只撤销自身后，该设备的凭证立即失效；只有它正持有控制连接时才关闭 SSE，其他设备不受影响。
7. 每个 Linux Host 最多保留 8 台 Windows Desktop 设备（R12，接口见 [R12 共享接口](r12-shared-interfaces.md)）；Web Remote 手机设备存储独立，仍只记住一部手机，双方不会互相替换。

正式 Windows 客户端按主机配置把原始凭证保存在 Windows Credential Manager（Generic target `PiGUI/DesktopHost/<credentialKey>`）。名称、Host alias、端口与凭证槽编号保存在 Main userData 的 `desktop-client-hosts.json`，不含 secret。Renderer、环境变量、URL 和日志不得出现原始 Bearer。`src/main/remote/windows-remote-session.ts` 在无凭证握手成功后才 `setCredential`；401 时清除存储的凭证。

## 协议与控制权

握手 `GET /api/desktop-host/session` 返回：

- Desktop Host protocol version；
- Pi GUI product version；
- 源码内容摘要（协议字段名仍为 `buildCommit`）或 `null`；
- 当前认证状态；
- `pairingKnown`：请求带 `x-pi-gui-pairing-id` 时表示该公开配对身份是否为当前有效配对，未带时为 `null`；Host 不列出、不计数其他设备；
- Host 明确允许的 Kernel command types。

当前 Desktop 协议为 3（R12），两端必须使用匹配构建；版本 2 的客户端或 Host 在匿名握手阶段即报不兼容，不发送凭证。公开配对身份为设备凭证哈希加固定用途前缀后的 SHA-256 摘要，区别于原始凭证与认证哈希；Host 重启并加载同一有效设备记录后保持一致。它用于在发送已存凭证前确认本设备仍在目标 Host 上有效，SSH 仍负责主机身份与加密。Windows 支持多套主机配置与独立 Credential Manager 槽；每个 Linux Host 可保留多台桌面设备，但同一时刻只有一个控制连接，不自动合并指向同一 Host 的不同 SSH 别名。

### 断开与取消配对

- 普通断开与关闭窗口共享连接清理入口，取消重连，等待正在建立的连接和临时资源收尾；保留设备凭证与成功主机配置。断开不会提交任务停止命令。
- 取消配对必须仍连接到界面观察的同一 Host 配置；离线、目标变化或已有收尾操作时拒绝。先请求 logout，确认兼容的 `authenticated: false` 且 `pairingKnown: false` 响应后才删除本机凭证；不自动重放撤销请求。
- logout 响应丢失时明确标为结果未确认，并保留本机凭证供用户核对。Host 已确认撤销但 Credential Manager 删除失败时，明确报告远端已撤销、本机删除失败；不误报完整成功。
- disconnecting/revoking 期间拒绝新连接、检查、任务命令及重复撤销；关闭或重复断开等待同一收尾。SSH 进程清理失败保留资源所有权，可关闭重试。
- Renderer 根据 Main 状态清除旧 Kernel 投影；断开请求的迟到返回不再次清空可能已建立的新连接。连接操作弹窗由 desktop-client feature 拥有，并复用共享 modal 的焦点和键盘协议。

首版客户端必须要求 protocol version、product version 和非空 build commit 完全一致，不猜测兼容或自动降级。JSON/SSE 的大小、UTF-8、versioned envelope 与 discriminator 在 client 边界校验；握手通过后，Kernel DTO 内部结构作为同 build shared contract 使用，不在 transport 中复制第二套完整 Kernel schema validator。

认证后的 API 为：

- `GET /api/desktop-host/events`：SSE KernelEvent；
- `GET /api/desktop-host/state`：权威 KernelSnapshot；
- `POST /api/desktop-host/command`：allowlist 内的 typed KernelCommand；
- `POST /api/desktop-host/logout`：只撤销发起请求的桌面设备。

客户端先以随机 UUID 放入 `X-Pi-Gui-Controller-Id` 并建立 SSE。Host 同一时刻只接受一个活动 controller，并把它同时绑定到打开它的设备与 controller identity：另一台设备借用相同 controller identity 也会被拒绝。另一台设备已持有控制连接时，事件流返回 409 `Another desktop device is controlling this Host.`，客户端归类为 `occupied` 并停止，不抢占、不排队、不自动重连。没有活动事件流、controller identity 缺失或另一 controller 已占用时，state/command 必须明确拒绝。Renderer 应用状态后更新 preload 的观察身份；Main 不在发命令前重新读取 Host 状态来替换目标。每个 command 必须携带客户端当前观察到的 `projectKey + sessionKey` control identity；Host 在 policy、dispatch 和异步准备边界重复核对，Linux 本地状态变化后以 typed `409 conflict` 拒绝 stale command，不能让旧 `steer`、`follow-up`、`abort` 或设置命令落入另一 Session。断线后客户端应先重建事件流并获取 snapshot，不自动重放未确认 mutation。

## 当前命令边界

当前核心命令包括 Project/Session 激活、Conversation 分页与图片读取、Prompt/Ask/Steer/Follow-up/Abort、模型与 Thinking 设置。R3 另外接通 `kernel.list-project-directories`、显式路径的 `kernel.add-project` 与 `kernel.resolve-project-trust`。R4 已接通下述 Git 只读传输和 Changes/History 审阅界面，同时提供当前变更文件的有界全文阅读；R5 通过下述窄协议支持附件上传；R6 接通已适配扩展交互，R7 接通下述普通 Git 写流程；Task workspace、Git 网络/分支操作、Provider、Package、Host 设置和任意 Shell 仍不经 Desktop Host 暴露。

### Git 只读审阅（R4）

- 同一 `/command`、设备凭证、controller 与观察身份承载独立 Git command DTO。仅在 Host 提供 Git handler 时，握手和配对才返回 `gitCommandTypes`；Windows 按实际 capability 拒绝未开放命令。
- 当前七项能力为刷新、精确上级仓库授权、工作区/暂存 diff、工作区文件全文、历史列表、历史详情和历史文件 diff；复用唯一 `GitCapabilityController`、项目 resolver、GitService、仓库队列与 snapshot 校验，不建立第二个 Git 服务 owner。暂存、提交、分支操作和网络 Git 不在当前远程 allowlist。
- Git 路径始终按 Linux 规则校验，Windows 不把 Host 路径改成本机路径。preload 的 Kernel/Git 命令读取同一观察身份；服务排队后、上级仓库授权发布前和读取结果发送前再次核对身份。断线/撤销/项目或会话切换后的旧结果不得交给新界面。
- 保留 GitService 的二进制、大文件、路径和输出限制；JSON 响应额外受 2 MiB 传输预算限制，超限明确拒绝。上级仓库必须先通过现有精确授权 challenge，之后才读取其文件变化。
- Renderer 在七项读取 capability 齐全时开放 SSH Git 审阅；未同时具备 R7 三项写能力时采用只读面板：显示 Changes/History，复用范围选择、diff 与历史详情；隐藏暂存、提交和分支/同步操作。项目、远程 Session 或读写模式变化时重建局部审阅状态，断线卸载后忽略迟到响应。本地/WSL 保留完整 Git 界面。
- `git.read-file` 只读取当前有界变更列表中的工作区文件，要求精确仓库 snapshot 和既有祖先授权；通过 Linux 目录句柄逐段拒绝符号链接，文件读取前后核对元数据、路径与仓库身份。最多 256 KiB，二进制、非 UTF-8、非普通文件和超限文件明确拒绝，不返回部分正文。
- 文件行“全文”打开可取消、可重试的纯文本阅读弹窗，明确标注当前工作区；关闭、刷新、模式/项目/会话变化及断线均丢弃旧请求与正文。真实 Windows→SSH→Linux 验收继续开放。

### 必要 Git 写操作（R7）

- 额外同时具备 `git.mutate-file`、`git.prepare-commit`、`git.execute-commit` 才显示写入口；远程仍只显示 Changes/History。文件操作复用精确文件/仓库 snapshot，提交先获取预览，再由用户确认暂存文件数量、分支和说明。
- Gateway 仅允许 `execute-commit.mode = commit`，拒绝 Amend、Commit & Push 及分支命令。Host 不自动暂存其他修改，不自动提交或推送。
- controller/Project/Session 复核沿共享 GitCapabilityController 进入 GitService 仓库队列，在身份检查与实际写操作之前再次执行；提交在授权等待后重新检查暂存快照。冲突文件在共享入口拒绝暂存和取消暂存，不依赖按钮隐藏。
- 并发重复提交在仓库队列中使用原 HEAD/index snapshot 校验，只能生成一次提交。外部进程仍可能在 Git 运行期间改变仓库，沿用既有提交后验证和明确警告；失去响应不等于失败，也不能推断操作未执行。
- 远程 Git 面板按项目与会话身份重建，导航或断线后丢弃旧预览与结果。提交响应未确认时显示“提交结果未确认”，禁用原确认框再次提交，关闭后刷新并检查历史；暂存响应未确认时提示先检查刷新后的暂存区。重连不重放 mutation。
- 自动化证据与真实 Windows→SSH→Linux 验收分别记录，本轮不改变发布 gate。

### 远程 Ask 与扩展交互（R6）

- Ask 继续使用已有 `kernel.submit-ask` / `kernel.cancel-ask`，按当前 Session 与 toolCallId 回答；前端阻止重复点击，Kernel 拒绝重复提交或已在进行的取消。
- Desktop 开放 `kernel.invoke-command`，只接受当前已注册普通 Project 的 normalized catalog 中已适配 Extension 命令。Host 重用 provenance/参数校验，参数最多 16,000 字符；GUI 内建命令、未知 Extension 和通用 RPC 不因此开放。远程 Composer 只显示 Extension 命令，且必须同时具备调用、回应和取消 capability。
- `kernel.respond-extension-dialog` / `kernel.cancel-extension-dialog` 复用现有 `select`、`input`、`editor`、`confirm` 对话框。请求精确绑定 Project、Session、Session ID、invocation ID、request ID，并沿既有 controller/credential 校验；过期、重复、值非法和其他会话的回应不能送入 Runtime。
- 切换任务后命令回显留在原 Session，迟到结果不能清空新 Session 的草稿。断线卸载交互；重连以 Host 当前请求恢复界面，不重放回应。已适配命令等待用户期间继续由 Host 持有，连接中断不等于命令已取消。
- 缺少回应能力时，对话框显示不可用原因并禁用动作；项目资源授权仍复用 R3 的现有信任请求。Provider 登录、Package 管理、任意 TUI UI 和其他 Host 管理操作保持原边界。真实 Windows→SSH→Linux 验收仍待进行。

### 远程附件上传（R5）

- 五项 attachment capability 齐全时开放选择、拖放/粘贴和提交。Windows 原生选择器读取用户所选本机文件；Renderer DOM 文件传有界字节，不接受任何客户端提交的 Host 文件路径。
- 单个附件最多 16 MiB、一次最多 8 个、每块最多 256 KiB。Host 从实际落盘文件验证 SHA-256；乱序/重复块、大小不符、源文件变化和不支持的图片明确拒绝。图片继续通过既有 nativeImage 处理到 2000×2000、4.5 MiB base64 以内，之后作为 Pi 原生 ImageContent 提交；普通文件仍只提交 Host 的 `@路径` 引用。
- 上传编号绑定 controller/Project/Session；移除或取消请求清理未提交副本，断线时无法确认的清理由 Host 过期机制处理。draft 在 15 分钟后失效、每分钟清理，Host 重启也清理未提交副本。暂存总量最多 64 项/128 MiB，每 controller 最多 8 项。
- 提交前校验并一次性消费编号，提交结果不确定时提示先检查对话，不能自动重试同一附件编号。已提交文件在 `<Linux userData>/desktop-attachments/submitted` 保留，以免删除 Pi 后续仍需读取的路径；自动过期只作用于 draft。
- 上传完成后，Renderer 附件草稿只保留引用、名称、类型和大小，不缓存远程绝对路径或附件正文；拖放和粘贴时会临时读取有界文件字节用于上传。本地/WSL 附件规则和 Web Remote allowlist 不变。真实 Windows 原生选择器→SSH→Linux 验收仍待准备 Host。

### 远程项目选择（R3）

- 已配对的桌面用户可从 Host 主目录开始浏览、返回上级或输入 Linux 绝对路径。Host 只返回目录名称、路径和链接标记，不读取普通文件正文；Web Remote 不开放此能力。
- 每次最多扫描 2,000 个条目、返回 200 个目录，响应预算 512 KiB；目录过多、无法表示的路径与不可访问链接会提示结果不完整。目录不存在、不是目录、无权限或循环链接返回明确错误。
- 符号链接通过 Host 解析为实际目录。注册时再次验证 canonical path；路径变化、过期 controller 或 Project/Session 身份变化拒绝写入。注册复用 `ProjectStore` 和唯一 `WorkbenchKernel`，重复添加不创建第二份记录，也不直接启动 Runtime。
- 项目启动仍使用现有信任请求。桌面只能回答匹配当前请求的已注册 Project；取消不创建 Runtime。仅当三个命令同时可用时，Renderer 显示远程添加入口。本地/WSL 继续使用原生目录选择。
- Renderer 的取消、路径编辑、导航、卸载和断线会使旧目录响应失效；添加等待 mutation acknowledgement，阻止重复提交。注册失败保留可重试的错误。真实 Windows→SSH→Linux 验收仍待进行。

后续能力只能通过 shared contract、Host allowlist、Windows client 和同 commit 测试一起增加；完整桌面界面存在不代表所有本地功能自动成为远程功能。

## 明确不做

- LAN/WAN 直接监听或端口映射。
- 云端 relay、账户体系或自动主机发现。
- Web Remote Cookie/Origin/Trusted Proxy 兼容分支。
- SSH 密码保存、自动接受 Host Key 或关闭 SSH 检查。
- Windows 本地 Pi、路径翻译、文件同步或多 Host。
- 网络失败后的 mutation 自动重试。

## SSH 配置发现（R8）

Windows 连接页的“从 SSH 配置选择主机”通过本机窄 IPC 读取 `%USERPROFILE%/.ssh/config` 与 `%ProgramData%/ssh/ssh_config`。Main 返回静态 `Host` 别名及文件/行号；支持多别名、双引号、注释、等号，以及静态 Include 的相对路径、绝对路径、主目录和常见通配符。Include 的相对基准保持用户或系统 SSH 目录；去重保留首次来源。

读取不执行 `ssh -G`、Match/Proxy/LocalCommand，不读取 IdentityFile 指向的私钥。Match 条件不求值，Include 中出现动态路径、未知模式、缺失、格式错误或循环会显示诊断；候选不能证明最终配置生效或 Host 在线。文件数最多 64、Include 深度最多 8、目录扫描最多 4096 项、配置总量最多 1 MiB、候选最多 256；超限明确失败，不静默截断。实际连接仍走既有系统 OpenSSH 与 Host 握手。

读取由用户点击触发，刷新不改手填 alias，不自动连接。选择候选只填入 alias 并清空旧配对码，保留两个端口；连接/恢复期间禁用发现与选择，卸载或开始连接后丢弃迟到结果。候选来源和诊断在连接页内展示；读取失败或未发现候选时仍可手填。

配置语法与路径依据：[OpenSSH ssh_config](https://man.openbsd.org/ssh_config)、[Microsoft Windows OpenSSH 配置](https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh-server-configuration)。R8 不替代 R9 Host 启动检查、R10 多主机与凭证管理，也不计为真实 SSH 验收。

## Host 连接检查（R9）

Windows 连接页的“检查 Host”不需要配对码。它复用正式连接的配置校验、系统 OpenSSH 隧道与无凭证兼容性握手：依次检查所填本机 loopback 端口能否监听、系统 SSH 程序、别名配置是否含额外转发、SSH 登录及本机转发就绪，以及 Desktop Host 的协议/产品/源码版本。端口检查后立即关闭探针；正式隧道仍必须取得实际监听成功证据，不能把预检当作端口预约。

结果逐项显示通过、失败或未完成，首次失败后不运行后续阶段；只有握手完成且临时隧道释放成功才返回整体验证通过。通过仅证明检查时的连接条件，正式连接仍重做握手和设备认证；不安装、启动或升级远端 Host 服务。

`desktop-client.check-host` 与取消命令位于 Windows Main 本机 IPC，由严格 operation ID 与 Host 配置绑定。检查期间 Session 使用 `checking` 状态，拒绝另一检查、正式连接与 Kernel 命令。检查不调用 pair、logout、SSE、Kernel snapshot 或任务命令，不读取/修改凭证和最后成功主机。取消绑定原 operation ID，关闭客户端等待检查清理，旧取消请求不能终止新检查。

SSH 配置检查和整个启动等待受取消信号及启动时限控制；Host HTTP 握手跟随连接/检查取消。启动失败时停止进程的错误不再被忽略，错误携带仍被拥有的隧道；Session 保留它供关闭重试，不能把释放失败报告为检查成功。Renderer 修改目标参数后清除旧结果，卸载取消自己的检查并丢弃迟到响应。

## 相关文档

- 产品边界：[`product-boundary.md`](product-boundary.md)
- 架构：[`architecture.md`](architecture.md)
- 决策：[`decisions.md`](decisions.md)（D-067）
- Web Remote：[`remote-access.md`](remote-access.md)
- Shared contract：[`../src/shared/desktop-host-contract.ts`](../src/shared/desktop-host-contract.ts)


## 多主机配置与凭证管理（R10）

连接页最多保存 32 套主机配置，支持选择、新建、编辑与删除；名称最多 80 字符，留空保存时使用 SSH 别名作为默认名称。相同 SSH 别名与 Host 端口不能重复保存。先保存配置，再连接；未保存的输入仍可进行 Host 检查。普通断开后可选择另一套配置，连接、恢复、检查或收尾期间不能修改列表。

WindowsRemoteHostManager 拥有配置列表和当前 WindowsRemoteSession，只有当前选中配置的凭证进入该 Session。名称和本机转发端口修改保留配对；SSH 别名或 Host 端口改变时生成新的凭证槽编号，并删除旧槽，下一次连接需要新的配对码。配置文件与列表响应均不含凭证；凭证槽编号仅存在 Main 配置存储，Renderer 只收到配置编号、名称和端口。

删除配置或“忘记凭证”只移除本机数据，不向 Host 发送撤销。需要撤销访问时，先连接目标 Host，再使用“取消配对”。删除当前配置后回到空白新主机草稿，不自动选择其他主机。配置变更携带观察到的列表 revision，连接同时携带所选配置编号与 revision；旧选择、旧确认和未保存目标不能发起连接。

`desktop-client-hosts.json` 使用严格 schema、128 KiB 读取上限、临时文件写入及原子替换。首次升级先持久化旧 `desktop-client-host.json` 的迁移目标，再将旧 `PiGUI/DesktopHost` 凭证复制到独立槽，清理旧槽和旧文件；中断后继续同一目标，不覆盖目标槽已有凭证。旧凭证缺少配套主机配置时不自动归属新主机，也不擅自删除它。已有多主机文件损坏时明确失败，不退回旧文件或空配置。

编辑端点、删除配置和忘记凭证先持久化新的配置及待删凭证槽，再处理 Credential Manager。删除中断时保留待办；连接页展示失败并提供“重试配置与凭证操作”。未完成处理前阻止新连接与配置编辑，重启也会继续处理待办，避免旧凭证被重新归到其他主机。

每次成功连接都有 Windows Main 生成的独立连接编号，断线后失效，恢复连接使用新编号。preload 将编号与观察到的项目/会话身份一起提交给 Windows Main；编号只用于本机 IPC，不进入 Host 网络协议。旧 Kernel/Git/撤销请求不能作用于另一连接，即使两台主机使用相同的项目路径和会话编号。原生文件选择、分块上传与失败清理在操作开始时绑定连接，迟到的选择结果不能上传到新 Host。迟到的 get-status 响应也不能覆盖已经收到的新连接状态。
