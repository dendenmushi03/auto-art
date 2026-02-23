#!/bin/bash
set -euo pipefail

APP_URL="${APP_URL:-https://YOUR-APP.onrender.com}"
CRON_KEY="${CRON_KEY:-YOUR_CRON_SECRET}"
REQUEST_TIMEOUT_SEC="${REQUEST_TIMEOUT_SEC:-30}"

log() {
  echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] [cron-runner] $*"
}

log "start: trigger /cron/run"
log "target=${APP_URL}/cron/run"

response_body_file="$(mktemp)"
http_code="$({
  curl --fail-with-body -sS -m "${REQUEST_TIMEOUT_SEC}" \
    -X POST "${APP_URL}/cron/run" \
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
