/**
 * swxtch fork — C/C++ symbol extraction (re-port of the 88a02775 chunker item).
 *
 * Upstream's chunker scans only the DIRECT named children of the root for
 * top-level nodes. Real-world C/C++ wraps everything in a header guard
 * (`preproc_ifdef`), an `extern "C"` linkage block, a namespace, or a
 * template, so a header has ZERO top-level semantic nodes and the whole file
 * falls through to the text chunker — every symbol invisible to code-def.
 *
 * The carried behavior these tests pin:
 *   1. `collectSemanticNodes` recurses through PASSTHROUGH_TYPES
 *      (preproc_ifdef / preproc_if / linkage_specification / declaration_list /
 *      namespace_definition / template_declaration) to reach the real
 *      definitions inside.
 *   2. `type_definition`, `enum_specifier`, `union_specifier`, `preproc_def`
 *      and `preproc_function_def` are top-level semantic node types for BOTH
 *      `c` and `cpp` (upstream's `cpp` set has none of them and there is no
 *      separate `c` entry for the aggregate forms).
 *   3. `extractSymbolName` walks the `declarator` field chain
 *      (function_declarator → pointer_declarator → parenthesized_declarator →
 *      identifier), so definitions, prototypes, and function-pointer typedefs
 *      get names instead of `null`.
 *   4. The two symbol types this carry adds to `DEF_TYPES`
 *      (src/core/chunkers/def-types.ts) — `type definition` and
 *      `union specifier` — are what the chunker actually emits for the
 *      idiomatic C aggregate forms, so code-def can resolve them and
 *      `MERGE_PROTECTED_SYMBOL_TYPES` (derived from the same list) keeps
 *      small-sibling merging from erasing their `symbol_name`.
 *
 *   5. The fork's C/C++ preserve-all arm in `mergeSmallSiblings`, which sits
 *      BESIDE upstream's `isDefChunk`/`MERGE_PROTECTED_SYMBOL_TYPES` (#4511)
 *      rather than replacing it. Upstream's guard covers the aggregate forms
 *      only — `MERGEABLE_RUN_TYPES` deliberately keeps `declaration` and
 *      `preproc def` mergeable — so without the fork arm a guarded header
 *      made of a RUN of `#define`s and prototypes, the ordinary shape of a C
 *      API header, collapses into one anonymous `merged` chunk that code-def
 *      cannot resolve anything in. `C_RUN_HEADER` below is that shape.
 */

import { describe, test, expect } from 'bun:test';
import { chunkCodeText } from '../../src/core/chunkers/code.ts';
import { DEF_TYPES, MERGE_PROTECTED_SYMBOL_TYPES } from '../../src/core/chunkers/def-types.ts';

const C_HEADER = `
#ifndef SPP_WIRE_H
#define SPP_WIRE_H

#include <stdint.h>

#define SPP_VERSION_CODE(major, minor) (((major) << 4) | (minor))

typedef struct {
  uint32_t seq;
  uint8_t flags;
} packet_header_t;

typedef enum {
  LINK_STATE_DOWN,
  LINK_STATE_UP
} link_state_t;

typedef union {
  uint32_t u32;
  float f32;
} wire_value_t;

typedef void (*spp_completion_cb)(int status, void *opaque_user_data);

union spp_wire_value {
  uint32_t u32;
  float f32;
};

struct spp_packet_header {
  uint32_t seq;
};

#ifdef __cplusplus
extern "C" {
#endif

int spp_encode_packet(const uint8_t *src, int src_len, uint8_t *dst);

#ifdef __cplusplus
}
#endif

#endif /* SPP_WIRE_H */
`;

// The shape the fork's merge guard exists for: a guarded C API header whose
// entire content is a RUN of object-like macros and bare prototypes. Every one
// of these normalizes to 'preproc def' or 'declaration', which #4511 keeps in
// MERGEABLE_RUN_TYPES on purpose — so without the fork's preserve-all arm the
// whole header collapses into one anonymous `merged` chunk and code-def can
// find nothing in it.
const C_RUN_HEADER = `
#ifndef SPP_LIMITS_H
#define SPP_LIMITS_H

#define SPP_MAX_PACKET_SIZE 1500
#define SPP_MAX_STREAMS 64
#define SPP_DEFAULT_TTL 32
#define SPP_RETRY_LIMIT 5

int spp_encode_packet(const unsigned char *src, int src_len, unsigned char *dst);
int spp_decode_packet(const unsigned char *src, int src_len);
int spp_stream_open(int id);
int spp_stream_close(int id);
void spp_reset(void);

#endif /* SPP_LIMITS_H */
`;

