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
mkdir -p "$base/releases"
candidate=$(mktemp -d "$base/releases/release.XXXXXXXX")
cleanup() { if [ -n "$candidate" ]; then rm -rf -- "$candidate"; fi; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
tar -xf "$archive" -C "$candidate"
cd "$candidate"
node scripts/verify-build.mjs
if [ -L "$base/current" ] && cmp -s out/main/build-identity.json "$base/current/out/main/build-identity.json"; then
  (cd "$base/current" && node scripts/verify-build.mjs && ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron -e 'process.exit(0)')
  echo "Reusing verified WSL backend: $base/start-host.sh"
  exit 0
fi
# Each release owns its dependencies; the active release is never installed into.
ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm install --frozen-lockfile
if [ ! -x node_modules/electron/dist/electron ]; then
  # Use a bounded system download; @electron/get can stall on this host's network.
  command -v unzip >/dev/null
  expected=$(node -p "require('./node_modules/electron/checksums.json')['electron-v43.1.1-linux-x64.zip']")
  if ! printf '%s  %s\n' "$expected" "$base/downloads/electron.zip" | sha256sum -c - >/dev/null 2>&1; then
    echo 'Downloading the pinned Electron binary...'
    curl -fL --retry 2 --connect-timeout 20 --max-time 300 -o "$base/downloads/electron.zip" https://github.com/electron/electron/releases/download/v43.1.1/electron-v43.1.1-linux-x64.zip
  fi
  printf '%s  %s\n' "$expected" "$base/downloads/electron.zip" | sha256sum -c -
  unzip -q -o "$base/downloads/electron.zip" -d node_modules/electron/dist
  printf electron > node_modules/electron/path.txt
fi
node scripts/verify-build.mjs
ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron -e 'console.log("Electron runtime ready")'
cp scripts/start-wsl-host.sh "$base/start-host.next.sh"
chmod 700 "$base/start-host.next.sh"
previous=''
if [ -L "$base/current" ]; then
  previous=$(readlink "$base/current")
elif [ -e "$base/current" ]; then
  echo 'WSL current release pointer is not a symlink.' >&2
  exit 1
fi
ln -sfn "$candidate" "$base/current.next"
mv -Tf "$base/current.next" "$base/current"
candidate=''
mv -f "$base/start-host.next.sh" "$base/start-host.sh"
if [ -n "$previous" ]; then
  ln -sfn "$previous" "$base/previous.next"
  mv -Tf "$base/previous.next" "$base/previous"
fi
# Keep the current and immediately previous release; remove only our retired releases.
current=$(readlink "$base/current")
for retired in "$base"/releases/release.*; do
  if [ -d "$retired" ] && [ "$retired" != "$current" ] && [ "$retired" != "$previous" ]; then
    rm -rf -- "$retired"
  fi
done
echo "WSL backend ready: $base/start-host.sh"
