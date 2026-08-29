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
| 1b GBRAIN_TOP_DIRS | CARRIED | **CARRIED** (re-expressed through the shared classifier) | No upstream allowlist appeared: the wave's `--include-hidden` and persisted `sync.exclude` both route through `matchesAnyGlob` (`src/core/sync.ts`), which has no negation operator, so exclusion still cannot express deny-all-except. Round-1 review found the carry incomplete — see below. |
| 1c N-segment slug resolver | RETIRED | **RETIRED** | Unchanged: the broadened `/^[a-z0-9][a-z0-9/_-]*$/` resolver is still in `src/core/link-extraction.ts:1206` and `src/commands/extract.ts:611`. Retiring commit stays `5e8816e7` (#3087). |
| 1d C/C++ chunker | CARRIED (whole) | **CARRIED** (re-expressed) | See below. p3 first read the merge guard as retired by `c860a411` (#4511); review round 1 falsified that and it is carried. |
| 1e code-def DEF_TYPES | CARRIED (4 entries) | **CARRIED (2 entries)** | See below — half the entries were already upstream, and the list moved file. |
| 1f gbrain-safe-update | CARRIED | **CARRIED** | `gbrain post-upgrade` is still a real command (`src/cli.ts:2195`); the wrapper's other externals (`bun install`, `systemctl --user`) are unaffected. |
| 2 write-through gate | RETIRED | **RETIRED, with a compensating check** | The upstream flag replaces the mechanism but FAILS OPEN, so the retirement was not behaviour-preserving on its own — see below. |
| 3 deploy/local-http | CARRIED | **CARRIED** | Re-verified every referenced surface on the new base: `--http`/`--port`/`--bind` (`src/commands/serve.ts:210,238,268`), `/health` (`src/commands/serve-http.ts:1343`), `GBRAIN_POOL_SIZE` (`src/core/postgres-engine.ts:301`), `GBRAIN_DIRECT_DATABASE_URL` (`src/core/connection-manager.ts:51`). |
| 4 safe-update restart | CARRIED | **CARRIED** | Rides in `scripts/gbrain-safe-update`; content unchanged. |
| 5 doctor onboard bound | CARRIED | **CARRIED** | The seam is still a bare `await runAllOnboardChecks(engine)` with no bound — it only moved from `doctor.ts:3939` to `doctor.ts:4081` inside the same `buildChecks`. No upstream timeout exists (`GBRAIN_DOCTOR_ONBOARD_TIMEOUT_MS` grep: absent). |
| 6 bootstrap v121/v122 | RETIRED | **RETIRED** (evidence strengthened) | Beyond `2fca1244`, upstream `d9909cdd` (v0.47.5.0, #4657/#4699) extracted the whole mechanism into `src/core/postgres-engine/forward-reference-bootstrap.ts` — a probe set incl. `timeline_event_page_id_exists` (line 162), an explicit v121 gate (line 293), and `ADD COLUMN IF NOT EXISTS event_page_id` repair (line 595) — plus the blob coverage gate. The fork's hand-added columns are now a strictly smaller subset of a self-repairing upstream path. |
| 7 docs | MIXED | **MIXED** (unchanged) | CLAUDE.md MUST-DO + llms-full.txt stay DROPPED (upstream documents and mechanically enforces the invariant); the deploy README "Upgrade gotcha" stays CARRIED, now citing `d9909cdd` alongside `2fca1244`. |

### 1d — carried, re-expressed on top of upstream `c860a411` (#4511)

The fork's chunker patch has four parts. Three are still absent upstream and
carry unchanged: `PASSTHROUGH_TYPES` + `collectSemanticNodes` (recursion
through header guards / `#if` / `extern "C"` / namespace / template), the
C/C++ `TOP_LEVEL_TYPES` additions (`type_definition`, `enum_specifier`,
`union_specifier`, `preproc_def`, `preproc_function_def`, plus a real `c`
entry), and the declarator-chain arm of `extractSymbolName`. Verified absent
on `7b7921d8`: `grep PASSTHROUGH|collectSemanticNodes|linkage_specification`
over `src/core/chunkers/code.ts` returns nothing, and the `cpp:`/`c:` sets at
`code.ts:419-423` are byte-identical to the pre-fork upstream.

The fourth part — the C/C++ preserve-all guard in `mergeSmallSiblings` — is
**also CARRIED**, re-expressed to sit beside upstream's mechanism instead of
replacing it.

**p3's first pass got this wrong and review round 1 caught it (codex 0 /
claude 0 / f5-panel 0, all blocking).** The reasoning that failed: upstream
`c860a411` implements a guard at the same two seams
(`isDefChunk`/`MERGE_PROTECTED_SYMBOL_TYPES`), derived from `DEF_TYPES`, so it
looked like a superseding implementation. It is not — it covers only the
aggregate half. `MERGEABLE_RUN_TYPES` (`def-types.ts:69-75`) deliberately
keeps `'declaration'` and `'preproc def'` mergeable, naming "C
`#define`/prototype runs" as what merging exists for. Three seats each
reproduced the consequence independently on this branch: a guarded header of
four `#define`s and five prototypes — the ordinary shape of a C API header —
indexes as **one** `{symbolType:'merged', symbolName:null}` chunk, and
`findCodeDef` has no recovery path from a merged chunk. Fork `88a02775` named
"function prototypes ~5 tokens, macros" FIRST as the guard's purpose, and the
fork's brains are C/C++ (spp/srtx) where those prototypes and macros are the
API surface. So this is fork behaviour lost, not redundancy, and an "accepted
delta" written into this plan was not the crew's call to make.

What is on the branch now: `isProtectedChunk = isDefChunk(c) ||
(preserveAllSymbols && c.metadata.symbolName != null)`, with
`preserveAllSymbols` scoped to `c`/`cpp` so every other language keeps
upstream's run-merging verbatim, applied at both seams (`code.ts` ~1020 and
~1034). Upstream's `isDefChunk` is kept and called first — the fork arm is
additive, so a future upstream widening of `MERGE_PROTECTED_SYMBOL_TYPES`
composes rather than conflicts.

Fixture gap closed too (f5-panel 1, blocking): the round-1 test held exactly
one prototype and one `#define`, and that `#define` was already merging
anonymously with the `#include` un-asserted — nothing exercised a RUN.
`test/chunkers/code-c-cpp.test.ts` now carries `C_RUN_HEADER` (four macros,
five prototypes, nothing else) and asserts each is individually named AND that
no anonymous merged chunk exists. Fail-without: with only the fork arm removed
from `isProtectedChunk` and upstream's `isDefChunk` left in place, 5 pass /
2 fail; restored, 7 pass.

### 1d — file-level prose reach (round-1 cluster 7)

Restoring the PASSTHROUGH recursion had a cost the round-1 branch neither
recorded nor pinned, and two seats measured it independently: a C/C++ header
whose prose (licence, threading contract, wire-frame table) lives OUTSIDE
every semantic node used to be indexed in full, because zero semantic nodes
meant the whole file fell to `fallbackChunks`. The recursion finds nodes in
those headers, which moves them onto the semantic path — where upstream emits
nothing between nodes. The carry was trading the file's prose for its symbols.

`chunkParsedLanguage` now emits the preamble, inter-node and trailing text as
symbol-less chunks, scoped to `c`/`cpp` (every other language reaches that
path exactly as before). Gap chunks carry `symbolName: null` and
`symbolType: 'module'` — the label `fallbackChunks` already uses for
symbol-less code text — so `findCodeDef`, which resolves on `symbol_name`,
can never return one. They flow through `mergeSmallSiblings` and
`capOversizedChunks` with everything else.

**A/B, measured on one header (581 source bytes: licence + threading + frame
table, header guard, `#include`, a typedef'd struct, one prototype).**
"Indexed body bytes" is total chunk text minus the `[C] path:N-M symbol`
header `buildChunk` prepends:

| | chunks | indexed body bytes | Copyright / Threading / frame table searchable | named symbols |
|---|---|---|---|---|
| pristine `origin/master` | 1 | 580 | yes | 0 |
| round-1 branch (`b1a06931`) | 4 | **170** | **no** | 3 |
| this branch | 6 | 571 | yes | 3 |

571 vs master's 580 is the whitespace trimmed at chunk boundaries. So the
fixed state is master's byte coverage plus the three symbols master could not
name — not a trade-off in either direction. Pinned by the two coverage cases
in `test/chunkers/code-c-cpp.test.ts`; fail-without (gap emission disabled,
everything else intact): 7 pass / 2 fail.

### 1b — the allowlist has to live in the classifier, not an enumerator (round-1 cluster 3)

The round-1 carry put `GBRAIN_TOP_DIRS` inside `collectSyncableFiles`, and the
plan claimed it covered "BOTH enumeration routes". Three seats found the same
defect: **the brain has three file-selection lanes, not two.**
`performSyncInner` filters its git-diff manifest through
`inScope`/`excluded`/`isSyncable` and never calls that enumerator, so a file
under a non-allowlisted top dir was excluded by the first full sync and then
imported by the next commit-driven one — the allowlist leaked one commit at a
time.

Re-expressed to close the class rather than add a third copy of the filter:
`topDirsAllowlist()` + `isAllowedTopDir()` now live beside `matchesAnyGlob` in
`src/core/sync.ts`, `classifySync` consults them (new `SyncableReason`
`'top-dir-excluded'`), and `collectSyncableFiles` reads the same helpers. Every
lane already routes through `isSyncable`/`unsyncableReason`, so all three agree
by construction — the same way `SYNC_SKIP_FILES` makes them agree for 1a.

**The FS-walk descent gate is load-bearing, not an optimisation.** Round-1
wrote it up as "IO only — `classifySync` rejects the same paths anyway", and
round-2 review falsified that: `collectSyncableFiles`' walk emits through
`isCollectibleForWalker`, which never calls `isSyncable`, and `runImport` does
not re-filter the collected list through it either — it applies only the
exclude globs. So on a NON-GIT brain root that descent gate is the only thing
enforcing `GBRAIN_TOP_DIRS`. The git fast path re-applies `isAllowedTopDir`
itself and incremental sync goes through `classifySync`, which is what made the
gate look redundant. No live bug — the gate is there — but the comment invited
the removal that would have created one, so both it and this paragraph now say
the opposite.

**A data-loss path the move exposed, fixed in the same commit.** The
unsyncable-modified cleanup loop in `commands/sync.ts` deletes the page for any
path that is modified-but-unsyncable, with carve-outs for `'metafile'` and
`'pruned-dir'`. `'top-dir-excluded'` needed the same carve-out for identical
reasons: sync never imports those paths, so a page there can only come from a
deliberate `put_page` or from before the allowlist was turned on, and "the file
was modified" is no evidence the page is stale. Without it, switching the
allowlist on and then editing a now-blocked file would destroy its page — the
exact #2404 class. This is why the finding had to be swept as a class: fixing
only the reported coordinate would have traded one bug for a worse one.

Tests: `test/sync-top-dirs.serial.test.ts` (real git repo + PGLite) covers the
reported reproduction end to end — full sync excludes `blocked/seed.md`, then a
commit adding `blocked/later.md` AND `allowed/later.md` imports only the
allowed one, so the absence is the allowlist rather than a sync that did
nothing — plus the newly-blocked-page survival case and the unset-env upstream
default. `test/sync-isSyncable-shape.test.ts` gains the duality cases for the
new reason (including the Windows-separator form and a case asserting every
pre-existing classification is untouched when the env is unset).
Fail-without: removing the `classifySync` gate reddens the incremental case
(1 pass / 1 fail); removing only the cleanup carve-out reddens the survival
case (0 pass / 1 fail).

### 5 — the bound has to CANCEL, not just stop waiting (round-1 cluster 4)

The round-1 bound raced `runAllOnboardChecks` against a bare `setTimeout` with
no `AbortSignal`. Two seats called it blocking and firstmate ruled with them:
the wedged query keeps running after the WARN, and it keeps holding its pooler
slot. That is not a tidiness point in this deployment —
`deploy/local-http/README.md`'s own "Why" section says the shared HTTP server
exists because the session pooler caps at **15 clients**
(`EMAXCONNSESSION`). A doctor run that "completes" by walking away from its own
queries trades a wedge for slow exhaustion of the exact resource being
rationed. `src/core/onboard/checks.ts` documents the required shape verbatim
("Per A20: callers can race this against an AbortSignal-bound timer"), and
`PostgresEngine#runUnsafe` already implements real cancellation
(postgres.js `.cancel()` plus an already-aborted short-circuit) — the signal
simply never reached it.

Threaded: `runAllOnboardChecks(engine, opts?)` forwards `opts.signal` to every
check, each check to `safeCount` / `sampleVisibleEntityCoverage`, and those to
`engine.executeRaw(sql, params, { signal })`. `runOnboardChecksBounded` owns an
`AbortController`, aborts it when the timer wins, and also aborts in `finally`
(`Promise.all` settles on the LAST check, so an earlier one can still hold a
statement open if a sibling threw).

This edits an upstream file the port had kept clean, which claude flagged as
firstmate's call. It is kept minimal and additive: `opts` is optional
everywhere, so `gbrain onboard`, autopilot and skillopt are byte-for-byte
unchanged. Two steps are honestly NOT cancellable — the schema-pack lookups in
`checkPackUpgradeAvailable`/`checkTypeProliferation` go through
`engine.getConfig` and module imports, which take no signal — so the signal
bounds the DB work, not the whole function, and the doc comment says so rather
than implying full coverage.

Tests: `test/doctor-onboard-timeout.serial.test.ts` gains a case asserting the
bound actually hands down a signal and fires it (a handle-free hang proves only
latency), and `test/onboard-checks-signal.test.ts` proves the signal reaches
the ENGINE through the real aggregate, plus the no-signal upstream-unchanged
case and an already-aborted case that still returns a full result set.
Fail-without: dropping the forwarding in `safeCount` reddens the engine test
(2 pass / 1 fail); removing the `controller.abort()` calls reddens the bound
test (0 pass / 1 fail).

**What those tests do NOT prove** (round-2 review, fixture honesty): they cover
the wrapper handing down a signal and firing it, and the signal arriving at
`engine.executeRaw`. Nothing here observes postgres.js `.cancel()` landing on a
live server or the pool slot coming back — that needs a live Postgres and a
long-running statement, and upstream pins its own `runUnsafe` cancellation only
by source-text guard (`test/connection-resilience.test.ts`), so there is no
such observation anywhere in the repo to match. PG-protocol cancellation is
best-effort regardless, which is why the WARN says "did not complete" rather
than "was cancelled". The claim in the code comment and the test header is
narrowed to match.

**Why two files.** `mock.module` leaks for the life of the process and
`mock.restore()` does not undo it (verified on bun 1.3.11 in both file orders,
with both a static binding and a re-`import()`), so a test of the REAL
aggregate cannot share a process with the file that mocks it to simulate the
hang. `scripts/run-serial-tests.sh` gives every `*.serial.test.ts` its own bun
process for exactly this reason, while plain files run in the parallel shards —
so the split IS the repo's isolation contract, not a workaround. Both file
headers say so, to stop a future editor merging them.

### 2 — retired to a fail-open flag, with a deploy-time posture gate

**The problem.** Fork `425a06fb` turned the disk mirror OFF automatically
whenever the engine was Postgres. Upstream's replacement is a config flag, and
`isWriteThroughDisabled` (`src/core/write-through.ts`) **fails open**: it
returns "disabled" only when `sync.write_through` is explicitly set to an off
value, so an unset key reads as ON. `07f5d28d` / `055ac6c7` supply a mechanism,
not "the code that now does the job", and README prose is not a control. So the
retirement needed something in the deploy path — and it took three rounds to
get the shape of that right. This section records the settled design; the two
earlier shapes are described only where knowing they failed explains the
current one.

**Scope: only where the deployment makes mirrors wrong.** The gate runs only
when `gbrain-http.service` is installed. That unit's presence is what makes
"shared, DB-authoritative brain" true. On a box without it — an ordinary
PGLite/file-authoritative brain — an unset key is the fork's CORRECT inherited
posture, and advising `sync.write_through false` there would disable the `.md`
mirror that IS that brain's source of truth. Round 2 gated unconditionally and
did exactly that, while also masking the honest "not installed — skipping"
branch. No unit, no probe, no gate, no advice.

**Placement: before the first irreversible change, and abort rather than
suppress.**

- `scripts/gbrain-safe-update` checks before the **rebase**, and dies there
  with the tree untouched. The rebase is the irreversible step because the
  `gbrain` CLI is bun-linked to this checkout: the moment it lands, every new
  process on the box — capture, `brainstorm --save`, cron sync, minion workers
  — runs the new code. The HTTP server is not the only disk sink, which is why
  round 2's placement in front of the explicit restart established nothing;
  the unit is enabled with `Restart=on-failure` + `WantedBy=default.target`, so
  systemd re-activates on the next crash, login or reboot regardless.
- `deploy/local-http/setup.sh` checks before it writes or runs **anything**.
  Round 1 checked after the restart; round 2 moved it above the restart but
  left the `cp` of the unit and the `sed -i --port` above it, so exit 3 left a
  rewritten unit on disk naming a port the running process did not use.

**Reading the plane the runtime reads.** Both go through
`deploy/local-http/write-through-probe.ts`, which calls `isWriteThroughDisabled`
itself. `gbrain config get` is deliberately not used: it resolves the FILE
plane above the DB plane, so a stale value in `~/.gbrain/config.json` makes it
report an off value while the brain still mirrors. Reproduced on a real brain:
`config get --raw` → `false`, probe → `enabled:unset`.

**The decision is recorded, not defaulted.** An undecided posture stops the
command; `GBRAIN_ALLOW_WRITE_THROUGH=1` is the explicit "keep the mirrors"
answer. Unknown (probe missing, bun absent, brain unreadable) fails closed for
the same reason the flag should not have: an unverified posture is the state
that let this ship silently in the first place.

**What it establishes and what it cannot.** It establishes that at the moment
it runs the DB-plane posture is decided, and refuses to put new code on the box
while it is not. It cannot establish that the posture stays decided — the flag
is DB-backed and any client can change it afterwards. No deploy-time check can
promise more, and neither message pretends to.

**Coverage.** Twelve gate cases in `test/swx-fork-tooling.test.ts`, in two
groups. STATE — no-unit → gate silent and the upgrade completes; unit +
undecided → abort with HEAD unmoved and no install/migrate/restart; the
recorded opt-in; decided → proceeds; unresolvable → aborts naming a remedy a
re-run can reach; setup.sh stops before any state change; setup.sh's
`enabled:*` arm. MODE (added in round 4, because the state group holds the
invocation mode constant and so could not express a mode regression) —
`--check` and `--dry-run` do not fire the gate; a run that would land no code
does not fire it; and the hole guard, `BEHIND=0` with the custom branch behind
the mirror, which still aborts. Plus three cases in
`test/write-through-probe.serial.test.ts`, which drives a real scratch PGLite
brain with both planes disagreeing — the guard that reddens if the probe ever
regresses to `config get` (fail-without: 1 pass / 2 fail).

### 1f/3/4 — the two deploy scripts (round-1 clusters 6 and 8)

**The backup could be skipped silently (cluster 6, blocking).**
`gbrain-safe-update` read the engine with
`python3 … || echo pglite`, so "cannot determine the engine" became "assume
pglite". On a Postgres brain the pglite arm then matched nothing, no snapshot
was written, and the script proceeded to run migrations against the live brain
with no net — the exact opposite of what that block is for. Two further faults
in the same read: `BRAIN_DIR` treated `GBRAIN_HOME` as the final directory
though gbrain's own `configDir()` appends `.gbrain` to it
(`src/core/config.ts:1556-1572`), so any override inspected and backed up the
wrong path; and the adjacent `database_url` read had no fallback at all and
would die under `set -e` mid-upgrade.

Now: `BRAIN_DIR` resolves canonically; the engine is read through the CLI's own
resolution (`gbrain config get engine --raw`) with a direct read of the
canonical `config.json` as the fallback for a box whose CLI is mid-upgrade; an
unreadable engine **aborts** with the reason and the `--no-backup` escape
hatch; and the `database_url` read degrades to a visible skip. Pinned by two
cases (abort-without-backup, `GBRAIN_HOME` parent-dir semantics).

**One port contract (cluster 8, blocking).** `setup.sh` templates
`GBRAIN_HTTP_PORT` into the installed unit while `gbrain-safe-update` probed a
literal `127.0.0.1:8787`, so every update of a moved service spent 30s on a
dead port and reported a false "did not pass health" — unless the operator also
set a second, undocumented `GBRAIN_HTTP_HEALTH`. The script now reads the port
back out of the unit it is about to restart, from the same
`systemctl --user cat` output the guard below it already needs. The env
override still wins for a proxied or remote service.

Swept the rest of the claim rather than the one line: the README asserted the
override "holds end to end", which was false — `gbrain connect
http://127.0.0.1:8787/mcp` writes the endpoint into `~/.claude.json` at user
scope and would have registered a dead address on a moved service, and two
more curl examples hardcoded it. The README now states plainly that every
`8787` on the page is the default and points at setup's own success line, which
prints the command with the port it just installed.

Two test-hygiene fixes the work exposed: the safe-update fixtures never stubbed
`systemctl`, so they reached this box's REAL user bus and would have read the
live fleet service's port; and the new `HTTP_PORT` assignment needed `|| true`,
because under `set -euo pipefail` a failing command substitution in an
assignment kills the script and `systemctl --user cat` exits non-zero whenever
the unit is absent — the ordinary case on a machine that does not run it.

### CHUNKER_VERSION 6 → 1006 (round-1 cluster 2)

The round-1 branch changed C/C++ chunk shape and symbol metadata while leaving
`CHUNKER_VERSION` at upstream's 6, which means none of the carry reaches a
brain that has already synced. Two mechanisms, both keyed on the constant:
`importCodeFile` folds it into the code page's `content_hash` and returns
`skipped` on a match, and `performSyncInner` bypasses the git-HEAD
`up_to_date` short-circuit ONLY when `sources.chunker_version` differs. The
same forced full walk re-enumerates through `collectSyncableFiles`, which is
also how the **1a index.md carry** reaches an existing brain — one bump
delivers two carries.

Correcting the round-1 report: "inert on the live brain" was wrong for the
fleet path. `~/gbrain` and `~/tools/gbrain` sit on `swxtch` at
`CHUNKER_VERSION = 4`, so those brains would re-walk anyway; the brains that
would silently keep stale chunks are any first synced at upstream 6. The bump
makes the outcome the same either way instead of depending on which it is.

**Numbered from 1000, not 7.** The gate is a string `!==`
(`commands/sync.ts`), so any distinct value forces the re-walk — but a fork
`7` would collide with upstream's next `7`, and a brain stamped by the fork
would then SKIP upstream's own re-chunk when that lands. `1000 + the upstream
version this fork sits on` keeps every future upstream bump effective.

Pinned by **three** numeric assertions — two in
`test/chunker-version-gate.test.ts` and one in `test/chunkers/code.test.ts`.
(The round-1 verdict said there were two and that every other reference was
symbolic; the third turned up in the full-suite run. `test/chunkers/
code-merge-defs.test.ts` uses `>= 6`, which the fork value satisfies.) Also
pinned by a new case in `test/sync-cost-gate.serial.test.ts`: the R-3 control
already asserts an unchanged tree at the CURRENT version reports
`estimateKind: "unchanged"`; the new case changes only the stored version and
requires `"ceiling"` instead. Fail-without (drift rung neutralised, everything
else intact): 0 pass / 1 fail.

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

**Final gate run after review round 6: 22559 pass / 1 fail / 10 skip**
(`bun run test`, 1819s, on a quiet box — load average 7.8). **All three
parallel shards clean** (8006 / 7143 / 7410, zero failures), and the single
remaining failure is the known pre-existing upstream cell in the serial pass.
`bun run verify` 55/55 green; `shellcheck` clean on both fork shell scripts.

**Run it serially on this box.** An earlier round-2 attempt at
`GBRAIN_UNIT_MAX_PARALLEL=2` produced 117 failures in one shard, every one a
PGLite `Out of memory` at `connect` — the box's known WASM-OOM class, not a
logic failure, and the runner's own serial rescue did not recover it.
`GBRAIN_UNIT_MAX_PARALLEL=1 GBRAIN_SERIAL_POOL=1` is clean (and slower: ~26min
vs ~10). Same order the p2 phase recorded as in force box-wide.

**Round-4 ran on a saturated box, and that produced timeouts — not signals.**
This round's runs happened at load average 10-57 (nine users; other sessions),
and every extra failure it produced was a wall-clock kill of a subprocess- or
server-spawning test, each proven environmental rather than assumed:

| Case | Symptom | Proof it is the box |
|---|---|---|
| `cli-search-dispatch` ×3 | exit 124 after 7-15s | a pristine `origin/master` tree fails the SAME cases under the same load; both pass on this branch minutes later at lower load |
| `commands-search` | `beforeEach` hook timeout | same pristine-master run, same result |
| `admin-embed-spawn` | 90,006ms | 5 pass / 0 fail in isolation once load fell to 10 |
| `bun run verify` `typecheck` | TIMED OUT at 120s | `tsc --noEmit` alone measures 98s against that cap; 55/55 green at `GBRAIN_VERIFY_TIMEOUT=300` |

None appears in more than one run, none is in a surface this branch touches,
and the pristine-master comparison is the same standard already accepted for
the rename cell. Recorded so a future reader does not mistake a busy box for a
regression — and so the *next* runner knows to check `uptime` before believing
a wall-clock failure.

**Two shard-1 failures appeared once in round 3 and were triaged, not
absorbed.** `skillify-check`'s `--recent` case was real and attributable:
`execFileSync`'s 1MB default `maxBuffer` truncated a legitimately 1,107,704-byte
JSON document, because `--recent` audits every file under `src/commands`,
`src/core` and `scripts` with an mtime inside 7 days — a set this branch's own
edits and fail-without probes grew past the line, and one that a fresh clone
trips for anyone. Fixed at the cause (the harness's buffer), fail-without
re-proven after a first probe that silently did not apply.
`eval-brainbench-e2e`'s `runBrainBenchCore` case passes 22/22 in isolation on
this branch, did not fail in the round-2 run, and did not reproduce on the
re-run — shard pressure, recorded rather than claimed either way.

Two failures the round-1 fix work introduced were caught by running the WHOLE
suite rather than the touched files, and are fixed: a third numeric
`CHUNKER_VERSION` pin in `test/chunkers/code.test.ts` (the round-1 verdict said
there were two), and a prose bleed of this branch's own making — the new
`topDirsAllowlist` doc comment named a bare `-`-prefixed flag, and
`core/sync.ts` is imported by nearly every command, so three unrelated commands
started accepting and ignoring it. Reworded; the generated registry is
byte-identical to master again.

An earlier run of the same suite, before the fixes below, reported 22526 pass
/ 3 fail. The three were:

- **1 pre-existing.** `test/sync-rename-reconcile.serial.test.ts` — "a
  frontmatter slug-authority rejection at the destination is retried, never
  falsely checkpointed". Fails identically on a pristine `origin/master`
  worktree at `7b7921d8` (57 pass / 1 fail there), so it is not port-caused.
  **Firstmate ruled on this in round 1** (adjudicating codex 4 / claude 11 /
  f5-panel 9): a failure that reproduces byte-identically on pristine master is
  a pre-existing upstream defect and out of this branch's scope; the branch's
  gate is "no new failures versus master", with the pristine-master proof
  recorded here and the cell named as an unfiled upstream follow-up. The brief
  scaffold's absolute green-gate lacking that carve-out is a brief defect owned
  by firstmate and tracked elsewhere.

  **Reproduction recipe (replaced in round 2 — the round-1 one no longer
  works).** Round 1 said "revert only this branch's two sync files to
  `origin/master` and re-run". That stopped isolating anything: round 2 moved
  `topDirsAllowlist`/`isAllowedTopDir` into `src/core/sync.ts`, which
  `src/commands/import.ts` imports, so the revert breaks the module graph and
  produces a mass failure instead of a comparison. Use a whole pristine tree:

  ```bash
  mkdir /tmp/pristine && git archive origin/master | tar -x -C /tmp/pristine
  ln -s "$PWD/node_modules" /tmp/pristine/node_modules   # or bun install there
  cd /tmp/pristine && bun test test/sync-rename-reconcile.serial.test.ts
  ```

  Run at this pin: **57 pass / 1 fail on pristine `origin/master`, 57 pass /
  1 fail on the branch — the identical cell.** So no branch change is
  available; the fix lives in an upstream file unrelated to all 7
  customizations.
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

## The two wave overlaps the brief named (verified, not assumed)

The brief singled out **sync soft-delete** and the **embed stall watchdog** as
the changes most likely to retire a fork customization, and said to verify
rather than assume either direction. Both checks, and both results:

**Sync soft-delete — real overlap, verdict unchanged.** `#4587` made full-sync
reconcile call `engine.softDeletePages` (`src/commands/sync.ts:4242`) instead
of hard-deleting. It touches 1a directly: it changes the HARM of dropping the
index.md carry from immediate page removal to a 72h hidden window ending in the
autopilot purge. It does not retire the carry — `SYNC_SKIP_FILES` still lists
`index.md` (`src/core/sync.ts`), so the pages still go away, just later. Row 1a
and the in-code comment both say this now.

**Embed stall watchdog — NO overlap. Null result.** The watchdog is
`GBRAIN_EMBED_STALL_ABORT_SECONDS` in `src/core/embed-stall.ts` (new in the
v0.47.6.0 wave). Checked against the fork commits by enumerating every file
the seven of them touch — 20 files, listed by `git show --name-only` across
`88a02775 425a06fb 194d067c 9bbafc96 3eb9aa4a d74d45be 63c50bb2` — and **none
is an embed path**: the set is the two engines, sync/import/extract,
link-extraction, the code chunker, code-def, doctor, brainstorm, write-through,
the deploy files and docs. This branch touches no embed file either
(`git diff --name-only origin/master..HEAD | grep -i embed` is empty). So the
watchdog neither retires nor is affected by any of the seven. Recorded so the
next porter does not redo the check.


## Round-3 record

**The red cell is settled, with evidence, and stays out of scope.** Round 3
saw one seat re-file `test/sync-rename-reconcile.serial.test.ts` as a P1
against the branch. The other two settled it the same way, independently: the
failure reproduces byte-identically on a pristine `origin/master` tree at
`7b7921d8` (the `git archive` recipe recorded above — 57 pass / 1 fail on both
sides, the same cell, the `(fail)` lines differing only in elapsed ms), and the
test touches none of the fork's surfaces. No branch-side change turns it green;
requiring one asks this crew to fix `garrytan/gbrain`'s test inside a fork
port. Firstmate ruled it out of scope in round 1 and that ruling stands; the
gap is the brief scaffold's absolute green-gate lacking a pre-existing-upstream
carve-out, which firstmate owns.

**Fixture classification for the round** (the obligation, not a defect list).
ALIGNED, each proved by ablation: the rewritten
`onboard-checks-signal` aborted-signal case (2 pass / 1 fail with `safeCount`'s
catch removed, where the old version passed verbatim); `sync-chunker-rewalk`
(1 pass / 1 fail with the version gate forced false); `code-c-cpp`'s prose case
(red with the inter-node flush disabled, and separately with the trailing
flush disabled); the new `write-through-probe.serial` guard (1 pass / 2 fail
with the probe regressed to file-plane-first); the newly armed `GBRAIN_HOME`
PARENT-dir case (0 pass / 1 fail with `BRAIN_DIR` reverted); the no-unit gate
case (0 pass / 1 fail with the scope predicate removed). QUALIFIED:
`import-top-dirs`' renamed case proves `collectSyncableFiles` filters; the
"only enforcement" half of its name rests on reading `runImport`, and the
case's own comment says so.

**A scoping lesson worth keeping.** Round 2 swept the fixtures the diff
CHANGED. The correct scope is every fixture whose MEANING the diff moves: the
`spawnEnv` `GBRAIN_HOME` correction is what made the PARENT-dir case's
precondition load-bearing, and that case was left vacuous for a round because
it was not in the changed set.

## Round-4 record

**The dominant finding was a regression in the round-3 repair, not a residual.**
Moving the write-through gate above the rebase also moved it above the
`--check` exit and the no-op short-circuit, so three invocations that land no
code began aborting — on the fork's own box, since the unit is installed and
the key is recorded UNSET. It also inverted the gate's own stated principle by
charging a recorded posture decision as the price of a READ. Scoped in round 4
to invocations that will actually mutate, keeping the round-3 property that it
still precedes the stash and the rebase. The predicate is deliberately NOT
`BEHIND=0`: the rebase block replays the custom branch whenever it is not
already on the mirror, so a naive skip would reopen the hole — there is a cell
that fails against exactly that shortcut.

**A guard set can be blind along an axis it holds constant.** The round-3
cases formed a STATE matrix (unit present/absent × posture
decided/undecided/unknown) with the invocation MODE fixed at "default,
mutating", which is why none of them could see a mode regression. The mode
group added in round 4 is the missing axis. Worth remembering next to the
round-3 lesson about scope (sweep every fixture whose MEANING the diff moves,
not only the ones it changed): both are ways a complete-looking guard set can
still be blind.

**The specification check was deleted, and its property re-expressed.** Reading
`src/core/chunkers/code.ts` as text to pin a docs claim made this repo's own
source the subject. The replacement asserts what the chunker PRODUCES, over a
sample of other languages, and says in the test that it is a sample rather than
a proof. Two corrections were needed to make it able to fail at all — the first
sample used an exported type alias, which chunks as the export wrapper and
never reaches the normalizer — so each fixture now also asserts its
alias-shaped construct actually chunked.

**Still out of scope, fourth round running:** the red
`test/sync-rename-reconcile.serial.test.ts` cell. Byte-identical on a pristine
`origin/master` tree, `git diff --name-only 7b7921d8..HEAD` empty for both that
test and its subject, and no branch-side change exists short of editing
`garrytan/gbrain`'s own test inside a fork port. One seat has escalated the
underlying point to firstmate: the objective's absolute green-gate has no
pre-existing-upstream carve-out, so either the scaffold gains one or the
waiver is recorded against this task. That is firstmate's to settle, not a
branch change.

## Round-7 record — the design settled

**Four generations, one unsettled design.** `BEHIND != 0` (r4) → an
ancestry-only `gate_lands_code` (r5) → a post-hoc `HEAD != SERVED_HEAD_BEFORE`
(r6). Each repair was a coordinate: it fixed the input the reviewer brought and
left the question unsettled, so the next reviewer brought a different input.
Round-6 review then swept the class and found **four non-equivalent predicates**
answering that one question — the ancestry test, the post-hoc comparison,
`REBASED`, and the closing summary's version diff — which falsifies the
round-6 claim, recorded in the section below, that prediction and confirmation
had made it "one mechanism". It had not; it had made it two, beside two more.

**The settlement.** One function, one evaluation, one value, a written
contract in the script above `run_lands_code`. Inputs: the branch topology
before anything mutates — served ref at launch, the ref the run ends on, the
fetched `$UPSTREAM` — and explicitly NOT the mode flags, because the answer is
a property of the plan rather than of whether we carry it out. Output:
`RUN_LANDS_CODE`. Invariant: every site reads that one value, so a `--dry-run`
prediction and the real run it predicts cannot disagree, because they are the
same number.

Two terms, because the run both checks out a ref and moves it: (a) it ends on
a different ref than it launched on — the term whose absence let a run started
on the mirror arm the entire upgrade block with the gate silent; (b) that ref
is not already on the fetched upstream. Planned state rather than post-hoc,
because `run()` prints mutations under `--dry-run` without performing them, so
a HEAD comparison is unsatisfiable there and hid the destructive half of the
script from the operator's only pre-flight.

Sites, all reading the one value: the posture gate, the upgrade block's arming
condition, the `--dry-run` path (inside both), and the closing summary — that
last was the fourth predicate, printing "no upstream change" directly above the
warning that the branch had been rebased.

**The matrix is indexed by (branch × mode × posture)**, because indexing by
SITE alone is what left the guard set blind three rounds running: every arming
cell asserted absence on a real run, every gate cell launched from the custom
branch, and both holes lay on axes the round had "added coverage along". 52
cells in `test/swx-safe-update-matrix.serial.test.ts`; the landing states also
assert the invariant directly, running one fixture twice — once predicting,
once doing — and requiring the destructive half to appear in the prediction
exactly when it happens for real.

It catches every generation, which is the test of a settlement rather than a
patch: r4's `BEHIND != 0` → 18 fail; r5's ancestry-only → 12 fail; r6's missing
launch term → 6 fail; r6's post-hoc arming → 3 fail, exactly the invariant
cells.

**The lesson, in its final form.** Round 3 said sweep every fixture whose
MEANING the diff moves. Round 4 said a guard set can be blind along an axis it
holds constant. Round 6 said adding an axis is not covering it. Round 7's is
the one underneath all three: *when the same question has more than one
answer in the tree, every fix is a coordinate.* Settle the question — one
function, one contract, one value — and the coordinates stop.

## Round-6 record

**One wrong proxy, two armed surfaces.** `BEHIND != 0` asks whether the mirror
moved; the property both the posture gate and the upgrade block need is whether
the SERVED ref moves, because the `gbrain` CLI is bun-linked to this checkout.
Those come apart in both directions, and each direction was live: a lagging
mirror with the custom branch already rebased made the gate refuse a run whose
rebase is a no-op on code the box already executes, while a current mirror with
the custom branch behind made the gate say "lands nothing" as the rebase moved
HEAD. The same proxy armed the expensive half — `bun install`, a `pg_dump` of
the live brain, migrations, and a session-dropping restart — for code already
in service, and it MISSED the fast-forward branch, which moves HEAD without
setting `REBASED`.

Replaced by one mechanism: `SERVED_HEAD_BEFORE` is captured before anything
mutates; the gate PREDICTS with an ancestry question against `$UPSTREAM` (the
ref the rebase lands on — the old code asked `$TRACK_BRANCH`, the
pre-fast-forward mirror), and the upgrade block CONFIRMS by comparing HEAD to
that capture. Prediction and confirmation of the same fact, so the two sites
can no longer disagree about what an upgrade is.

**Crossing axes, not just adding them.** Round 4's record diagnosed that a
guard set can be blind along an axis it holds constant, and round 4 then added
the mode axis without CROSSING it with the opt-in — which is exactly how an
inverted dry-run prediction shipped under twelve green cases. The lesson has a
sharper form now: adding an axis is not covering it. The crossed cells are in
place, and the two lagging-mirror cells cover the proxy's other direction.

**Prose that describes a mechanism the artifact does not implement** was swept
across the round's delta: the gate comment asserting the mirror-based rule (the
very sentence that would have caught the bug), the chunker sample's claim that
all five of its rows were type-alias constructs when two have no alias at all,
and a stale round-3 headline left standing beside the round-4 one. All three
corrected in place.

## Follow-ups deliberately NOT filed

`swxtchio/gbrain` is public, has issues disabled, and is absent from
`config/gh-repo-allowlist`, so the repository-artifact contract forbids opening
an issue and the task objective forbids GitHub artifacts outright. This section
is therefore the only permitted home for deferred work — and, unlike a PR body
or a review record, it is committed to the branch and survives the merge.
Round-2 review made that explicit: naming a finding in a verdict is not filing
it. Everything below was either raised in review and adjudicated non-blocking,
or found while doing the work and judged out of scope.

**Round-2 non-blocking findings, resolved rather than deferred** (recorded here
so the trail is complete, not because they are outstanding): the
`import.ts` false-invariant comment and its copy in this plan were CORRECTED in
place, not appended to; the `config get` plane mismatch became the
`write-through-probe.ts` fix; the `checks.ts` indentation was fixed in passing;
the three fixture overstatements were rewritten to prove their names; and the
isolation recipe above was replaced.

**Round-3 non-blocking findings, likewise resolved rather than deferred:** the
duplicated preamble this paragraph replaces (the round-2 text was inserted
above the pre-existing one instead of replacing it); the fixture
classification, which is folded into the round-3 record below; and the
`enabled:unset|enabled:*` subsumed alternative in `setup.sh`, dropped.

The genuinely deferred items follow.

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
- **Upstream accepts `gbrain sync --check` and `gbrain status --check`** and
  silently ignores them, so a user typing `sync --check` expecting a dry
  inspection runs a real sync. Cause: the bare `--check` token in the
  `src/core/cli-options.ts` comment at the `onboard --check --explain` example,
  reached by the flag-registry generator's import-graph text scan. Reproduced
  on a pristine `origin/master` worktree. Belongs in a PR to
  `garrytan/gbrain`, not in this fork port — the fix is either rewording the
  comment or teaching the generator to ignore tokens inside comments.
- **Gap emission has no minimum size**, so every inter-node region becomes its
  own symbol-less chunk however small, and the fork's `preserveAllSymbols` arm
  means a gap chunk can never merge forward into a symbol-bearing neighbour.
  Measured with this branch's chunker on real corpus (reproduced independently
  of the reviewer who raised it, same numbers):
  `dpdk-wrapper/dependencies/libpcap/ieee80211.h` — 147 lines → 71 chunks, 7
  symbol-less, **6 under 40 bytes** (`/* for TYPE_MGT */`, `/* for TYPE_CTL */`);
  `pflog.h` — 158 lines → 46 chunks, 10 symbol-less, **7 tiny**
  (`#if defined(__OpenBSD__)`, `#endif`). Byte coverage stays complete (5355
  indexed of 5439 source bytes on ieee80211.h), so this is embedding and
  retrieval NOISE, not loss — and it is the direct price of the coverage fix.
  A minimum-size threshold (fold a sub-N-byte gap into the next one, or drop
  comment-only fragments) is the obvious follow-up; not taken here because
  choosing N is a retrieval-quality question that wants an eval, not a guess.
