#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Liveness watchdog for gbrain-http.service, run every minute by
# gbrain-http-liveness.timer.
#
# `Restart=on-failure` only reacts to the server EXITING. A server that hangs
# while still holding the port (observed 2026-09-26: silent from 19:29Z to
# 00:51Z, every MCP call timing out) is never restarted. This probe restarts
# the unit after N consecutive failed checks.
#
# Healthy = the unit is active, ITS OWN MainPID owns the listening socket, and
# /health answers {"status":"ok"} within the timeout. /health runs `SELECT 1`
# through the engine pool, so a stalled event loop (no answer) and a stuck
# database pool (503) both count as failures. An orphaned server holding the
# port does not pass for the unit.
#
# Hands off when the unit is not active (stopped on purpose, or systemd's own
# Restart= is handling a crash) and during a startup grace window (cold start
# runs schema-init against the remote pooler).
#
# Env overrides:
#   GBRAIN_HTTP_SERVICE              unit (default gbrain-http.service)
#   GBRAIN_HTTP_PORT                 port (default: the unit's --port, else 8787)
#   GBRAIN_HTTP_LIVENESS_FAILURES    consecutive failures before restart (default 3)
#   GBRAIN_HTTP_LIVENESS_TIMEOUT_S   /health timeout in seconds (default 10)
#   GBRAIN_HTTP_LIVENESS_GRACE_S     no action this long after the unit starts (default 120)
#   GBRAIN_HTTP_LIVENESS_STATE       failure-counter file
# ---------------------------------------------------------------------------
set -uo pipefail

UNIT="${GBRAIN_HTTP_SERVICE:-gbrain-http.service}"
THRESHOLD="${GBRAIN_HTTP_LIVENESS_FAILURES:-3}"
TIMEOUT_S="${GBRAIN_HTTP_LIVENESS_TIMEOUT_S:-10}"
GRACE_S="${GBRAIN_HTTP_LIVENESS_GRACE_S:-120}"
STATE="${GBRAIN_HTTP_LIVENESS_STATE:-${XDG_STATE_HOME:-$HOME/.local/state}/gbrain-http-liveness.failures}"

failures() { cat "$STATE" 2>/dev/null || echo 0; }
set_failures() { mkdir -p "$(dirname "$STATE")" && echo "$1" > "$STATE"; }

if ! systemctl --user is-active --quiet "$UNIT"; then
  # Not ours to fight: stopped deliberately, or systemd's Restart= is on it.
  set_failures 0
  exit 0
fi

started="$(systemctl --user show -p ActiveEnterTimestamp --value "$UNIT" 2>/dev/null)"
started_s="$(date -d "$started" +%s 2>/dev/null || echo 0)"
if [ "$started_s" -gt 0 ] && [ $(( $(date +%s) - started_s )) -lt "$GRACE_S" ]; then
  exit 0 # still inside the startup grace window
fi

PORT="${GBRAIN_HTTP_PORT:-}"
if [ -z "$PORT" ]; then
  PORT="$(systemctl --user show -p ExecStart --value "$UNIT" 2>/dev/null \
    | grep -m1 -o -- '--port[= ][0-9][0-9]*' | grep -o '[0-9]*$' || true)"
fi
PORT="${PORT:-8787}"

main_pid="$(systemctl --user show -p MainPID --value "$UNIT" 2>/dev/null)"
reason=""
if [ -z "$main_pid" ] || [ "$main_pid" = 0 ]; then
  reason="no MainPID"
elif ! ss -Hltnp "sport = :$PORT" 2>/dev/null | grep -q "pid=$main_pid,"; then
  reason="MainPID $main_pid does not own :$PORT"
elif ! curl -fsS --max-time "$TIMEOUT_S" "http://127.0.0.1:$PORT/health" 2>/dev/null | grep -q '"status":"ok"'; then
  reason="/health did not answer ok within ${TIMEOUT_S}s"
fi

if [ -z "$reason" ]; then
  [ "$(failures)" != 0 ] && echo "gbrain-http liveness: healthy again (pid $main_pid owns :$PORT)"
  set_failures 0
  exit 0
fi

count=$(( $(failures) + 1 ))
echo "gbrain-http liveness: check failed ($count/$THRESHOLD): $reason"
if [ "$count" -lt "$THRESHOLD" ]; then
  set_failures "$count"
  exit 0
fi

echo "gbrain-http liveness: $THRESHOLD consecutive failures — restarting $UNIT"
set_failures 0
systemctl --user restart "$UNIT"
