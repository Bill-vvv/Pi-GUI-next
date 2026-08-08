#!/usr/bin/env bash
# Prepare an internal machine-secret file and a non-secret environment file for Remote v2.
# The secret never leaves Main and is not a phone login credential.
# This script never edits firewall/Lucky/systemd and never starts or restarts Pi GUI.

set -euo pipefail
umask 077

usage() {
  cat <<'EOF'
Usage:
  scripts/setup-remote-access.sh \
    --public-origin https://pi-gui.example.com \
    --trusted-proxy 192.168.1.1 \
    --bind-host 192.168.1.50 \
    --port 18787 \
    [--token-file /absolute/path] \
    [--write-env /absolute/path | --print-env]

Defaults:
  internal machine-secret file: ${XDG_CONFIG_HOME:-$HOME/.config}/pi-gui-next/remote.token
  output: print the non-secret environment template when --write-env is omitted
EOF
}

fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

is_exact_ipv4() {
  local value="$1" IFS=. octet
  [[ "$value" =~ ^(0|[1-9][0-9]{0,2})(\.(0|[1-9][0-9]{0,2})){3}$ ]] || return 1
  read -r -a octets <<<"$value"
  for octet in "${octets[@]}"; do
    ((10#$octet <= 255)) || return 1
  done
}

validate_origin() {
  node --input-type=module - "$1" <<'NODE'
const value = process.argv[2]
let url
try {
  url = new URL(value)
} catch {
  process.exit(1)
}
if (
  url.protocol !== 'https:' ||
  url.username !== '' ||
  url.password !== '' ||
  url.pathname !== '/' ||
  url.search !== '' ||
  url.hash !== '' ||
  value !== url.origin
) {
  process.exit(1)
}
NODE
}

assert_regular_path_or_missing() {
  local path="$1" label="$2" parent
  [[ ! -L "$path" ]] || fail "$label must not be a symlink: $path"
  if [[ -e "$path" ]]; then
    [[ -f "$path" ]] || fail "$label must be a regular file: $path"
  fi
  parent="$(dirname -- "$path")"
  [[ ! -L "$parent" ]] || fail "$label parent must not be a symlink: $parent"
  mkdir -p -- "$parent"
  [[ -d "$parent" && ! -L "$parent" ]] || fail "$label parent is not a safe directory: $parent"
}

validate_token_file() {
  local path="$1" mode owner uid
  [[ -f "$path" && ! -L "$path" ]] || fail "token file must be a regular non-symlink: $path"
  mode="$(stat -c '%a' -- "$path")"
  owner="$(stat -c '%u' -- "$path")"
  uid="$(id -u)"
  [[ "$owner" == "$uid" ]] || fail "token file must be owned by uid $uid: $path"
  [[ "$mode" == '600' ]] || fail "token file mode must be exactly 0600: $path (mode $mode)"
  node --input-type=module - "$path" <<'NODE' || fail "token file must contain one line of 32 to 4096 trimmed characters without NUL bytes: $path"
import { readFileSync } from 'node:fs'
const value = readFileSync(process.argv[2], 'utf8')
const token = value.trim()
if (
  value.includes('\0') ||
  /[\r\n]/u.test(token) ||
  token.length < 32 ||
  token.length > 4096
) process.exit(1)
NODE
}

prepare_token_file() {
  local path="$1" temporary
  assert_regular_path_or_missing "$path" 'token file'
  if [[ -e "$path" ]]; then
    validate_token_file "$path"
    printf 'using existing token file: %s\n' "$path" >&2
    return
  fi
  temporary="$(mktemp -- "${path}.tmp.XXXXXX")"
  node --input-type=module <<'NODE' >"$temporary"
import { randomBytes } from 'node:crypto'
process.stdout.write(randomBytes(32).toString('hex'))
NODE
  chmod 0600 -- "$temporary"
  mv -- "$temporary" "$path"
  validate_token_file "$path"
  printf 'created token file: %s\n' "$path" >&2
}

shell_quote() {
  local value="${1//\'/\'\\\'\'}"
  printf "'%s'" "$value"
}

render_environment() {
  local token_file="$1" public_origin="$2" trusted_proxy="$3" bind_host="$4" port="$5"
  printf '%s\n' '# Pi GUI Remote v2 — generated non-secret environment'
  printf '%s\n' '# Source this file in the same shell that starts Pi GUI, then fully restart Main.'
  printf 'export PI_GUI_REMOTE_ENABLED=%s\n' "$(shell_quote '1')"
  printf 'export PI_GUI_REMOTE_BIND_HOST=%s\n' "$(shell_quote "$bind_host")"
  printf 'export PI_GUI_REMOTE_PORT=%s\n' "$(shell_quote "$port")"
  printf 'export PI_GUI_REMOTE_PUBLIC_ORIGIN=%s\n' "$(shell_quote "$public_origin")"
  printf 'export PI_GUI_REMOTE_TRUSTED_PROXY=%s\n' "$(shell_quote "$trusted_proxy")"
  printf 'export PI_GUI_REMOTE_TOKEN_FILE=%s\n' "$(shell_quote "$token_file")"
}

main() {
  require_command node
  require_command stat
  require_command id
  require_command mktemp
  require_command chmod
  require_command mv
  require_command mkdir

  local public_origin='' trusted_proxy='' bind_host='' port=''
  local token_file='' write_env='' print_env=0

  while (($# > 0)); do
    case "$1" in
      --public-origin|--trusted-proxy|--bind-host|--port|--token-file|--write-env)
        (($# >= 2)) || fail "$1 requires a value"
        case "$1" in
          --public-origin) public_origin="$2" ;;
          --trusted-proxy) trusted_proxy="$2" ;;
          --bind-host) bind_host="$2" ;;
          --port) port="$2" ;;
          --token-file) token_file="$2" ;;
          --write-env) write_env="$2" ;;
        esac
        shift 2
        ;;
      --print-env)
        print_env=1
        shift
        ;;
      -h|--help)
        usage
        return
        ;;
      *) fail "unknown argument: $1" ;;
    esac
  done

  [[ -n "$public_origin" ]] || fail '--public-origin is required'
  [[ -n "$trusted_proxy" ]] || fail '--trusted-proxy is required'
  [[ -n "$bind_host" ]] || fail '--bind-host is required'
  [[ -n "$port" ]] || fail '--port is required'
  validate_origin "$public_origin" || fail '--public-origin must be an exact HTTPS origin without path/query/fragment/trailing slash'
  is_exact_ipv4 "$trusted_proxy" || fail '--trusted-proxy must be one exact IPv4 address'
  is_exact_ipv4 "$bind_host" || fail '--bind-host must be one exact IPv4 address'
  [[ "$bind_host" != '0.0.0.0' ]] || fail '--bind-host must not be the wildcard address 0.0.0.0'
  [[ "$port" =~ ^[1-9][0-9]{0,4}$ ]] || fail '--port must be an exact integer from 1 to 65535'
  ((10#$port <= 65535)) || fail '--port must be an exact integer from 1 to 65535'

  if [[ -z "$token_file" ]]; then
    token_file="${XDG_CONFIG_HOME:-$HOME/.config}/pi-gui-next/remote.token"
  fi
  [[ "$token_file" == /* ]] || fail '--token-file must be absolute'
  [[ -z "$write_env" || "$write_env" == /* ]] || fail '--write-env must be absolute'

  prepare_token_file "$token_file"
  local environment
  environment="$(render_environment "$token_file" "$public_origin" "$trusted_proxy" "$bind_host" "$port")"

  if [[ -n "$write_env" ]]; then
    local temporary
    assert_regular_path_or_missing "$write_env" 'environment file'
    temporary="$(mktemp -- "${write_env}.tmp.XXXXXX")"
    printf '%s\n' "$environment" >"$temporary"
    chmod 0600 -- "$temporary"
    mv -f -- "$temporary" "$write_env"
    chmod 0600 -- "$write_env"
    printf 'wrote non-secret environment file: %s\n' "$write_env" >&2
  fi
  if [[ -z "$write_env" || "$print_env" -eq 1 ]]; then
    printf '%s\n' "$environment"
  fi

  cat >&2 <<EOF

Next:
  1. Configure Lucky HTTPS ${public_origin} -> http://${bind_host}:${port}.
  2. Preserve X-Forwarded-Host, set X-Forwarded-Proto=https, disable SSE buffering/cache,
     and use a long read timeout. Never WAN-forward ${port}.
  3. Restrict the PC firewall so only ${trusted_proxy} can reach ${port}.
  4. Fully stop Pi GUI, source the environment file/template, then foreground-restart Main.
  5. In desktop Pi GUI, open Settings -> Remote Access, generate a 6-digit code,
     then enter only that one-time code on the phone. Never copy ${token_file} to the phone.
See docs/remote-access.md.
EOF
}

main "$@"
