#!/bin/bash
# Per-repo HEAD watermark guard for gbrain refresh scripts.
#
# Use case: developer temporarily checks out an old commit for testing
# (`git checkout HEAD~5`), the weekly refresh fires while they're on the
# old tree, and stale content gets re-imported into the brain.
#
# Logic:
#   - Track newest imported HEAD per repo in ~/.gbrain/refresh-watermark.json
#   - Before refreshing repo X, check if current HEAD is a strict ancestor
#     of the watermark — if yes, HEAD is older than what's already in the
#     brain → skip.
#   - First-time run: no watermark → proceed, record HEAD as initial watermark.
#   - Same commit: proceed (gbrain content_hash makes it idempotent).
#   - Divergent / unrelated history: proceed (assume user's intent — they
#     switched branches deliberately). Update watermark.
#
# Usage (source this in a refresh script):
#   . ~/.gbrain/refresh-watermark.sh
#   if should_skip_repo "$REPO_DIR" "$repo_name"; then continue; fi
#   # ... do the import work ...
#   update_watermark "$repo_name" "$REPO_DIR"

WATERMARK_FILE="${WATERMARK_FILE:-$HOME/.gbrain/refresh-watermark.json}"

_ensure_watermark_file() {
  if [ ! -f "$WATERMARK_FILE" ]; then
    echo '{}' > "$WATERMARK_FILE"
  fi
}

# Return 0 (skip) if HEAD is strictly older than watermark, else 1 (proceed)
should_skip_repo() {
  local repo_dir="$1"
  local repo_name="$2"
  _ensure_watermark_file

  if [ ! -d "$repo_dir/.git" ] && [ ! -f "$repo_dir/.git" ]; then
    return 1  # not a git repo or working tree, proceed (libsrt etc.)
  fi

  local current_head
  current_head=$(git -C "$repo_dir" rev-parse HEAD 2>/dev/null) || return 1

  local watermark
  watermark=$(jq -r --arg k "$repo_name" '.[$k] // ""' "$WATERMARK_FILE" 2>/dev/null)

  if [ -z "$watermark" ]; then
    return 1  # no watermark yet, proceed
  fi
  if [ "$watermark" = "$current_head" ]; then
    return 1  # same commit, proceed (no-op via content_hash)
  fi

  # Ensure watermark commit is reachable in this repo (if user did history
  # rewriting / force-push, the old watermark may have been pruned).
  if ! git -C "$repo_dir" cat-file -e "$watermark" 2>/dev/null; then
    return 1  # watermark gone, treat as fresh start
  fi

  # Is current HEAD an ancestor of watermark? If yes (and not equal),
  # HEAD is strictly older — skip.
  if git -C "$repo_dir" merge-base --is-ancestor "$current_head" "$watermark" 2>/dev/null; then
    return 0  # SKIP
  fi
  return 1  # proceed (newer or divergent)
}

# Record current HEAD as the new watermark for this repo.
update_watermark() {
  local repo_name="$1"
  local repo_dir="$2"
  _ensure_watermark_file

  if [ ! -d "$repo_dir/.git" ] && [ ! -f "$repo_dir/.git" ]; then
    return 0
  fi

  local current_head
  current_head=$(git -C "$repo_dir" rev-parse HEAD 2>/dev/null) || return 0

  # Atomic update via tmp + mv
  local tmp="$WATERMARK_FILE.tmp.$$"
  jq --arg k "$repo_name" --arg v "$current_head" \
     '. + {($k): $v}' "$WATERMARK_FILE" > "$tmp" && mv "$tmp" "$WATERMARK_FILE"
}
