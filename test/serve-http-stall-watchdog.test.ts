/**
 * #4281 — watchdog wiring in the `gbrain serve --http` branch.
 *
 * Pins the arm/dispose ordering around runServeHttp WITHOUT booting the real
 * OAuth server or a real watchdog worker: everything routes through the
 * injectable ServeOptions seams (runServeHttp / installStallWatchdog /
 * stallWatchdogMs), the same pattern as the stdio lifecycle tests.
 *
 * Worker starvation and pending-request termination are covered by
 * test/process-watchdog.serial.test.ts (spawned processes); state math is in
 * test/process-watchdog.test.ts.
 */
import { describe, test, expect } from 'bun:test';
import { runServe, type ServeOptions } from '../src/commands/serve.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { STALL_DEFAULT_GRACE_MS, type LoopStallWatchdogOpts } from '../src/core/process-watchdog.ts';
import { DEFAULT_SERVE_MCP_REQUEST_TIMEOUT_MS, SERVE_MCP_REQUEST_TIMEOUT_ENV } from '../src/commands/serve-http-request-watchdog.ts';
import { withEnv } from './helpers/with-env.ts';

interface Harness {
  engine: { disconnectCalls: number; disconnect: () => Promise<void> };
  order: string[];
  installs: LoopStallWatchdogOpts[];
  mcpRequestTimeouts: number[];
  logs: string[];
  exits: number[];
  opts: ServeOptions;
}

function makeHarness(overrides: Partial<ServeOptions> = {}): Harness {
  const order: string[] = [];
  const installs: LoopStallWatchdogOpts[] = [];
  const mcpRequestTimeouts: number[] = [];
  const logs: string[] = [];
  const exits: number[] = [];

  const engine = {
    disconnectCalls: 0,
    disconnect: async () => {
      engine.disconnectCalls += 1;
      order.push('disconnect');
    },
  };

  const opts: ServeOptions = {
    exit: (code?: number) => {
      order.push('exit');
      exits.push(code ?? 0);
    },
    log: (m: string) => { logs.push(m); },
    runServeHttp: async (_engine, httpOptions) => {
      mcpRequestTimeouts.push(httpOptions.mcpRequestTimeoutMs ?? 0);
      order.push('run-start');
      // A real serve resolves only when its lifecycle ends; a tick is enough
      // to prove the watchdog stays armed across the await.
      await new Promise((r) => setTimeout(r, 5));
      order.push('run-end');
    },
    installStallWatchdog: (o: LoopStallWatchdogOpts) => {
      installs.push(o);
      order.push('install');
      let disposed = false;
      return {
        dispose() {
          if (disposed) return;
          disposed = true;
          order.push('dispose');
        },
        get active() { return !disposed; },
      };
    },
    stallWatchdogMs: 20_000,
    mcpRequestTimeoutMs: DEFAULT_SERVE_MCP_REQUEST_TIMEOUT_MS,
    ...overrides,
  };

  return { engine, order, installs, mcpRequestTimeouts, logs, exits, opts };
}

