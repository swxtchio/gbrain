import { STALL_DEFAULT_GRACE_MS } from '../core/process-watchdog.ts';
import type { Express, NextFunction, Request, RequestHandler, Response } from 'express';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { withBearerScopeHint } from './serve-http-oauth.ts';

export const SERVE_MCP_REQUEST_TIMEOUT_ENV = 'GBRAIN_SERVE_MCP_REQUEST_TIMEOUT_MS';

/** Separate request deadline, derived from the supported slow MCP call durations. */
export const DEFAULT_SERVE_MCP_REQUEST_TIMEOUT_MS = 300_000;

export type RequestWatchdogSignal = 'SIGTERM' | 'SIGKILL';

type McpRequestWatchdogState = {
  serverHandlerStarted: boolean;
  transportCompleted: boolean;
  activeServerOperations: number;
  stop: () => void;
};

export interface ServeMcpRequestWatchdogLifecycle {
  requestWatchdog: RequestHandler;
  trackAuthorization(handler: RequestHandler): RequestHandler;
  trackTransport(handler: (req: Request, res: Response) => Promise<void>): RequestHandler;
  trackServerOperation<T>(res: Response, operation: () => Promise<T>): Promise<T>;
}

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

/** Owns per-response watchdog state and its Express request/operation lifecycle. */
export function createServeMcpRequestWatchdogLifecycle(
  timeoutMs: number,
): ServeMcpRequestWatchdogLifecycle {
  const requests = new WeakMap<Response, McpRequestWatchdogState>();
  const stopIfSettled = (state: McpRequestWatchdogState): void => {
    if (state.transportCompleted && state.activeServerOperations === 0) state.stop();
  };

  const requestWatchdog: RequestHandler = (_req, res, next) => {
    if (timeoutMs > 0) {
      const state: McpRequestWatchdogState = {
        serverHandlerStarted: false,
        transportCompleted: false,
        activeServerOperations: 0,
        stop: startServeMcpRequestWatchdog(timeoutMs),
      };
      requests.set(res, state);
      // Auth failures finish before the operation handler starts. A socket
      // close alone is deliberately NOT completion: server work may continue.
      res.once('finish', () => { if (!state.serverHandlerStarted) state.stop(); });
    }
    next();
  };

  const trackAuthorization = (handler: RequestHandler): RequestHandler => (req, res, next) => {
    const state = requests.get(res);
    if (!state) return handler(req, res, next);

    state.activeServerOperations += 1;
    let authorized = false;
    const authNext: NextFunction = error => {
      if (!error) authorized = true;
      next(error);
    };
    void Promise.resolve(handler(req, res, authNext)).then(
      () => {
        state.activeServerOperations -= 1;
        if (!authorized) state.transportCompleted = true;
        stopIfSettled(state);
      },
      error => {
        state.activeServerOperations -= 1;
        state.transportCompleted = true;
        stopIfSettled(state);
        next(error);
      },
    );
  };

  const trackTransport = (
    handler: (req: Request, res: Response) => Promise<void>,
  ): RequestHandler => (req, res, next) => {
    const state = requests.get(res);
    if (state) state.serverHandlerStarted = true;
    const completeTransport = (): void => {
      if (!state) return;
      state.transportCompleted = true;
      stopIfSettled(state);
    };
    void handler(req, res).then(
      completeTransport,
      error => {
        completeTransport();
        next(error);
      },
    );
  };

  const trackServerOperation = async <T>(res: Response, operation: () => Promise<T>): Promise<T> => {
    const state = requests.get(res);
    if (!state) return operation();
    state.activeServerOperations += 1;
    try {
      return await operation();
    } finally {
      state.activeServerOperations -= 1;
      stopIfSettled(state);
    }
  };

  return { requestWatchdog, trackAuthorization, trackTransport, trackServerOperation };
}

/** Mount stateless MCP HTTP routes and return their per-request lifecycle tracker. */
export function mountServeMcpRequestRoutes(
  app: Express,
  timeoutMs: number,
  authOptions: Parameters<typeof requireBearerAuth>[0],
  handlePost: (req: Request, res: Response) => Promise<void>,
): ServeMcpRequestWatchdogLifecycle {
  // Stateless Streamable HTTP has no GET backchannel, so return the protocol
  // response that lets clients recognize this as an MCP endpoint.
  app.get('/mcp', (_req: Request, res: Response) => {
    res.set('Allow', 'POST, DELETE');
    res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null });
  });

  const lifecycle = createServeMcpRequestWatchdogLifecycle(timeoutMs);
  const authorization = withBearerScopeHint(requireBearerAuth(authOptions), ['read']);
  app.post(
    '/mcp',
    lifecycle.requestWatchdog,
    lifecycle.trackAuthorization(authorization),
    lifecycle.trackTransport(handlePost),
  );
  return lifecycle;
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
