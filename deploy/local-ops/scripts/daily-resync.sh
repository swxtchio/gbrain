#!/bin/bash
# Daily resync of all swxtch-owned brain content.
#
# Runs in two phases:
#   1. Markdown bulk-refresh (delegates to ~/.gbrain/bulk-refresh.sh)
#      Stages markdown into ~/.gbrain-staging-bulk/<repo-name>/<rel-path>
#      so slugs stay namespaced under source_id='default' (e.g.
#      swx-srtx/docs/foo). Existing infrastructure; we just call it.
#
#   2. Per-repo code sync. For each registered code source, run
#      `gbrain sync --source <id> --strategy code --no-pull --yes`.
#      Each repo's code lives in its own source row, so slug
#      collisions across repos (`src/main.c` in swx-srtx vs swx-spp)
#      are isolated by source_id. Requires the v0.18.0 Step 5
#      source-id propagation patch on the swxtch branch.
#
# Triggered by gbrain-daily-resync.timer (daily 03:30 local).
# Manual run: ~/.gbrain/daily-resync.sh
#
# Code repos must be pre-registered via `gbrain sources add <id>
# --path <path>`. The repo IDs below match the gbrain source IDs.

set -e
export PATH="$HOME/.bun/bin:/usr/bin:/bin:/usr/local/bin"

LOG="$HOME/.gbrain/daily-resync.log"
exec >>"$LOG" 2>&1

echo ""
echo "=== daily resync @ $(date -Iseconds) ==="

# Fetch OpenAI key from Azure KV (same source as ~/.bashrc interactive path)
if command -v az >/dev/null 2>&1; then
  # `|| true`: under set -e a failing az (e.g. not logged in) used to kill the
  # whole job here, silently, every night (2026-09-24..26). Fall back to the
  # key already in the environment / gbrain config instead.
  _OPENAI_KEY=$(az keyvault secret show --vault-name swx-mr-orch-dev-kv --name openai-api-key --query value -o tsv 2>/dev/null) || true
  [ -n "$_OPENAI_KEY" ] && export OPENAI_API_KEY="$_OPENAI_KEY"
  unset _OPENAI_KEY
fi

# Phase 1: markdown bulk-refresh (~/.gbrain/bulk-refresh.sh stages 7 repos
# under ~/.gbrain-staging-bulk and gbrain-imports the lot under default).
echo ""
echo "--- phase 1: markdown bulk-refresh ---"
# A failed phase is recorded, not fatal: the rest still run, and the job exits
# nonzero at the end so systemd shows the failure.
failed=""
"$HOME/.gbrain/bulk-refresh.sh" || { echo "  !! phase 1 failed (exit $?); see ~/.gbrain/bulk-refresh.log"; failed="$failed bulk-refresh"; }

# Phase 2: per-repo code sync. Each ID matches a `gbrain sources` row.
# 2026-09-26: the swx-model-router-* repos are deprecated and their sources were
# removed; swx-abbe consolidates them. swx-abbe syncs markdown AND code
# (--strategy auto) because bulk-refresh no longer stages it.
# 2026-09-27: + swx-opencode (opencode fork) and swx-llmrouter; both sync markdown
# AND code (--strategy auto), like swx-abbe — bulk-refresh does not stage them.
CODE_SOURCES="swx-srtx swx-spp swx-abbe swx-opencode swx-llmrouter"

# sync_on_default_branch: stash -> default branch -> ff -> sync -> switch back ->
# unstash, per repo (~/.gbrain/resync-lib.sh). Never syncs a stale or temporary
# checkout, never leaves the user's branch or changes disturbed.
. "$HOME/.gbrain/resync-lib.sh"

echo ""
echo "--- phase 2: per-repo code sync ---"
for src in $CODE_SOURCES; do
  echo ""
  echo "+ source=$src"
  if ! gbrain sources list 2>/dev/null | grep -q "^  $src "; then
    echo "  skip: source '$src' not registered (run: gbrain sources add $src --path ~/$src)"
    continue
  fi
  # sync_on_default_branch indexes the repo's current default branch (stash,
  # switch, ff, sync, switch back, unstash), so a temporarily-checked-out
  # branch never triggers surprise re-imports and a stale checkout never steps
  # pages back. It passes --no-pull --yes to gbrain sync.
  strategy=code
  case "$src" in swx-abbe|swx-opencode|swx-llmrouter) strategy=auto ;; esac
  sync_on_default_branch "$src" "$strategy"
done

echo ""
echo "--- phase 3: embed any stale chunks ---"
if embed_out=$(mktemp); then
  gbrain embed --stale >"$embed_out" 2>&1 || failed="$failed embed"
  grep -vE '^(\[[^]]+\] )?\[[a-z0-9_.-]+\] [0-9]+/[0-9]+ \([0-9]+%\)' "$embed_out" || true
  rm -f "$embed_out"
else
  echo "  !! could not create a temp file; embed skipped"
  failed="$failed embed"
fi

[ -n "${RS_FAILED:-}" ] && failed="$failed sync:${RS_FAILED# }"
echo ""
echo "=== daily resync done @ $(date -Iseconds) ==="
if [ -n "$failed" ]; then
  echo "!! failed:$failed"
  exit 1
fi
