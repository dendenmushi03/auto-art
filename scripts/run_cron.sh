#!/bin/bash
set -euo pipefail

# Prefer explicit APP_URL, then common Render URL envs.
APP_URL="${APP_URL:-${RENDER_EXTERNAL_URL:-${WEB_SERVICE_URL:-}}}"
CRON_KEY="${CRON_KEY:-${CRON_SECRET:-}}"
CRON_ENDPOINT_PATH="${CRON_ENDPOINT_PATH:-/cron/run}"
REQUEST_TIMEOUT_SEC="${REQUEST_TIMEOUT_SEC:-30}"
CURL_RETRY_COUNT="${CURL_RETRY_COUNT:-2}"
CURL_RETRY_DELAY_SEC="${CURL_RETRY_DELAY_SEC:-2}"

log() {
  echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] [cron-runner] $*"
}

fail() {
  log "error: $*"
  exit 1
}

if [[ -z "${APP_URL}" ]]; then
  fail "APP_URL is not set. Set APP_URL (or RENDER_EXTERNAL_URL / WEB_SERVICE_URL) to your web service base URL."
fi

if [[ -z "${CRON_KEY}" ]]; then
  fail "CRON_KEY is not set. Set CRON_KEY (or CRON_SECRET) to match the web service CRON_SECRET."
fi

if [[ "${APP_URL}" == *"YOUR-APP"* ]]; then
  fail "APP_URL looks like a placeholder (${APP_URL}). Set the real Render web URL."
fi

# Normalize URL pieces.
base_url="${APP_URL%/}"
path="/${CRON_ENDPOINT_PATH#/}"
endpoint="${base_url}${path}"

log "start: trigger ${path}"
log "target=${endpoint}"

response_body_file="$(mktemp)"
http_code="$({
  curl --fail-with-body -sS -m "${REQUEST_TIMEOUT_SEC}" \
    --retry "${CURL_RETRY_COUNT}" \
    --retry-delay "${CURL_RETRY_DELAY_SEC}" \
    --retry-all-errors \
    -X POST "${endpoint}" \
    -H "x-cron-key: ${CRON_KEY}" \
    -o "${response_body_file}" \
    -w '%{http_code}'
} || true)"

if [[ "${http_code}" != "200" ]]; then
  log "failed: non-200 response (status=${http_code:-unknown})"
  if [[ -s "${response_body_file}" ]]; then
    log "failure body: $(cat "${response_body_file}")"
  fi
  rm -f "${response_body_file}"
  exit 1
fi

log "success: status=200 response=$(cat "${response_body_file}")"
rm -f "${response_body_file}"
log "end: trigger completed"
