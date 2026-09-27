#!/usr/bin/env bash
# Fetch the gbrain Supabase connection URL from Azure Key Vault and write it to
# ~/.gbrain/config.json (0600). This is the single source of truth for gbrain's
# DB credential, so a password rotation is a one-place update: rotate the secret
# in KV, then run this with --force on each machine.
#
# The KV secret value must be the full Supabase session-pooler URL, e.g.
#   postgresql://postgres.<ref>:<password>@aws-1-us-east-1.pooler.supabase.com:5432/postgres
#
# Usage:
#   ~/.gbrain/refresh-gbrain-db-url.sh           # write if config.json missing/urlless
#   ~/.gbrain/refresh-gbrain-db-url.sh --force   # always re-pull (use after a rotation)

set -euo pipefail

VAULT="swx-mr-master-dev-kv"
SECRET="gbrain-db-url"
OUT="$HOME/.gbrain/config.json"

force=0
[ "${1:-}" = "--force" ] && force=1

# Skip if we already have a usable database_url and not forced.
if [ "$force" = 0 ] && [ -f "$OUT" ] && grep -q '"database_url"[[:space:]]*:[[:space:]]*"postgres' "$OUT" 2>/dev/null; then
  echo "config.json already has a database_url — no refresh needed."
  echo "Re-pull after a password rotation with: $0 --force"
  exit 0
fi

if ! command -v az >/dev/null 2>&1; then
  echo "ERROR: az CLI not on PATH. (postinst installs it; open a new shell.)" >&2
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

if ! url="$(az keyvault secret show --vault-name "$VAULT" --name "$SECRET" --query value -o tsv 2>&1)"; then
  echo "ERROR: az keyvault fetch failed:" >&2
  echo "$url" >&2
  [ -f "$OUT" ] && echo "Keeping existing $OUT (may be stale)." >&2
  exit 1
fi

# Validate shape without echoing the secret (it contains a password).
if ! printf '%s' "$url" | grep -qE '^postgres(ql)?://[^[:space:]]+@[^[:space:]]+/[^[:space:]]+$'; then
  echo "ERROR: KV value is not a postgres URL; aborting (not written)." >&2
  exit 1
fi

tmp="$(mktemp "$OUT.tmp.XXXXXX")"
trap 'rm -f "$tmp"' EXIT

# Preserve any extra config keys if jq is available; otherwise write canonical.
if command -v jq >/dev/null 2>&1 && [ -f "$OUT" ]; then
  jq --arg url "$url" '. + {engine: "postgres", database_url: $url}' "$OUT" > "$tmp"
else
  printf '{\n  "engine": "postgres",\n  "database_url": "%s"\n}\n' "$url" > "$tmp"
fi

chmod 600 "$tmp"
mv "$tmp" "$OUT"
echo "OK: wrote DB URL to $OUT (0600). Verify with: gbrain doctor"
