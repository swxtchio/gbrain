import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';
import {
  DEFAULT_SERVE_MCP_REQUEST_TIMEOUT_MS,
  createServeMcpRequestWatchdogLifecycle,
  resolveServeMcpRequestTimeoutMs,
  startServeMcpRequestWatchdog,
  SERVE_MCP_REQUEST_TIMEOUT_ENV,
} from '../src/commands/serve-http-request-watchdog.ts';
import { STALL_DEFAULT_GRACE_MS } from '../src/core/process-watchdog.ts';
import { installCapabilitiesResource, CAPABILITIES_URI } from '../src/mcp/capabilities.ts';
import { ReadResourceRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';

function fakeClock() {
  let nowMs = 0;
  let tick: (() => void) | undefined;
  let hardKill: (() => void) | undefined;
  let hardKillDelay: number | undefined;
  let intervalClears = 0;
  const signals: Array<'SIGTERM' | 'SIGKILL'> = [];
  const logs: string[] = [];
  return {
    signals,
    logs,
    get intervalClears() { return intervalClears; },
    get hardKillDelay() { return hardKillDelay; },
    set now(value: number) { nowMs = value; },
    tick() { tick?.(); },
    fireHardKill() { hardKill?.(); },
    deps: {
      now: () => nowMs,
      setInterval: (callback: () => void) => { tick = callback; return 'interval'; },
      clearInterval: () => { intervalClears++; },
      setTimeout: (callback: () => void, ms: number) => { hardKill = callback; hardKillDelay = ms; return 'timeout'; },
      unref: () => {},
      signal: (signal: 'SIGTERM' | 'SIGKILL') => { signals.push(signal); },
      log: (message: string) => { logs.push(message); },
    },
  };
}

async function flushLifecycleMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('resolveServeMcpRequestTimeoutMs', () => {
  test('uses the request-specific default, accepts overrides, and treats zero as off', () => {
    expect(resolveServeMcpRequestTimeoutMs(undefined)).toBe(DEFAULT_SERVE_MCP_REQUEST_TIMEOUT_MS);
    expect(resolveServeMcpRequestTimeoutMs('120000')).toBe(120_000);
    expect(resolveServeMcpRequestTimeoutMs('0')).toBe(0);
  });

  test('invalid input warns and falls back to the safe request default', () => {
    const warnings: string[] = [];
    expect(resolveServeMcpRequestTimeoutMs('not-ms', message => warnings.push(message)))
      .toBe(DEFAULT_SERVE_MCP_REQUEST_TIMEOUT_MS);
    expect(warnings[0]).toContain(SERVE_MCP_REQUEST_TIMEOUT_ENV);
  });
});

describe('startServeMcpRequestWatchdog', () => {
  test('a mocked 120-second handler survives the default deadline and clears on server completion', async () => {
    const clock = fakeClock();
    let completeHandler!: () => void;
    const operation = new Promise<void>(resolve => { completeHandler = resolve; });
    const stop = startServeMcpRequestWatchdog(DEFAULT_SERVE_MCP_REQUEST_TIMEOUT_MS, clock.deps);
    const trackedOperation = operation.finally(stop);

    clock.now = 120_000;
    clock.tick();
    expect(clock.signals).toEqual([]);

    completeHandler();
    await trackedOperation;
    expect(clock.intervalClears).toBe(1);
    clock.now = DEFAULT_SERVE_MCP_REQUEST_TIMEOUT_MS + 1000;
    clock.tick();
    expect(clock.signals).toEqual([]);
  });

  test('a silent handler sends SIGTERM at its deadline and arms the grace-period SIGKILL', () => {
    const clock = fakeClock();
    startServeMcpRequestWatchdog(1000, { ...clock.deps, graceMs: STALL_DEFAULT_GRACE_MS });

    clock.now = 999;
    clock.tick();
    expect(clock.signals).toEqual([]);

    clock.now = 1000;
    clock.tick();
    expect(clock.signals).toEqual(['SIGTERM']);
    expect(clock.hardKillDelay).toBe(STALL_DEFAULT_GRACE_MS);
    expect(clock.logs[0]).toContain('POST /mcp operation is still unresolved');

    clock.fireHardKill();
    expect(clock.signals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  test('capability resource reads stay tracked until their server handler resolves', async () => {
    const handlers: Array<{ schema: unknown; handler: (request: never) => Promise<unknown> }> = [];
    const fakeServer = {
      setRequestHandler: (schema: unknown, handler: unknown) => {
        handlers.push({ schema, handler: handler as (request: never) => Promise<unknown> });
      },
    };
    let finishDescription!: () => void;
    const description = new Promise<void>(resolve => { finishDescription = resolve; });
    let activeOperations = 0;
    installCapabilitiesResource(
      fakeServer as unknown as Server,
      async () => { await description; return {}; },
      undefined,
      async operation => {
        activeOperations += 1;
        try { return await operation(); }
        finally { activeOperations -= 1; }
      },
    );

    const registration = handlers.find(item => item.schema === ReadResourceRequestSchema);
    const readResource = registration?.handler;
    if (!readResource) throw new Error('ReadResourceRequestSchema handler was not installed');
    const operation = readResource({ params: { uri: CAPABILITIES_URI } } as never);
    expect(activeOperations).toBe(1);
    finishDescription();
    await operation;
    expect(activeOperations).toBe(0);
  });

  test('zero disables the request watchdog without scheduling timers', () => {
    const clock = fakeClock();
    const stop = startServeMcpRequestWatchdog(0, clock.deps);
    stop();
    clock.now = 1000;
    clock.tick();
    expect(clock.intervalClears).toBe(0);
    expect(clock.signals).toEqual([]);
  });
});

describe('createServeMcpRequestWatchdogLifecycle', () => {
  test('a normally completed POST disarms its deadline through the lifecycle factory', async () => {
    const clock = fakeClock();
    const lifecycle = createServeMcpRequestWatchdogLifecycle(1000, clock.deps);
    const request = {} as Request;
    const response = new EventEmitter() as unknown as Response;

    lifecycle.requestWatchdog(request, response, () => {});
    const post = lifecycle.trackTransport(async (_req, res) => {
      await lifecycle.trackServerOperation(res, async () => {});
    });
    post(request, response, () => {});
    await flushLifecycleMicrotasks();
    response.emit('finish');

    clock.now = 2000;
    clock.tick();
    expect(clock.signals).toEqual([]);
    expect(clock.intervalClears).toBe(1);
  });

  test('an auth-rejected POST disarms its deadline through the lifecycle factory', async () => {
    const clock = fakeClock();
    const lifecycle = createServeMcpRequestWatchdogLifecycle(1000, clock.deps);
    const request = {} as Request;
    const response = new EventEmitter() as unknown as Response;
    let forwardedError: unknown;

    lifecycle.requestWatchdog(request, response, () => {});
    const authorization = lifecycle.trackAuthorization((_req, _res, next) => {
      next(new Error('unauthorized'));
    });
    authorization(request, response, error => { forwardedError = error; });
    await flushLifecycleMicrotasks();

    expect(forwardedError).toBeInstanceOf(Error);
    clock.now = 2000;
    clock.tick();
    expect(clock.signals).toEqual([]);
    expect(clock.intervalClears).toBe(1);
  });
});
