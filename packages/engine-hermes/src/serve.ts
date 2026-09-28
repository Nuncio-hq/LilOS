import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

export interface HermesServeOptions {
  /** Path to the `hermes` binary. */
  bin: string;
  /** Extra argv for `hermes serve` (e.g. ["--profile", "lilos7"]). */
  args?: string[];
  /** Extra env (e.g. HERMES_HOME). */
  env?: Record<string, string>;
  cwd?: string;
  /** Port; 0 lets the OS pick (parsed from the ready marker). Default 0. */
  port?: number;
  /** Fixed dashboard token; generated when omitted. */
  token?: string;
  /** Ready timeout ms. Default 30s. */
  timeoutMs?: number;
}

export interface HermesServeHandle {
  port: number;
  token: string;
  url: string;
  child: ChildProcess;
  close(): Promise<void>;
}

const READY_RE = /HERMES_BACKEND_READY port=(\d+)/;
const HEALTH_TIMEOUT_MS = 4000;

/**
 * Harness-managed `hermes serve` lifecycle: spawn on 127.0.0.1 with a
 * generated `HERMES_DASHBOARD_SESSION_TOKEN`, wait for `HERMES_BACKEND_READY`,
 * verify `/api/health`. Used by #26; closed with `handle.close()`.
 */
export async function startHermesServe(
  opts: HermesServeOptions,
): Promise<HermesServeHandle> {
  const token = opts.token ?? `lilos-${randomBytes(16).toString("hex")}`;
  const portFlag =
    opts.port === undefined ? ["--port", "0"] : ["--port", String(opts.port)];
  const env = {
    ...(process.env as Record<string, string>),
    ...opts.env,
    HERMES_DASHBOARD_SESSION_TOKEN: token,
  };
  const child = spawn(
    opts.bin,
    [
      "serve",
      "--host",
      "127.0.0.1",
      ...portFlag,
      "--skip-build",
      ...(opts.args ?? []),
    ],
    { env, cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] },
  );

  let logs = "";
  const logCap = (d: Buffer | string) => {
    logs += String(d);
    if (logs.length > 64_000) logs = logs.slice(-64_000);
  };
  child.stdout?.on("data", logCap);
  child.stderr?.on("data", logCap);

  const port = await new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `hermes serve did not become ready in ${opts.timeoutMs ?? 30_000}ms:\n${logs}`,
        ),
      );
    }, opts.timeoutMs ?? 30_000);
    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout?.off("data", onData);
      child.stderr?.off("data", onData);
      child.off("exit", onExit);
    };
    const onData = (d: Buffer | string) => {
      const m = READY_RE.exec(String(d));
      if (m) {
        cleanup();
        resolve(Number(m[1]));
      }
    };
    const onExit = (code: number | null, signal: string | null) => {
      cleanup();
      // #95: a signal kill names the signal — the harness surfaces this
      // verbatim, and "code null" says nothing about a device policy.
      const why = signal ? `killed by ${signal}` : `code ${code}`;
      reject(new Error(`hermes serve exited early (${why}):\n${logs}`));
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("exit", onExit);
  });

  const url = `http://127.0.0.1:${port}`;
  const health = await fetch(`${url}/api/health`, {
    signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
  }).catch(() => null);
  if (!health?.ok) {
    child.kill("SIGTERM");
    throw new Error(
      `hermes serve failed health check on ${url}/api/health\n${logs}`,
    );
  }

  return {
    port,
    token,
    url,
    child,
    async close() {
      if (child.exitCode !== null || child.killed) return;
      child.kill("SIGTERM");
      await new Promise<void>((r) => {
        const t = setTimeout(() => {
          child.kill("SIGKILL");
          r();
        }, 3000);
        child.once("exit", () => {
          clearTimeout(t);
          r();
        });
      });
    },
  };
}
