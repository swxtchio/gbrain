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
 * NOT pinned here, deliberately: the fork's own C/C++-wide merge guard was
 * retired in favour of upstream's `MERGE_PROTECTED_SYMBOL_TYPES` (#4511,
 * c860a411), whose `MERGEABLE_RUN_TYPES` keeps `declaration` and
 * `preproc def` mergeable on purpose — so a RUN of adjacent bare prototypes
 * or object-like `#define`s still folds into one anonymous chunk. That is an
 * upstream design decision post-dating the fork patch; an isolated prototype
 * or macro between protected definitions keeps its name either way.
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
