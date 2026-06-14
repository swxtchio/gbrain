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

## Notes

- Loopback only (`--bind 127.0.0.1`): reachable on this VM, not the network. For
  cross-machine/global access, see `docs/tutorials/connect-coding-agent.md` and
  `docs/mcp/DEPLOY.md` (HTTPS + `--bind 0.0.0.0` + `--public-url` + OAuth scoping).
- The `gbrain` CLI is `bun link`ed to this fork checkout, so the service must be
  restarted to pick up new code. Update the fork via `scripts/gbrain-safe-update`
  (sync upstream → rebase `swxtch` → `bun install` → `gbrain post-upgrade` →
  **restart `gbrain-http.service`**); it handles the restart automatically.