// The byte-coverage shape: a header whose file-level prose (licence,
// threading contract, wire-frame table) lives OUTSIDE every semantic node.
// Pre-carry this file had zero top-level semantic nodes and fell to the text
// chunker, so all of it was indexed; the PASSTHROUGH recursion moves it onto
// the semantic path, where upstream emits nothing between nodes.
const C_PROSE_HEADER = `/*
 * Copyright (c) 2026 swxtch.io. All rights reserved.
 *
 * Threading: spp_encode_packet is re-entrant; spp_reset is NOT and must be
 * called only from the control thread while no encode is in flight.
 *
 * Wire frame layout:
 *   +--------+--------+----------------+
 *   | seq(4) | flag(1)| payload(0..N)  |
 *   +--------+--------+----------------+
 */
#ifndef SPP_WIRE_H
#define SPP_WIRE_H

#include <stdint.h>

typedef struct {
  uint32_t seq;
  uint8_t flags;
} packet_header_t;

/*
 * Retry policy (INTER-NODE prose): callers must not retry spp_encode_packet
 * on SPP_EAGAIN more than three times; the sequence window is advisory.
 */

int spp_encode_packet(const uint8_t *src, int len, uint8_t *dst);

#endif /* SPP_WIRE_H */

/* Deprecated (TRAILING prose): spp_encode_v1 was removed in wire format 3. */
`;

const CPP_SOURCE = `
#include <stdint.h>

namespace swx {
namespace pipeline {

int compute_crc32(const char *data, int len) {
  int crc = 0;
  for (int i = 0; i < len; ++i) {
    crc = (crc << 1) ^ data[i];
  }
  return crc;
}

} // namespace pipeline
} // namespace swx

// linkage_specification exists only in the C++ grammar — this block is what
// genuinely exercises the PASSTHROUGH recursion through it (the C-header
// fixture's 'extern "C"' lives inside preproc nodes under the C grammar).
extern "C" {
int spp_wire_checksum(const uint8_t *src, int len);
}

template <typename T>
T clamp_value(T v, T lo, T hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}

struct PacketHeaderView {
  uint32_t seq;
  uint8_t flags;
};
`;

/** Chunk text minus the "[C] path:N-M symbol\n\n" header buildChunk prepends. */
const CHUNK_HEADER = /^\[[^\]]+\] [^\n]+\n\n/;

async function symbolsFor(source: string, filePath: string) {
  const chunks = await chunkCodeText(source, filePath);
  const named = chunks.filter((c) => c.metadata.symbolName);
  return {
    chunks,
    named,
    names: new Set(named.map((c) => c.metadata.symbolName)),
    typeOf: (name: string) => named.find((c) => c.metadata.symbolName === name)?.metadata.symbolType,
  };
}

