# SWX patches on the swxtch branch

This file documents every commit on the `swxtch` branch that doesn't exist
on `origin/master`. Each is prefixed `SWX:` in its commit message so a
glance at `git log master..swxtch` shows what's local at all times.

The patches address gaps we hit running gbrain against a multi-domain
brain (7 swxtch.io repos, mixed markdown + C/C++/TypeScript code) on
Supabase Postgres. Some are upstream-PR-worthy; others are
swxtch-specific. Tagged below.

Last updated: 2026-04-27. Branch base: upstream `master` at v0.22.2.

---

## Repo layout

We maintain this hard fork at `git@github.com:swxtchio/gbrain.git`. Local
remotes:

| remote   | URL                                       | role                  |
|----------|-------------------------------------------|------------------------|
| `origin` | `https://github.com/garrytan/gbrain.git`  | upstream — fetch only. Push URL is `no_push`. |
| `swxtch` | `git@github.com:swxtchio/gbrain.git`      | our fork — fetch + push. |

Branches:

- `master` — mirrors upstream. Never modified directly.
- `swxtch` — all SWX patches, rebased onto master on each upstream pull.
  Force-push expected after rebase.

### Update workflow

```bash
git checkout master
git pull --ff-only origin master
git checkout swxtch
git rebase master
git push swxtch swxtch --force-with-lease
```

Conflicts are rare. Each SWX patch is surgical and touches a small
contiguous region. If conflicts arise, the table below tells you where
each commit lives in the codebase.

---

## Patches (in commit order, oldest first)

### 1. `SWX: multi-domain brain compatibility patches`

**Files:** `src/commands/extract.ts`, `src/core/sync.ts`

**Two surgical fixes for multi-domain brains where slugs are
`domain/docs/page` (three segments) instead of upstream's
`people/alice` (two segments):**

1. `extract.ts:223` — depth-2 resolver regex
   (`/^[a-z][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/`) replaced by
   `allSlugs.has(trimmed)`. The regex capped slugs at depth-2 so
   frontmatter `related:` refs to three-segment slugs always failed
   resolution even when the target page existed. On our 433-page brain
   this dropped 333 false-positive "unresolved frontmatter ref" reports.

