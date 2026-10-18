import { accessSync, constants, statSync } from 'node:fs';
import type { BrainEngine } from '../../../core/engine.ts';
import type { Check } from '../../doctor.ts';

interface SourcePathRow {
  id: string;
  local_path: string | null;
}

interface SourcePathFailure {
  id: string;
  path: string;
  reason: string;
}

function pathFailureReason(error: unknown): string {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as NodeJS.ErrnoException).code)
    : '';
  if (code === 'ENOENT') return 'directory does not exist on this host';
  if (code === 'ENOTDIR') return 'path or one of its parent components is not a directory';
  if (code === 'EACCES' || code === 'EPERM') return 'directory is not readable and traversable by the doctor process';
  return `directory cannot be accessed on this host${code ? ` (${code})` : ''}`;
}

export async function sourceLocalPathCheck(engine: BrainEngine): Promise<Check> {
  let sources: SourcePathRow[];
  try {
    sources = await engine.executeRaw<SourcePathRow>(
      `SELECT id, local_path FROM sources WHERE archived = false ORDER BY id`,
    );
  } catch {
    return {
      name: 'source_local_path_resolvable',
      status: 'warn',
      message: 'Could not read active sources to verify their local_path directories; rerun doctor after the sources table is available.',
    };
  }

  const configured = sources.filter((source) => source.local_path !== null);
  const failures: SourcePathFailure[] = [];
  for (const source of configured) {
    const path = source.local_path!;
    try {
      if (!statSync(path).isDirectory()) {
        failures.push({ id: source.id, path, reason: 'path is not a directory' });
        continue;
      }
      accessSync(path, constants.R_OK | constants.X_OK);
    } catch (error) {
      failures.push({ id: source.id, path, reason: pathFailureReason(error) });
    }
  }

  if (failures.length > 0) {
    return {
      name: 'source_local_path_resolvable',
      status: 'fail',
      message:
        `${failures.length} active source local_path value(s) are unusable on this host:\n` +
        failures.map(({ id, path, reason }) =>
          `- ${id} (${path}): ${reason}; use \`gbrain sources set-path ${id} <path>\` to select a readable directory.`,
        ).join('\n'),
    };
  }

  return {
    name: 'source_local_path_resolvable',
    status: 'ok',
    message: configured.length === 0
      ? 'No active source has an explicit local_path; no source-directory repair is needed.'
      : `All ${configured.length} active source local_path value(s) are readable directories.`,
  };
}
