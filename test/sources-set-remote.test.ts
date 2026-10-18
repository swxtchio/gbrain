/**
 * Protects the existing-source remote repair through runSources and persisted rows.
 * Regressions: missing dispatch, unchecked URL, detached config replacement, early
 * success, or checkout ownership escalation. Existing set-path/pull-strategy tests
 * never invoke set-remote. Uses real config writers and pull policy, with spies
 * only for failure injection and deterministic interleaving; no production seam.
 */
import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as spawn from '../src/core/spawn.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runSources } from '../src/commands/sources.ts';
import { automaticSyncPull } from '../src/core/persistence/automatic-sync-policy.ts';
import { isOwnedClone } from '../src/core/sources-ops.ts';
import { withEnv } from './helpers/with-env.ts';

const FIRST = 'https://example.com/acme-example/brain.git';
const NEXT = 'https://example.com/acme-example/rotated.git';
let engine: PGLiteEngine;
let scratch: string;
beforeAll(async () => {
  scratch = mkdtempSync(join(import.meta.dir, '.set-remote-'));
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);
afterAll(async () => { await engine.disconnect(); rmSync(scratch, { recursive: true, force: true }); });

async function cli(args: string[], events: string[] = []): Promise<{ out: string; err: string; exit: number | null }> {
  const out: string[] = [], err: string[] = [];
  let exit: number | null = null;
  const stopped = new Error('CLI exited');
  const exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => { exit = code ?? 0; throw stopped; }) as never);
  const logSpy = spyOn(console, 'log').mockImplementation((...parts: unknown[]) => { const line = parts.map(String).join(' '); out.push(line); events.push(line); });
  const errSpy = spyOn(console, 'error').mockImplementation((...parts: unknown[]) => { err.push(parts.map(String).join(' ')); });
  try { await runSources(engine, args); } catch (error) { if (error !== stopped) throw error; }
  finally { exitSpy.mockRestore(); logSpy.mockRestore(); errSpy.mockRestore(); }
  return { out: out.join('\n'), err: err.join('\n'), exit };
}
async function seed(config: unknown = {}, path: string | null = null) {
  const id = `remote-${randomUUID().slice(0, 8)}`;
  await engine.executeRaw('INSERT INTO sources(id,name,local_path,config,last_commit,last_sync_at) VALUES($1,$1,$2,$3::text::jsonb,$4,$5)',
    [id, path, JSON.stringify(config), 'kept-sync-commit', '2026-10-01T00:00:00Z']);
  return id;
}
async function row(id: string) {
  return (await engine.executeRaw<{ id: string; local_path: string | null; config: Record<string, unknown>; config_type: string }>(
    'SELECT *, jsonb_typeof(config) AS config_type FROM sources WHERE id=$1', [id]))[0]!;
}

test('help advertises set-remote and missing operands refuse without writes', async () => {
  expect((await cli(['--help'])).out).toContain('set-remote <id> <url>');
  const id = await seed();
  const before = await row(id);
  for (const args of [[], [id], [id, FIRST, 'extra']]) {
    const result = await cli(['set-remote', ...args]);
    expect(result.exit).toBe(2);
    expect(result.err).toContain('set-remote <id> <url>');
    expect(await row(id)).toEqual(before);
  }
  expect((await cli(['set-remote', id, NEXT, '--help'])).out).toContain('set-remote <id> <url>');
  expect(await row(id)).toEqual(before);
});

test('assignment and rotation preserve source data, config, other sources and checkout; saved row enables eligible pulls', async () => {
  const checkout = join(scratch, 'checkout');
  execFileSync('git', ['init', checkout]);
  execFileSync('git', ['-C', checkout, 'remote', 'add', 'origin', 'https://example.com/original.git']);
  writeFileSync(join(checkout, 'kept.md'), 'dirty checkout content\n');
  const id = `remote-${randomUUID().slice(0, 8)}`;
  expect((await cli(['add', id, '--path', checkout, '--force'])).exit).toBeNull();
  await engine.updateSourceConfig(id, { federated: true, last_full_cycle_at: '2026-10-01T00:00:00Z', strategy: 'code' });
  await engine.executeRaw('UPDATE sources SET last_commit=$1, last_sync_at=$2 WHERE id=$3', ['kept-sync-commit', '2026-10-01T00:00:00Z', id]);
  const other = await seed({ remote_url: FIRST, managed_clone: true });
  await engine.putPage('notes/kept', { type: 'note', title: 'Kept', compiled_truth: 'Existing source data' }, { sourceId: id });
  const page = await engine.getPage('notes/kept', { sourceId: id });
  const before = await row(id), otherBefore = await row(other);
  const gitConfig = readFileSync(join(checkout, '.git/config'), 'utf8');
  await engine.executeRaw('UPDATE persistence_brain SET enabled = false');
  expect(await automaticSyncPull(engine, before)).toBe(false);

  const gitSpy = spyOn(spawn, 'execFileSync');
  try {
    for (const url of [FIRST, NEXT]) {
      expect((await cli(['set-remote', id, url])).exit).toBeNull();
      const saved = await row(id);
      expect(saved).toEqual({ ...before, config: { ...before.config, remote_url: url } });
      expect(saved.config_type).toBe('object');
      expect(isOwnedClone(saved)).toBe(false);
      expect(await automaticSyncPull(engine, saved)).toBe(true);
      expect(await engine.getPage('notes/kept', { sourceId: id })).toEqual(page);
      expect(await row(other)).toEqual(otherBefore);
      expect(readFileSync(join(checkout, '.git/config'), 'utf8')).toBe(gitConfig);
      expect(readFileSync(join(checkout, 'kept.md'), 'utf8')).toBe('dirty checkout content\n');
    }
    expect(gitSpy).not.toHaveBeenCalled();
  } finally { gitSpy.mockRestore(); }
  const saved = await row(id);
  await engine.setConfig('autopilot.git_pull', 'false');
  expect(await automaticSyncPull(engine, saved)).toBe(false);
  await engine.setConfig('autopilot.git_pull', 'true');
  await engine.executeRaw('UPDATE persistence_brain SET enabled = true');
  expect(await automaticSyncPull(engine, saved)).toBe(false);
  await engine.executeRaw('UPDATE persistence_brain SET enabled = false');
});

