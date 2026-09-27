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
# Our stash, found by the run-unique message: refs/stash is shared by every
# worktree of a repo, so "the newest stash" may belong to someone else.
_rs_our_stash() { _rs_git stash list --format='%H %s' | awk -v m="$RS_STASH_MSG" 'index($0, m) {print $1; exit}'; }
# The current `stash@{n}` of our stash. Resolve it right before each use: the
# index shifts whenever another worktree pushes a stash.
_rs_stash_ref() { _rs_git stash list --format='%gd %H' | awk -v h="$RS_STASH" '$2 == h {print $1; exit}'; }

# Restore the recorded branch, then our stash. Uses RS_DIR, RS_ORIG, RS_STASH.
# Returns 1 only when switching back failed (the stash is then kept and named).
# A signal that lands mid-restore does not re-enter it: the restore finishes,
# then the job exits.
_rs_restore() {
  local ok=0 ref
  RS_RESTORING=1
  if [ "$(_rs_head)" != "$RS_ORIG" ] && ! _rs_git checkout -q "$RS_ORIG"; then
    if [ -n "$RS_STASH" ]; then
      echo "  !! could not switch $RS_DIR back to $RS_ORIG; your changes are safe in stash $RS_STASH (git -C $RS_DIR stash list)"
    else
      echo "  !! could not switch $RS_DIR back to $RS_ORIG — do it by hand"
    fi
    ok=1
  elif [ -n "$RS_STASH" ]; then
    # Apply by SHA, never by a selector that another worktree's push can shift.
    if [ -z "$(_rs_stash_ref)" ]; then
      echo "  !! stash $RS_STASH is no longer in $RS_DIR's stash list; nothing restored"
    elif _rs_git stash apply -q --index "$RS_STASH"; then
      echo "  restored local changes on $RS_ORIG"
      _rs_drop_ours
    else
      echo "  !! could not restore stash $RS_STASH cleanly in $RS_DIR; it is kept (git -C $RS_DIR stash list)"
    fi
  fi
  RS_STASH="" RS_RESTORING=""
  if [ -n "$RS_SIGNALED" ]; then trap - TERM INT; exit 143; fi
  return "$ok"
}

# On SIGTERM/SIGINT: find a stash we created but had not recorded yet (the
# signal landed during or right after `stash push`), then restore and exit.
_rs_on_signal() {
  RS_SIGNALED=1
  [ -n "$RS_RESTORING" ] && return 0   # the running _rs_restore exits when done
  [ -z "$RS_STASH" ] && [ -n "$RS_STASH_MSG" ] && RS_STASH=$(_rs_our_stash)
  _rs_restore || true
  trap - TERM INT
  exit 143
}

# Drop our (already applied) stash. git can only drop by `stash@{n}`, and a
# push from another worktree can shift that between lookup and drop, so check
# what was actually dropped: if it wasn't ours, store it straight back (same
# commit, same message) and leave ours listed.
_rs_drop_ours() {
  local ref dropped
  ref=$(_rs_stash_ref)
  # LC_ALL=C: the "Dropped ... (<sha>)" line is translated in other locales.
  dropped=$([ -n "$ref" ] && LC_ALL=C _rs_git stash drop "$ref" 2>/dev/null | sed -n 's/^Dropped .* (\([0-9a-f]*\))$/\1/p')
  [ "$dropped" = "$RS_STASH" ] && return 0
  if [ -n "$dropped" ]; then
    _rs_git stash store -m "$(_rs_git log -1 --format=%s "$dropped")" "$dropped"
    echo "  note: a concurrent stash shifted $ref; put back $dropped"
  fi
  echo "  note: stash $RS_STASH was applied but not dropped (git -C $RS_DIR stash list)"
}

sync_on_default_branch() {
  local src="$1" strategy="$2"
  RS_DIR="${3:-$HOME/$1}" RS_ORIG="" RS_STASH="" RS_STASH_MSG="" RS_RESTORING="" RS_SIGNALED=""
  local def gitdir ready=0

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

  # From here on the repo may be off its branch with the user's work stashed:
  # an interrupted job still restores it (including a stash made just before
  # the signal).
  trap _rs_on_signal TERM INT

  if [ -n "$(_rs_git status --porcelain)" ]; then
    RS_STASH_MSG="gbrain-daily-resync auto-stash $(date -Iseconds) run-$$-$RANDOM$RANDOM"
    if ! _rs_git stash push -u -q -m "$RS_STASH_MSG"; then
      echo "  skip: could not stash local changes in $RS_DIR"; trap - TERM INT; return 0
    fi
    RS_STASH=$(_rs_our_stash)
    if [ -n "$(_rs_git status --porcelain)" ]; then
      # Changes stash could not hold (e.g. a dirty submodule): never switch
      # branches over them. Put back what we did stash and leave the repo alone.
      echo "  skip: $RS_DIR has changes git stash cannot hold"
      _rs_restore || true
      trap - TERM INT
      return 0
    fi
    [ -n "$RS_STASH" ] && echo "  stashed local changes on $RS_ORIG ($RS_STASH)"
  fi

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

  # `|| true`: a failed switch-back is already logged with the stash to recover;
  # under the caller's `set -e` it must not abort the remaining repos.
  _rs_restore || true
  trap - TERM INT
  return 0
}
