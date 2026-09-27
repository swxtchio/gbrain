/**
 * Fixture for test/process-watchdog.serial.test.ts. Spawned via `bun`.
 *
 * Usage: bun watchdog-harness.ts <mode> <deadlineMs> <graceMs>
 *   starve-with    — install the watchdog, then starve the event loop forever.
 *                    The watchdog must SIGKILL this process by deadline+grace.
 *   starve-without — no watchdog, just starve. Proves the busy loop truly hangs
 *                    (the test kills it). Isolates the watchdog as cause of death.
 *   clean-dispose  — install with a long deadline, dispose immediately, exit 0.
 *                    The watchdog must NOT kill a cleanly-disposed process.
 *
 * Loop-stall watchdog modes (#4281) — <deadlineMs> is the stall threshold:
 *   stall-with     — register an inert SIGTERM listener (so the OS default
 *                    disposition can't kill us — mirrors serve-http, whose
 *                    process-cleanup SIGTERM handler can't run when the loop
 *                    is starved), install the stall watchdog, starve forever.
 *                    The watchdog must SIGTERM at ~stall, then SIGKILL at
 *                    ~stall+grace.
 *   stall-healthy  — install the stall watchdog and stay HEALTHY (idle loop,
 *                    pets flowing) well past stall+grace. Neither signal may
 *                    fire; a false SIGTERM prints TERMED and exits 1.
 *   stall-dispose  — install, dispose immediately, then genuinely starve past
 *                    stall+grace. A disposed watchdog must never kill.
 *
 * Usage: bun watchdog-harness.ts serve-mcp-stall <requestTimeoutMs> <port>
 *   serve-mcp-stall — start the real HTTP serve with a fresh in-memory PGLite
 *                     brain, leave an authenticated get_page request pending,
 *                     and require the armed request watchdog to signal death
 *                     while /health still answers. This mode has no grace arg.
 *
 * Safety net: the busy loop self-exits after 8s so a failed test kill can't hang CI.
 */
import { installProcessWatchdog, installLoopStallWatchdog } from '../../src/core/process-watchdog.ts';

const mode = process.argv[2] ?? 'starve-with';
const deadlineMs = Number(process.argv[3] ?? 300);
const graceMs = mode === 'serve-mcp-stall' ? 0 : Number(process.argv[4] ?? 150);

