#!/bin/sh
set -eu
base="${XDG_DATA_HOME:-$HOME/.local/share}/pi-gui-next-wsl"
exec 9>"$base/host.lock"
if ! flock -n 9; then
  echo 'Pi GUI WSL backend is already running. Close it before starting another client.' >&2
  exit 1
fi
cd "$base/app"
export PATH="$base/node/bin:$base/tooling/node_modules/.bin:$PWD/node_modules/.bin:$PATH"
unset ELECTRON_RUN_AS_NODE PI_GUI_WSL_DISTRO ELECTRON_RENDERER_URL NODE_ENV_ELECTRON_VITE ELECTRON_ENABLE_LOGGING
export DISPLAY="${DISPLAY:-:0}"
export WAYLAND_DISPLAY="${WAYLAND_DISPLAY:-wayland-0}"
export PI_GUI_WSL_HOST=1
export PI_GUI_PI_EXECUTABLE="$PWD/node_modules/@earendil-works/pi-coding-agent/dist/cli.js"
chmod +x "$PI_GUI_PI_EXECUTABLE"
exec "$PWD/node_modules/electron/dist/electron" --no-sandbox --disable-gpu --disable-dev-shm-usage --disable-logging .
