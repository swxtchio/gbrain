/**
 * Strict argument check for the `gbrain jobs` subcommands that mutate the
 * queue (#6).
 *
 * cli.ts's pre-dispatch validator checks `jobs` against ONE flag set: the
 * union of every flag in jobs.ts and its imports. A flag that is legal for
 * some other subcommand therefore passes for prune — `jobs prune --days 7`
 * ran the 30-day default because parseFlag never looks at `--days`. Each
 * spec below mirrors exactly what its case block in runJobs consumes, so any
 * token left over is refused before the subcommand runs.
 */

interface SubcommandArgSpec {
  /** Positional tokens after the subcommand name (e.g. the job id). */
  positionals: number;
  /** Flags read with parseFlag: the NEXT token is the value. */
  valueFlags: readonly string[];
  /** Flags read with hasFlag. */
  booleanFlags: readonly string[];
  /** One-line usage printed with the refusal. */
  usage: string;
}

const STRICT_JOBS_SUBCOMMANDS: Record<string, SubcommandArgSpec> = {
  prune: {
    positionals: 0, valueFlags: ['--older-than'], booleanFlags: ['--dry-run'],
    usage: 'gbrain jobs prune [--older-than 30d] [--dry-run]',
  },
  delete: { positionals: 1, valueFlags: [], booleanFlags: [], usage: 'gbrain jobs delete <id>' },
  cancel: { positionals: 1, valueFlags: [], booleanFlags: [], usage: 'gbrain jobs cancel <id>' },
  retry: { positionals: 1, valueFlags: [], booleanFlags: [], usage: 'gbrain jobs retry <id>' },
};

/**
 * Returns the refusal (a message naming the first argument the subcommand
 * would not consume, plus its usage line), or null when every token is
 * accounted for (or the subcommand has no strict spec). `args` is the full
 * jobs argv: args[0] is the subcommand name. A `--name=v` token is
 * unconsumed because parseFlag only reads the space-separated form; a value
 * flag with no value is refused because parseFlag would return undefined and
 * the default would run; a repeated value flag is refused because parseFlag
 * reads only its first occurrence.
 */
export function findUnconsumedJobsArg(
  args: readonly string[],
): { message: string; usage: string } | null {
  const sub = args[0];
  if (sub === undefined || !Object.hasOwn(STRICT_JOBS_SUBCOMMANDS, sub)) return null;
  const spec: SubcommandArgSpec = sub === 'cancel' && args.includes('--select')
    ? { positionals: 0, valueFlags: ['--select', '--expect'], booleanFlags: ['--yes', '--dry-run', '--json'], usage: 'gbrain jobs cancel --select <filter> [--expect <hash> --yes] [--dry-run] [--json]' }
    : sub === 'cancel' && args.includes('--group')
      ? { positionals: 0, valueFlags: ['--group'], booleanFlags: [], usage: 'gbrain jobs cancel --group <id>' }
      : STRICT_JOBS_SUBCOMMANDS[sub];
  const refuse = (message: string) => ({ message, usage: spec.usage });
  const seenValueFlags = new Set<string>();
  let positionals = 0;
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (spec.valueFlags.includes(a)) {
      // parseFlag reads only the first occurrence, so a repeat (and whatever
      // token it would swallow as its value) would be silently ignored.
      if (seenValueFlags.has(a)) return refuse(`${a} given more than once`);
      seenValueFlags.add(a);
      if (i + 1 >= args.length) return refuse(`${a} requires a value`);
      i++; // parseFlag consumes the next token as the value
      continue;
    }
    if (spec.booleanFlags.includes(a)) continue;
    if (a.startsWith('-')) return refuse(`unknown flag ${a}`);
    if (positionals < spec.positionals) {
      positionals++;
      continue;
    }
    return refuse(`unexpected argument ${a}`);
  }
  return null;
}