if (mode === 'serve-mcp-stall') {
  const port = Number(process.argv[4]);

  async function reproduceLiveLoopMcpStall(): Promise<void> {
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error(`invalid serve-mcp-stall port: ${process.argv[4]}`);
    }

    const coldStartAt = Date.now();
    const [{ PGLiteEngine }, { runServe }, { generateToken, hashToken }] = await Promise.all([
      import('../../src/core/pglite-engine.ts'),
      import('../../src/commands/serve.ts'),
      import('../../src/core/utils.ts'),
    ]);
    const engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();

    const token = generateToken('gbrain_');
    await engine.executeRaw(
      `INSERT INTO access_tokens (id, name, token_hash, permissions)
       VALUES (gen_random_uuid(), $1, $2, $3::text::jsonb)`,
      ['watchdog-live-mcp-stall', hashToken(token), JSON.stringify({ takes_holders: ['world'] })],
    );

    let markMcpEntered!: () => void;
    const mcpEntered = new Promise<void>(resolve => { markMcpEntered = resolve; });
    (engine as unknown as { readPageSnapshot: (...args: unknown[]) => Promise<never> }).readPageSnapshot = async () => {
      process.stdout.write('MCP_HANDLER_ENTERED\n');
      markMcpEntered();
      return await new Promise<never>(() => {});
    };

    process.once('SIGTERM', () => {
      process.stdout.write('WATCHDOG_SIGTERM\n');
      process.exit(23);
    });

    const serve = runServe(
      engine,
      ['--http', '--port', String(port), '--bind', '127.0.0.1', '--suppress-bootstrap-token'],
      { stallWatchdogMs: deadlineMs, sweepEnabled: false },
    );
    void serve.catch(error => {
      process.stderr.write(`SERVE_FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    });

    const base = `http://127.0.0.1:${port}`;
    const bindDeadline = Date.now() + 30_000;
    let coldHealth: Response | undefined;
    while (Date.now() < bindDeadline) {
      try {
        const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1500) });
        if (response.ok && (await response.json() as { status?: string }).status === 'ok') {
          coldHealth = response;
          break;
        }
      } catch { /* the HTTP listener is still starting */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!coldHealth) throw new Error('cold serve did not answer /health within 30s');
    process.stdout.write(`COLD_BIND_MS=${Date.now() - coldStartAt}\n`);

    const abort = new AbortController();
    let mcpHeadersReceived = false;
    let mcpResponseCompleted = false;
    let mcpRequestFailed = false;
    let markMcpHeaders!: () => void;
    const mcpHeaders = new Promise<void>(resolve => { markMcpHeaders = resolve; });
    void fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'get_page', arguments: { slug: 'watchdog-live-stall' } },
      }),
      signal: abort.signal,
    }).then(
      async response => {
        mcpHeadersReceived = true;
        markMcpHeaders();
        process.stdout.write('MCP_HEADERS_RECEIVED\n');
        try {
          await response.text();
          mcpResponseCompleted = true;
        } catch {
          if (!abort.signal.aborted) mcpRequestFailed = true;
        }
      },
      () => { if (!abort.signal.aborted) mcpRequestFailed = true; },
    );

    await Promise.race([
      mcpEntered,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('/mcp did not reach the operation handler within 10s')), 10_000)),
    ]);
    await Promise.race([
      mcpHeaders,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('/mcp did not accept the request within 10s')), 10_000)),
    ]);

    const healthDuringStall = await fetch(`${base}/health`, { signal: AbortSignal.timeout(3000) });
    const healthBody = await healthDuringStall.json() as { status?: string };
    if (!healthDuringStall.ok || healthBody.status !== 'ok') {
      throw new Error(`/health did not stay healthy during the pending MCP request: ${healthDuringStall.status} ${healthBody.status}`);
    }
    process.stdout.write('HEALTH_OK\n');

    // Keep the real HTTP server alive beyond the loop-stall threshold. The
    // unresolved operation holds only this request; timers and /health still
    // run on the main loop, so the watchdog continues to receive pets.
    await new Promise(resolve => setTimeout(resolve, deadlineMs + 500));
    if (!mcpHeadersReceived || mcpResponseCompleted || mcpRequestFailed) {
      throw new Error(`/mcp did not remain unanswered: headers=${mcpHeadersReceived} completed=${mcpResponseCompleted} failed=${mcpRequestFailed}`);
    }
    process.stdout.write('MCP_UNANSWERED\nWATCHDOG_ALIVE\n');
    abort.abort();
    process.exit(0);
  }

  void reproduceLiveLoopMcpStall().catch(error => {
    process.stderr.write(`REPRO_FAILED: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  });
  await new Promise<void>(() => {});
}

if (mode.startsWith('stall-')) {
  const installStall = () => installLoopStallWatchdog({
    stallMs: deadlineMs,
    graceMs,
    label: 'test-stall',
    petIntervalMs: 50,
    checkIntervalMs: 25,
  });

  if (mode === 'stall-dispose') {
    const handle = installStall();
    handle.dispose();
    // Genuinely starve past stall+grace: the disposed watchdog must not fire.
    const t0 = Date.now();
    while (Date.now() - t0 < deadlineMs + graceMs + 400) { /* spin */ }
    process.stdout.write('DISPOSED\n');
    process.exit(0);
  }

  if (mode === 'stall-healthy') {
    const handle = installStall();
    // A false SIGTERM (watchdog misfiring on a healthy loop) is the bug this
    // mode exists to catch — make it loud and non-zero.
    process.on('SIGTERM', () => { process.stdout.write('TERMED\n'); process.exit(1); });
    // Healthy loop: idle awaits keep the pet interval firing. Wait several
    // full stall+grace windows to prove pets genuinely reset the lag.
    await new Promise((r) => setTimeout(r, deadlineMs + graceMs + 700));
    handle.dispose();
    process.stdout.write('HEALTHY\n');
    process.exit(0);
  }

  // stall-with: the listener's mere presence stops the OS default SIGTERM
  // disposition from killing us; the JS callback itself can never run while
  // the loop is starved (the #1633 premise), so death must come from SIGKILL.
  process.on('SIGTERM', () => { /* starved loop never runs this */ });
  installStall();
  process.stdout.write('STALL_LOOP_START\n');
  const t0 = Date.now();
  while (Date.now() - t0 < 8000) { /* spin — no await, no yield */ }
  process.stdout.write('SURVIVED\n'); // must NOT print under stall-with
  process.exit(0);
}

if (mode === 'starve-with' || mode === 'clean-dispose') {
  const handle = installProcessWatchdog({ deadlineMs, graceMs, label: 'test-wd' });
  if (mode === 'clean-dispose') {
    handle.dispose();
    process.stdout.write('DISPOSED\n');
    process.exit(0);
  }
}

// Starve the main event loop with a synchronous busy loop (simulates ReDoS).
const start = Date.now();
while (Date.now() - start < 8000) { /* spin — no await, no yield */ }
process.stdout.write('SURVIVED\n'); // must NOT print under starve-with
process.exit(0);
