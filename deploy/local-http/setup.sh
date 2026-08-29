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

echo "==> Reloading user systemd + (re)starting"
systemctl --user daemon-reload
systemctl --user enable "${UNIT}"
# restart, not `enable --now`: on a RE-RUN against an already-enabled,
# already-active unit, enable --now is a no-op and daemon-reload restarts
# nothing — the old process would keep listening on the OLD port while the
# health probe below checks the new one. restart moves the serving process
# onto the freshly-installed unit (and starts it on first install).
systemctl --user restart "${UNIT}"

# REQUIRED at deploy: the brain must stay DB-only.
#
# The fork used to disable disk write-through automatically on postgres
# engines; that is retired in favour of upstream's `sync.write_through` flag,
# which FAILS OPEN — isWriteThroughDisabled() reports "enabled" when the key
# is unset. So installing this service on a brain whose key was never set
# silently starts mirroring every put_page / capture / brainstorm --save into
# the source tree. Round-1 review was right that README prose is not a
# control: this is the deploy entrypoint, so the check belongs here.
#
# Positive confirmation, not an assumption — read the value back and say what
# was found. Advisory (never blocks the install): the operator may be running
# a brain that genuinely wants mirrors, and setup's job is the SERVER.
echo "==> Checking sync.write_through (this deployment wants it OFF)"
if command -v gbrain >/dev/null 2>&1; then
  WT="$(gbrain config get sync.write_through --raw 2>/dev/null | tail -1 || true)"
  case "$(printf '%s' "${WT}" | tr '[:upper:]' '[:lower:]')" in
    false|0|off|no)
      echo "    sync.write_through=${WT} — brain stays DB-only." ;;
    "")
      echo "!!  sync.write_through is UNSET, which upstream reads as ON: this brain will" >&2
      echo "!!  write a .md mirror for every put_page / capture / brainstorm --save." >&2
      echo "!!  If this brain is DB-authoritative (the shared-server case this unit is" >&2
      echo "!!  for), run:  gbrain config set sync.write_through false" >&2 ;;
    *)
      echo "!!  sync.write_through=${WT} — disk mirroring is ON for this brain." >&2
      echo "!!  Turn it off with:  gbrain config set sync.write_through false" >&2 ;;
  esac
else
  echo "!!  gbrain not on PATH — could not verify sync.write_through. Check it by hand:" >&2
  echo "!!    gbrain config get sync.write_through   # want: false" >&2
fi

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