2. `core/sync.ts:195` — `index.md` removed from `skipFiles`. We use
   `index.md` as the canonical entry page for a folder
   (`blox-spec/index.md` is the spec's table of contents). The upstream
   skip list treated it as noise.

**Upstream-worthy:** Yes. Both fixes preserve upstream behavior for
single-domain brains (the `allSlugs.has()` call is strictly more
restrictive than the regex was, so no new false matches; the `index.md`
skip removal lets `index.md` files import where they used to be silently
dropped).

---

### 2. `SWX: GBRAIN_TOP_DIRS env var to scope multi-repo brain walks`

**Files:** `src/commands/import.ts`, `src/commands/sync.ts`

When the brain root sits above many sibling repos (e.g. `~/byates/` with
15+ `swx-*` checkouts) and only a subset belong in the brain, we need
top-level scoping. Upstream sync has no `--include` flag and the existing
`isSyncable` include/exclude options aren't wired to the CLI.

Smallest possible patch: at the root of both walkers (`walkSyncableFiles`
in sync.ts and `collectMarkdownFiles` in import.ts), honor
`GBRAIN_TOP_DIRS=name1,name2,...` as a top-level allowlist. Subdirectories
descend normally — we only filter at depth 0.

Usage:

```bash
GBRAIN_TOP_DIRS=swx-srtx,swx-spp,swx-model-router-blox \
  gbrain sync --repo /home/byates
```

Both walkers honor the same env var so the full-sync (`runImport` →
`collectMarkdownFiles`) and incremental (`walkSyncableFiles` via git diff)
paths agree on scope.

**Upstream-worthy:** Borderline. Useful for any multi-repo brain. Could
be reframed as `--include` / `--exclude` CLI flags for upstream taste.

---

### 3. `SWX: extend depth-2 resolver fix to core/link-extraction.ts`

**Files:** `src/core/link-extraction.ts`

The depth-2 regex bug from commit #1 lived in **two** places. The DB-source
extract path (`extractLinksFromDB`) uses `makeResolver` from
`core/link-extraction.ts`, which had its own copy of the same broken
regex. Without this companion fix, `gbrain extract --source db
--include-frontmatter` reports refs as unresolved even when their targets
exist verbatim in `pages.slug`.

Replaced regex with `trimmed.includes('/')` — `engine.getPage()` is the
authority and returns null for invalid slugs, so this widens the
resolved set without producing false positives.

**Upstream-worthy:** Yes — same severity as #1. If we PR them up, ship
together.

---

### 4. `SWX: code-def includes 'declaration' for C function support`

**Files:** `src/commands/code-def.ts`

Tree-sitter's C grammar emits function definitions as
`symbol_type='declaration'` (no separate `function_definition` node like
TS/Python/Ruby produce). Upstream `code-def` filtered
`symbol_type IN ('function','class',...)` — every C function definition
was invisible to `code-def` even though the chunker correctly extracted
them.

Added `'declaration'` to the allowlist. Trade-off: prototypes and
forward-decls in headers surface alongside actual definitions. The
result row carries `file:line` so the user can tell at a glance which is
which.

This patch was necessary but not sufficient. **The chunker itself wasn't
extracting C/C++ symbol names** at the time — see commit #5.

**Upstream-worthy:** Yes, clearly. Combined with #5 it makes `code-def`
useful on C codebases.

---

### 5. `SWX: fix C/C++ tree-sitter chunker — symbols now extracted`

**Files:** `src/core/chunkers/code.ts`

**The big chunker fix.** Five compounding bugs made the C/C++ chunker
silently fall back to the recursive text chunker for ~all real-world
files, producing thousands of chunks with NULL `symbol_name` and NULL
`language` metadata:

1. **`PASSTHROUGH_TYPES`.** Real-world C/C++ wraps content in header
   guards (`preproc_ifdef`), conditional compilation, `extern "C"`
   blocks (`linkage_specification`), and the `declaration_list` body of
   either of those. The walker only inspected `root.namedChildren`,
   never recursing through any wrapper, so `semanticNodes` ended up
   empty and the chunker fell back. Added `collectSemanticNodes` helper
   that recurses through these wrappers.

2. **`TOP_LEVEL_TYPES['c']` / `['cpp']`** — missing `type_definition`,
   `enum_specifier`, `union_specifier`. tree-sitter parses
   `typedef struct {...} foo_t;` as a top-level `type_definition` (not
   a `declaration`), so every typedef'd struct/union — i.e. ~all
   idiomatic C type aliases — was invisible.

3. **`extractSymbolName` declarator chain** — didn't follow C/C++
   `declarator` field chains. `int big_add(int)` returned
   `symbolName=null` even though tree-sitter correctly tagged it
   `function_definition`. Added recursion through
   `childForFieldName('declarator')` with terminal cases for
   `identifier` / `field_identifier` / `type_identifier`.

4. **`extractSymbolName` namedChildren walk** — didn't recurse through
   nested `*_declarator` types (`parenthesized_declarator`,
   `pointer_declarator`), so function-pointer typedefs
   `typedef void (*cb)(int);` lost their name.

5. **`mergeSmallSiblings`** collapsed chunks under 15% of `chunkTarget`
   into anonymous `merged` blocks. C function prototypes are tiny
   (~5-10 tokens) and were being rolled up, erasing the symbol metadata
   `code-def` relies on. Added `currentHasSymbol` guard so any chunk
   with a symbol_name passes through verbatim regardless of size.

Result on `srtx_engine_perf_abi.h` (109 lines, idiomatic C header):
- Before: 3 chunks, all `type='module' name=null` (full fallback).
- After: 27 chunks with real `symbol_type` and `symbol_name`
  (function definitions, prototypes, type_definitions, preproc_defs all
  surfaced individually).

End-to-end on swx-srtx (282 code pages):
- Before: 0 of 4523 chunks had `symbol_name` populated (0%).
- After: 5918 of 6265 (94%); language populated on 100%.

**Upstream-worthy:** Definitively yes. This is a real bug, not
swxtch-specific. Any C/C++ codebase processed by upstream has the same
silent fallback.

---

### 6. `SWX: code-def accepts the full set of symbol_type tags we extract`

**Files:** `src/commands/code-def.ts`

Follow-on to #4 and #5. After #5's chunker fixes, we now extract symbols
for typedefs, struct/union/enum specifiers, and `#define` macros — but
`code-def`'s `DEF_TYPES` allowlist only included
`'function|class|...|declaration'`. Result: `code-def srtx_eng_conn_params_t`
returned 0 even though the chunk had `symbol_name='srtx_eng_conn_params_t'`
and `symbol_type='type definition'`.

Added `'type definition'`, `'struct specifier'`, `'union specifier'`,
`'enum specifier'`, and `'preproc def'` to `DEF_TYPES`.

**Upstream-worthy:** Yes — paired with #5.

---

### 7. `SWX: keep cli.ts executable`

**Files:** `src/cli.ts` (mode change only, 0644 → 0755)

Upstream lands `src/cli.ts` with mode 0644. Our install path is
`bun link`-ed: `~/.bun/bin/gbrain` is a symlink directly into
`src/cli.ts`, so the file must be `0755` for `gbrain ...` to invoke.
Without this, every fresh checkout of the fork breaks the bin entrypoint
with `Permission denied`.

This is a one-bit change (mode bit), no content diff.

**Upstream-worthy:** Probably not — depends on how upstream expects
people to install. Most users go through `bun build --compile` which
embeds the file regardless of source mode.

---

### 8. `SWX: source_id propagates through write path (v0.18.0 Step 5)`

**Files:** `src/cli.ts`, `src/commands/import.ts`, `src/commands/sync.ts`,
`src/core/engine.ts`, `src/core/import-file.ts`,
`src/core/pglite-engine.ts`, `src/core/postgres-engine.ts`,
`src/core/types.ts`

**The big multi-source isolation fix.** Resolves the v0.18.0 "Step 5" gap
that `pglite-engine.ts:138` explicitly flagged in a comment. Before this
patch, `putPage` relied on the schema DEFAULT `'default'` for source_id,
so every page write — regardless of which `gbrain sources` row the sync
declared as active — landed in `source_id='default'`. Per-repo sources
were Potemkin: they tracked `last_commit` and `local_path`, but the
actual pages all collided in one bucket.

Concretely: `gbrain sync --source swx-srtx --strategy code` writes
`src/main.c` → slug `'src-main-c'` → `source_id='default'`. The next
day, sync `--source swx-spp` writes a different `src/main.c` → same slug
`'src-main-c'` → ON CONFLICT (source_id='default', slug) overwrites
yesterday's swx-srtx row last-writer-wins. Silent data loss.

Changes:

1. `PageInput += source_id?: string`. Optional. Falls through to schema
   DEFAULT when omitted so every legacy caller behaves identically.
2. `postgres-engine.ts` and `pglite-engine.ts` `putPage` now write the
   explicit source_id when present.
3. Read path (`getPage`, `getChunks`) accepts an optional `sourceId`
   scope so the import path's content-hash short-circuit doesn't
   false-skip when a sibling source happens to have the same slug.
4. `import-file.ts` `importFromContent` / `importFromFile` /
   `importCodeFile` all accept `opts.sourceId` and pass it to `putPage`
   and the scoped reads.
5. `sync.ts` per-file `importFile` calls forward `opts.sourceId`.
   `performFullSync` passes `opts.sourceId` into `runImport`.
6. `import.ts` `runImport` accepts `opts.sourceId` and forwards it.
7. `cli.ts`: `gbrain import` resolves `--source` / `GBRAIN_SOURCE` /
   `.gbrain-source` the same way `gbrain sync` does.

**Upstream-worthy:** Definitely. This is literally the v0.18.0 Step 5
that was promised.

---

### 9. `SWX: address cross-model review P1 findings on the Step-5 patch`

**Files:** `src/cli.ts`, `src/core/engine.ts`, `src/core/import-file.ts`,
`src/core/pglite-engine.ts`, `src/core/postgres-engine.ts`

Codex (high reasoning) and Gemini (gemini-3.1-pro-preview) independently
reviewed the Step 5 patch and flagged the same three correctness gaps:

1. **`cli.ts`**: `gbrain import` strips the `--source <id>` pair from
   args before forwarding to `runImport`. The previous shape left both
   flag and value in the args array; `runImport`'s first-non-flag-arg
   lookup grabbed the source id as the import directory, so
   `gbrain import --source srtx ./docs` would try to import a directory
   literally named `srtx` instead of `./docs`.

2. **`cli.ts`**: `gbrain import` invokes `resolveSourceId`
   unconditionally so the `.gbrain-source` dotfile and
   registered-source cwd-prefix paths actually fire on a bare
   `gbrain import <dir>`. The previous shape gated the resolver on
   `--source || GBRAIN_SOURCE`, leaving the dotfile path entirely dead.
   `resolveSourceId` returns `'default'` when nothing claims the cwd, so
   the legacy single-source brain still behaves identically.

3. **Engine**: thread an optional `{ sourceId }` opts arg through six
   slug-keyed write paths the import transaction uses —
   `upsertChunks`, `deleteChunks`, `addTag`, `removeTag`, `getTags`,
   `createVersion`. Every method already resolved `page_id` with
   `(SELECT id FROM pages WHERE slug = $1)`, which returns multiple rows
   in a multi-source brain and either errors or — worse — silently grabs
   an arbitrary same-slug page. Scoping the subquery to
   `(slug, source_id)` when the caller knows which source it's writing
   for fixes that.

Gemini also flagged a P2 about `preproc_ifndef` missing from
`PASSTHROUGH_TYPES`. Verified false — tree-sitter-c uses `preproc_ifdef`
for both `#ifdef` and `#ifndef`. There is no `preproc_ifndef` node type.

**Upstream-worthy:** Yes — paired with #8.

---

## How to PR these upstream

Recommended grouping for upstream PRs:

| PR | commits | scope                                                                                       |
|----|---------|---------------------------------------------------------------------------------------------|
| 1  | #1, #3  | Frontmatter resolver depth-2 regex fix + `index.md` skip removal. Smallest, safest.        |
| 2  | #5, #4, #6 | C/C++ tree-sitter chunker fixes + `code-def` allowlist extensions. The big one.          |
| 3  | #8, #9  | Source-id propagation (Step 5) + the cross-model review fixes that close it out.           |
| —  | #2      | `GBRAIN_TOP_DIRS` — could go upstream but probably better reframed as `--include` flags.   |
| —  | #7      | `cli.ts +x` — swxtch-specific install detail. Don't PR.                                    |

Don't squash within a PR — preserve the per-commit narrative so reviewers
can read each change in isolation.
