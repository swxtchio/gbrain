# Port plan: swxtch customizations onto current upstream master

One-time re-port of the 7 `swxtch`-branch commits (fork point a25209bbb,
2026-07-10) onto origin/master. Port, not rebase: every customization ends
either **carried** (re-implemented + behavior test) or **retired** (dropped,
naming the upstream commit/code that now does the job).

**Base history.** p1/p2 built against master `4e4677b1` (v0.46.28.0). Master
then advanced 20 commits to **`7b7921d8`** (v0.47.6.0 community fix wave +
post-release audit). This phase (p3) re-derives every verdict against that new
base and adopts the p2 content that survives. The p3 re-derivation is the
authoritative record; the p1/p2 sections below are kept for provenance, and
where p3 changed a verdict the p3 table says so explicitly.

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
  mentioned `gbrain onboard --check`; FLAG_RE's text scan bled that token onto
  sync/status/maintain, so an inspection-shaped flag was accepted and ignored
  (a typed `sync --check` would run a real sync). Final resolution: the
  reworded message carries no bare `--check` token, so scripts/generate-flag-registry.ts
  and the registry are byte-identical to origin/master, and three subprocess
  tests pin rejection of `--check` on all three commands (they redden if any
  future prose bleed regenerates the token in).

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

---

## p3 RE-DERIVATION against master `7b7921d8` (2026-08-29)

Master moved 20 commits (`4e4677b1..7b7921d8`, 889 files) after p2 paused.
Twelve of the files p2 touched were also touched by that range, so every
verdict was re-checked against the new tree rather than inherited. **Two
verdicts changed**; the rest hold with refreshed evidence.

