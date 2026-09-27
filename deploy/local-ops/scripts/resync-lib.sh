# Sourced by daily-resync.sh.
#
# sync_on_default_branch <source-id> <strategy> [repo-dir]
#
# Syncs a source from its repo's CURRENT default branch without disturbing the
# working tree the user left behind:
#   1. record the current branch (or detached commit)
#   2. stash any changes, untracked files included
#   3. switch to the default branch and fast-forward it to origin
#      (if that branch is checked out in another worktree, use a detached
#      checkout of origin/<default> instead)
#   4. gbrain sync --source <id> --strategy <strategy> --no-pull --yes
#   5. ALWAYS switch back to the recorded branch/commit and pop the stash
# A repo mid-rebase/merge is skipped (stashing is unsafe there). A stash that
# cannot be popped cleanly is kept and reported, never dropped.
# Always returns 0 so one repo can't abort the nightly job under `set -e`.

_rs_git() { git -C "$RS_DIR" "$@"; }

sync_on_default_branch() {
  local src="$1" strategy="$2"
  RS_DIR="${3:-$HOME/$1}"
  local def orig gitdir stashed=0 ready=0

  if ! _rs_git rev-parse --git-dir >/dev/null 2>&1; then
    echo "  skip: $RS_DIR is not a git checkout"; return 0
  fi
  gitdir=$(_rs_git rev-parse --absolute-git-dir)
  if [ -d "$gitdir/rebase-merge" ] || [ -d "$gitdir/rebase-apply" ] || [ -f "$gitdir/MERGE_HEAD" ] || [ -f "$gitdir/CHERRY_PICK_HEAD" ]; then
    echo "  skip: $RS_DIR has a rebase/merge/cherry-pick in progress"; return 0
  fi

  # Ask the remote which branch is default: a local refs/remotes/origin/HEAD
  # can be stale (swx-opencode's still said `dev` after the fork moved to
  # `swxtch`). Fall back to the local ref, then `main`, when offline.
  def=$(_rs_git ls-remote --symref origin HEAD 2>/dev/null | sed -n 's#^ref: refs/heads/\(.*\)[[:space:]]HEAD$#\1#p')
  [ -n "$def" ] || def=$(_rs_git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##')
  [ -n "$def" ] || def=main
  orig=$(_rs_git symbolic-ref --short -q HEAD || _rs_git rev-parse HEAD)

  if [ -n "$(_rs_git status --porcelain)" ]; then
    if _rs_git stash push -u -q -m "gbrain-daily-resync auto-stash $(date -Iseconds)"; then
      stashed=1; echo "  stashed local changes on $orig"
    else
      echo "  skip: could not stash local changes in $RS_DIR"; return 0
    fi
  fi

  if ! _rs_git fetch -q origin "$def"; then
    echo "  !! fetch of origin/$def failed"
  elif [ "$orig" = "$def" ] || _rs_git checkout -q "$def" 2>/dev/null; then
    if _rs_git merge -q --ff-only "origin/$def"; then
      ready=1
    else
      echo "  !! $def cannot fast-forward to origin/$def (local commits?); not syncing a diverged branch"
    fi
  elif _rs_git checkout -q --detach "origin/$def"; then
    # $def is checked out in another worktree; index origin's default directly.
    echo "  note: $def is checked out elsewhere; syncing detached origin/$def"
    ready=1
  else
    echo "  !! could not switch $RS_DIR to $def"
  fi

  if [ "$ready" = 1 ]; then
    echo "  syncing $src @ $(_rs_git rev-parse --short HEAD) ($def)"
    # Run from the repo so any cwd-based resolution agrees with --source.
    (cd "$RS_DIR" && gbrain sync --source "$src" --strategy "$strategy" --no-pull --yes) 2>&1 | \
      grep -vE "^\[(import\.files|sync\.imports|embed)\.[a-z]+\] [0-9]+/[0-9]+ \(" || true
  fi

  # Restore exactly what the user left, whatever happened above.
  if [ "$(_rs_git symbolic-ref --short -q HEAD || _rs_git rev-parse HEAD)" != "$orig" ]; then
    _rs_git checkout -q "$orig" || echo "  !! could not switch $RS_DIR back to $orig — do it by hand"
  fi
  if [ "$stashed" = 1 ]; then
    if _rs_git stash pop -q; then
      echo "  restored local changes on $orig"
    else
      echo "  !! stash pop hit conflicts in $RS_DIR; changes kept in the stash (git -C $RS_DIR stash list)"
    fi
  fi
  return 0
}
