/**
 * SWX port — C/C++ symbol extraction (re-port of the 88a02775 chunker item).
 *
 * Upstream's chunker only surfaces bare top-level C `function_definition` /
 * `struct_specifier` / `declaration` nodes, and never names them (no
 * declarator-chain dive). Real-world C/C++ — header guards, extern "C"
 * blocks, namespaces, templates, typedefs, macros, prototypes — fell back to
 * text chunks or symbol-less opaque wrappers, and code-def went blind.
 *
 * These tests pin the carried behavior:
 *   1. collectSemanticNodes recurses through preproc_ifdef / linkage_specification
 *      / namespace_definition / template_declaration (PASSTHROUGH_TYPES).
 *   2. typedefs (type_definition), enum/union specifiers, and object- and
 *      function-like macros (preproc_def / preproc_function_def) are top-level
 *      semantic nodes for C and C++.
 *   3. extractSymbolName walks the declarator field chain (function_declarator,
 *      pointer_declarator, parenthesized_declarator) so definitions, prototypes,
 *      and function-pointer typedefs get symbol names.
 *   4. mergeSmallSiblings never absorbs a symbol-bearing C/C++ chunk (tiny
 *      prototypes/macros/typedefs keep their symbol metadata for code-def).
 *   5. Every symbol_type emitted for C/C++ is in code-def's DEF_TYPES — the
 *      chunker→code-def contract (the code-def half of the carry).
 */

import { describe, test, expect } from 'bun:test';
import { chunkCodeText } from '../../src/core/chunkers/code.ts';
import { DEF_TYPES } from '../../src/commands/code-def.ts';

const C_HEADER = `
#ifndef SPP_WIRE_H
#define SPP_WIRE_H

#include <stdint.h>

#define SPP_MAX_PACKET_SIZE 1500
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

#ifdef __cplusplus
extern "C" {
#endif

int spp_encode_packet(const uint8_t *src, int src_len, uint8_t *dst);
int spp_decode_packet(const uint8_t *src, int src_len);

#ifdef __cplusplus
}
#endif

#endif /* SPP_WIRE_H */
`;

const CPP_SOURCE = `
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
  return { chunks, names: new Set(chunks.map((c) => c.metadata.symbolName).filter(Boolean)) };
}

describe('SWX: C header symbol extraction (header guards + extern "C")', () => {
  test('surfaces macros, typedefs, and prototypes as named symbol chunks', async () => {
    const { chunks, names } = await symbolsFor(C_HEADER, 'spp_wire.h');

    // Object-like and function-like macros.
    expect(names.has('SPP_MAX_PACKET_SIZE')).toBe(true);
    expect(names.has('SPP_VERSION_CODE')).toBe(true);
    // Typedef'd struct / enum / union and a function-pointer typedef.
    expect(names.has('packet_header_t')).toBe(true);
    expect(names.has('link_state_t')).toBe(true);
    expect(names.has('wire_value_t')).toBe(true);
    expect(names.has('spp_completion_cb')).toBe(true);
    // Prototypes wrapped in preproc_ifdef + extern "C" linkage blocks.
    expect(names.has('spp_encode_packet')).toBe(true);
    expect(names.has('spp_decode_packet')).toBe(true);

    // Symbols must survive small-sibling merging: each named symbol above is
    // its own chunk (not a "merged (N siblings)" blob with symbolName null).
    const mergedBlob = chunks.find((c) => /merged \(\d+ siblings\)/.test(c.text));
    if (mergedBlob) {
      expect(mergedBlob.metadata.symbolName).toBeNull();
      for (const s of ['spp_encode_packet', 'packet_header_t', 'SPP_MAX_PACKET_SIZE']) {
        expect(mergedBlob.text).not.toContain(s);
      }
    }
  });

  test('every emitted C symbol_type is accepted by code-def DEF_TYPES', async () => {
    const { chunks } = await symbolsFor(C_HEADER, 'spp_wire.h');
    const defTypes = new Set<string>(DEF_TYPES);
    const named = chunks.filter((c) => c.metadata.symbolName);
    expect(named.length).toBeGreaterThanOrEqual(7);
    for (const c of named) {
      expect(
        defTypes.has(c.metadata.symbolType),
        `chunk ${c.metadata.symbolName} has symbol_type '${c.metadata.symbolType}' not in DEF_TYPES — code-def would be blind to it`,
      ).toBe(true);
    }
  });
});

describe('SWX: C++ symbol extraction (namespaces + templates)', () => {
  test('recurses into namespaces and templates to name the inner symbols', async () => {
    const { chunks, names } = await symbolsFor(CPP_SOURCE, 'fixture.cpp');

    expect(names.has('compute_crc32')).toBe(true); // namespace member function
    expect(names.has('clamp_value')).toBe(true); // templated function
    expect(names.has('PacketHeaderView')).toBe(true); // plain struct

    // The namespace/template wrappers must NOT index as opaque unnamed chunks:
    // no chunk whose symbolType is 'namespace definition' or 'template declaration'.
    const opaque = chunks.filter((c) =>
      ['namespace definition', 'template declaration'].includes(c.metadata.symbolType),
    );
    expect(opaque).toEqual([]);
  });

  test('every emitted C++ symbol_type is accepted by code-def DEF_TYPES', async () => {
    const { chunks } = await symbolsFor(CPP_SOURCE, 'fixture.cpp');
    const defTypes = new Set<string>(DEF_TYPES);
    const named = chunks.filter((c) => c.metadata.symbolName);
    expect(named.length).toBeGreaterThanOrEqual(3);
    for (const c of named) {
      expect(
        defTypes.has(c.metadata.symbolType),
        `chunk ${c.metadata.symbolName} has symbol_type '${c.metadata.symbolType}' not in DEF_TYPES`,
      ).toBe(true);
    }
  });
});
