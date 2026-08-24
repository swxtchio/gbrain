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
| 1b | — GBRAIN_TOP_DIRS | ~~**RETIRE**~~ → **CARRY** (superseded in round 1 — see final table) | The ordering check falsified this row: per-source registration (`90c5d93f`, 2026-04-22) and per-source walking predate the 2026-06-09 fork patch; no post-dating change supplies a top-dir allowlist (`--exclude` is exclusion-only). Carried in `5e1206a9`, both enumeration routes. |
| 1c | — N-segment slug resolver | **RETIRE** | Upstream `5e8816e7` "fix(links): resolve [[wikilink]] + slug-path frontmatter values" broadened Step 1 in both `link-extraction.ts` (accepts `a/b/c`, exact getPage) and `extract.ts` (`/^[a-z0-9][a-z0-9/_-]*$/` + `allSlugs.has`). Equivalent for real (slug-charset) pages. |
| 1d | — C/C++ chunker | **CARRY** (re-expressed) | Still absent upstream: no PASSTHROUGH recursion (header guards / extern "C" / namespace / template), no `type_definition`/`enum_specifier`/`union_specifier`/`preproc_function_def` top-level types, no declarator-field chain (upstream's #3789 wrapper dive covers `init_declarator` only, not `function_declarator`), no C/C++ symbol-preserving merge. Upstream `namespace_definition`/`template_declaration` remain opaque top-level chunks. No upstream C/C++ symbol tests exist. |
| 1e | — code-def DEF_TYPES | **CARRY** (reduced) | Add `declaration`, `type definition`, `union specifier`, `preproc def`. `struct specifier` already upstream; `preproc function def` is dead under current `normalizeSymbolType` (`preproc_function_def` → `function`, already covered). |
| 1f | — scripts/gbrain-safe-update | **CARRY** | Fork-preserving upgrade wrapper; upstream `gbrain upgrade` is binary self-update for non-fork installs — no equivalent. |
| 2 | `425a06fb` write-through gate | **RETIRE** (citation corrected in round 1) | The `sync.write_through` flag + facts-fence gate actually landed in upstream **`07f5d28d`** (v0.46.23.0 roll), timeline lane in **`055ac6c7`** (v0.46.25.0 roll) — `git log -S` proof; `42375bde` contains zero `write_through` occurrences. DB-backed, checked before any FS/DB work, with upstream tests; gates lanes our patch never reached. **Mandatory ops step at deploy: `gbrain config set sync.write_through false`** — verified UNSET on the live brain; also carried in deploy/local-http/README.md (round-1 B4). Ride-along carry: brainstorm `formatSaveOutcome` `disabled_by_config` branch. |
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

---

## FINAL STATUS (p2 crew, 2026-08-24) — all 7 resolved

The p1 crew's verdicts were re-confirmed against the adopted tree and
`origin/master` = 4e4677b1 (unchanged since p1's base; `git fetch` 2026-08-24).
No verdict changed.

| # | Commit | Final verdict | Where it landed / retiring commit |
|---|--------|---------------|-----------------------------------|
| 1a | index.md syncable | CARRIED | `82b81a41` (p1). Confirmed origin/master still skips it (`SYNC_SKIP_FILES`, sync.ts:489 on master). |
| 1b | GBRAIN_TOP_DIRS | **CARRIED** (round-1 flip) | `5e1206a9` (p2). The retire row above was falsified by the round-1 ordering check: per-source registration (`90c5d93f`, v0.18.0, 2026-04-22) and per-source walking both PREDATE the 2026-06-09 fork patch, and no post-dating upstream change supplies an allowlist of top-level directory NAMES (`--exclude` from `f72de979` is exclusion-only, cannot express deny-all-except). Re-expressed to cover BOTH enumeration routes (git fast path + FS walk); test/import-top-dirs.test.ts. Zero live consumers remains true (verified: not in service env, crontab, systemd units, or fleet docs). |
| 1c | N-segment slug resolver | RETIRED | Upstream `5e8816e7` (#3087, 2026-07-23 — post-dates the 2026-06-09 fork patch ✓) broadened both resolver sites to `/^[a-z0-9][a-z0-9/_-]*$/` with the same authoritative guards (`allSlugs.has` / exact `getPage`). Equivalent for real slug-charset pages. `git log -S` proof: pickaxe on the broadened regex in link-extraction.ts/extract.ts. |
| 1d | C/C++ chunker | CARRIED | `0b243a6b` (p1), re-expressed alongside NESTED_EMIT_CONFIG/NAME_WRAPPER_TYPES. Tests: test/chunkers/code-c-cpp.test.ts (32 green). |
| 1e | code-def DEF_TYPES | CARRIED (reduced) | `0b243a6b` (p1): added `declaration`, `type definition`, `union specifier`, `preproc def`. |
| 1f | gbrain-safe-update | CARRIED | `613b9230` (p2). Pure addition; upstream `gbrain upgrade` is binary self-update, no equivalent. |
| 2 | `425a06fb` write-through gate | RETIRED | Upstream **`07f5d28d`** (v0.46.23.0 roll, 2026-08-19) introduced the DB-backed `sync.write_through` flag + `disabled_by_config` + `isWriteThroughDisabled` and the facts-fence gate (fence-write.ts); **`055ac6c7`** (v0.46.25.0 roll) extended it to the timeline lane (timeline-write-through.ts). Both POST-DATE the fork patch (2026-06-10) ✓ — `git log -S 'sync.write_through'` proof (the p1 row's citation `42375bde` was wrong: that commit contains zero `write_through` occurrences; verified by pickaxe). Checked first in `writePageThrough` (write-through.ts:325), also gates backstop (backstop.ts:633) — lanes our engine-kind patch never reached. The brief's named upstream touches (`f8b0ecec` recorded-source_path, `ca04874c` Bun+Windows EEXIST) are file-naming/FS fixes, unrelated to the skip decision. **MANDATORY OPS STEP AT DEPLOY: `gbrain config set sync.write_through false`** (flag verified unset on the live brain) — now ALSO carried in the operator-facing deploy/local-http/README.md (round-1 B4: the control must live where operators meet it, not only in this plan). Ride-along CARRY: brainstorm `formatSaveOutcome` `disabled_by_config` branch + test (`6c89103b`). |
| 3 | `194d067c` deploy/local-http | CARRIED | `613b9230` (p2). All referenced upstream surface verified present on master: `serve --http --port --bind` (serve.ts:198/226/256), `/health` (serve-http.ts:10), `GBRAIN_POOL_SIZE` (db.ts), `GBRAIN_DIRECT_DATABASE_URL` (connection-manager.ts), `auth`/`connect` commands. |
| 4 | `9bbafc96` safe-update restart | CARRIED | `613b9230` (p2), content unchanged (rides in scripts/gbrain-safe-update). |
| 5 | `3eb9aa4a` doctor onboard bound | CARRIED (re-expressed) | `31f5c287` (p2) — adopted from the p1 crew's UNCOMMITTED worktree (doctor.ts hunk + test/doctor-onboard-timeout.serial.test.ts) after verifying the seam (doctor.ts:3939 bare await) and fail-without (bun per-test timeout pre-patch, ~50ms pass post-patch). README pooler-topology + unit EnvironmentFile parts ride in `613b9230`. |
| 6 | `d74d45be` bootstrap v121/v122 | RETIRED | Upstream `2fca1244` (#2724/#2735, 2026-07-13 — post-dates the fork commit 2026-07-12 ✓) adds the `event_page_id` forward-reference probe + bare-column repair to BOTH engines + test/bootstrap.test.ts + the test/schema-bootstrap-coverage.test.ts CI gate. The fork's extra facts-ontology columns were defense-in-depth: verified the static schema blob (src/core/schema-embedded.generated.ts) contains NO facts-table indexes, so they never blocked blob replay. |
| 7 | `63c50bb2` docs | MIXED | CLAUDE.md MUST-DO + llms-full.txt: DROPPED — upstream CLAUDE.md:94 documents the invariant and the coverage test enforces it mechanically. deploy README "Upgrade gotcha": CARRIED in `613b9230`, updated to cite `2fca1244` instead of claiming the fork fixed it. |

### Port-induced test failures found by the full suite (all fixed in `45261161`)

The p1 index.md carry updated sync-isSyncable-shape + sync.test.ts but missed
two more suites pinning the old skip behavior:
- test/import-metafile-skip.test.ts — now asserts index.md IS collected on both
  the FS-walk and git-fast-path routes (fast path shares SYNC_SKIP_FILES;
  consistency verified by the walk/fast-path agreement test).
- test/import-git-fastpath-prune.test.ts — same update.
- test/doctor-categories.test.ts — the new `onboard_checks` timeout WARN name
  categorized OPS (infrastructure signal, not brain data quality).
- test/cli-flag-validation.test.ts freshness guard — the timeout error message
  mentions `gbrain onboard --check`; FLAG_RE scans doctor.ts text via the
  maintain→doctor and status→sync→doctor chains, so `--check` became legal for
  sync/status/maintain. Regenerated via the sanctioned
  `bun run build:flag-registry` (3-line diff; prose mentions count by design).

### Pre-existing environmental failures on this box (NOT port-caused)

11 tests fail identically on pristine origin/master (verified via a
/tmp/opencode/gbrain-base worktree at 4e4677b1):
- git-class (6: put-page-push-reporting ×2, write-through-commit #2426 ×1,
  fence-write ×3) — the box's global `core.hookspath` prepare-commit-msg hook
  rewrites commit subjects; all 31 pass with `GIT_CONFIG_GLOBAL=/dev/null`.
- child-job-runner ×2 — the box's ambient `GBRAIN_POOL_SIZE` env leaks into the
  env-contract tests; all 14 pass with it unset.
- connection-manager.serial ×3 (#1915 retry tests) — retry-scheduling
  assumptions don't hold under this box's bun 1.3.11; fail identically on
  baseline with the env scrubbed.

Full-suite run on this branch: 20493 pass / 11 fail (the above) / 4 skip.
