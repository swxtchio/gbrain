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

# pairs: "<repo source>|<installed destination>|<mode>". Units are 644.
pairs() {
  local f rel
  # Install git's tracked mode (100755 -> 755, else 644), not the checkout's
  # filesystem mode, which carries the umask and may have lost its exec bit.
  for f in "$SRC"/scripts/* "$SRC"/tools/*; do
    echo "$f|$BIN_DEST/$(basename "$f")|$(git -C "$SRC" ls-files -s -- "$f" | grep -q '^100755 ' && echo 755 || echo 644)"
  done
  while IFS= read -r f; do
    rel="${f#"$SRC/systemd/"}"
    echo "$f|$UNIT_DEST/$rel|644"
  done < <(find "$SRC/systemd" -type f | sort)
}

while IFS='|' read -r src dst mode; do
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
done < <(pairs)

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