| # | p2 verdict | p3 verdict | What the new base changed |
|---|---|---|---|
| 1a index.md syncable | CARRIED | **CARRIED** (evidence refreshed) | `SYNC_SKIP_FILES` still lists `index.md` (`src/core/sync.ts:540`). The *harm* changed: reconcile now soft-deletes (`engine.softDeletePages`, `src/commands/sync.ts:4242`, #4587) instead of hard-deleting, so dropping the patch hides the `*/index` pages for a 72h recovery window and the autopilot purge phase hard-deletes them after it. Still data loss, just delayed. |
| 1b GBRAIN_TOP_DIRS | CARRIED | **CARRIED** | No upstream allowlist appeared. The wave added `--include-hidden` and made `sync.exclude` persist on every path, but both route through `matchesAnyGlob` (`src/core/sync.ts:320`), which has no negation operator — exclusion still cannot express deny-all-except. Seam moved: `gitListSyncableFiles` gained an `includeHidden` parameter, so the git-fast-path filter re-applies one line lower. |
| 1c N-segment slug resolver | RETIRED | **RETIRED** | Unchanged: the broadened `/^[a-z0-9][a-z0-9/_-]*$/` resolver is still in `src/core/link-extraction.ts:1206` and `src/commands/extract.ts:611`. Retiring commit stays `5e8816e7` (#3087). |
| 1d C/C++ chunker | CARRIED (whole) | **SPLIT: carried in part, merge guard RETIRED** | See below — the merge-guard half is now upstream. |
| 1e code-def DEF_TYPES | CARRIED (4 entries) | **CARRIED (2 entries)** | See below — half the entries were already upstream, and the list moved file. |
| 1f gbrain-safe-update | CARRIED | **CARRIED** | `gbrain post-upgrade` is still a real command (`src/cli.ts:2195`); the wrapper's other externals (`bun install`, `systemctl --user`) are unaffected. |
| 2 write-through gate | RETIRED | **RETIRED** | `isWriteThroughDisabled` / `sync.write_through` still gate `writePageThrough` (`src/core/write-through.ts:183,369`). Retiring commits stay `07f5d28d` + `055ac6c7`. The deploy-time ops step (`gbrain config set sync.write_through false`) stands. |
| 3 deploy/local-http | CARRIED | **CARRIED** | Re-verified every referenced surface on the new base: `--http`/`--port`/`--bind` (`src/commands/serve.ts:210,238,268`), `/health` (`src/commands/serve-http.ts:1343`), `GBRAIN_POOL_SIZE` (`src/core/postgres-engine.ts:301`), `GBRAIN_DIRECT_DATABASE_URL` (`src/core/connection-manager.ts:51`). |
| 4 safe-update restart | CARRIED | **CARRIED** | Rides in `scripts/gbrain-safe-update`; content unchanged. |
| 5 doctor onboard bound | CARRIED | **CARRIED** | The seam is still a bare `await runAllOnboardChecks(engine)` with no bound — it only moved from `doctor.ts:3939` to `doctor.ts:4081` inside the same `buildChecks`. No upstream timeout exists (`GBRAIN_DOCTOR_ONBOARD_TIMEOUT_MS` grep: absent). |
| 6 bootstrap v121/v122 | RETIRED | **RETIRED** (evidence strengthened) | Beyond `2fca1244`, upstream `d9909cdd` (v0.47.5.0, #4657/#4699) extracted the whole mechanism into `src/core/postgres-engine/forward-reference-bootstrap.ts` — a probe set incl. `timeline_event_page_id_exists` (line 162), an explicit v121 gate (line 293), and `ADD COLUMN IF NOT EXISTS event_page_id` repair (line 595) — plus the blob coverage gate. The fork's hand-added columns are now a strictly smaller subset of a self-repairing upstream path. |
| 7 docs | MIXED | **MIXED** (unchanged) | CLAUDE.md MUST-DO + llms-full.txt stay DROPPED (upstream documents and mechanically enforces the invariant); the deploy README "Upgrade gotcha" stays CARRIED, now citing `d9909cdd` alongside `2fca1244`. |

### 1d — the merge guard is retired by upstream `c860a411` (#4511)

The fork's chunker patch had four parts. Three are still absent upstream and
carry unchanged: `PASSTHROUGH_TYPES` + `collectSemanticNodes` (recursion
through header guards / `#if` / `extern "C"` / namespace / template), the
C/C++ `TOP_LEVEL_TYPES` additions (`type_definition`, `enum_specifier`,
`union_specifier`, `preproc_def`, `preproc_function_def`, plus a real `c`
entry), and the declarator-chain arm of `extractSymbolName`. Verified absent
on `7b7921d8`: `grep PASSTHROUGH|collectSemanticNodes|linkage_specification`
over `src/core/chunkers/code.ts` returns nothing, and the `cpp:`/`c:` sets at
`code.ts:419-423` are byte-identical to the pre-fork upstream.

The fourth part — the C/C++-only `preserveSymbols` guard in
`mergeSmallSiblings` — is **RETIRED**. Upstream `c860a411` (#4511, in the
v0.47.4.0 test-gap closure wave) implemented the same protection at the same
two seams:

- fork `currentHasSymbol` → upstream `isDefChunk(current)` in the
  pass-through condition (`src/core/chunkers/code.ts:955`);
- fork `if (preserveSymbols && next.metadata.symbolName) break` → upstream
  `if (isDefChunk(next)) break` in the accumulation loop (`code.ts:966`).

Upstream's version is strictly better for our purpose: it is language-agnostic
and it is a *derived view* of `code-def`'s allowlist
(`MERGE_PROTECTED_SYMBOL_TYPES` in `src/core/chunkers/def-types.ts`), so a
symbol type code-def can resolve cannot be erased by merging, and the two lists
cannot drift.

One deliberate behavioural delta is accepted rather than fought: upstream's
`MERGEABLE_RUN_TYPES` keeps `'declaration'` and `'preproc def'` mergeable,
naming "C `#define`/prototype runs" as exactly what `mergeSmallSiblings` exists
for. That is a post-dating upstream decision on the fork's own case, so the
fork's broader "preserve every symbol-bearing C/C++ chunk" rule is dropped, not
re-litigated. The types the fork actually needed protected — the typedef'd
aggregates — are covered instead by the 1e entries below, because protection is
derived from `DEF_TYPES`.

### 1e — reduced from four DEF_TYPES entries to two, in a new file

p2 added `'declaration', 'type definition', 'union specifier', 'preproc def'`.
Two of those were **already upstream** and shipped as literal duplicates in the
p2 tree: upstream `67e7e8a9` (v0.46.28.0, 2026-08-21 — post-dates the
2026-06-09 fork patch ✓) added the `#3789` residual-audit block carrying
`'namespace definition', 'template declaration', 'declaration', 'preproc def'
// C/C++`. (Proof: stripping comments from the p2 tree's `DEF_TYPES` and
`uniq -d` reports exactly `'declaration'` and `'preproc def'`; the same check
on `4e4677b1` reports nothing.) Those two are dropped.

The residual carry is `'type definition'` and `'union specifier'` — still
absent from the new base, and needed because `normalizeSymbolType`
(`code.ts:1499`) has no rule for either node type, so they fall through
`type.replace(/_/g, ' ')`. (`enum_specifier` → `'enum'` and
`preproc_function_def` → `'function'` are already covered; `struct_specifier`
→ `'struct specifier'` is already listed.)

They now land in `src/core/chunkers/def-types.ts`, not `src/commands/code-def.ts`
— `#4511` moved the list and `code-def.ts` re-exports it. Landing them there is
what re-supplies the merge protection the fork's own guard used to give them,
via `MERGE_PROTECTED_SYMBOL_TYPES`.

### p3 test plan

Adopt p2's suites, re-pointed at the new base, plus one change:

1. `test/sync-isSyncable-shape.test.ts`, `test/sync.test.ts`,
   `test/import-metafile-skip.test.ts`, `test/import-git-fastpath-prune.test.ts`
   — index.md classification (1a). Unchanged from p2.
2. `test/import-top-dirs.test.ts` — both enumeration routes (1b). Unchanged.
3. `test/chunkers/code-c-cpp.test.ts` — C/C++ symbol extraction (1d). The
   merge-guard cases are re-pointed at the upstream mechanism: they assert the
   typedef/union symbols survive merging *because* they are in `DEF_TYPES`,
   which is the behaviour that now delivers it.
4. `test/doctor-onboard-timeout.serial.test.ts` — the bound (5). Unchanged.
5. `test/brainstorm/save.test.ts` — `disabled_by_config` ride-along (2).
6. `test/swx-fork-tooling.test.ts` — hermetic shell guards for
   `deploy/local-http/setup.sh` and `scripts/gbrain-safe-update` (3/1f/4). p2
   left the fail-without proofs unrun; p3 runs them and reports the result.

### Ordering receipts

A retire is only honest if the upstream change POST-DATES the fork patch it
supersedes, and is actually in this branch's history. Both checked for every
retire verdict on this base:

| Retired item | Fork patch (date) | Retiring upstream commit (date) | Ancestor of this branch |
|---|---|---|---|
| 1c N-segment slug resolver | `88a02775` 2026-06-09 | `5e8816e7` 2026-07-23 | yes |
| 1d merge guard | `88a02775` 2026-06-09 | `c860a411` 2026-08-28 (#4511) | yes |
| 1e `declaration` + `preproc def` | `88a02775` 2026-06-09 | `67e7e8a9` 2026-08-21 (#3789 audit) | yes |
| 2 write-through engine gate | `425a06fb` 2026-06-10 | `07f5d28d` 2026-08-19 + `055ac6c7` 2026-08-21 | yes |
| 6 bootstrap v121/v122 | `d74d45be` 2026-07-12 | `2fca1244` 2026-07-13, extended by `d9909cdd` 2026-08-28 | yes |
| 7 CLAUDE.md MUST-DO prose | `63c50bb2` 2026-07-12 | same as 6 (the invariant is documented + gated upstream) | yes |

## The B1 fail-without proofs (p2 wrote the tests, never ran the proofs)

Run on this base, each with ONLY the fix under test reverted. **Two held; one
did not, and the test it belonged to was rewritten rather than kept.**

| Guard | Fix reverted | Result |
|---|---|---|
| argv `run()` | the `%q` runner → `eval "$@"` / `"$*"` | **PROOF FAILED** — the test passed against the unfixed script. See below. |
| no-op-rebase gate | the `PRE_REBASE_HEAD` comparison | held: 0 pass / 1 fail. Output shows the run reaching "Rebase clean" and the stub log recording `bun install` + `gbrain post-upgrade` — the migrations-against-the-live-brain the gate prevents. |
| setup.sh port re-run (B2) | `enable`+`restart` → `enable --now` | held: 0 pass / 1 fail. The re-run's probe loops 30s and exits 1 with the old process still on the old port. |
| setup.sh port templating (R9) | the `sed -i --port` block | held: 0 pass / 1 fail, same shape on the first install. |

All three green again after restore.

**Why the argv proof failed.** p2's claim was that the pre-fix
`run "git stash push -u -m 'gbrain-safe-update auto-stash'"` re-parses under
`eval` into pathspecs and exits non-zero. It does not — the single quotes
survive eval's re-parse, which was reproduced standalone in a scratch repo.
Every other call site the R8 refactor touched was checked too: git refnames
cannot contain spaces and the remaining interpolations are already
single-quoted, so **R8 has no reachable failure on the non-dry-run path**. It
stands as a class-level hardening, not a bug fix.

R8 does have one reachable behavioural difference, and the test now asserts
that instead: `--dry-run` rendering. `echo "  [dry-run] $*"` flattens argv into
a space-joined string, so the printed command does not re-parse into what would
actually run; `printf ' %q'` does. The test extracts the rendered stash line,
re-parses it the way a shell would, and requires the original argv back. Red
against the pre-fix runner, green against the fix.

The proofs also exposed a leak: the systemctl stub launches a real loopback
listener that only its own next `restart` reaps, so a run ending early left the
process listening after the sandbox was deleted (one was found alive on the
box). `afterEach` now reaps the banked pid first; verified against a
deliberately-failing case.


## Fail-without proofs for every CARRIED behaviour

The B1 section above covers the three shell guards. The remaining carried
items were proved the same way on this base — revert only that item's source
change, keep its test, run it:

| Carried item | Reverted | Result |
|---|---|---|
| 1a index.md syncable | `index.md` put back in `SYNC_SKIP_FILES` | 111 pass / **7 fail** across the four index.md suites (isSyncable shape ×3, metafile-skip ×2, git-fast-path ×1, sync ×1) |
| 1b GBRAIN_TOP_DIRS | the parse block + both route filters | 1 pass / **3 fail**. The 1 pass is the "unset env collects everything" case, which is upstream's default and correctly passes either way. |
| 1d+1e C/C++ chunker + DEF_TYPES | `src/core/chunkers/{code,def-types}.ts` checked out from `origin/master` | 0 pass / **5 fail** |
| 5 bounded onboard phase | the bare `await runAllOnboardChecks(engine)` restored | 1 pass / **1 fail** (the hang case times out). The 1 pass is the happy-path case, which guards the wrapper against emitting a spurious warn or dropping results — a real risk in the ADDED code, not a vacuous assertion. |

Every one green again after restore.

Item 2's retirement needs no new test: upstream's own `disabled_by_config`
cases in `test/write-through.test.ts` pin the replacement behaviour, and the
ride-along brainstorm branch has its own case in `test/brainstorm/save.test.ts`.

## Full-suite result

**Final gate run on the finished branch: 22526 pass / 1 fail / 10 skip**
(`bun run test`, 1127s, 3 shards + the serial pass). The single failure is
pre-existing — see below.

An earlier run of the same suite, before the fixes below, reported 22526 pass
/ 3 fail. The three were:

- **1 pre-existing.** `test/sync-rename-reconcile.serial.test.ts` — "a
  frontmatter slug-authority rejection at the destination is retried, never
  falsely checkpointed". Fails identically on a pristine `origin/master`
  worktree at `7b7921d8` (57 pass / 1 fail there), so it is not port-caused.
- **2 were this branch's own tests asserting something false.** p2's
  `sync/status/maintain --check` rejection trio. On this base `--check` IS in
  the generated registry for `sync` and `status` — and on pristine master too:
  `bun src/cli.ts sync --check` runs a real sync there. The source is an
  upstream comment in `src/core/cli-options.ts` (`onboard --check --explain`),
  which nearly every command imports, so the generator's text scan bleeds the
  token. That is upstream's defect, not the fork's, and this branch ships the
  generated registry byte-identical to master on purpose. Only the `maintain`
  case is kept — verified live as a real guard for the fork's OWN regression:
  putting `--check` back into the onboard-timeout message and regenerating puts
  the token into maintain's entry and reddens the test (0 pass / 1 fail),
  restored green after.


## Repo notes for the next porter

- **Do not run `fm-ensure-agents-md.sh` in this repo.** It refuses here
  ("both AGENTS.md and CLAUDE.md are real files … reconcile them manually"),
  and reconciling them is the wrong move: both are upstream-owned, published,
  user-facing product docs (`AGENTS.md` is the non-Claude-harness install +
  operating protocol; `CLAUDE.md` is the Claude Code orientation), not agent
  scratch memory. Merging and symlinking them would be a permanent fork diff
  in two shipped files — the same friction item 7 dropped the CLAUDE.md
  MUST-DO prose to avoid. Fork-port knowledge belongs in THIS file.
- **The in-code marker for a fork delta is `SWX` in a comment on the changed
  line.** Several spellings are in use (`SWX:`, `SWX patch:`, `SWX local
  patch:`, `SWX fork delta:`, `swxtch fork:`); a bare `grep -rn SWX src test
  deploy scripts` finds all of them, which is why they were left alone rather
  than churned.
- **Two shell scripts carry fork behaviour** (`deploy/local-http/setup.sh`,
  `scripts/gbrain-safe-update`) and are guarded hermetically by
  `test/swx-fork-tooling.test.ts`. Run `shellcheck` on both after touching
  them; the repo has no shellcheck lane of its own.

## Follow-ups deliberately NOT filed

`swxtchio/gbrain` is public, has issues disabled, and is not in
`config/gh-repo-allowlist`, so no issue is opened for these. They are recorded
here instead:

- **brainstorm 3-sibling issue** (carried over unfiled from p2's round-1 report):
  `formatSaveOutcome`'s sibling branches were reviewed together and one
  reported outcome reads ambiguously to an operator; the fix is upstream-shaped
  and belongs in a PR to `garrytan/gbrain`, not in this fork port.
- **`type definition` / `union specifier` belong upstream.** They are a
  general C/C++ gap in `def-types.ts`, not a swxtch preference. Worth
  contributing to `garrytan/gbrain` so the fork can retire 1e entirely on a
  later port. The same is true of the whole 1d chunker reach — upstream's own
  `cpp` set indexes `namespace_definition` and `template_declaration` as
  opaque top-level chunks, which is a bug by upstream's own standard (a
  namespace indexes only its name).
- **C `#define` / prototype RUNS lose their symbol names** under upstream's
  `MERGEABLE_RUN_TYPES` (see the 1d section). Isolated ones are unaffected.
  This is an accepted upstream design decision, recorded here so a future
  operator who finds `gbrain code-def SOME_MACRO` empty on a macro block knows
  it is known, not a port regression.
- **Upstream accepts `gbrain sync --check` and `gbrain status --check`** and
  silently ignores them, so a user typing `sync --check` expecting a dry
  inspection runs a real sync. Cause: the bare `--check` token in the
  `src/core/cli-options.ts` comment at the `onboard --check --explain` example,
  reached by the flag-registry generator's import-graph text scan. Reproduced
  on a pristine `origin/master` worktree. Belongs in a PR to
  `garrytan/gbrain`, not in this fork port — the fix is either rewording the
  comment or teaching the generator to ignore tokens inside comments.
- **R8 (the argv `run()` refactor in `scripts/gbrain-safe-update`) has no
  reachable failure** on the non-dry-run path — see the B1 section. It is kept
  as hardening. If it is ever revisited, the honest framing is "class-level
  hardening + dry-run output fidelity", not "fixes a stash bug".
