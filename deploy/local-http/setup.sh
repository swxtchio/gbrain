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

# The override must hold end to end: the health probe below uses ${PORT}, so
# the installed unit must listen on it too — a knob that changes the check
# but not the thing being checked falsely fails setup.
[[ "${PORT}" =~ ^[0-9]+$ ]] || { echo "!! GBRAIN_HTTP_PORT must be numeric, got '${PORT}'" >&2; exit 2; }

echo "==> Installing ${UNIT} -> ${DEST_DIR}/"
mkdir -p "${DEST_DIR}"
cp "${SRC_DIR}/${UNIT}" "${DEST_DIR}/${UNIT}"
if [ "${PORT}" != "8787" ]; then
  echo "==> GBRAIN_HTTP_PORT=${PORT} — templating the installed unit's --port"
  sed -i "s/--port 8787/--port ${PORT}/" "${DEST_DIR}/${UNIT}"
  grep -q -- "--port ${PORT}" "${DEST_DIR}/${UNIT}" \
    || { echo "!! failed to template --port in ${DEST_DIR}/${UNIT}" >&2; exit 1; }
fi

# REQUIRED at deploy, and BEFORE the restart that would make it true.
#
# The fork used to disable disk write-through automatically on postgres
# engines; that is retired in favour of upstream's `sync.write_through` flag,
# which FAILS OPEN — isWriteThroughDisabled() reports "enabled" when the key
# is unset. Starting this service on a brain whose key was never set turns on
# a .md mirror for every put_page / capture / brainstorm --save.
#
# Round-1 put this check AFTER `systemctl --user restart`, which round-2
# review correctly called a post-mortem rather than a confirmation: by the
# time it printed, the serving process was already live with mirroring on.
# It now runs before the unit is started, and an UNSET key is a hard stop
# rather than a silent default-on — the operator makes the decision once,
# either way, and GBRAIN_ALLOW_WRITE_THROUGH=1 records the "yes, mirror"
# answer so a re-run is not blocked.
#
# The read goes through write-through-probe.ts, not `gbrain config get`:
# `config get` resolves the FILE plane above the DB plane, while every runtime
# disk sink asks `isWriteThroughDisabled`, which reads only the DB plane. The
# probe calls that predicate, so it cannot print "off" while the brain mirrors.
echo "==> Checking sync.write_through (DB plane, the one the runtime reads)"
WT_STATE="unknown:probe-not-run"
if command -v bun >/dev/null 2>&1; then
  WT_STATE="$(bun "${SRC_DIR}/write-through-probe.ts" 2>/dev/null | tail -1 || true)"
  [ -n "${WT_STATE}" ] || WT_STATE="unknown:probe-no-output"
else
  WT_STATE="unknown:bun-not-on-path"
fi
case "${WT_STATE}" in
  disabled)
    echo "    sync.write_through is off — brain stays DB-only." ;;
  enabled:unset|enabled:*)
    if [ "${GBRAIN_ALLOW_WRITE_THROUGH:-}" = "1" ]; then
      echo "!!  ${WT_STATE} — disk mirroring is ON, allowed by GBRAIN_ALLOW_WRITE_THROUGH=1." >&2
    else
      echo "!! Refusing to start ${UNIT}: disk mirroring would be ON for this brain (${WT_STATE})." >&2
      echo "!! Every put_page / capture / brainstorm --save would also write a .md mirror" >&2
      echo "!! into the registered source's tree. This unit is for a DB-authoritative brain," >&2
      echo "!! so decide once:" >&2
      echo "!!   gbrain config set sync.write_through false   # DB-only (what this deploy wants)" >&2
      echo "!!   GBRAIN_ALLOW_WRITE_THROUGH=1 $0              # keep the mirrors, on purpose" >&2
      echo "!! The unit file is installed; nothing has been started." >&2
      exit 3
    fi ;;
  *)
    # Could not determine. Fail closed for the same reason the flag itself
    # should not have: an unverified posture is exactly the state that let
    # this ship silently the first time.
    if [ "${GBRAIN_ALLOW_WRITE_THROUGH:-}" = "1" ]; then
      echo "!!  could not verify sync.write_through (${WT_STATE}); continuing on GBRAIN_ALLOW_WRITE_THROUGH=1." >&2
    else
      echo "!! Refusing to start ${UNIT}: could not verify sync.write_through (${WT_STATE})." >&2
      echo "!! Check by hand, then re-run:" >&2
      echo "!!   gbrain config set sync.write_through false" >&2
      echo "!!   GBRAIN_ALLOW_WRITE_THROUGH=1 $0   # or proceed without verifying" >&2
      exit 3
    fi ;;
esac

echo "==> Reloading user systemd + (re)starting"
systemctl --user daemon-reload
systemctl --user enable "${UNIT}"
# restart, not `enable --now`: on a RE-RUN against an already-enabled,
# already-active unit, enable --now is a no-op and daemon-reload restarts
# nothing — the old process would keep listening on the OLD port while the
# health probe below checks the new one. restart moves the serving process
# onto the freshly-installed unit (and starts it on first install).
systemctl --user restart "${UNIT}"

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
journalctl --user -u "${UNIT}" --no-pager -n 40 >&2 2>&1 || true
exit 1
