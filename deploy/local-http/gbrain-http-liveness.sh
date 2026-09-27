#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Liveness watchdog for gbrain-http.service, run every minute by
# gbrain-http-liveness.timer.
#
# `Restart=` only reacts to the server EXITING. A server that hangs while still
# holding the port (observed 2026-09-26: silent from 19:29Z to 00:51Z, every
# MCP call timing out) is never restarted. This probe restarts the unit after
# consecutive failed checks of the SAME process.
#
# Two failure kinds, because a restart only helps one of them:
#   hung      no answer from /health within the timeout, or the unit's own
#             MainPID does not own the port. The process is wedged; restart
#             after GBRAIN_HTTP_LIVENESS_FAILURES (3) consecutive checks.
#   degraded  /health answered, but not ok (503: its `SELECT 1` through the
#             engine pool failed or timed out). The process is alive; the
#             database may be down or the pool saturated, and a restart cures
#             only a locally wedged pool. Restart only after
#             GBRAIN_HTTP_LIVENESS_DEGRADED_FAILURES (10) consecutive checks.
# Restarts are capped at GBRAIN_HTTP_LIVENESS_MAX_RESTARTS (3) per hour, so a
# sustained database outage cannot turn into a restart storm.
#
# The counters are keyed to the unit's MainPID: a new process (systemd
# Restart=, a manual or safe-update restart) starts from zero, and the PID is
# re-checked right before restarting. Hands off when the unit is not active
# (stopped on purpose, or systemd's Restart= is handling it) and during a
# startup grace window (cold start runs schema-init against the remote pooler).
#
# Env overrides:
#   GBRAIN_HTTP_SERVICE                      unit (default gbrain-http.service)
#   GBRAIN_HTTP_PORT                         port (default: the unit's --port, else 8787)
#   GBRAIN_HTTP_LIVENESS_FAILURES            hung checks before restart (default 3)
#   GBRAIN_HTTP_LIVENESS_DEGRADED_FAILURES   degraded checks before restart (default 10)
#   GBRAIN_HTTP_LIVENESS_MAX_RESTARTS        restarts allowed per hour (default 3)
#   GBRAIN_HTTP_LIVENESS_TIMEOUT_S           /health timeout in seconds (default 10)
#   GBRAIN_HTTP_LIVENESS_GRACE_S             no action this long after the unit starts (default 120)
#   GBRAIN_HTTP_LIVENESS_STATE               state directory
# ---------------------------------------------------------------------------
set -uo pipefail

UNIT="${GBRAIN_HTTP_SERVICE:-gbrain-http.service}"
HUNG_MAX="${GBRAIN_HTTP_LIVENESS_FAILURES:-3}"
DEGRADED_MAX="${GBRAIN_HTTP_LIVENESS_DEGRADED_FAILURES:-10}"
RESTARTS_PER_HOUR="${GBRAIN_HTTP_LIVENESS_MAX_RESTARTS:-3}"
TIMEOUT_S="${GBRAIN_HTTP_LIVENESS_TIMEOUT_S:-10}"
GRACE_S="${GBRAIN_HTTP_LIVENESS_GRACE_S:-120}"
STATE_DIR="${GBRAIN_HTTP_LIVENESS_STATE:-${XDG_STATE_HOME:-$HOME/.local/state}/gbrain-http-liveness}"
COUNTS="$STATE_DIR/counts"       # "<main_pid> <hung> <degraded>"
RESTARTS="$STATE_DIR/restarts"   # one epoch second per probe-issued restart

mkdir -p "$STATE_DIR"
main_pid_of() { systemctl --user show -p MainPID --value "$UNIT" 2>/dev/null; }
save_counts() { echo "$1 $2 $3" > "$COUNTS"; }

if ! systemctl --user is-active --quiet "$UNIT"; then
  # Not ours to fight: stopped deliberately, or systemd's Restart= is on it.
  rm -f "$COUNTS"
  exit 0
fi

main_pid="$(main_pid_of)"
# Guard the read: a failed `<` redirection prints to stderr even with 2>/dev/null.
[ -f "$COUNTS" ] && read -r seen_pid hung degraded < "$COUNTS"
if [ "${seen_pid:-}" != "$main_pid" ]; then
  hung=0 degraded=0 # a different process: its predecessor's failures don't count
