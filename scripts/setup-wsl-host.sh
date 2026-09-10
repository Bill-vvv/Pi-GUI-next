#!/bin/sh
set -eu
archive="$1"
base="${XDG_DATA_HOME:-$HOME/.local/share}/pi-gui-next-wsl"
mkdir -p "$base"
exec 9>"$base/host.lock"
if ! flock -n 9; then
  echo 'Close the Pi GUI WSL client before updating its backend.' >&2
  exit 1
fi
if [ "$(uname -m)" != x86_64 ]; then
  echo 'This setup currently supports WSL x86_64 only.' >&2
  exit 1
fi
if [ ! -x "$base/node/bin/node" ]; then
  echo 'Installing isolated Node.js 26.4.0 for the WSL backend...'
  mkdir -p "$base/downloads" "$base/node"
  curl -fL --retry 2 --connect-timeout 20 --max-time 300 -o "$base/downloads/node.tar.xz" https://nodejs.org/dist/v26.4.0/node-v26.4.0-linux-x64.tar.xz
  curl -fL --retry 2 --connect-timeout 20 --max-time 60 -o "$base/downloads/SHASUMS256.txt" https://nodejs.org/dist/v26.4.0/SHASUMS256.txt
  expected=$(awk '$2 == "node-v26.4.0-linux-x64.tar.xz" { print $1 }' "$base/downloads/SHASUMS256.txt")
  test -n "$expected"
  printf '%s  %s\n' "$expected" "$base/downloads/node.tar.xz" | sha256sum -c -
  tar -xJf "$base/downloads/node.tar.xz" -C "$base/node" --strip-components=1
fi
export PATH="$base/node/bin:$base/tooling/node_modules/.bin:$PATH"
test "$(node --version)" = v26.4.0
if [ ! -x "$base/tooling/node_modules/.bin/pnpm" ]; then
  npm install --prefix "$base/tooling" --no-audit --no-fund pnpm@11.9.0
fi
mkdir -p "$base/app"
tar -xf "$archive" -C "$base/app"
cd "$base/app"
pnpm install --frozen-lockfile
node -e "console.log(require('electron'))"
cp scripts/start-wsl-host.sh "$base/start-host.sh"
chmod 700 "$base/start-host.sh"
echo "WSL backend ready: $base/start-host.sh"
