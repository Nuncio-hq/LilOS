/**
 * Shared plumbing for live scripts (scripts/live/*) and the harness demo
 * scripts (apps/harness/scripts/*) — the helpers every live leg used to
 * paste in: a free port, a log-prefixed child process, a file waiter,
 * teardown, and the OpenAI-compatible stub.
 *
 * Lives under scripts/live because it exists for live legs; app scripts
 * import it by relative path (`../../../scripts/live/lib/helpers`) —
 * scripts/ is outside the workspaces, so @lilos/* specifiers don't apply.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Kernel-assigned free TCP port on loopback. */
export const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      srv.close(() =>
        typeof addr === "object" && addr
          ? resolve(addr.port)
          : reject(new Error("no port")),
      );
    });
  });

/* Every `launch`ed/`startStub` child lands here so `cleanup` kills them
   all — and the exit hook is the belt under that (D-#347): a script that
   exits without cleaning up must not leave a stub or stack running. */
const procs: ChildProcess[] = [];
process.on("exit", () => {
  for (const p of procs) p.kill("SIGTERM");
});

/** Spawn `cmd` with `env` merged over process.env; stdio is piped back out
 *  with a `[name]` prefix (stderr gets `[name!]`). */
export const launch = (
  name: string,
  cmd: string[],
  env: Record<string, string>,
  cwd = process.env.LILOS_REPO_ROOT ?? process.cwd(),
) => {
  const child = spawn(cmd[0] ?? "bun", cmd.slice(1), {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  procs.push(child);
  child.stdout?.on("data", (d) =>
    String(d)
      .trimEnd()
      .split("\n")
      .forEach((l) => {
        console.log(`  [${name}] ${l}`);
      }),
  );
  child.stderr?.on("data", (d) =>
    String(d)
      .trimEnd()
      .split("\n")
      .forEach((l) => {
        console.error(`  [${name}!] ${l}`);
      }),
  );
  return child;
};

/** Kill every launched child and remove the given scratch dirs. */
export const cleanup = (...dirs: string[]) => {
  for (const p of procs) p.kill("SIGTERM");
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
};

/** Poll until `path` reads; resolves with its trimmed contents, rejects on
 *  timeout (callers decide whether that's a FAIL). */
export const waitForFile = async (
  path: string,
  ms = 10_000,
): Promise<string> => {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      return readFileSync(path, "utf8").trim();
    } catch {
      if (Date.now() >= deadline)
        throw new Error(`timed out waiting for ${path}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }
};

export interface RunningStub {
  /** The port the stub actually bound (may differ from the request on 0). */
  port: number;
  kill: () => void;
}

/** Spawn `scripts/live/openai-stub.ts` and resolve once its "listening"
 *  line prints — no fixed sleep, and a failed bind is a clear error instead
 *  of a silently shadowed port. Env (STUB_SCRIPT, STUB_REQUEST_LOG, …)
 *  passes through process.env. The child is tracked for `cleanup`. */
export const startStub = async (port = 0): Promise<RunningStub> => {
  const stub = join(
    dirname(dirname(fileURLToPath(import.meta.url))),
    "openai-stub.ts",
  );
  const child = spawn("bun", [stub, String(port)], {
    env: process.env,
    stdio: ["ignore", "pipe", "inherit"],
  });
  procs.push(child);
  const bound = await new Promise<number>((resolve, reject) => {
    let buf = "";
    const to = setTimeout(
      () => reject(new Error(`openai-stub did not start: ${buf.trim()}`)),
      10_000,
    );
    child.stdout?.on("data", (d) => {
      buf += d;
      const m = buf.match(/openai-stub listening on http:\/\/\S+:(\d+)/);
      if (m) {
        clearTimeout(to);
        resolve(Number(m[1]));
      }
    });
    child.on("exit", (c) =>
      reject(new Error(`openai-stub exited ${c}: ${buf.trim()}`)),
    );
  });
  return { port: bound, kill: () => child.kill("SIGTERM") };
};
