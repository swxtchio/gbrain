/**
 * SWX: a source whose registered root was missing (e.g. a path from another
 * host) must be repairable with `gbrain sources set-path`. The failed v0.53.0
 * shared-skills migration run persisted the missing root in its checkpoint,
 * and the "root changed since migration inventory" guard then refused the
 * repaired root on every retry, wedging the migration. The guard protects an
 * INVENTORIED checkpoint; one that never inventoried must not pin its root.
 */
import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { withEnv } from './helpers/with-env.ts';
import { runSharedSkillsMigration } from '../src/core/shared-skills/migration.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';

test('a source relinked after a missing-root failure is inventoried, not refused', async () => {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-shared-relink-'));
  await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
    const { engine, close } = await isolatedSharedSkillsEngine();
    try {
      const ctx: OperationContext = { engine, config: { engine: 'pglite' }, sourceId: 'default', remote: false, dryRun: false, logger: { info() {}, warn() {}, error() {} } };
      await engine.executeRaw("INSERT INTO sources (id, name, local_path) VALUES ('repo', 'repo', $1)", ['/Users/someone/Projects/repo']);
      const stageOf = (report: Awaited<ReturnType<typeof runSharedSkillsMigration>>) =>
        report.sources.find((source) => source.source_id === 'repo')!.stages[0]!;

      const missing = await runSharedSkillsMigration(ctx);
      expect(stageOf(missing).reason).toBe('The registered canonical root is missing.');

      const root = join(home, 'repo');
      mkdirSync(root);
      await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='repo'", [root]);

      const relinked = await runSharedSkillsMigration(ctx);
      const source = relinked.sources.find((row) => row.source_id === 'repo')!;
      expect(source.root).toBe(root);
      expect(stageOf(relinked)).toEqual({ stage: 'inventory', status: 'complete' });
      expect(source.status).not.toBe('conflict');
    } finally { await close(); rmSync(home, { recursive: true, force: true }); }
  });
}, 120_000);
