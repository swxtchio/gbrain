#!/usr/bin/env bash
# Fetch OPENAI_API_KEY from Azure Key Vault and write it to ~/.gbrain/openai.env
# (0600). Source ~/.gbrain/openai.env from your shell rc to pick it up.
#
# Usage:
#   ~/.gbrain/refresh-openai-key.sh           # refresh if stale (>12h) or missing
#   ~/.gbrain/refresh-openai-key.sh --force   # always refresh

set -euo pipefail

VAULT="swx-mr-master-dev-kv"
SECRET="openai-api-key"
OUT="$HOME/.gbrain/openai.env"
TTL_HOURS=12

force=0
[ "${1:-}" = "--force" ] && force=1

if [ "$force" = 0 ] && [ -f "$OUT" ]; then
  age_seconds=$(( $(date +%s) - $(stat -c %Y "$OUT") ))
  if [ "$age_seconds" -lt $(( TTL_HOURS * 3600 )) ]; then
    echo "openai.env is fresh (age $(( age_seconds / 60 ))m, TTL ${TTL_HOURS}h) — no refresh needed."
    echo "Force refresh with: $0 --force"
    exit 0
  fi
fi

if ! command -v az >/dev/null 2>&1; then
  echo "ERROR: az CLI not on PATH." >&2
  exit 1
fi

# Probe az auth before clobbering the existing file.
if ! az account show >/dev/null 2>&1; then
  echo "ERROR: az not logged in. Run: az login --tenant 29fc2961-3afa-4f23-97fe-795c7749efdf" >&2
  [ -f "$OUT" ] && echo "Keeping existing $OUT (may be stale)." >&2
  exit 1
fi

umask 077
mkdir -p "$(dirname "$OUT")"

tmp="$(mktemp "$OUT.tmp.XXXXXX")"
trap 'rm -f "$tmp"' EXIT

if ! key="$(az keyvault secret show --vault-name "$VAULT" --name "$SECRET" --query value -o tsv 2>&1)"; then
  echo "ERROR: az keyvault fetch failed:" >&2
  echo "$key" >&2
  [ -f "$OUT" ] && echo "Keeping existing $OUT (may be stale)." >&2
  exit 1
fi

if [ -z "$key" ] || printf '%s' "$key" | grep -qi "error"; then
  echo "ERROR: KV returned empty or error-looking value; aborting." >&2
  exit 1
fi

printf 'export OPENAI_API_KEY=%q\n' "$key" > "$tmp"
chmod 600 "$tmp"
mv "$tmp" "$OUT"

bytes=$(wc -c < "$OUT")
echo "OK: refreshed $OUT ($bytes bytes, 0600)."
echo "Source it now in this shell: source $OUT"
