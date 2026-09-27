#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Install the dev-box gbrain ops suite: the nightly resync, the weekly refresh
# jobs, and their systemd user units. The repo is the source of truth; the box
# runs installed COPIES (in ~/.gbrain and ~/.config/systemd/user), so removing a
# checkout or worktree never breaks a timer.
#
#   deploy/local-ops/install.sh           install/refresh, enable the default timers
#   deploy/local-ops/install.sh --check   report drift between repo and installed copies (exit 1 on drift)
#   deploy/local-ops/install.sh --dry-run show what would change
#
# A replaced file that differs is kept as <file>.bak-<timestamp>. Timers not in
# ENABLED_TIMERS are installed but left as they are (not enabled).
# ---------------------------------------------------------------------------
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DEST="${GBRAIN_OPS_BIN_DIR:-$HOME/.gbrain}"
UNIT_DEST="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
# Enabled on the dev box as of 2026-09-27. bulk-refresh runs inside daily-resync;
# todo-refresh is opt-in.
ENABLED_TIMERS="${GBRAIN_OPS_ENABLED_TIMERS:-gbrain-daily-resync.timer gbrain-libsrt-refresh.timer}"

MODE=install
case "${1:-}" in
  --check) MODE=check ;;
  --dry-run) MODE=dry-run ;;
  "") ;;
  *) echo "usage: $0 [--check|--dry-run]" >&2; exit 2 ;;
esac

TS="$(date +%Y%m%d-%H%M%S)"
drift=0

# What to install, as parallel arrays (paths may hold any character).
SRCS=() DSTS=() MODES=()

# git's tracked mode for a file: 755 for 100755, 644 for 100644, and `?` for
# anything without exactly one stage-0 index entry (untracked, staged for
# deletion, unmerged, or git unavailable). Install the tracked mode rather than
# the checkout's filesystem mode, which carries the umask and may have lost its
# exec bit.
tracked_mode() {
  git --literal-pathspecs -C "$SRC" ls-files -s -z -- "$1" 2>/dev/null | tr '\0' '\n' |
    awk '$3 == 0 {m[n++] = $1} END {print (n == 1 && m[0] == "100755") ? 755 : (n == 1 && m[0] == "100644") ? 644 : "?"}'
}

for f in "$SRC"/scripts/* "$SRC"/tools/*; do
  SRCS+=("$f") DSTS+=("$BIN_DEST/$(basename "$f")") MODES+=("$(tracked_mode "$f")")
done
while IFS= read -r -d '' f; do
  # Units install 644 whatever their tracked mode, but must still be tracked.
  m=$(tracked_mode "$f"); [ "$m" = "?" ] || m=644
  SRCS+=("$f") DSTS+=("$UNIT_DEST/${f#"$SRC/systemd/"}") MODES+=("$m")
done < <(find "$SRC/systemd" -type f -print0 | sort -z)

# Refuse before copying anything: an untracked file has no mode to install.
untracked=0
for i in "${!SRCS[@]}"; do
  [ "${MODES[$i]}" = "?" ] || continue
  [ "$untracked" = 1 ] || echo "refusing to install: not tracked in git (no single stage-0 index entry):" >&2
  printf '  %q\n' "${SRCS[$i]}" >&2
  untracked=1
done
[ "$untracked" = 0 ] || exit 1

for i in "${!SRCS[@]}"; do
  src=${SRCS[$i]} dst=${DSTS[$i]} mode=${MODES[$i]}
  # Same bytes AND same mode: a script that lost its exec bit is drift too
  # (its timer would fail with Permission denied).
  if [ -f "$dst" ] && cmp -s "$src" "$dst" && [ "$(stat -c %a "$dst")" = "$mode" ]; then
    continue
  fi
  if [ ! -f "$dst" ]; then state=missing
  elif cmp -s "$src" "$dst"; then state="mode $(stat -c %a "$dst") != $mode"
  else state=changed; fi
  case "$MODE" in
    check) echo "drift ($state): $dst"; drift=1 ;;
    dry-run) echo "would install ($state): $dst" ;;
    install)
      mkdir -p "$(dirname "$dst")"
      [ -f "$dst" ] && cp -p "$dst" "$dst.bak-$TS"
      install -m "$mode" "$src" "$dst"
      echo "installed ($state): $dst"
      ;;
  esac
done

if [ "$MODE" = check ]; then
  [ "$drift" = 0 ] && echo "no drift: installed ops suite matches $SRC"
  exit "$drift"
fi
[ "$MODE" = dry-run ] && exit 0

systemctl --user daemon-reload
for timer in $ENABLED_TIMERS; do
  systemctl --user enable --now "$timer"
done
echo "enabled: $ENABLED_TIMERS"
