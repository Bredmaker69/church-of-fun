#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FUNCTIONS_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
VENV_DIR="${FUNCTIONS_DIR}/.venv-stable-ts"
ENV_FILE="${FUNCTIONS_DIR}/.env.local"
MODEL_NAME="${STABLE_TS_MODEL:-large-v3-turbo}"
ALIGN_SCRIPT="${FUNCTIONS_DIR}/scripts/stable_ts_align.py"
STABLE_TS_PIP_SPEC="${STABLE_TS_PIP_SPEC:-stable-ts==2.19.1}"
FORCE_ARM64="${FORCE_ARM64:-1}"

resolve_python_bin() {
  if [[ -n "${PYTHON_BIN:-}" ]]; then
    printf "%s" "${PYTHON_BIN}"
    return 0
  fi

  local candidates=(
    "/Library/Frameworks/Python.framework/Versions/3.13/bin/python3.13"
    "/opt/homebrew/bin/python3.13"
    "/usr/local/bin/python3.13"
    "python3.13"
    "/opt/homebrew/bin/python3.11"
    "/usr/local/bin/python3.11"
    "python3.11"
    "python3.10"
    "python3"
  )
  local candidate
  for candidate in "${candidates[@]}"; do
    if command -v "${candidate}" >/dev/null 2>&1; then
      printf "%s" "${candidate}"
      return 0
    fi
  done

  return 1
}

print_step() {
  printf "\n[%s] %s\n" "stable-ts-setup" "$1"
}

is_arm64_capable_host() {
  local arm_capable
  arm_capable="$(/usr/sbin/sysctl -n hw.optional.arm64 2>/dev/null || echo 0)"
  [[ "${arm_capable}" == "1" ]]
}

run_python_cmd() {
  if [[ "${USE_ARM64_LAUNCH}" == "1" ]]; then
    arch -arm64 "$@"
  else
    "$@"
  fi
}

upsert_env_key() {
  local key="$1"
  local raw_value="$2"
  local escaped_value
  escaped_value="$(printf "%s" "${raw_value}" | sed 's/\\/\\\\/g; s/\"/\\"/g')"
  local line="${key}=\"${escaped_value}\""

  touch "${ENV_FILE}"

  if grep -q "^${key}=" "${ENV_FILE}"; then
    local tmp_file
    tmp_file="$(mktemp)"
    awk -v key="${key}" -v line="${line}" '
      $0 ~ ("^" key "=") { print line; next }
      { print }
    ' "${ENV_FILE}" > "${tmp_file}"
    mv "${tmp_file}" "${ENV_FILE}"
  else
    printf "%s\n" "${line}" >> "${ENV_FILE}"
  fi
}

SELECTED_PYTHON="$(resolve_python_bin || true)"
if [[ -z "${SELECTED_PYTHON}" ]]; then
  echo "No supported Python runtime found."
  echo "Install Python 3.13, then retry."
  exit 1
fi

if ! command -v "${SELECTED_PYTHON}" >/dev/null 2>&1; then
  echo "Python executable not found: ${SELECTED_PYTHON}"
  echo "Set PYTHON_BIN to a valid interpreter, e.g. PYTHON_BIN=/usr/bin/python3"
  exit 1
fi

if [[ ! -f "${ALIGN_SCRIPT}" ]]; then
  echo "stable-ts align script is missing: ${ALIGN_SCRIPT}"
  exit 1
fi

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "ffmpeg is not installed. Install it first with: brew install ffmpeg"
  exit 1
fi

USE_ARM64_LAUNCH="0"
if [[ "${FORCE_ARM64}" == "1" ]] && is_arm64_capable_host && command -v arch >/dev/null 2>&1; then
  USE_ARM64_LAUNCH="1"
fi

print_step "Using Python runtime: ${SELECTED_PYTHON}"
if [[ "${USE_ARM64_LAUNCH}" == "1" ]]; then
  print_step "Launching Python commands in native arm64 mode"
fi
if [[ -d "${VENV_DIR}" ]]; then
  print_step "Resetting existing virtualenv at ${VENV_DIR}"
  rm -rf "${VENV_DIR}"
fi

print_step "Creating local virtualenv at ${VENV_DIR}"
run_python_cmd "${SELECTED_PYTHON}" -m venv "${VENV_DIR}"

print_step "Upgrading pip tooling"
run_python_cmd "${VENV_DIR}/bin/python" -m pip install --upgrade pip setuptools wheel

print_step "Installing stable-ts + runtime deps"
if ! run_python_cmd "${VENV_DIR}/bin/python" -m pip install --upgrade "${STABLE_TS_PIP_SPEC}" "yt-dlp[default]"; then
  echo "stable-ts install failed."
  echo "Try forcing a known-good runtime:"
  echo "PYTHON_BIN=/Library/Frameworks/Python.framework/Versions/3.13/bin/python3.13 npm run stable-ts:setup"
  exit 1
fi

print_step "Verifying stable_whisper import"
run_python_cmd "${VENV_DIR}/bin/python" - <<'PY'
import stable_whisper  # noqa: F401
print("stable_whisper import: OK")
PY

CA_BUNDLE_PATH="$(run_python_cmd "${VENV_DIR}/bin/python" - <<'PY'
try:
    import certifi
    print(certifi.where())
except Exception:
    print("")
PY
)"

print_step "Wiring functions/.env.local for local provider"
upsert_env_key "STABLE_TS_LOCAL_ENABLED" "true"
upsert_env_key "STABLE_TS_PYTHON_BIN" "${VENV_DIR}/bin/python"
upsert_env_key "STABLE_TS_MODEL" "${MODEL_NAME}"
upsert_env_key "STABLE_TS_TIMEOUT_MS" "420000"
upsert_env_key "STABLE_TS_FORCE_ARM64" "true"
upsert_env_key "STABLE_TS_DISABLE_OPENAI_FALLBACK" "true"
if [[ -n "${CA_BUNDLE_PATH}" ]]; then
  upsert_env_key "STABLE_TS_CA_BUNDLE" "${CA_BUNDLE_PATH}"
fi
upsert_env_key "STABLE_TS_ALIGN_SCRIPT" "${ALIGN_SCRIPT}"

print_step "Done"
cat <<EOF
Local stable-ts is configured.

Next:
1) Restart emulator:
   npm run firebase:emulators:functions
2) In the app, choose:
   Precision Mode -> High Accuracy (Local beta) or A/B Test
EOF