- **No CLI surface prints `sources.chunker_version`.** The verify runbook
  works around it by observing the carried behaviour instead (the
  `type definition` symbol_type only this carry can emit — see 4d check 2), but
  an operator diagnosing "why did it not re-walk" still cannot read the stored
  stamp against the binary's. `gbrain sources status` would be the natural home
  for a column, or doctor's `sync_freshness` message could name both numbers.
  Upstream-shaped; not taken here because it widens the port into a CLI surface
  the fork does not otherwise touch.
- **No test anywhere observes PG cancellation actually landing** — postgres.js
  `.cancel()` reaching a live server, or the pool slot returning. The fork
  proves the signal arrives at `engine.executeRaw`; upstream pins its own
  `runUnsafe` cancellation by source-text guard only
  (`test/connection-resilience.test.ts`). A live-Postgres e2e with a
  long-running statement would close it, in upstream's lane.
- **`extractSymbolName`'s declarator arm drops the outermost namespace** on an
  out-of-line C++ definition: `int swx::pipeline::Engine::run(int)` is named
  `pipeline::Engine::run`, because the `qualified_identifier` `name`-field dive
  returns the inner `qualified_identifier`. Verified against `origin/master`
  this is still a strict improvement, not a regression — master returned `null`
  there, and named `MyType make_thing(int)` as `MyType`, the return type. Worth
  fixing upstream alongside the rest of the C/C++ reach.
- **`test/sync-rename-reconcile.serial.test.ts` fails on pristine
  `origin/master`** at `7b7921d8` (57 pass / 1 fail, same env, both sides).
  Upstream's own test, from `3f2f3004`. Belongs in a report to
  `garrytan/gbrain`; there is no branch-side fix.
- **R8 (the argv `run()` refactor in `scripts/gbrain-safe-update`) has no
  reachable failure** on the non-dry-run path — see the B1 section. It is kept
  as hardening. If it is ever revisited, the honest framing is "class-level
  hardening + dry-run output fidelity", not "fixes a stash bug".
