# R12 共享接口（阶段 0 第 5 步）

> 状态：2026-09-29 用户确认，已冻结。A/B/C 只按本文实现；需要改动时由主线修改本文并通知相关任务。
> 范围：Desktop Host（SSH）多设备配对。Web Remote 的单设备模型、DTO 和协议完全不变。

## 1. 协议与数据版本

| 项目 | 当前 | R12 |
| --- | --- | --- |
| `DESKTOP_HOST_PROTOCOL_VERSION` | 2 | **3**，双方必须完全相等 |
| Desktop 设备文件 | 版本 1 单记录（`RemoteDeviceStore`） | 版本 2 集合（`openDesktopDeviceStore`），路径不变：`${PI_GUI_DESKTOP_HOST_TOKEN_FILE}.desktop-device` |
| `package.json` → `desktopHost.deviceStoreVersions` | `[1]` | `[1, 2]`，与 Main 改用版本 2 集合放在同一候选中 |

- 版本 3 客户端遇到版本 2 的 Host，或反过来，都在匿名握手阶段报“不兼容”并停止，不发送凭证，也不降级。产品版本和构建摘要仍须完全一致（现有规则）。
- Main 第一次以新版本启动时，由 `openDesktopDeviceStore` 原子迁移旧的版本 1 文件；之后只含版本 1 读取能力的发行版由现有 D-093 检查拒绝启动和回退。

## 2. 无凭证身份核对

**请求**：`GET /api/desktop-host/session`，不带 `Authorization`。已有凭证的客户端附带请求头：

```text
x-pi-gui-pairing-id: <desktopPairingId(credential)>   // 64 位小写十六进制
```

请求头格式错误时返回 400。没有凭证（首次配对）时不带这个请求头。

**响应** `DesktopHostSessionStatus`（版本 3）：

```ts
type DesktopHostSessionStatus = {
  protocolVersion: 3
  productVersion: string
  buildCommit: string | null
  authenticated: boolean          // 只有带有效 Bearer 时为 true
  pairingKnown: boolean | null    // 未带请求头时为 null；否则表示该身份当前是否为有效配对
  capabilities: DesktopHostCapabilities
}
```

- 删除版本 2 的 `pairingId` 字段。Host 不列出、不计数其他设备。
- 客户端规则：`pairingKnown !== true` 时不发送凭证，报 `credential-target` 类错误：“此设备在该 Host 上没有有效配对（可能已撤销、已过期，或连接到了另一台 Host）。原凭证未发送。”本地凭证不自动删除（沿用 D-087）。
- 继续复用 `desktop-device-binding.ts` 的 `desktopPairingId` / `desktopPairingIdFromHash`；凭证和认证哈希不进入 Renderer。

## 3. 设备列表与撤销（仅 Linux Host 本机管理）

```ts
type DesktopHostDeviceSummary = {
  deviceId: string        // 即公开配对身份 pairingId，64 位小写十六进制
  label: string | null    // 配对时由 Windows 客户端带上的计算机名；旧记录为 null
  pairedAt: number
  expiresAt: number
  controlling: boolean    // 是否持有当前控制连接
}

type DesktopHostAccessStatus =
  | { enabled: false }
  | { enabled: true; endpoint: string; devices: DesktopHostDeviceSummary[] }  // 替换原 device 字段
```

- `devices` 只含当前有效（未过期）的设备，按 `pairedAt` 升序，最多 8 项。过期记录不显示，在下一次配对时由存储清理。
- RemoteAdmin 命令：
  - `remote-admin.get-desktop-host-status`：不变，返回新的状态。
  - `remote-admin.create-desktop-host-pairing-code`：已有 8 台有效设备时直接报错“Host 已有 8 台配对设备，请先撤销一台。”，不生成配对码。
  - `remote-admin.revoke-desktop-host-device`：改为 `{ type, deviceId }`（原来无参数）。返回新的状态。`deviceId` 不在当前列表中时报错“设备不存在或已撤销”，界面随后刷新列表。写盘失败时报错，但该设备已在内存中立即失去授权（沿用存储层语义），重复撤销会重试写盘。
- Gateway 对外提供 `listDevices()` 和 `revokeDevice(deviceId)`；设置页和以后的命令行（D-095）都调用这两个函数。

