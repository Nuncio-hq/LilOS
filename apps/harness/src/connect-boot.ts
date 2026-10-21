import type { Logger } from "./log";

/**
 * D-#817: how long boot waits for Connect to finish replacing the plugin
 * before starting the engine anyway. A pass stuck awaiting the relay must
 * not keep the engine down. 20s is past a healthy pass (the copy is local)
 * and short of stalling first run. Past the bound the engine starts
 * anyway. A copy that lands after that restarts the engine once no turn
 * is running.
 *
 * This bound does not cut a `hermes` CLI call short. Those are
 * `spawnSync` and block the event loop, each with its own 30s timeout.
 * The file replace before the CLI is synchronous, so the engine is not
 * started in the middle of a `cpSync` unless this bound already fired
 * while the pass was awaiting.
 */
export const CONNECT_BOOT_RECONCILE_MS = 20_000;

/**
 * D-#817: the engine must not import `lilos` while a pass is still
 * replacing it. Reconcile first, then `startEngine`. The timeout is the
 * bound above — `startEngine` still runs if the pass has not finished.
 */
export async function reconcileBeforeEngine(
  reconcile: () => Promise<void>,
  startEngine: () => void,
  opts?: { timeoutMs?: number; log?: Logger },
): Promise<void> {
  const timeoutMs = opts?.timeoutMs ?? CONNECT_BOOT_RECONCILE_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      opts?.log?.warn("connect boot reconcile timed out; starting the engine", {
        timeoutMs,
      });
      resolve();
    }, timeoutMs);
    timer.unref?.();
  });
  try {
    await Promise.race([
      reconcile().catch((error) => {
        if (timedOut) return;
        opts?.log?.warn("connect boot reconcile failed", {
          error: String(error),
        });
      }),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  startEngine();
}
