#!/bin/bash
# Weekly libsrt drift refresh: git pull, rsync .md files into staging,
# gbrain import, gbrain embed. Reports drift to log.
#
# Triggered by gbrain-libsrt-refresh.timer (Sunday 02:00 local).
# Manual run: ~/.gbrain/libsrt-refresh.sh
set -e
export PATH="$HOME/.bun/bin:/usr/bin:/bin:/usr/local/bin"

LOG="$HOME/.gbrain/libsrt-refresh.log"
exec >>"$LOG" 2>&1

echo ""
echo "=== libsrt refresh @ $(date -Iseconds) ==="

CLONE="$HOME/tools/libsrt"
STAGE="$HOME/.gbrain-staging/libsrt"

# 1. Pull upstream
cd "$CLONE"
# $CLONE is a dedicated shallow mirror, reset hard to origin/master below. Refuse
# if it has become anything else, so a local edit or branch is never discarded.
if [ "$(git symbolic-ref --short -q HEAD)" != master ] || [ -n "$(git status --porcelain)" ]; then
  echo "  skip: $CLONE is not a clean master mirror ($(git symbolic-ref --short -q HEAD || echo detached), $(git status --porcelain | wc -l) change(s)); not resetting it"
  exit 0
fi
OLD_SHA=$(git rev-parse HEAD)
git fetch --depth 1 origin master 2>&1
git reset --hard origin/master 2>&1
NEW_SHA=$(git rev-parse HEAD)

if [ "$OLD_SHA" = "$NEW_SHA" ]; then
  echo "  no drift ($OLD_SHA), exiting clean"
  exit 0
fi
echo "  $OLD_SHA -> $NEW_SHA"
echo "  changed files since previous: $(git diff --name-only $OLD_SHA $NEW_SHA | wc -l)"

# 2. Resync .md tree
mkdir -p "$STAGE"
rsync -a --delete --include='*/' --include='*.md' --include='*.MD' --exclude='*' "$CLONE/" "$STAGE/"
echo "  staged md files: $(find "$STAGE" -name '*.md' -o -name '*.MD' | wc -l)"

# 3. Fetch OpenAI key for embeddings
if command -v az >/dev/null 2>&1; then
  # `|| true`: under set -e a failing az (e.g. expired login) used to abort the
  # whole job here, silently (and, for bulk-refresh, the nightly resync with it).
  _OPENAI_KEY=$(az keyvault secret show --vault-name swx-mr-orch-dev-kv --name openai-api-key --query value -o tsv 2>/dev/null) || true
  [ -n "$_OPENAI_KEY" ] && export OPENAI_API_KEY="$_OPENAI_KEY"
  unset _OPENAI_KEY
fi

# 4. Import + embed
cd "$HOME"
gbrain import "$HOME/.gbrain-staging" --no-embed 2>&1 | grep -E "imported|skipped|error|chunks" | head -5
gbrain embed --stale 2>&1 | tail -2

# 5. Extract links/timeline (autopilot's continuous extract is broken in v0.18.2)
gbrain extract links --source fs --dir "$HOME/.gbrain-staging" --json 2>&1 | grep -E '"links_created"' | tail -1
gbrain extract timeline --source fs --dir "$HOME/.gbrain-staging" --json 2>&1 | grep -E '"timeline_entries_created"' | tail -1

echo "  done @ $(date -Iseconds)"