fi
hung="${hung:-0}" degraded="${degraded:-0}"

started="$(systemctl --user show -p ActiveEnterTimestamp --value "$UNIT" 2>/dev/null)"
started_s="$(date -d "$started" +%s 2>/dev/null || echo 0)"
if [ "$started_s" -gt 0 ] && [ $(( $(date +%s) - started_s )) -lt "$GRACE_S" ]; then
  save_counts "$main_pid" 0 0
  exit 0 # still inside the startup grace window
fi

PORT="${GBRAIN_HTTP_PORT:-}"
if [ -z "$PORT" ]; then
  PORT="$(systemctl --user show -p ExecStart --value "$UNIT" 2>/dev/null \
    | grep -m1 -o -- '--port[= ][0-9][0-9]*' | grep -o '[0-9]*$' || true)"
fi
PORT="${PORT:-8787}"

kind="" reason=""
if [ -z "$main_pid" ] || [ "$main_pid" = 0 ]; then
  kind=hung reason="no MainPID"
elif ! ss -Hltnp "sport = :$PORT" 2>/dev/null | grep -q "pid=$main_pid,"; then
  kind=hung reason="MainPID $main_pid does not own :$PORT"
else
  # -w prints the HTTP status even when the body is empty; 000 = no answer.
  body="$(curl -sS --max-time "$TIMEOUT_S" -w '\n%{http_code}' "http://127.0.0.1:$PORT/health" 2>/dev/null)"
  curl_rc=$?
  code="${body##*$'\n'}"
  # curl_rc must be 0 too: a 200 header followed by a body that stalls past the
  # timeout still prints 200 via -w, and is a hang, not a healthy answer.
  if [ "$curl_rc" = 0 ] && [ "$code" = 200 ] && printf '%s' "$body" | grep -q '"status":"ok"'; then
    :
  elif [ "$curl_rc" != 0 ] || [ -z "$code" ] || [ "$code" = 000 ]; then
    kind=hung reason="/health did not answer within ${TIMEOUT_S}s"
  else
    kind=degraded reason="/health answered $code (database unavailable or pool saturated)"
  fi
fi

if [ -z "$kind" ]; then
  [ "$hung" != 0 ] || [ "$degraded" != 0 ] && echo "gbrain-http liveness: healthy again (pid $main_pid owns :$PORT)"
  save_counts "$main_pid" 0 0
  exit 0
fi

if [ "$kind" = hung ]; then
  hung=$((hung + 1)) degraded=0 count=$hung max=$HUNG_MAX
else
  degraded=$((degraded + 1)) hung=0 count=$degraded max=$DEGRADED_MAX
fi
echo "gbrain-http liveness: $kind check failed ($count/$max) for pid $main_pid: $reason"
save_counts "$main_pid" "$hung" "$degraded"
[ "$count" -lt "$max" ] && exit 0

now=$(date +%s)
recent=$(awk -v since=$((now - 3600)) '$1 >= since' "$RESTARTS" 2>/dev/null | wc -l)
if [ "$recent" -ge "$RESTARTS_PER_HOUR" ]; then
  echo "gbrain-http liveness: NOT restarting — already restarted $recent time(s) in the last hour (cap $RESTARTS_PER_HOUR); needs a human: journalctl --user -u $UNIT"
  exit 0
fi
if ! systemctl --user is-active --quiet "$UNIT"; then
  echo "gbrain-http liveness: unit stopped during the check; not restarting it"
  rm -f "$COUNTS"
  exit 0
fi
if [ "$(main_pid_of)" != "$main_pid" ]; then
  echo "gbrain-http liveness: pid changed during the check; not restarting the new process"
  rm -f "$COUNTS"
  exit 0
fi

echo "gbrain-http liveness: $max consecutive $kind failures for pid $main_pid — restarting $UNIT"
echo "$now" >> "$RESTARTS"
awk -v since=$((now - 86400)) '$1 >= since' "$RESTARTS" > "$RESTARTS.tmp" 2>/dev/null && mv "$RESTARTS.tmp" "$RESTARTS"
rm -f "$COUNTS"
# try-restart: restarts only a RUNNING unit, so a stop that lands between the
# check above and this call is never undone by starting it back up.
systemctl --user try-restart "$UNIT"
