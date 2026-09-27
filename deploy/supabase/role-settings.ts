/**
 * SWX: verify (default) or apply (--apply) the role-level session limits in
 * role-settings.sql against the brain database (swxtchio/gbrain#14).
 *
 *   bun deploy/supabase/role-settings.ts           # exit 1 if any setting is missing
 *   bun deploy/supabase/role-settings.ts --apply   # run role-settings.sql, then verify
 *
 * Connects with GBRAIN_DIRECT_DATABASE_URL (the :5432 session pooler), which
 * ~/.gbrain/http.env provides.
 */
import postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const SQL_FILE = join(import.meta.dir, 'role-settings.sql');

/** The `<guc>=<value>` pairs role-settings.sql sets, parsed from its ALTER ROLE lines. */
export function expectedSettings(sqlText: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of sqlText.matchAll(/^ALTER ROLE (\w+) SET (\w+) = '([^']+)';$/gm)) out[m[2]!] = m[3]!;
  return out;
}

/** Settings from `expected` that are missing or different in the role's setconfig array. */
export function missingSettings(expected: Record<string, string>, setconfig: string[] | null): string[] {
  const have = new Map((setconfig ?? []).map((kv) => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)]));
  return Object.entries(expected).filter(([k, v]) => have.get(k) !== v).map(([k, v]) => `${k}=${v}`);
}

if (import.meta.main) {
  const url = process.env.GBRAIN_DIRECT_DATABASE_URL;
  if (!url) {
    console.error('GBRAIN_DIRECT_DATABASE_URL is not set (source ~/.gbrain/http.env).');
    process.exit(2);
  }
  const sqlText = readFileSync(SQL_FILE, 'utf8');
  const expected = expectedSettings(sqlText);
  const sql = postgres(url, { max: 1, prepare: false, idle_timeout: 5, onnotice: () => {} });
  try {
    if (process.argv.includes('--apply')) {
      for (const stmt of sqlText.split('\n').filter((l) => l.startsWith('ALTER ROLE '))) await sql.unsafe(stmt);
      console.log('applied role-settings.sql');
    }
    const [row] = await sql`SELECT s.setconfig FROM pg_db_role_setting s JOIN pg_roles r ON r.oid = s.setrole
      WHERE r.rolname = 'postgres' AND s.setdatabase = 0`;
    const missing = missingSettings(expected, row?.setconfig ?? null);
    if (missing.length) {
      console.log(`MISSING on role postgres: ${missing.join(', ')} (run with --apply)`);
      process.exitCode = 1;
    } else {
      console.log(`ok: role postgres has ${Object.entries(expected).map(([k, v]) => `${k}=${v}`).join(', ')}`);
    }
  } finally {
    await sql.end();
  }
}
