#!/usr/bin/env bash

set -euo pipefail

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$project_dir"

if ! command -v pnpm >/dev/null 2>&1; then
  echo "错误：未找到 pnpm，请先安装 pnpm 11.9.0。" >&2
  exit 1
fi

if [[ ! -d node_modules ]]; then
  echo "错误：项目依赖尚未安装，请先运行：pnpm install --frozen-lockfile" >&2
  exit 1
fi

exec pnpm dev "$@"
