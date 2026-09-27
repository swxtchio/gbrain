import { STALL_DEFAULT_GRACE_MS } from '../core/process-watchdog.ts';

export const SERVE_MCP_REQUEST_TIMEOUT_ENV = 'GBRAIN_SERVE_MCP_REQUEST_TIMEOUT_MS';

/** Separate request deadline, derived from the supported slow MCP call durations. */
export const DEFAULT_SERVE_MCP_REQUEST_TIMEOUT_MS = 300_000;

export type RequestWatchdogSignal = 'SIGTERM' | 'SIGKILL';

export interface ServeMcpRequestWatchdogDeps {
  now?: () => number;
  setInterval?: (callback: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
  setTimeout?: (callback: () => void, ms: number) => unknown;
  unref?: (handle: unknown) => void;
  signal?: (signal: RequestWatchdogSignal) => void;
  log?: (message: string) => void;
  graceMs?: number;
}

function defaultLog(message: string): void {
  try { process.stderr.write(`${message}\n`); } catch { /* stderr may be broken */ }
}

/** Unset uses the request-specific default; zero is the explicit off switch. */
export function resolveServeMcpRequestTimeoutMs(
  raw: string | undefined,
  warn: (message: string) => void = defaultLog,
): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_SERVE_MCP_REQUEST_TIMEOUT_MS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    warn(
      `[serve-http-request-watchdog] ignoring invalid ${SERVE_MCP_REQUEST_TIMEOUT_ENV}=${JSON.stringify(raw)}; ` +
        `using ${DEFAULT_SERVE_MCP_REQUEST_TIMEOUT_MS}ms (0 disables)`,
    );
    return DEFAULT_SERVE_MCP_REQUEST_TIMEOUT_MS;
  }
  if (value === 0) return 0;
  return Math.max(1, Math.floor(value));
}

/** Start a request deadline; the caller stops it after transport and handler work settle. */
export function startServeMcpRequestWatchdog(
  timeoutMs: number,
  deps: ServeMcpRequestWatchdogDeps = {},
): () => void {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return () => {};

  const now = deps.now ?? Date.now;
  const scheduleInterval = deps.setInterval ?? ((callback, ms) => setInterval(callback, ms));
  const cancelInterval = deps.clearInterval ?? (handle => clearInterval(handle as ReturnType<typeof setInterval>));
  const scheduleTimeout = deps.setTimeout ?? ((callback, ms) => setTimeout(callback, ms));
  const unref = deps.unref ?? (handle => (handle as { unref?: () => void }).unref?.());
  const signal = deps.signal ?? (value => { process.kill(process.pid, value); });
  const log = deps.log ?? defaultLog;
  const graceMs = Number.isFinite(deps.graceMs) ? Math.max(0, Math.floor(deps.graceMs!)) : STALL_DEFAULT_GRACE_MS;
  const startedAt = now();
  const checkEveryMs = Math.min(1000, Math.max(10, Math.floor(timeoutMs / 4)));
  let stopped = false;
  let interval: unknown;

  interval = scheduleInterval(() => {
    if (stopped) return;
    const elapsedMs = now() - startedAt;
    if (elapsedMs < timeoutMs) return;

    stopped = true;
    cancelInterval(interval);
    log(`[serve-http-request-watchdog] POST /mcp operation is still unresolved after ${elapsedMs}ms (deadline ${timeoutMs}ms); sending SIGTERM`);
    const hardKill = scheduleTimeout(() => {
      log('[serve-http-request-watchdog] graceful shutdown did not finish; sending SIGKILL');
      try { signal('SIGKILL'); } catch { /* process is already exiting */ }
    }, graceMs);
    unref(hardKill);
    try { signal('SIGTERM'); } catch { /* process is already exiting */ }
  }, checkEveryMs);
  unref(interval);

  return () => {
    if (stopped) return;
    stopped = true;
    cancelInterval(interval);
  };
}
