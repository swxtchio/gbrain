import type { BrainEngine } from '../core/engine.ts';
import { parseRemoteUrl, RemoteUrlError } from '../core/git-remote.ts';
import { parseSourceConfig } from '../core/sources-load.ts';

export async function runSetRemote(engine: BrainEngine, args: string[]): Promise<void> {
  const [id, url, extra] = args;
  if (!id || id.startsWith('-') || !url || extra !== undefined) {
    console.error('Usage: gbrain sources set-remote <id> <url>');
    console.error('  Set or rotate an existing source remote URL (https://); updates config only.');
    process.exit(2);
  }
  try {
    parseRemoteUrl(url);
  } catch (error) {
    if (!(error instanceof RemoteUrlError)) throw error;
    console.error(`Error (${error.code}): ${error.message}`);
    process.exit(2);
  }

  const [source] = await engine.executeRaw<{ config: unknown }>(
    'SELECT config FROM sources WHERE id = $1', [id],
  );
  if (!source) {
    console.error(`Source "${id}" not found. List sources with: gbrain sources list`);
    process.exit(4);
  }
  const prior = parseSourceConfig(source.config).remote_url;
  console.log(`Source "${id}" previous remote_url: ${typeof prior === 'string' && prior.length > 0 ? prior : '(unset)'}`);
  if (!await engine.updateSourceConfig(id, { remote_url: url })) {
    console.error(`Source "${id}" was not updated. List sources with: gbrain sources list`);
    process.exit(4);
  }
  console.log(`Source "${id}" remote_url set to ${url}.`);
}
