#!/bin/bash
# Daily TODO/ROADMAP refresh: walks the active swx repos, stages each
# TODO.md/TODOS.md/ROADMAP.md under <repo-name>/<relative-path> so slugs
# stay namespaced (no cross-repo collisions), then imports + embeds.
#
# Triggered by gbrain-todo-refresh.timer (daily 02:30 local).
# Manual run: ~/.gbrain/todo-refresh.sh
set -e
export PATH="$HOME/.bun/bin:/usr/bin:/bin:/usr/local/bin"

LOG="$HOME/.gbrain/todo-refresh.log"
exec >>"$LOG" 2>&1

# HEAD-watermark guard: skip repos whose current HEAD is strictly older
# than the last-imported commit. (Shared logic; bulk-refresh does the
# global watermark update — todo-refresh only reads it.)
. "$HOME/.gbrain/refresh-watermark.sh"

echo ""
echo "=== TODO refresh @ $(date -Iseconds) ==="

REPOS="swx-srtx swx-model-router-saas swx-model-router-blox swx-model-router-design swx-model-router-ops swx-model-router-orchestration swx-spp"
STAGE="$HOME/.gbrain-staging/_todos"

# Wipe + rebuild stage (TODO files are small + few; rebuilding from scratch
# avoids stale entries when a TODO.md gets renamed or deleted upstream)
rm -rf "$STAGE"
mkdir -p "$STAGE"

count=0
for d in $REPOS; do
  REPO_DIR="$HOME/$d"
  [ -d "$REPO_DIR" ] || continue
  if should_skip_repo "$REPO_DIR" "$d"; then
    head=$(git -C "$REPO_DIR" rev-parse --short HEAD 2>/dev/null)
    wm=$(jq -r --arg k "$d" '.[$k] // ""' "$WATERMARK_FILE" 2>/dev/null | cut -c1-7)
    echo "  skip: $d HEAD=$head older than watermark=$wm"
    continue
  fi
  while IFS= read -r f; do
    rel="${f#./}"
    # gbrain skips dotfile dirs during import — rewrite leading-dot path
    # components to keep ROADMAP.md / TODO.md inside .planning/, .docs/, etc.
    # reachable. e.g. ".planning/ROADMAP.md" -> "planning/ROADMAP.md".
    rel_safe=$(echo "$rel" | sed 's|/\.|/|g; s|^\.||')
    target="$STAGE/$d/$rel_safe"
    mkdir -p "$(dirname "$target")"
    cp "$REPO_DIR/$rel" "$target"
    count=$((count+1))
    note=""
    [ "$rel" != "$rel_safe" ] && note=" -> $rel_safe"
    echo "  staged: $d/$rel ($(wc -c <"$REPO_DIR/$rel") bytes)$note"
  done < <(cd "$REPO_DIR" && find . -type f \( -iname "todo.md" -o -iname "todos.md" -o -iname "roadmap.md" \) \
    -not -path "*/node_modules/*" -not -path "*/.git/*" -not -path "*/build/*" \
    -not -path "*/dist/*" -not -path "*/_deps/*" \
    -not -path "*/dependencies/*" -not -path "*/.claude/*" -not -path "*/target/*" 2>/dev/null)
done
echo "  total staged: $count files"

# Fetch OpenAI key for embeddings
if command -v az >/dev/null 2>&1; then
  # `|| true`: under set -e a failing az (e.g. expired login) used to abort the
  # whole job here, silently (and, for bulk-refresh, the nightly resync with it).
  _OPENAI_KEY=$(az keyvault secret show --vault-name swx-mr-orch-dev-kv --name openai-api-key --query value -o tsv 2>/dev/null) || true
  [ -n "$_OPENAI_KEY" ] && export OPENAI_API_KEY="$_OPENAI_KEY"
  unset _OPENAI_KEY
fi

# Import staging dir; gbrain hashes content so unchanged files are no-ops
cd "$HOME"
gbrain import "$STAGE" --no-embed 2>&1 | grep -E "imported|skipped|error|chunks" | head -3
gbrain embed --stale 2>&1 | tail -2

# Extract links/timeline so any new wikilinks in TODO/ROADMAP files become edges.
# (autopilot's continuous extract is broken in v0.18.2; weekly refreshes handle it.)
gbrain extract links --source fs --dir "$STAGE" --json 2>&1 | grep -E '"links_created"' | tail -1
gbrain extract timeline --source fs --dir "$STAGE" --json 2>&1 | grep -E '"timeline_entries_created"' | tail -1

echo "  done @ $(date -Iseconds)"
