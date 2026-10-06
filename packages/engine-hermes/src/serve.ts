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
  /** The child's stdout+stderr so far (kept to the last 64KB). */
  logTail(): string;
  close(): Promise<void>;
}

const READY_RE = /HERMES_BACKEND_READY port=(\d+)/;
const HEALTH_TIMEOUT_MS = 4000;

/* #548: since the host-backend multiplex rework, one `hermes serve` per OS
 * user owns the machine-level backend; another `serve` on the same user
 * attaches to it and exits 0 printing this marker (or refuses with
 * `Refusing to start:` and exit 78 when the endpoint conflicts). LilOS must
 * own its backend, so the adapter passes `--isolated` when the binary
 * advertises it and names the owner when a build still attaches. */
const HOST_ATTACH_RE =
  /Hermes \w+ already running on this host: PID (\d+), port (\d+)/;
const HOST_REFUSE_RE =
  /Refusing to start: this host is already served by ([^\n]+)/;

/** `hermes serve` attached to — or was refused by — a backend that already
    owns this host. Not a crash: retrying can't help while the owner lives. */
export class HermesHostConflict extends Error {
  constructor(
    message: string,
    readonly owner: { pid?: number; port?: number },
  ) {
    super(message);
    this.name = "HermesHostConflict";
  }
}

/** Logs say this `serve` exit was the multiplex attach/refusal, not a crash. */
function hostConflict(logs: string): HermesHostConflict | undefined {
  const attach = HOST_ATTACH_RE.exec(logs);
  if (attach) {
    const [pid, port] = [Number(attach[1]), Number(attach[2])];
    return new HermesHostConflict(
      `another Hermes backend is already running on this Mac (PID ${pid}, port ${port}) — \`hermes serve\` attached to it instead of starting LilOS's own engine. Quit Hermes Desktop or the other \`hermes serve\`/LilOS, then try again`,
      { pid, port },
    );
  }
  const refused = HOST_REFUSE_RE.exec(logs);
  if (refused) {
    return new HermesHostConflict(
      `another Hermes backend already owns this host (${refused[1]?.trim()}) and refused LilOS's own backend. Quit Hermes Desktop or the other \`hermes serve\`/LilOS, then try again`,
      {},
    );
  }
  return undefined;
}

const isolatedSupport = new Map<string, Promise<boolean>>();

/* `serve --help` is the feature probe: multiplex landed mid-line on
   v0.21.5+builds, so no version string can answer it. Cached per binary —
   a supervisor relaunch must not re-probe. */
function probeIsolated(bin: string, env: Record<string, string>) {
  return new Promise<boolean>((resolve) => {
    const child = spawn(bin, ["serve", "--help"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    const cap = (d: Buffer | string) => {
      out += String(d);
    };
    child.stdout?.on("data", cap);
    child.stderr?.on("data", cap);
    const done = (ok: boolean) => {
      clearTimeout(timer);
      resolve(ok);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done(false);
    }, 10_000);
    child.on("exit", () => done(/--isolated\b/.test(out)));
    child.on("error", () => done(false));
  });
}

function supportsIsolated(
  bin: string,
  env: Record<string, string>,
): Promise<boolean> {
  let probe = isolatedSupport.get(bin);
  if (!probe) {
    probe = probeIsolated(bin, env).catch(() => false);
    isolatedSupport.set(bin, probe);
  }
  return probe;
}

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
  // #548: dedicated backend for this app — without it a Hermes with the
  // host-backend multiplex attaches to whoever owns the host and exits 0.
  const isolated =
    !(opts.args ?? []).includes("--isolated") &&
    (await supportsIsolated(opts.bin, env));
  const child = spawn(
    opts.bin,
    [
      "serve",
      "--host",
      "127.0.0.1",
      ...portFlag,
      "--skip-build",
      ...(isolated ? ["--isolated"] : []),
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
      // #548: an attach/refusal names its owner and is never a restartable
      // crash — reject typed so callers can fail fatal, not retry.
      const conflict = hostConflict(logs);
      if (conflict) {
        reject(conflict);
        return;
      }
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
    logTail() {
      return logs;
    },
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
