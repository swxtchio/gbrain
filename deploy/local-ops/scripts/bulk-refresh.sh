#!/bin/bash
# Weekly bulk content refresh for all owned repos.
# Stages each repo's .md files under <repo-name>/<rel-path> in a single
# staging dir, then runs gbrain import. Excludes vendored deps and build
# artifacts. Slugs are namespaced (no cross-repo collisions).
#
# Triggered by gbrain-bulk-refresh.timer (Sunday 03:00 local).
# Manual run: ~/.gbrain/bulk-refresh.sh
#
# This script does NOT git pull — the repos are the user's working trees.
# It rsyncs whatever is currently checked out. If a repo's main branch has
# moved upstream and the local tree is behind, the brain reflects local.
set -e
export PATH="$HOME/.bun/bin:/usr/bin:/bin:/usr/local/bin"

LOG="$HOME/.gbrain/bulk-refresh.log"
exec >>"$LOG" 2>&1

# HEAD-watermark guard: skip repos whose current HEAD is strictly older
# than the last-imported commit (e.g. user temporarily checked out an old
# commit for testing). See ~/.gbrain/refresh-watermark.sh for logic.
. "$HOME/.gbrain/refresh-watermark.sh"

echo ""
echo "=== bulk refresh @ $(date -Iseconds) ==="

# Repos to bulk-refresh. Names match $HOME/<name> directories.
# (~/swx-spp is a symlink to ~/spp.)
# 2026-09-26: swx-model-router-* repos deprecated (consolidated into swx-abbe,
# which is its own source synced by daily-resync — staging it here too would
# duplicate its pages under default).
REPOS="swx-srtx swx-spp"
STAGE="$HOME/.gbrain-staging-bulk"

# Wipe + rebuild stage so deletions upstream get reflected in the brain
rm -rf "$STAGE"
mkdir -p "$STAGE"

total=0
for d in $REPOS; do
  REPO_DIR="$HOME/$d"
  if [ ! -d "$REPO_DIR" ]; then
    echo "  skip: $d not found"
    continue
  fi
  if should_skip_repo "$REPO_DIR" "$d"; then
    head=$(git -C "$REPO_DIR" rev-parse --short HEAD 2>/dev/null)
    wm=$(jq -r --arg k "$d" '.[$k] // ""' "$WATERMARK_FILE" 2>/dev/null | cut -c1-7)
    echo "  skip: $d HEAD=$head is older than watermark=$wm (likely temp checkout — brain stays at $wm)"
    continue
  fi
  TARGET="$STAGE/$d"
  mkdir -p "$TARGET"

  # rsync .md files only, excluding 3rd-party + build artifacts.
  # Exclude rules MUST come before --include='*/' so they bind on the
  # top-level dirs (rsync uses first-match-wins).
  rsync -a \
    --exclude='dependencies' \
    --exclude='.claude' \
    --exclude='.git' \
    --exclude='build' \
    --exclude='target' \
    --exclude='node_modules' \
    --exclude='dist' \
    --exclude='_deps' \
    --include='*/' \
    --include='*.md' \
    --include='*.MD' \
    --exclude='*' \
    "$REPO_DIR/" "$TARGET/"

  # Strip leading dots from path components so gbrain doesn't skip dotfile
  # dirs (e.g. .planning/ROADMAP.md -> planning/ROADMAP.md). Same trick the
  # todo-refresh script uses.
  while IFS= read -r f; do
    rel="${f#$TARGET/}"
    rel_safe=$(echo "$rel" | sed 's|/\.|/|g; s|^\.||')
    if [ "$rel" != "$rel_safe" ]; then
      mkdir -p "$(dirname "$TARGET/$rel_safe")"
      mv "$f" "$TARGET/$rel_safe"
    fi
  done < <(find "$TARGET" -type f \( -name '*.md' -o -name '*.MD' \) -path '*/.*')

  count=$(find "$TARGET" -type f \( -name '*.md' -o -name '*.MD' \) | wc -l)
  echo "  staged: $d -> $count files"
  total=$((total + count))
  update_watermark "$d" "$REPO_DIR"
done
echo "  total staged: $total files"

# Fetch OpenAI key for embeddings
if command -v az >/dev/null 2>&1; then
  _OPENAI_KEY=$(az keyvault secret show --vault-name swx-mr-orch-dev-kv --name openai-api-key --query value -o tsv 2>/dev/null)
  [ -n "$_OPENAI_KEY" ] && export OPENAI_API_KEY="$_OPENAI_KEY"
  unset _OPENAI_KEY
fi

# Import (content_hash dedup makes unchanged files no-op)
cd "$HOME"
gbrain import "$STAGE" --no-embed 2>&1 | grep -E "imported|skipped|error|Import complete" | tail -5
gbrain embed --stale 2>&1 | tail -2

# Extract links + timeline AFTER import so the graph stays current. Autopilot's
# continuous extract is silently a no-op in v0.18.2 (verified empty links
# table after hours of cycles), so the weekly refresh has to handle it. Use
# --source fs which works; --source db is broken in v0.18.2.
gbrain extract links --source fs --dir "$STAGE" --json 2>&1 | grep -E '"links_created"' | tail -1
gbrain extract timeline --source fs --dir "$STAGE" --json 2>&1 | grep -E '"timeline_entries_created"' | tail -1

echo "  done @ $(date -Iseconds)"
