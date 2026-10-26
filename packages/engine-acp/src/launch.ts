import { spawn } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
import type { AcpEngineOptions } from "./engine.js";

/**
 * D-#845 — launch recipes for named ACP runtimes. A registry entry (the
 * curated table in `scripts/serve.ts`) says where the agent's CLI lives,
 * how to verify the install, which client capabilities to advertise, and
 * the access→mode mapping — everything the generic seam needs supplied
 * per-agent without naming the agent in src/.
 *
 * T3's `AcpRegistrySupport.ts`/`driver.ts` ported as plain TS: resolve the
 * executable against PATH (plus the well-known user dirs a minimal spawn
 * env may lack), probe it once, and never store credentials — the agent's
 * own login carries the session.
 */

export interface AcpLaunchSpec {
  /** Registry id (the `--agent` name on serve.ts). */
  id: string;
  /** stdio command argv — e.g. `["devin", "acp"]`. */
  command: string[];
  /** Install check: `<bin> <verifyArgs>` must exit 0 before serving. */
  verify?: { args: string[]; timeoutMs?: number };
  /** `initialize.clientCapabilities` override (e.g. terminal on). */
  clientCapabilities?: acp.ClientCapabilities;
  /** Client-side `terminal/*` serving options for this agent. */
  terminals?: { shellCommands?: boolean };
  /** access → agent mode id (the agent's own vocabulary). */
  modeForAccess?: AcpEngineOptions["modeForAccess"];
  /** `_meta` on `session/new` for this agent. */
  sessionMeta?: AcpEngineOptions["sessionMeta"];
}

/** Directories a user install lands in that a bare spawn PATH may miss —
    the same fallback set T3's registry support uses for managed runtimes. */
const EXTRA_BIN_DIRS = (env: NodeJS.ProcessEnv) => [
  join(env.HOME ?? homedir(), ".local", "bin"),
  "/opt/homebrew/bin",
  "/usr/local/bin",
];

/**
 * Resolve `bin` to an executable path: absolute/relative paths check
 * directly; bare names search `env.PATH` then the well-known user dirs.
 * Returns undefined when nothing executable exists — the caller reports
 * the install as missing rather than letting spawn throw a bare ENOENT.
 */
export function resolveExecutable(
  bin: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const ok = (p: string) => {
    try {
      accessSync(p, constants.X_OK);
      return existsSync(p);
    } catch {
      return false;
    }
  };
  if (bin.includes("/") || isAbsolute(bin)) return ok(bin) ? bin : undefined;
  const seen = new Set<string>();
  for (const dir of [
    ...(env.PATH ?? "").split(delimiter),
    ...EXTRA_BIN_DIRS(env),
  ]) {
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    const candidate = join(dir, bin);
    if (ok(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Verified install: run `<bin> <verifyArgs>` once; exit 0 inside the
 * timeout means the CLI is really there and runnable (a PATH hit that
 * only resolves under a shell shim is not an install).
 */
export function probeExecutable(
  bin: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      ...(opts.env ? { env: opts.env } : {}),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    const onData = (c: Buffer) => {
      if (out.length < 8_192) out += c.toString("utf8");
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    const timeout = opts.timeoutMs ?? 15_000;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ ok: false, output: `timed out after ${timeout}ms\n${out}` });
    }, timeout);
    child.once("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, output: e.message });
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, output: out.trim() });
    });
  });
}