describe('swxtch: C header symbol extraction (header guards + extern "C")', () => {
  test('names the definitions inside header guards and linkage blocks', async () => {
    const { names } = await symbolsFor(C_HEADER, 'spp_wire.h');

    // Function-like macro (preproc_function_def).
    expect(names.has('SPP_VERSION_CODE')).toBe(true);
    // Typedef'd struct / enum / union, and a function-pointer typedef whose
    // name is only reachable through the nested declarator chain.
    expect(names.has('packet_header_t')).toBe(true);
    expect(names.has('link_state_t')).toBe(true);
    expect(names.has('wire_value_t')).toBe(true);
    expect(names.has('spp_completion_cb')).toBe(true);
    // Bare aggregates.
    expect(names.has('spp_wire_value')).toBe(true);
    expect(names.has('spp_packet_header')).toBe(true);
    // A prototype nested two wrappers deep (preproc_ifdef → linkage block).
    expect(names.has('spp_encode_packet')).toBe(true);
  });

  test('the C aggregate forms emit the two symbol types this carry adds to DEF_TYPES', async () => {
    const { typeOf } = await symbolsFor(C_HEADER, 'spp_wire.h');

    // normalizeSymbolType has no rule for either node type, so both arrive as
    // the tree-sitter node type with underscores replaced.
    expect(typeOf('packet_header_t')).toBe('type definition');
    expect(typeOf('spp_wire_value')).toBe('union specifier');

    // Both halves of why those two entries exist: code-def's lookup allowlist,
    // and the merge guard derived from it.
    for (const t of ['type definition', 'union specifier']) {
      expect(DEF_TYPES).toContain(t);
      expect(MERGE_PROTECTED_SYMBOL_TYPES.has(t)).toBe(true);
    }
  });

  test("'type definition' is the string the carry emits for a C typedef", async () => {
    // docs/GBRAIN_VERIFY.md 4d check 2 is
    //   gbrain query 'typedef' --lang c --symbol-kind 'type definition'
    // and `--symbol-kind` is an exact match on content_chunks.symbol_type
    // (search/cjk-keyword-sql.ts), so the runbook's command only finds
    // anything if the chunker emits exactly this string.
    const { typeOf } = await symbolsFor(C_HEADER, 'spp_wire.h');
    expect(typeOf('packet_header_t')).toBe('type definition');
  });

  test("a sample of other languages, incl. every type-alias one, emits no 'type definition'", async () => {
    // The other half of the runbook's claim, asserted against what the chunker
    // PRODUCES rather than against how its source is written. An earlier
    // revision read src/core/chunkers/code.ts as text and checked which
    // TOP_LEVEL_TYPES entries own `type_definition` — that made this repo's own
    // source the subject, which is not a check this crew builds.
    //
    // The name says "a sample" because that is what it is: five of ~35
    // registered languages. It cannot prove the universal the runbook states;
    // it covers the realistic ways the string could stop being C/C++-exclusive.
    //
    // Two groups, because they are not the same evidence. Round-5 review caught
    // the earlier version calling all five "type-alias constructs" when Java
    // has no type alias at all and its anchor was `class` — prose describing a
    // mechanism two of its own rows do not implement.

    // (a) ALIAS-BEARING: the alias construct reaches normalizeSymbolType as a
    //     top-level chunk, so a normalization drift toward 'type definition'
    //     shows up here. Bare `type Alias = …`, not exported — an exported one
    //     chunks as the `export statement` wrapper and never exercises the path.
    //     Anchors measured, not remembered: ts -> type, go -> type declaration,
    //     rust -> type item.
    const aliasBearing: Array<[string, string, string]> = [
      ['t.ts', 'type Alias = { a: number };\ninterface I { b: string }\nfunction g() { return 1; }\n', 'type'],
      ['t.go', 'package m\n\ntype Alias struct{ A int }\n\nfunc F() {}\n', 'type declaration'],
      ['t.rs', 'pub type Alias = u32;\npub struct S { a: u32 }\nfn f() {}\n', 'type item'],
    ];

    // (b) NO ALIAS CONSTRUCT: these languages have none, so they carry no
    //     collision risk through normalization. They are here as breadth — a
    //     grammar upgrade that introduced a `type_definition` node would show
    //     up — and their anchors are just "this file chunked at all".
    //     Measured: java -> class, c# -> namespace declaration.
    const noAlias: Array<[string, string, string]> = [
      ['t.java', 'class C { int f() { return 1; } }\n', 'class'],
      ['t.cs', 'namespace N { class C { int F() => 1; } }\n', 'namespace declaration'],
    ];

    for (const [path, source, anchor] of [...aliasBearing, ...noAlias]) {
      const chunks = await chunkCodeText(source, path);
      const types = chunks.map((c) => c.metadata.symbolType);
      // Anti-vacuity: without this, "no offenders" could hold because the file
      // produced nothing, and the case could not redden on a drift.
      expect(types, `${path} did not chunk its anchor construct (${anchor})`).toContain(anchor);
      const offenders = chunks
        .filter((c) => c.metadata.symbolType === 'type definition')
        .map((c) => `${path}:${c.metadata.symbolName}`);
      expect(offenders, `${path} also emits 'type definition'`).toEqual([]);
    }
  });

  test('every emitted C symbol_type is accepted by code-def DEF_TYPES', async () => {
    const { named } = await symbolsFor(C_HEADER, 'spp_wire.h');
    const defTypes = new Set<string>(DEF_TYPES);
    expect(named.length).toBeGreaterThanOrEqual(8);
    for (const c of named) {
      expect(
        defTypes.has(c.metadata.symbolType),
        `chunk ${c.metadata.symbolName} has symbol_type '${c.metadata.symbolType}' not in DEF_TYPES — code-def would be blind to it`,
      ).toBe(true);
    }
  });
});

