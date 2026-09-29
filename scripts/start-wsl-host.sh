#!/bin/sh
set -eu
base="${XDG_DATA_HOME:-$HOME/.local/share}/pi-gui-next-wsl"
exec 9>"$base/host.lock"
if ! flock -n 9; then
  echo 'Pi GUI WSL backend is already running. Close it before starting another client.' >&2
  exit 1
fi
cd "$base/current"
export PATH="$base/node/bin:$base/tooling/node_modules/.bin:$PWD/node_modules/.bin:$PATH"
unset ELECTRON_RUN_AS_NODE PI_GUI_WSL_HOST PI_GUI_WSL_DISTRO PI_GUI_WSL_LAUNCHER PI_GUI_PROBE_ONLY ELECTRON_RENDERER_URL NODE_ENV_ELECTRON_VITE NODE_OPTIONS
node scripts/verify-build.mjs >&2
export PI_GUI_PI_EXECUTABLE="$PWD/node_modules/@earendil-works/pi-coding-agent/dist/cli.js"
# The Node Host (D-095) serves the Windows client over this stdio pipe; no display is needed.
# --use-env-proxy lets Node fetch honor HTTP(S)_PROXY like Chromium did under Electron.
exec node --use-env-proxy out/main/pi-host.js wsl
