# Sourced by daily-resync.sh.
#
# sync_on_default_branch <source-id> <strategy> [repo-dir]
#
# Syncs a source from its repo's CURRENT default branch without disturbing the
# working tree the user left behind:
#   1. record the current branch (or detached commit)
#   2. stash any changes, untracked files included, and remember WHICH stash
#   3. switch to the default branch and fast-forward it to origin
#      (if that branch is checked out in another worktree, use a detached
#      checkout of origin/<default> instead)
#   4. gbrain sync --source <id> --strategy <strategy> --no-pull --yes
#   5. switch back to the recorded branch/commit and, only once that is
#      verified, restore exactly our stash with --index (staged stays staged)
# Step 5 also runs if the job is interrupted (SIGTERM/SIGINT) mid-sync.
# A repo mid-rebase/merge is skipped (stashing is unsafe there), as is a repo
# whose changes `git stash` cannot hold (e.g. a dirty submodule). A stash that
# cannot be restored cleanly is kept and reported, never dropped.
# Always returns 0 so one repo can't abort the nightly job under `set -e`.

_rs_git() { git -C "$RS_DIR" "$@"; }
_rs_head() { _rs_git symbolic-ref --short -q HEAD || _rs_git rev-parse HEAD; }

# Restore the recorded branch, then our stash. Uses RS_DIR, RS_ORIG, RS_STASH.
_rs_restore() {
  if [ "$(_rs_head)" != "$RS_ORIG" ]; then
    if ! _rs_git checkout -q "$RS_ORIG"; then
      if [ -n "$RS_STASH" ]; then
        echo "  !! could not switch $RS_DIR back to $RS_ORIG; your changes are safe in stash $RS_STASH (git -C $RS_DIR stash list)"
      else
        echo "  !! could not switch $RS_DIR back to $RS_ORIG — do it by hand"
      fi
      RS_STASH=""
      return 1
    fi
  fi
  if [ -n "$RS_STASH" ]; then
    local ref
    ref="$(_rs_git stash list --format='%gd %H' | awk -v h="$RS_STASH" '$2 == h {print $1; exit}')"
    if [ -z "$ref" ]; then
      echo "  !! stash $RS_STASH is no longer in $RS_DIR's stash list; nothing restored"
    elif _rs_git stash pop -q --index "$ref"; then
      echo "  restored local changes on $RS_ORIG"
    else
      echo "  !! could not restore stash $RS_STASH cleanly in $RS_DIR; it is kept (git -C $RS_DIR stash list)"
    fi
    RS_STASH=""
  fi
  return 0
}

sync_on_default_branch() {
  local src="$1" strategy="$2"
  RS_DIR="${3:-$HOME/$1}" RS_ORIG="" RS_STASH=""
  local def gitdir ready=0 before after

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
  RS_ORIG=$(_rs_head)

  if [ -n "$(_rs_git status --porcelain)" ]; then
    before=$(_rs_git rev-parse -q --verify refs/stash || echo none)
    if ! _rs_git stash push -u -q -m "gbrain-daily-resync auto-stash $(date -Iseconds)"; then
      echo "  skip: could not stash local changes in $RS_DIR"; return 0
    fi
    after=$(_rs_git rev-parse -q --verify refs/stash || echo none)
    [ "$after" != "$before" ] && RS_STASH="$after"
    if [ -n "$(_rs_git status --porcelain)" ]; then
      # Changes stash could not hold (e.g. a dirty submodule): never switch
      # branches over them. Put back what we did stash and leave the repo alone.
      echo "  skip: $RS_DIR has changes git stash cannot hold"
      _rs_restore
      return 0
    fi
    [ -n "$RS_STASH" ] && echo "  stashed local changes on $RS_ORIG ($RS_STASH)"
  fi

  # From here on the repo may be off its branch with the user's work stashed:
  # an interrupted job still restores it.
  trap '_rs_restore; trap - TERM INT; exit 143' TERM INT

  if ! _rs_git fetch -q origin "$def"; then
    echo "  !! fetch of origin/$def failed"
  elif [ "$RS_ORIG" = "$def" ] || _rs_git checkout -q "$def" 2>/dev/null; then
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

  _rs_restore
  trap - TERM INT
  return 0
}
