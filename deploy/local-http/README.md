# Single shared gbrain HTTP MCP server (local VM)

Run **one** `gbrain serve --http` on loopback as a systemd **user** service, and
point every Claude Code session on this VM at it — instead of each session
spawning its own `gbrain serve` stdio child.

## Why

Each stdio `gbrain serve` opens its own connection pool against the remote
Supabase **session** pooler, whose client cap is **15**. With several Claude
sessions open (each `GBRAIN_POOL_SIZE=2`) plus cron jobs, that cap was exhausted
(`EMAXCONNSESSION: max clients reached in session mode`), and every MCP reconnect
re-ran the ~15s schema-init, surfacing as `Failed to reconnect to gbrain: -32000`.

One shared server fixes all of it:

| | N× stdio (per session) | 1× HTTP service (this) |
|---|---|---|
| DB pool connections | N × 2 + cron → blows past 15 | one shared pool (`GBRAIN_POOL_SIZE=6`) |
| `EMAXCONNSESSION` | recurring | gone |
| `-32000` reconnect storms | per-session 15s schema-init | one warm server |
| Survives terminal close | no | yes (systemd user service + linger) |

## Setup (server)

```bash
deploy/local-http/setup.sh
```

Idempotent. Installs `gbrain-http.service` into `~/.config/systemd/user/`,
enables + starts it, and waits for `http://127.0.0.1:8787/health`. The brain's
DB URL, OpenAI key, and **embedding model (pinned to `openai:text-embedding-3-large`
@ 1536)** are read from `~/.gbrain/config.json` — not duplicated in the unit, so
the file-plane pin stays the single source of truth.

`loginctl enable-linger "$USER"` must be on so the service runs without an active
login (already enabled on this VM; the command is idempotent if you need it).

## Wire Claude Code (per agent, one-time)

```bash
gbrain auth create "claude-code-vm"                 # prints a long-lived gbrain_… bearer token
gbrain connect http://127.0.0.1:8787/mcp --token gbrain_… --install --force
```

`--install` runs `claude mcp add` and smoke-tests the token (`get_brain_identity`)
before handing off; `--force` replaces the prior stdio `gbrain` entry. For the
entry to apply to **all** projects/sessions it must live at **user** scope in
`~/.claude.json` (`claude mcp add --scope user …` / top-level `mcpServers`), not a
project-local scope.

Existing Claude sessions keep their old stdio child until restarted; restart them
to pick up the HTTP transport.

## Manage

```bash
systemctl --user status  gbrain-http.service
systemctl --user restart gbrain-http.service     # manual reload (e.g. config change)
journalctl --user -u gbrain-http.service -f
curl -fsS http://127.0.0.1:8787/health
```

After a fork update, `scripts/gbrain-safe-update` restarts this service for you
(it loads the rebased code), so a manual restart is only needed for out-of-band
changes like editing `~/.gbrain/config.json`.

## Connection pooler topology (transaction pooler + dual-pool)

`database_url` (config.json) points at the Supabase **transaction pooler (`:6543`)**
so high client concurrency (many MCP callers, multi-worker `gbrain sync`) doesn't
hit the session pooler's 15-client cap. gbrain auto-disables prepared statements on
`:6543`.

Session-scoped operations (DDL, the schema-init advisory lock, autopilot/cycle
locks) are **not** transaction-mode safe, so they route to a small **direct pool**
on the `:5432` **session** pooler via `GBRAIN_DIRECT_DATABASE_URL` in
`~/.gbrain/http.env` (0600, gitignored — loaded by the unit's `EnvironmentFile=`
and, for CLI use, by sourcing it in your shell). Without it gbrain auto-derives
`db.<ref>.supabase.co` which is **IPv6-only → unreachable here**, hanging any
direct-pool op. For CLI (`gbrain doctor`/`sync`), source it: `set -a; . ~/.gbrain/http.env; set +a`.

