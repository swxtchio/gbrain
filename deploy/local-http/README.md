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
systemctl --user restart gbrain-http.service     # e.g. after `git pull` on the fork
journalctl --user -u gbrain-http.service -f
curl -fsS http://127.0.0.1:8787/health
```

## Notes

- Loopback only (`--bind 127.0.0.1`): reachable on this VM, not the network. For
  cross-machine/global access, see `docs/tutorials/connect-coding-agent.md` and
  `docs/mcp/DEPLOY.md` (HTTPS + `--bind 0.0.0.0` + `--public-url` + OAuth scoping).
- The `gbrain` CLI is `bun link`ed to this fork checkout, so `systemctl --user
  restart` after updating the `swxtch` branch picks up new code. Update the fork
  via `scripts/gbrain-safe-update` (sync upstream → rebase `swxtch` → safe-update).
