#!/bin/bash
set -euo pipefail

PROVIDER_ID="third_party"
KEYCHAIN_SERVICE="codex-third-party-api-key"
CODEX_DIR="${HOME}/.codex"
CONFIG_FILE="${CODEX_DIR}/config.toml"
MACOS_ACCOUNT="$(id -un)"
DEFAULTS_BEGIN="# >>> codex-third-party defaults >>>"
DEFAULTS_END="# <<< codex-third-party defaults <<<"
PROVIDER_BEGIN="# >>> codex-third-party provider >>>"
PROVIDER_END="# <<< codex-third-party provider <<<"

BODY_FILE=""
OUTPUT_FILE=""

cleanup() {
  [[ -z "${BODY_FILE}" ]] || rm -f "${BODY_FILE}"
  [[ -z "${OUTPUT_FILE}" ]] || rm -f "${OUTPUT_FILE}"
}
trap cleanup EXIT

fail() {
  printf 'Error: %s\n' "$1" >&2
  exit 1
}

toml_escape() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  printf '%s' "${value}"
}

reject_multiline() {
  local label="$1"
  local value="$2"
  case "${value}" in
    *$'\n'*|*$'\r'*) fail "${label} must be a single line." ;;
  esac
}

[[ "$(uname -s)" == "Darwin" ]] || fail "This installer is for macOS."
[[ -x /usr/bin/security ]] || fail "macOS Keychain command /usr/bin/security was not found."
command -v awk >/dev/null 2>&1 || fail "awk was not found."

printf '\nCodex Desktop third-party platform setup\n'
printf 'The platform must implement the OpenAI Responses API, including streaming.\n\n'

read -r -p "API base URL (example: https://api.example.com/v1): " BASE_URL
read -r -p "Model ID exposed by the platform: " MODEL_ID
read -r -s -p "API key (stored in macOS Keychain): " API_KEY
printf '\n'

[[ -n "${BASE_URL}" ]] || fail "API base URL is required."
[[ -n "${MODEL_ID}" ]] || fail "Model ID is required."
[[ -n "${API_KEY}" ]] || fail "API key is required."
reject_multiline "API base URL" "${BASE_URL}"
reject_multiline "Model ID" "${MODEL_ID}"
reject_multiline "API key" "${API_KEY}"

case "${BASE_URL}" in
  https://*|http://localhost*|http://127.0.0.1*) ;;
  *) fail "Use an https:// URL, or an http:// localhost URL for a local service." ;;
esac

BASE_URL="${BASE_URL%/}"
ESCAPED_BASE_URL="$(toml_escape "${BASE_URL}")"
ESCAPED_MODEL_ID="$(toml_escape "${MODEL_ID}")"
ESCAPED_ACCOUNT="$(toml_escape "${MACOS_ACCOUNT}")"

mkdir -p "${CODEX_DIR}"
chmod 700 "${CODEX_DIR}"
BODY_FILE="$(mktemp "${CODEX_DIR}/config.toml.body.XXXXXX")"
OUTPUT_FILE="$(mktemp "${CODEX_DIR}/config.toml.new.XXXXXX")"

if [[ -f "${CONFIG_FILE}" ]]; then
  BACKUP_FILE="$(mktemp "${CONFIG_FILE}.backup.XXXXXX")"
  cp -p "${CONFIG_FILE}" "${BACKUP_FILE}"
  printf 'Backup: %s\n' "${BACKUP_FILE}"

  awk -v defaults_begin="${DEFAULTS_BEGIN}" \
      -v defaults_end="${DEFAULTS_END}" \
      -v provider_begin="${PROVIDER_BEGIN}" \
      -v provider_end="${PROVIDER_END}" '
    $0 == defaults_begin { skip = 1; next }
    $0 == defaults_end { skip = 0; next }
    $0 == provider_begin { skip = 1; next }
    $0 == provider_end { skip = 0; next }
    skip { next }
    !seen_table && /^[[:space:]]*\[/ { seen_table = 1 }
    !seen_table && /^[[:space:]]*(model|model_provider)[[:space:]]*=/ { next }
    { print }
  ' "${CONFIG_FILE}" > "${BODY_FILE}"
else
  : > "${BODY_FILE}"
fi

if grep -Eq '^[[:space:]]*\[model_providers\.third_party(\.auth)?\][[:space:]]*$' "${BODY_FILE}"; then
  fail "${CONFIG_FILE} already contains an unmanaged ${PROVIDER_ID} provider. Rename or remove it, then rerun."
fi

{
  printf '%s\n' "${DEFAULTS_BEGIN}"
  printf '# Managed by mac-codex-third-party/install.command\n'
  printf 'model = "%s"\n' "${ESCAPED_MODEL_ID}"
  printf 'model_provider = "%s"\n' "${PROVIDER_ID}"
  printf '%s\n\n' "${DEFAULTS_END}"
  cat "${BODY_FILE}"
  printf '\n%s\n' "${PROVIDER_BEGIN}"
  printf '[model_providers.%s]\n' "${PROVIDER_ID}"
  printf 'name = "Third-party OpenAI-compatible platform"\n'
  printf 'base_url = "%s"\n' "${ESCAPED_BASE_URL}"
  printf 'wire_api = "responses"\n\n'
  printf '[model_providers.%s.auth]\n' "${PROVIDER_ID}"
  printf 'command = "/usr/bin/security"\n'
  printf 'args = ["find-generic-password", "-a", "%s", "-s", "%s", "-w"]\n' \
    "${ESCAPED_ACCOUNT}" "${KEYCHAIN_SERVICE}"
  printf 'timeout_ms = 5000\n'
  printf 'refresh_interval_ms = 0\n'
  printf '%s\n' "${PROVIDER_END}"
} > "${OUTPUT_FILE}"

if command -v python3 >/dev/null 2>&1 && python3 -c 'import tomllib' >/dev/null 2>&1; then
  python3 - "${OUTPUT_FILE}" <<'PY'
import pathlib
import sys
import tomllib

with pathlib.Path(sys.argv[1]).open("rb") as config_file:
    tomllib.load(config_file)
PY
fi

/usr/bin/security add-generic-password \
  -U \
  -a "${MACOS_ACCOUNT}" \
  -s "${KEYCHAIN_SERVICE}" \
  -w "${API_KEY}" >/dev/null

chmod 600 "${OUTPUT_FILE}"
mv "${OUTPUT_FILE}" "${CONFIG_FILE}"
OUTPUT_FILE=""

/usr/bin/security find-generic-password \
  -a "${MACOS_ACCOUNT}" \
  -s "${KEYCHAIN_SERVICE}" \
  -w >/dev/null

printf '\nDone: %s\n' "${CONFIG_FILE}"
printf 'Provider: %s\n' "${PROVIDER_ID}"
printf 'Model: %s\n' "${MODEL_ID}"
printf 'Base URL: %s\n' "${BASE_URL}"
printf '\nFully quit Codex Desktop (Command-Q), then reopen it.\n'
printf 'If the platform does not support POST /responses streaming, this configuration will not work.\n\n'

read -r -p "Press Return to close..." _ || true