describe('serve --http watchdog seam (#4281)', () => {
  test('arms before runServeHttp and disposes after it resolves, before teardown', async () => {
    const h = makeHarness();
    let finishRunServeHttp!: () => void;
    const heldServe = new Promise<void>(resolve => { finishRunServeHttp = resolve; });
    h.opts.runServeHttp = async (_engine, httpOptions) => {
      h.mcpRequestTimeouts.push(httpOptions.mcpRequestTimeoutMs ?? 0);
      h.order.push('run-start');
      await heldServe;
      h.order.push('run-end');
    };
    let runSettled = false;
    const serving = runServe(h.engine as unknown as BrainEngine, ['--http'], h.opts).then(() => {
      runSettled = true;
    });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(h.order).toEqual(['install', 'run-start']);
    expect(runSettled).toBe(false);
    finishRunServeHttp();
    await serving;

    // dispose must land BETWEEN the server lifecycle resolving and the
    // engine teardown — both watchdog paths stay active for the full
    // runServeHttp lifetime; finishHttpServe has its own cleanup deadline.
    expect(h.order).toEqual(['install', 'run-start', 'run-end', 'dispose', 'disconnect', 'exit']);
    expect(h.exits).toEqual([0]);
    expect(h.installs.length).toBe(1);
    expect(h.installs[0].stallMs).toBe(20_000);
    expect(h.installs[0].graceMs).toBe(STALL_DEFAULT_GRACE_MS);
    expect(h.installs[0].label).toContain('serve');
    expect(h.mcpRequestTimeouts).toEqual([DEFAULT_SERVE_MCP_REQUEST_TIMEOUT_MS]);
  });

  test('turning off the loop watchdog leaves the independent request deadline armed', async () => {
    const h = makeHarness({ stallWatchdogMs: 0, mcpRequestTimeoutMs: undefined });
    await withEnv({ [SERVE_MCP_REQUEST_TIMEOUT_ENV]: '45000' }, () =>
      runServe(h.engine as unknown as BrainEngine, ['--http'], h.opts));

    expect(h.installs.length).toBe(0);
    expect(h.mcpRequestTimeouts).toEqual([45_000]);
    expect(h.order).toEqual(['run-start', 'run-end', 'disconnect', 'exit']);
    expect(h.logs.join('\n')).toContain('request watchdog armed');
    expect(h.logs.join('\n')).not.toContain('loop watchdog armed');
  });

  test('request deadline stays armed when the loop worker is inert', async () => {
    const h = makeHarness({ mcpRequestTimeoutMs: 45_000 });
    h.opts.installStallWatchdog = () => ({ dispose() {}, get active() { return false; } });
    await runServe(h.engine as unknown as BrainEngine, ['--http'], h.opts);

    expect(h.mcpRequestTimeouts).toEqual([45_000]);
    expect(h.logs.join('\n')).toContain('request watchdog armed');
    expect(h.logs.join('\n')).not.toContain('loop watchdog armed');
  });

  test('request deadline can be disabled without disabling the loop watchdog', async () => {
    const h = makeHarness({ mcpRequestTimeoutMs: 0 });
    await runServe(h.engine as unknown as BrainEngine, ['--http'], h.opts);

    expect(h.installs.length).toBe(1);
    expect(h.mcpRequestTimeouts).toEqual([0]);
    expect(h.logs.join('\n')).toContain('loop watchdog armed');
    expect(h.logs.join('\n')).toContain('request watchdog disabled');
    expect(h.logs.join('\n')).not.toContain('request watchdog armed');
  });

  test('disposes the watchdog even when runServeHttp rejects', async () => {
    const h = makeHarness();
    h.opts.runServeHttp = async () => {
      h.order.push('run-throw');
      throw new Error('listen EADDRINUSE');
    };

    await expect(
      runServe(h.engine as unknown as BrainEngine, ['--http'], h.opts),
    ).rejects.toThrow('EADDRINUSE');

    // finally-dispose fired; finishHttpServe is intentionally NOT reached on a
    // failed boot (pre-#4281 behavior preserved — the error propagates to the CLI).
    expect(h.order).toEqual(['install', 'run-throw', 'dispose']);
    expect(h.exits).toEqual([]);
  });

  test('an armed watchdog logs an operator-visible line naming the env knob', async () => {
    const h = makeHarness();
    await runServe(h.engine as unknown as BrainEngine, ['--http'], h.opts);

    const joined = h.logs.join('\n');
    expect(joined).toContain('loop watchdog armed');
    expect(joined).toContain('request watchdog armed');
    expect(joined).toContain('GBRAIN_SERVE_STALL_WATCHDOG_MS');
    expect(joined).toContain(SERVE_MCP_REQUEST_TIMEOUT_ENV);
    expect(joined).toContain(`unset/invalid defaults to ${DEFAULT_SERVE_MCP_REQUEST_TIMEOUT_MS}ms`);
    expect(joined).toContain('if configured to restart after clean exits');
    expect(joined).toContain('a supervisor such as this systemd unit (Restart=always) brings it back');
    expect(joined).toContain('unsupervised foreground/manual invocation exits and stays down');
    expect(joined).toContain('long-blocking RPCs when running unsupervised');
  });

  test('reports the disabled request watchdog when both watchdogs are off', async () => {
    const h = makeHarness({ stallWatchdogMs: 0, mcpRequestTimeoutMs: 0 });
    await runServe(h.engine as unknown as BrainEngine, ['--http'], h.opts);
    expect(h.logs.join('\n')).not.toContain('loop watchdog armed');
    expect(h.logs.join('\n')).toContain('request watchdog disabled');
    expect(h.logs.join('\n')).not.toContain('request watchdog armed');
  });
});
