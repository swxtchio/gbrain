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
enables it, `restart`s it (not `enable --now`: on a re-run against an
already-active unit that is a no-op, so the OLD process would keep serving the
OLD unit), and waits for `http://127.0.0.1:8787/health`.

`GBRAIN_HTTP_PORT=<n> deploy/local-http/setup.sh` moves the service off 8787:
the value is numeric-validated, the installed unit copy is templated to
`--port <n>`, and setup's health probe checks that same port.
`scripts/gbrain-safe-update` reads the port back out of the installed unit
before probing, so an update of a moved service does not false-red. **Every
`8787` written below is the default** — if you moved the port, substitute it,
including in the `gbrain connect` line, which writes the endpoint into
`~/.claude.json` at user scope and would otherwise register a dead address.
The brain's
DB URL, OpenAI key, and **embedding model (pinned to `openai:text-embedding-3-large`
@ 1536)** are read from `~/.gbrain/config.json` — not duplicated in the unit, so
the file-plane pin stays the single source of truth.

`loginctl enable-linger "$USER"` must be on so the service runs without an active
login (already enabled on this VM; the command is idempotent if you need it).

## Wire Claude Code (per agent, one-time)

```bash
gbrain auth create "claude-code-vm"                 # prints a long-lived gbrain_… bearer token
gbrain connect http://127.0.0.1:8787/mcp --token gbrain_… --install --force
# moved the port? use it here too — setup.sh's own success line prints the
# exact command with the port it just installed.
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

## REQUIRED at deploy: keep the brain DB-only (`sync.write_through`)

Upstream defaults **write-through ON**: every `put_page` / capture /
`brainstorm --save` also renders a `.md` mirror of the page into the
registered source's `local_path` (or `sync.repo_path`). The old fork patch
disabled that automatically on postgres engines; it is RETIRED in favor of
upstream's config flag (introduced in the v0.46.23.0 roll `07f5d28d`,
extended to the timeline lane in `055ac6c7`) — which means deploying this
branch **re-enables** `.md` mirroring unless the flag is set.

Both entrypoints CHECK it rather than trusting this page, before the first
change either one makes, and neither proceeds past an undecided posture:

- `deploy/local-http/setup.sh` checks before it writes or runs anything. An
  undetermined or mirroring posture exits 3 with nothing installed and nothing
  started — earlier revisions checked after the restart, then after the unit
  had already been copied and re-templated, which left a rewritten unit on disk
  for the next reboot to pick up.
- `scripts/gbrain-safe-update` checks before the REBASE, and aborts the whole
  update rather than skipping a restart. The `gbrain` CLI is bun-linked to this
  checkout, so the moment the rebase lands every new process on the box —
  capture, `brainstorm --save`, cron sync, minion workers — runs the new code;
  the HTTP server is not the only disk sink. And the unit is enabled with
  `Restart=on-failure` + `WantedBy=default.target`, so skipping one restart
  would only defer activation to the next crash or reboot.
- **Only when the unit is installed.** `gbrain-http.service` being present is
  what makes "shared, DB-authoritative brain" true. On a box without it — an
  ordinary PGLite/file-authoritative brain — an unset key is the CORRECT
  inherited posture, and turning write-through off there would disable the
  `.md` mirror that IS that brain's source of truth. No unit, no gate, no
  advice.

**What the gate establishes, and what it cannot.** It establishes that at the
moment it runs the DB-plane posture is decided, and refuses to put new code on
the box while it is not. It cannot establish that the posture stays decided:
the flag is DB-backed and any client can change it afterwards. No deploy-time
check can promise more, and neither message pretends to.

Either way the decision is made once and recorded:

```bash
gbrain config set sync.write_through false      # DB-only — what this unit is for
GBRAIN_ALLOW_WRITE_THROUGH=1 <the command>      # keep the mirrors, deliberately
```

The read goes through `deploy/local-http/write-through-probe.ts`, which calls
`isWriteThroughDisabled` — the same predicate every runtime disk sink asks.
`gbrain config get` is deliberately NOT used: it resolves the file plane above
the DB plane, so a stale value in `~/.gbrain/config.json` would let it report
"off" while the brain still mirrors.

The shared brain is remote-postgres and DB-authoritative; the mirrors are
redundant and litter whatever tree the server runs from. Set the flag ONCE
(it is DB-backed, shared by every client of the brain — CLI, this service,
and MCP callers all honor it):

```bash
set -a; . ~/.gbrain/http.env; set +a   # session-pooler URL for CLI use
gbrain config set sync.write_through false
bun deploy/local-http/write-through-probe.ts   # verify: prints `disabled`
```

Verify with the probe, NOT with `gbrain config get sync.write_through`: `config
get` resolves the file plane above the DB plane, so a stale value in
`~/.gbrain/config.json` makes it print an off value while the brain still
mirrors. The probe calls `isWriteThroughDisabled`, the predicate every runtime
disk sink asks, and exits 0/1/2 for disabled/enabled/unknown. (The `config set`
above writes the DB plane, which is the right one — `sync.write_through` is not
a file-plane key.)

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
can run. `applyForwardReferenceBootstrap` exists to pre-add exactly these columns, but
it only covers them if someone remembered to add the new column to it. When a
release adds a forward-referenced column and *doesn't* extend the bootstrap,
every pre-that-version brain wedges on upgrade.

Fixed upstream for the v121/v122 Life Chronicle columns by `2fca1244`
"fix(schema): unblock pre-v121 schema replay (#2724) (#2735)" — the fork's own
bootstrap patch is retired in favor of it — and hardened again by `d9909cdd`
(v0.47.5.0, #4657), which moved the Postgres probe set + DDL into the shared
`src/core/postgres-engine/forward-reference-bootstrap.ts` so BOTH replay
entrypoints (`PostgresEngine.initSchema()` and the standalone `db.initSchema()`)
run it, and added a blob coverage gate. `test/schema-bootstrap-coverage.test.ts`
guards the class mechanically. It can still recur on any future release that
adds a static-schema-indexed column.

**Recovery / workaround if it recurs:**

1. **Identify the missing column** from the error (`column "X" does not exist`)
   and which migration adds it (`grep -n "ADD COLUMN.*X" src/core/migrate.ts`).
2. **Extend the bootstrap** — the correct fix. Two places, kept in parity:
   `src/core/postgres-engine/forward-reference-bootstrap.ts` (the Postgres
   probe set + DDL, which `PostgresEngine#applyForwardReferenceBootstrap`
   delegates to) and `PGLiteEngine#applyForwardReferenceBootstrap` in
   `src/core/pglite-engine.ts`. In each: add an `information_schema` probe for
   the column, a `needs…` flag, include it in the early-return guard, and an
   `ADD COLUMN IF NOT EXISTS` apply block. Parity is guarded by
   `test/schema-bootstrap-coverage.test.ts` (PGLite side + the Postgres-blob
   CREATE-INDEX gate, which parses the module's source) and
   `test/e2e/postgres-bootstrap.test.ts`. Then re-run the migration; the CLI
   runs from source so the fix is live immediately.
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
