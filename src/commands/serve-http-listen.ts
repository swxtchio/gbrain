/**
 * SWX: HTTP listen readiness for `gbrain serve --http`.
 *
 * Express 5 routes a listen failure into the app.listen() callback, so a
 * callback that ignored its argument printed the startup banner for a server
 * that never bound, and the process then waited forever. runServeHttp awaits
 * this before printing the banner or binding the resolve-IPC socket.
 */

type ListenSubscriber = {
  once(event: string, listener: (...args: any[]) => void): unknown;
  off(event: string, listener: (...args: any[]) => void): unknown;
};

/**
 * SWX: resolve once `server` is bound, reject once it fails to bind.
 * EADDRINUSE gets an actionable message: a second `serve --http` on a taken
 * port must exit non-zero instead of idling unbound, which is how duplicate
 * launches used to pile up as orphaned processes.
 */
export function waitForHttpListening(
  server: ListenSubscriber,
  port: number,
  bind: string,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    const onError = (error: Error & { code?: string }) => {
      server.off('listening', onListening);
      if (error.code === 'EADDRINUSE') {
        reject(new Error(
          `gbrain serve --http: ${bind}:${port} is already in use (EADDRINUSE). ` +
            `Another server is listening there — check with: ss -ltnp | grep :${port}`,
        ));
        return;
      }
      reject(error);
    };
    server.once('listening', onListening);
    server.once('error', onError);
  });
}
