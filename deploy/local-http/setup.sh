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
# The committed unit binds 8787; render GBRAIN_HTTP_PORT into the installed copy
# so the port this script probes is the port the service actually binds.
sed "s/--port 8787 /--port ${PORT} /" "${SRC_DIR}/${UNIT}" > "${DEST_DIR}/${UNIT}"

# Liveness probe: Restart=on-failure never catches a server that hangs while
# holding the port, so a timer restarts the unit after consecutive failed checks.
# Install a COPY of the probe script: running it from this checkout would break
# silently the moment the checkout (e.g. a worktree) is removed.
LIVENESS="gbrain-http-liveness"
LIBEXEC_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/gbrain/libexec"
mkdir -p "${LIBEXEC_DIR}"
install -m 755 "${SRC_DIR}/${LIVENESS}.sh" "${LIBEXEC_DIR}/${LIVENESS}.sh"
sed "s#@LIVENESS_SCRIPT@#${LIBEXEC_DIR}/${LIVENESS}.sh#" "${SRC_DIR}/${LIVENESS}.service" > "${DEST_DIR}/${LIVENESS}.service"
cp "${SRC_DIR}/${LIVENESS}.timer" "${DEST_DIR}/${LIVENESS}.timer"

echo "==> Reloading user systemd, enabling, and (re)starting"
systemctl --user daemon-reload
systemctl --user enable "${UNIT}"
# restart, not `enable --now`: --now only starts an INACTIVE unit, so re-running
# this after editing the unit left the old process and settings running.
systemctl --user restart "${UNIT}"
systemctl --user enable --now "${LIVENESS}.timer"

echo "==> Waiting for ${HEALTH_URL} (up to 30s)"
for _ in $(seq 1 30); do
  # Require OUR unit's process to own the port, not just something answering
  # there: an orphaned server on the port would otherwise pass while the
  # restarted unit is still starting (and then fails to bind).
  MAIN_PID="$(systemctl --user show -p MainPID --value "${UNIT}" 2>/dev/null || true)"
  if systemctl --user is-active --quiet "${UNIT}" \
    && [ -n "${MAIN_PID}" ] && [ "${MAIN_PID}" != 0 ] \
    && curl -fsS --max-time 3 "${HEALTH_URL}" >/dev/null 2>&1 \
    && ss -Hltnp "sport = :${PORT}" 2>/dev/null | grep -q "pid=${MAIN_PID},"; then
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
