# Port plan: swxtch customizations onto current upstream master

One-time re-port of the 7 `swxtch`-branch commits (fork point a25209bbb,
2026-07-10) onto origin/master (4e4677b1, v0.46.28.0). Port, not rebase: every
customization ends either **carried** (re-implemented + behavior test) or
**retired** (dropped, naming the upstream commit/code that now does the job).

## Survey verdicts (evidence gathered before writing code)

| # | Commit | Verdict | Evidence |
|---|--------|---------|----------|
| 1 | `88a02775` consolidated re-port | split by item | see below |
| 1a | — index.md syncable | **CARRY** | `SYNC_SKIP_FILES` still skips it upstream (sync.ts:489). Live brain has real pages at 3-segment slugs (`docs/blox-spec/index`, `docs/interfaces/index`); dropping the patch would classify those files `metafile` and delete-reconcile would REMOVE the pages on next sync. |
| 1b | — GBRAIN_TOP_DIRS | **RETIRE** | Job was "scope a mono-root above sibling repos". The fleet moved to per-source registration (`gbrain sources add <id> --path <repo>`; sync walks only the source's own `local_path` — src/commands/sync.ts `syncScopeRoot`, src/core/sync-cost-gate.ts:58). Verified zero consumers: not in the live service env, no crontab, no systemd unit, no fleet-doc reference. Upstream also gained a git-aware fast path (`gitListSyncableFiles`) that would silently bypass a walk-only re-apply, making a lazy carry a trap. Operators needing scoping use per-source registration or `--exclude` globs. |
| 1c | — N-segment slug resolver | **RETIRE** | Upstream `5e8816e7` "fix(links): resolve [[wikilink]] + slug-path frontmatter values" broadened Step 1 in both `link-extraction.ts` (accepts `a/b/c`, exact getPage) and `extract.ts` (`/^[a-z0-9][a-z0-9/_-]*$/` + `allSlugs.has`). Equivalent for real (slug-charset) pages. |
| 1d | — C/C++ chunker | **CARRY** (re-expressed) | Still absent upstream: no PASSTHROUGH recursion (header guards / extern "C" / namespace / template), no `type_definition`/`enum_specifier`/`union_specifier`/`preproc_function_def` top-level types, no declarator-field chain (upstream's #3789 wrapper dive covers `init_declarator` only, not `function_declarator`), no C/C++ symbol-preserving merge. Upstream `namespace_definition`/`template_declaration` remain opaque top-level chunks. No upstream C/C++ symbol tests exist. |
| 1e | — code-def DEF_TYPES | **CARRY** (reduced) | Add `declaration`, `type definition`, `union specifier`, `preproc def`. `struct specifier` already upstream; `preproc function def` is dead under current `normalizeSymbolType` (`preproc_function_def` → `function`, already covered). |
| 1f | — scripts/gbrain-safe-update | **CARRY** | Fork-preserving upgrade wrapper; upstream `gbrain upgrade` is binary self-update for non-fork installs — no equivalent. |
| 2 | `425a06fb` write-through gate | **RETIRE** | Upstream `42375bde` (#2404/#2426/#2607) added the `sync.write_through` config flag — DB-backed (shared across all clients of the brain), checked before any FS/DB work, with upstream tests, and it ALSO gates the facts-fence and timeline lanes our patch never reached. **Mandatory ops step at deploy: `gbrain config set sync.write_through false`** — verified the flag is currently UNSET on the live brain; without it, post-upgrade the shared server starts writing .md mirrors into `sync.repo_path` (`/home/byates/swx-model-router-ops`). Small ride-along carry: a `disabled_by_config` branch in brainstorm's `formatSaveOutcome` (upstream falls through to a misleading "file NOT written — see error above" for this skip reason). |
| 3 | `194d067c` deploy/local-http | **CARRY** | Fleet load-bearing (live `gbrain-http.service` runs exactly this unit). Verified all referenced upstream surface still exists: `serve --http --port --bind`, `/health`, `GBRAIN_POOL_SIZE`, `GBRAIN_DIRECT_DATABASE_URL`, `auth create`, `connect`. No behavior change to the unit. |
| 4 | `9bbafc96` safe-update restart | **CARRY** | Rides with 1f; content unchanged. |
| 5 | `3eb9aa4a` doctor onboard bound | **CARRY** (re-expressed) | Upstream doctor.ts:3939 is still a bare `await runAllOnboardChecks(engine)` — no bound. Hang reproduces TODAY on the live brain via :6543 (45s timeout kill, old binary). Upstream `79f6d1bf` made an unreachable direct host non-fatal (fallback + log) but does not bound onboard checks. Part 2 (GBRAIN_DIRECT_DATABASE_URL → :5432 session pooler) is uncommitted env-file config — README documentation only. |
| 6 | `d74d45be` bootstrap v121/v122 | **RETIRE** | Upstream `2fca1244` "fix(schema): unblock pre-v121 schema replay (#2724) (#2735)" — merged one day after ours — adds the `event_page_id` forward-reference probe + bare-column repair to BOTH engines, plus `test/bootstrap.test.ts` and the `test/schema-bootstrap-coverage.test.ts` CI gate for the whole incident class. The facts-ontology columns we also pre-added were defense-in-depth only: verified no static-schema index references `facts.dimension/value/value_hash/dim_status` (schema-embedded.generated.ts), so they never blocked blob replay. |
| 7 | `63c50bb2` docs | **MIXED** | CLAUDE.md MUST-DO prose + llms-full.txt: DROP — upstream documents the invariant ("Forward-referenced columns/indexes go in the bootstrap probe set (guarded by test/schema-bootstrap-coverage.test.ts)") and now enforces it mechanically; a fork CLAUDE.md diff is permanent merge friction. deploy README "Upgrade gotcha": CARRY with item 3, updated to cite the upstream fix `2fca1244`. |

## Re-expression pressure points (upstream restructuring)

- `src/commands/doctor.ts` (66 upstream commits): the onboard phase moved from
  ~line 7310 to ~3939 inside a slimmer `buildChecks` (monolith peels). The bound
  re-expresses around the same seam; env var `GBRAIN_DOCTOR_ONBOARD_TIMEOUT_MS`
  unchanged. Test seam: `buildChecks` is unit-testable in-process
  (test/doctor-behavioral.test.ts pattern) + `mock.module` the checks import.
- `src/core/chunkers/code.ts` (10 upstream commits): gained `NESTED_EMIT_CONFIG`,
  `NAME_WRAPPER_TYPES`, tiktoken-safe `estimateTokens`, oversize capping. The
  walker site (semanticNodes filter) is structurally unchanged — re-express
  `collectSemanticNodes`/PASSTHROUGH there; extend `extractSymbolName` with the
  declarator-field chain alongside (not against) the #3789 wrapper dive; add the
  C/C++ symbol-preserving guard to the current `mergeSmallSiblings`.
- `src/commands/import.ts` (14 upstream commits): `collectSyncableFiles` gained
  the git-aware fast path. (Would have mattered for GBRAIN_TOP_DIRS; moot after
  retirement.)

## Test plan (every carried behavior gets a fail-without-it test)

1. index.md — update `test/sync-isSyncable-shape.test.ts` (classification +
   exact skip-list) and `test/sync.test.ts` (`isSyncable('index.md') === true`).
   These assert upstream's skip today → fail pre-patch.
2. C/C++ chunker — new `test/chunkers/code-c-cpp.test.ts`: fixture covering
   header guard, extern "C", prototype, typedef, struct/union/enum, object- and
   function-like macro, namespace member, templated function → assert
   symbol-bearing chunks. Fails pre-patch (text fallback / symbol-less).
3. code-def — same file: assert every emitted C/C++ `symbolType` ∈ `DEF_TYPES`.
4. doctor bound — `mock.module` the onboard checks to hang forever,
   `GBRAIN_DOCTOR_ONBOARD_TIMEOUT_MS=50`, assert buildChecks completes with an
   `onboard_checks` warn. Hangs (fails) pre-patch.
5. brainstorm message — `formatSaveOutcome` test for `disabled_by_config`.
6. write-through retirement — no new test: upstream's `disabled_by_config`
   tests (test/write-through.test.ts:235+) pin the replacement behavior.

## Verification

- `bun run verify` + `bun test` (unit, sharded) green; E2E per CLAUDE.md
  (docker-compose.ci.yml Postgres) if the lane is available.
- Empirical: run this tree's `onboard --check` against the live :6543 brain
  (read-only) to record whether the underlying hang persists on current code.
- Ready report states per-commit verdicts, the re-expressions, the mandatory
  `sync.write_through=false` ops step, and deploy/local-http impact (none to
  the unit definition).