for (const [label, config, kept] of [
  ['nested string', JSON.stringify(JSON.stringify({ federated: true })), { federated: true }],
  ['array fragments', [JSON.stringify({ federated: true }), { strategy: 'code' }, 'invalid'], { federated: true, strategy: 'code' }],
  ['unrecoverable scalar', 'garbage', {}],
] as const) {
  test(`normalizes ${label} through the shared writer`, async () => {
    const id = await seed(config);
    expect((await cli(['set-remote', id, FIRST])).exit).toBeNull();
    expect((await row(id)).config_type).toBe('object');
    expect((await row(id)).config).toEqual({ ...kept, remote_url: FIRST });
  });
}

test('URL policy rejects unsafe input and missing sources visibly without changing state', async () => {
  const id = await seed({ remote_url: FIRST, federated: true });
  const before = await row(id);
  await withEnv({ GBRAIN_ALLOW_PRIVATE_REMOTES: undefined }, async () => {
    for (const url of ['garbage', 'ssh://example.com/repo', 'https://user:pass@example.com/repo', 'https://example.com/../repo', 'https://127.0.0.1/repo']) {
      const result = await cli(['set-remote', id, url]);
      expect(result.exit).toBe(2);
      expect(result.err.length).toBeGreaterThan(0);
      expect(await row(id)).toEqual(before);
    }
    const result = await cli(['set-remote', 'missing-source', FIRST]);
    expect(result.exit).toBe(4);
    expect(result.err).toContain('sources list');
    expect(await row('missing-source')).toBeUndefined();
    expect(await row(id)).toEqual(before);
    await withEnv({ GBRAIN_ALLOW_PRIVATE_REMOTES: '1' }, async () => {
      const privateUrl = 'https://127.0.0.1/repo';
      expect((await cli(['set-remote', id, privateUrl])).exit).toBeNull();
      expect((await row(id)).config.remote_url).toBe(privateUrl);
    });
  });
});

for (const prior of [undefined, FIRST]) {
  test(`reports previous remote (${prior ?? 'unset'}) before the write and success after it`, async () => {
    const id = await seed(prior ? { remote_url: prior } : {});
    const events: string[] = [];
    const original = engine.updateSourceConfig.bind(engine);
    const updateSpy = spyOn(engine, 'updateSourceConfig').mockImplementation(async (...args) => {
      events.push('WRITE');
      return original(...args);
    });
    try { expect((await cli(['set-remote', id, NEXT], events)).exit).toBeNull(); }
    finally { updateSpy.mockRestore(); }
    const writeIndex = events.indexOf('WRITE');
    expect(writeIndex).toBeGreaterThan(0);
    expect(events.slice(0, writeIndex).join('\n')).toContain(prior ?? '(unset)');
    expect(events.slice(writeIndex + 1).join('\n')).toContain(NEXT);
    expect((await row(id)).config.remote_url).toBe(NEXT);
  });
}

for (const outcome of ['zero rows', 'storage error'] as const) {
  test(`does not announce success on ${outcome}`, async () => {
    const id = await seed({ remote_url: FIRST });
    const before = await row(id);
    const updateSpy = spyOn(engine, 'updateSourceConfig').mockImplementation(async () => {
      if (outcome === 'storage error') throw new Error('injected storage failure');
      return false;
    });
    try {
      if (outcome === 'storage error') {
        const messages: string[] = [];
        await expect(cli(['set-remote', id, NEXT], messages)).rejects.toThrow('injected storage failure');
        expect(messages.join('\n')).not.toContain(NEXT);
      }
      else {
        const result = await cli(['set-remote', id, NEXT]);
        expect(result.exit).toBe(4);
        expect(result.out).not.toContain(NEXT);
      }
      expect(await row(id)).toEqual(before);
    } finally { updateSpy.mockRestore(); }
  });
}

test('patches only remote_url so a concurrent writer key survives the detached prior-value read', async () => {
  const id = await seed({ federated: true, last_full_cycle_at: 'old-cycle' });
  const original = engine.updateSourceConfig.bind(engine);
  const updateSpy = spyOn(engine, 'updateSourceConfig').mockImplementation(async (sourceId, patch) => {
    await original(sourceId, { last_full_cycle_at: 'concurrent-cycle' });
    return original(sourceId, patch);
  });
  try { expect((await cli(['set-remote', id, FIRST])).exit).toBeNull(); }
  finally { updateSpy.mockRestore(); }
  expect((await row(id)).config).toEqual({ federated: true, last_full_cycle_at: 'concurrent-cycle', remote_url: FIRST });
});
