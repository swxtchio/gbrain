#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Install + (re)start the single shared gbrain HTTP MCP server as a systemd
# user service on this VM. Idempotent — safe to re-run after editing the unit.
#
# This only manages the SERVER. Wiring a coding agent to it (mint a token +
# `gbrain connect`) is a separate, per-agent step documented in README.md.
# ---------------------------------------------------------------------------
set -euo pipefail

PORT="${GBRAIN_HTTP_PORT:-8787}"
HEALTH_URL="http://127.0.0.1:${PORT}/health"
UNIT="gbrain-http.service"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"

echo "==> Installing ${UNIT} -> ${DEST_DIR}/"
mkdir -p "${DEST_DIR}"
cp "${SRC_DIR}/${UNIT}" "${DEST_DIR}/${UNIT}"

echo "==> Reloading user systemd + enabling --now"
systemctl --user daemon-reload
systemctl --user enable --now "${UNIT}"

echo "==> Waiting for ${HEALTH_URL} (up to 30s)"
for _ in $(seq 1 30); do
  if curl -fsS --max-time 3 "${HEALTH_URL}" >/dev/null 2>&1; then
    echo "==> Healthy:"
    curl -fsS --max-time 3 "${HEALTH_URL}"; echo
    echo
    echo "Next: wire a coding agent (see README.md):"
    echo "  gbrain auth create \"claude-code-vm\"          # prints a gbrain_… bearer token"
    echo "  gbrain connect http://127.0.0.1:${PORT}/mcp --token gbrain_… --install --force"
    exit 0
  fi
  sleep 1
done

echo "!! Service did not become healthy within 30s. Recent logs:" >&2
systemctl --user status "${UNIT}" --no-pager -l 2>&1 | tail -20 >&2 || true
journalctl --user -u "${UNIT}" --no-pager -n 40 2>&1 >&2 || true
exit 1