describe('swxtch: C/C++ macro and prototype RUNS keep their symbol names', () => {
  test('every macro and prototype in an all-run header is individually named', async () => {
    const { chunks, names, named } = await symbolsFor(C_RUN_HEADER, 'spp_limits.h');

    for (const macro of ['SPP_MAX_PACKET_SIZE', 'SPP_MAX_STREAMS', 'SPP_DEFAULT_TTL', 'SPP_RETRY_LIMIT']) {
      expect(names.has(macro), `macro ${macro} lost its symbol name to merging`).toBe(true);
    }
    for (const fn of ['spp_encode_packet', 'spp_decode_packet', 'spp_stream_open', 'spp_stream_close', 'spp_reset']) {
      expect(names.has(fn), `prototype ${fn} lost its symbol name to merging`).toBe(true);
    }

    // The whole point: none of them ended up inside an anonymous merged blob.
    // Upstream's isDefChunk alone leaves 'preproc def' and 'declaration'
    // mergeable, which collapses this header to a single unnamed chunk.
    const anonymousMerged = chunks.filter(
      (c) => c.metadata.symbolType === 'merged' && c.metadata.symbolName == null,
    );
    expect(anonymousMerged.map((c) => c.text.split('\n')[0])).toEqual([]);
    expect(named.length).toBeGreaterThanOrEqual(9);
  });

  test('the run types are the ones upstream leaves mergeable', async () => {
    const { typeOf } = await symbolsFor(C_RUN_HEADER, 'spp_limits.h');
    // Pins WHY the fork arm is needed rather than assuming it: these are the
    // normalized types, and MERGE_PROTECTED_SYMBOL_TYPES does not carry them.
    expect(typeOf('SPP_MAX_PACKET_SIZE')).toBe('preproc def');
    expect(typeOf('spp_encode_packet')).toBe('declaration');
    expect(MERGE_PROTECTED_SYMBOL_TYPES.has('preproc def')).toBe(false);
    expect(MERGE_PROTECTED_SYMBOL_TYPES.has('declaration')).toBe(false);
  });
});

describe('swxtch: C/C++ file-level prose stays indexed', () => {
  test('licence, threading contract and frame table survive the semantic path', async () => {
    const { chunks, names } = await symbolsFor(C_PROSE_HEADER, 'spp_wire.h');
    const indexed = chunks.map((c) => c.text.replace(CHUNK_HEADER, '')).join('\n');

    // All THREE gap positions, not just the preamble — round-2 review found
    // the earlier fixture asserted only strings from the leading comment
    // block, so the inter-node and trailing arms were unexercised.
    // Preamble (before the first semantic node):
    expect(indexed).toContain('Copyright (c) 2026 swxtch.io');
    expect(indexed).toContain('Threading: spp_encode_packet is re-entrant');
    expect(indexed).toContain('payload(0..N)');
    // Inter-node (between the typedef and the prototype):
    expect(indexed).toContain('Retry policy (INTER-NODE prose)');
    // Trailing (after the last semantic node):
    expect(indexed).toContain('Deprecated (TRAILING prose)');

    // And the symbols the carry exists for are still there — the point is
    // that the two are not a trade-off.
    expect(names.has('packet_header_t')).toBe(true);
    expect(names.has('spp_encode_packet')).toBe(true);
  });

  test('gap chunks are symbol-less, so code-def can never return one', async () => {
    const { chunks } = await symbolsFor(C_PROSE_HEADER, 'spp_wire.h');
    const prose = chunks.filter((c) => c.text.includes('Copyright (c) 2026'));
    expect(prose.length).toBeGreaterThan(0);
    for (const c of prose) expect(c.metadata.symbolName).toBeNull();
  });
});

describe('swxtch: C++ symbol extraction (namespaces + templates)', () => {
  test('recurses into namespaces and templates to name the inner symbols', async () => {
    const { chunks, names } = await symbolsFor(CPP_SOURCE, 'fixture.cpp');

    expect(names.has('compute_crc32')).toBe(true); // namespace member function
    expect(names.has('clamp_value')).toBe(true); // templated function
    expect(names.has('PacketHeaderView')).toBe(true); // plain struct
    expect(names.has('spp_wire_checksum')).toBe(true); // extern "C" linkage_specification member

    // The namespace/template wrappers must NOT index as opaque unnamed chunks:
    // no chunk whose symbolType is 'namespace definition' or 'template declaration'.
    const opaque = chunks.filter((c) =>
      ['namespace definition', 'template declaration'].includes(c.metadata.symbolType),
    );
    expect(opaque).toEqual([]);
  });

  test('every emitted C++ symbol_type is accepted by code-def DEF_TYPES', async () => {
    const { named } = await symbolsFor(CPP_SOURCE, 'fixture.cpp');
    const defTypes = new Set<string>(DEF_TYPES);
    expect(named.length).toBeGreaterThanOrEqual(4);
    for (const c of named) {
      expect(
        defTypes.has(c.metadata.symbolType),
        `chunk ${c.metadata.symbolName} has symbol_type '${c.metadata.symbolType}' not in DEF_TYPES`,
      ).toBe(true);
    }
  });
});