Known transaction-pooler limitation: gbrain's **onboard checks hang on `:6543`**
(they work on `:5432`). `gbrain doctor` bounds that phase with a timeout
(`GBRAIN_DOCTOR_ONBOARD_TIMEOUT_MS`, default 15000) so it always completes —
onboard shows a `[WARN]`. For full onboard/pack info run it against the session
pooler: `GBRAIN_DATABASE_URL=$GBRAIN_DIRECT_DATABASE_URL gbrain onboard --check`.

## Upgrade gotcha: forward-reference bootstrap gap (long-lived brains)

Upgrading a **long-lived** brain (one created many versions ago) can abort schema
init with a `column "<name>" does not exist` error, leaving the DB **stuck at the
old schema version** even though the code updated. This bit us upgrading to
v0.42.58.0: `column "event_page_id" does not exist`, DB frozen at v119.

**Why it happens.** `initSchema()` replays the static schema blob
(`src/schema.sql` / `src/core/pglite-schema.ts`) **before** `runMigrations()`.
The blob's `CREATE INDEX` statements run *unconditionally*, but
`CREATE TABLE IF NOT EXISTS` is a no-op on a table that already exists — so a new
column added to that table by a recent migration never lands during the replay,
and the blob's index-on-that-column throws before the migration that would add it
can run. `applyForwardReferenceBootstrap` (in both engine files) exists to
pre-add exactly these columns, but it only covers them if someone remembered to
add the new column to it. When a release adds a forward-referenced column and
*doesn't* extend the bootstrap, every pre-that-version brain wedges on upgrade.
(Fixed for the v121/v122 Life Chronicle columns in this fork; the class can recur
on any future release.)

**Recovery / workaround if it recurs:**

1. **Identify the missing column** from the error (`column "X" does not exist`)
   and which migration adds it (`grep -n "ADD COLUMN.*X" src/core/migrate.ts`).
2. **Extend the bootstrap** — the correct fix. In *both*
   `src/core/postgres-engine.ts` and `src/core/pglite-engine.ts`
   `applyForwardReferenceBootstrap`: add an `information_schema` probe for the
   column, a `needs…` flag, include it in the early-return guard, and an
   `ADD COLUMN IF NOT EXISTS` apply block. Keep the two engines in parity
   (guarded by `test/schema-bootstrap-coverage.test.ts`). Then re-run the
   migration; the CLI runs from source so the fix is live immediately.
3. **Then run** `gbrain init --migrate-only` (NOT bare `apply-migrations` — the
   wedge is in the blob replay, which `init --migrate-only` drives). Verify:
   `psql "$GBRAIN_DIRECT_DATABASE_URL" -tc "SELECT value FROM config WHERE key='version'"`
   equals `LATEST_VERSION`.

**Watch for `EMAXCONNSESSION` during recovery.** Migration DDL routes to the
`:5432` **session** pool (15-client cap). A long-running `gbrain-http.service` (or
stray CLI workers) can hold all 15 slots → `max clients reached in session mode`.
Free them first: `systemctl --user restart gbrain-http.service` (also loads the
new code), confirm `curl -fsS http://127.0.0.1:8787/health`, then re-run the
migration. Don't sleep-and-hope — poll the health endpoint.

## Notes

- Loopback only (`--bind 127.0.0.1`): reachable on this VM, not the network. For
  cross-machine/global access, see `docs/tutorials/connect-coding-agent.md` and
  `docs/mcp/DEPLOY.md` (HTTPS + `--bind 0.0.0.0` + `--public-url` + OAuth scoping).
- The `gbrain` CLI is `bun link`ed to this fork checkout, so the service must be
  restarted to pick up new code. Update the fork via `scripts/gbrain-safe-update`
  (sync upstream → rebase `swxtch` → `bun install` → `gbrain post-upgrade` →
  **restart `gbrain-http.service`**); it handles the restart automatically.
