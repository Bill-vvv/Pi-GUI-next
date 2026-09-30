# Windows GUI + WSL 安装版

此版本是本地体验版：Windows x64 运行 GUI，Ubuntu-24.04 / WSL2 x86_64 运行 Pi 0.99.0、项目和会话。安装包未签名，不代表已完成正式发布 gate。

## 安装

1. Windows 需已启用 WSL2，并安装、初始化 Ubuntu-24.04，使用普通用户作为默认用户。未安装时，在管理员终端执行 `wsl --install -d Ubuntu-24.04`，按系统提示重启并完成 Ubuntu 用户初始化。
2. 在 Ubuntu 中准备 `curl`、`unzip`、`util-linux` 以及 Electron 所需桌面库；Ubuntu 24.04 可执行：`sudo apt-get update && sudo apt-get install -y curl unzip util-linux libnss3 libatk-bridge2.0-0 libgtk-3-0t64 libasound2t64 libgbm1`。WSLg 必须可用。
3. 关闭已有 Pi GUI WSL 窗口，运行 `pi-gui-next-<version>-win-x64-setup.exe`。安装详情中可查看 WSL 部署进度。首次安装联网获取隔离的 Node 26.4.0、pnpm 11.9.0、Electron 和依赖；Windows 不需要 Node、pnpm 或源码。
4. 安装完成后启动 Pi GUI。没有既有环境偏好时默认使用 Ubuntu-24.04；已有用户可在运行环境中选择 WSL。模型凭据、项目和会话仍由 WSL 管理。

升级运行新的安装程序，后端安装成功后切换 `~/.local/share/pi-gui-next-wsl/current`，保留上一后端版本。后端正在使用时安装明确失败，不终止工作中的 Pi。卸载 Windows GUI 不删除 WSL 项目、会话、Pi 配置或后端数据。

## 构建

在 Windows x64、项目锁定的 Node 26.4.0 和平台独立依赖环境中执行：

```powershell
pnpm package:win:wsl
# 可显式指定体验版号：
node scripts/package-win-wsl.mjs 0.0.1-wsl.20260928
```

输出位于 `release/`：NSIS 安装程序、SHA-256 文件和包含源码/产物摘要的 JSON。打包不修改源码版本号，不创建 tag，不上传 GitHub Release。客户端与后端使用同一份构建清单；安装后握手继续校验产物摘要。