## 4. 控制连接归属

当前控制连接记录为 `{ 设备认证哈希, controllerId, SSE 响应 }`。

| 请求 | 条件 | 结果 |
| --- | --- | --- |
| `GET events` | 没有控制连接 | 成为控制连接 |
| | 同一设备、同一 `controllerId` | 替换旧流（断线重连，现有行为） |
| | 同一设备、不同 `controllerId` | 409 “Another desktop controller is active.”（现有） |
| | **不同设备** | 409 “Another desktop device is controlling this Host.”（新增，表示被占用） |
| `GET state` / `POST command` | 凭证所属设备和 `controllerId` 都与控制连接一致 | 执行；每次 await 之后复核（现有做法，改为按设备复核） |
| | 任一不一致 | 409 `conflict` “Controller event stream is not active.”（现有） |

- **新设备配对不再关闭当前控制连接**（版本 2 会关闭）。
- 撤销（Host 管理或客户端登出）**当前控制设备**：立即关闭它的事件流，在途请求在下一次复核时得到 401。撤销**其他设备**不影响控制连接。
- 控制设备过期：在下一次心跳或事件推送时关闭（现有逻辑，改为按设备判断）。
- 不自动抢占，也不排队。客户端收到“被占用”的 409 后显示明确状态，**不进入自动重连循环**；用户可稍后手动重试。

## 5. 客户端取消配对

- `POST /api/desktop-host/logout` 带 Bearer：只撤销该凭证对应的设备；只有该设备正在控制时才关闭控制连接。
- 响应为版本 3 的 `DesktopHostSessionStatus`，其中 `authenticated: false`，`pairingKnown: false`（Host 按刚撤销的身份作答）。
- 客户端只有看到 `authenticated === false && pairingKnown === false` 才视为确认，随后删除本 Host 配置的本地凭证；否则沿用现有“未确认撤销”错误并保留凭证。不影响其他 Host 配置的凭证。
- 未认证的登出仍返回 401。

## 6. 管理权限

- 列出和撤销设备只能通过 Linux Host 本机的 RemoteAdmin IPC（设置页），以及以后 D-095 的本机命令行。
- Desktop Host HTTP 接口**不新增**任何设备管理入口，`capabilities` 不变；SSH 客户端只能取消自己的配对。

## 7. 文件格式兼容

- 在同一候选里：Main 改用版本 2 集合，`deviceStoreVersions` 改为 `[1, 2]`，D-093 的检查链不变。
- 升级后首次启动完成迁移；此后回退到只声明 `[1]` 的发行版会被拒绝，配对文件保持原样。

## 8. 客户端错误分类（供 B/C 使用）

`desktop-client-contract.ts` 的 `DesktopConnectionFailureKind` 新增 `occupied`：

| 类型 | 触发 | 界面表现 |
| --- | --- | --- |
| `occupied` | `GET events` 返回“不同设备”409 | “该 Host 正被另一台设备使用”，提供手动重试，不自动重连 |
| `credential-target`（现有） | `pairingKnown !== true` | 按第 2 节文案提示重新配对，凭证未发送 |

撤销导致的 401 沿用现有 `authentication` 类型；`occupied` 与 `authentication` 都不属于 `network`，因此不会触发现有的自动重连。

## 9. 文件归属

| 部分 | 负责方 | 文件 |
| --- | --- | --- |
| 共享契约与接线 | 主线 | `shared/desktop-host-contract.ts`、`shared/remote-admin-contract.ts`、`shared/desktop-client-contract.ts`、`remote/desktop-device-binding.ts`、`main/index.ts`、`preload/index.ts`、`package.json` |
| Host 端 | A | 见重启计划 A 行 |
| Windows 客户端 | B | 见重启计划 B 行 |
| 设备管理界面 | C | 见重启计划 C 行 |

## 设备名称

配对请求增加可选字段 `label`：Windows 客户端自动带上本机计算机名，去掉首尾空白和控制字符后截断到 80 字符，结果为空时不带。Host 按 `desktop-device-store.ts` 的规则校验，不合格时按无名称保存，不因名称拒绝配对。R12 不提供改名。界面在名称为空时显示“未命名设备”。
