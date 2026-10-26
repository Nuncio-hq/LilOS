import { spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { scrubLilosEnv } from "@lilos/contracts/env";
import type { AcpLaunchSpec, NpmDistribution } from "./launch.js";
import { probeExecutable, resolveExecutable } from "./launch.js";

/**
 * D-#866 — install-on-first-use for agents the ACP registry distributes
 * as npm packages (`npx <pkg>@<ver>`). A user install on PATH wins when
 * its `--version` is at least the pin — an older adapter predates the
 * access-meta gate and hard-codes bypass, so it must lose (r6 review).
 * Otherwise the exact pinned version lands once in a LilOS-owned cache
 * and a local JS runtime runs the package's own bin entry. The desktop
 * app ships no package manager, so fetch goes through whatever the
 * machine has — `bun` first, then `npm`; a machine with neither reports
 * the runtime unavailable with the reason, never a retry loop.
 *
 * Everything here is vendor-neutral: the shim declares `provision.npm`
 * (`{package, version, bin}`) and this file knows only that recipe shape.
 */

/** Where provisioned packages live. Production always takes the default
    `~/.lilos/acp` (the app's own state root — LilOS-owned, not npm's):
    spawned children are LILOS_*-scrubbed, so the override is only ever
    visible to tests and to the harness's in-process probe. */
export const provisionRoot = (env: NodeJS.ProcessEnv = process.env): string =>
  env.LILOS_ACP_CACHE ?? join(env.HOME ?? homedir(), ".lilos", "acp");

const INSTALL_TIMEOUT_MS = 120_000;
/** A PATH adapter's `--version` gets its own small bound — a binary
    that cannot answer promptly is not worth trusting either. */
const PATH_VERSION_PROBE_MS = 5_000;

/** A JS runtime that can execute an npm package's dist entry. Bun first
    (the dev-stack norm), then node, then the packaged Electron binary —
    `ELECTRON_RUN_AS_NODE=1` makes `Contents/MacOS/LilOS` a plain node for
    exactly this kind of helper. */
function resolveRunner(
  env: NodeJS.ProcessEnv,
): { argv0: string; env?: Record<string, string> } | undefined {
  const bun = resolveExecutable("bun", env);
  if (bun) return { argv0: bun };
  const node = resolveExecutable("node", env);
  if (node) return { argv0: node };
  /* Packaged app: execPath is a MacOS/ sibling of the Electron binary. */
  const electron = join(dirname(process.execPath), "LilOS");
  if (existsSync(electron))
    return { argv0: electron, env: { ELECTRON_RUN_AS_NODE: "1" } };
  return undefined;
}

/** The package's own `bin` entry resolved inside an installed tree —
    read from its package.json so the recipe's `bin` name is the contract. */
function binEntry(dir: string, npm: NpmDistribution): string | undefined {
  try {
    const pkgRoot = join(dir, "node_modules", npm.package);
    const manifest = JSON.parse(
      readFileSync(join(pkgRoot, "package.json"), "utf8"),
    ) as { bin?: string | Record<string, string> };
    const rel =
      typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.[npm.bin];
    if (!rel) return undefined;
    const entry = join(pkgRoot, rel);
    return existsSync(entry) ? entry : undefined;
  } catch {
    return undefined;
  }
}

const cacheKey = (npm: NpmDistribution): string =>
  `${npm.package.replaceAll("/", "+")}@${npm.version.replaceAll("/", "+")}`;

/** Spawn + capture, async — the install path used to be `spawnSync`,
    which froze the harness event loop (relay heartbeats, describe
    probes) for up to two minutes on first use (r6 review). */
function runCapture(
  bin: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<{ status: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    const cap = (chunk: Buffer) => {
      if (out.length < 64_000) out += chunk.toString("utf8");
    };
    child.stdout?.on("data", cap);
    child.stderr?.on("data", cap);
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ status: null, output: `timed out after ${opts.timeoutMs}ms` });
    }, opts.timeoutMs);
    child.once("error", (e) => {
      clearTimeout(timer);
      resolve({ status: null, output: e.message });
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ status: code, output: out });
    });
  });
}

/** One fetch+install into the cache; returns the failure text or ok.
    Stages in a temp dir and renames once — a reader never sees a
    half-written tree, and a crashed install leaves no marker. */
async function install(
  dir: string,
  npm: NpmDistribution,
  env: NodeJS.ProcessEnv,
): Promise<{ ok: boolean; output: string }> {
  const bun = resolveExecutable("bun", env);
  const npmBin = resolveExecutable("npm", env);
  /* `--ignore-scripts`: the adapter is a pure JS dist — lifecycle
     scripts are not needed and must never run fetched code inside the
     harness. The installer's env is LILOS_*-scrubbed too — the relay
     token and friends are never the package manager's to read (D-#412). */
  const installer = bun
    ? { bin: bun, args: ["install", "--production", "--ignore-scripts"] }
    : npmBin
      ? {
          bin: npmBin,
          args: [
            "install",
            "--omit=dev",
            "--no-audit",
            "--no-fund",
            "--loglevel=error",
            "--ignore-scripts",
          ],
        }
      : undefined;
  if (!installer)
    return {
      ok: false,
      output: `no bun or npm found to fetch ${npm.package}@${npm.version}`,
    };
  /* Stage beside the target so the publish rename never crosses a
     filesystem boundary. */
  let stage: string;
  try {
    mkdirSync(dirname(dir), { recursive: true });
    stage = mkdtempSync(join(dirname(dir), ".stage-"));
  } catch (e) {
    return {
      ok: false,
      output: `cache root isn't writable: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  try {
    writeFileSync(
      join(stage, "package.json"),
      JSON.stringify({
        name: "lilos-acp-provision",
        private: true,
        dependencies: { [npm.package]: npm.version },
      }),
    );
    const r = await runCapture(installer.bin, installer.args, {
      cwd: stage,
      env: scrubLilosEnv(env),
      timeoutMs: INSTALL_TIMEOUT_MS,
    });
    if (r.status !== 0)
      return {
        ok: false,
        output:
          `${installer.bin.split("/").pop()} install failed` +
          ` (${r.status ?? "?"}): ` +
          `${r.output.trim().slice(0, 400)}`,
      };
    if (!binEntry(stage, npm))
      return {
        ok: false,
        output: `installed tree has no "${npm.bin}" bin entry`,
      };
    /* bun links `file:` deps into node_modules — the leaf can be a real
       dir whose files still point back at the source, which the cache
       would lose when the source moves. Re-materialize the package
       root with every symlink dereferenced so the cache owns its tree. */
    const pkgRoot = join(stage, "node_modules", npm.package);
    const detached = join(
      dirname(pkgRoot),
      `.detach-${npm.bin}-${process.pid}`,
    );
    try {
      cpSync(pkgRoot, detached, { recursive: true, dereference: true });
      rmSync(pkgRoot, { recursive: true, force: true });
      renameSync(detached, pkgRoot);
    } catch (e) {
      return {
        ok: false,
        output: `couldn't detach ${npm.package} into the cache: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
    writeFileSync(
      join(stage, ".lilos-provisioned"),
      `${npm.package}@${npm.version}\n`,
    );
    try {
      renameSync(stage, dir);
    } catch {
      /* A racing install won — reuse it; if its marker never landed the
         cache-miss path answers plainly instead. */
      return existsSync(join(dir, ".lilos-provisioned"))
        ? { ok: true, output: "" }
        : { ok: false, output: "concurrent install collided" };
    }
    return { ok: true, output: "" };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

export interface ResolvedAgentCommand {
  ok: boolean;
  /** Launch argv — `[bin, ...spec args]` or `[runner, entry, ...spec args]`. */
  command?: string[];
  /** The verify probe's argv WITHOUT the launch args — `devin --version`,
      not `devin acp --model x --version` (launch args before verify args
      broke the Devin probe — D-#866 r4). */
  probeHead?: string[];
  /** Extra env the resolved command needs (Electron-as-node). */
  env?: Record<string, string>;
  /** Why resolution failed — goes on the runtime's status detail. */
  output: string;
}

/** First `x.y(.z…)` anywhere — the version a `--version` banner prints
    (`claude-agent-acp 0.96.0`, `fake-acp 1.2.3`). */
const versionIn = (s: string): string | undefined =>
  s.match(/\d+\.\d+(?:\.\d+)?/)?.[0];

/** A semver-looking pin — `file:`/`git+`/workspace recipes are not
    versions and can never prove a PATH install stale. */
const pinnedVersion = (v: string): string | undefined =>
  /^\d/.test(v) ? versionIn(v) : undefined;

/** Numeric compare over dotted versions; missing parts read as 0. */
const cmpVersion = (a: string, b: string): number => {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
};

/**
 * The entry the runner actually launches. Provisioned commands always
 * go through a generated `lilos-run.mjs` shim beside the install: a
 * runner that needs env (`ELECTRON_RUN_AS_NODE=1` for the packaged
 * Electron-as-node) must scope it to THIS process — left in the env it
 * leaks into the agent's tool shells, where a child re-exec'ing the
 * Electron binary silently runs as plain node (r6 review). The shim
 * deletes the name before adapter code runs, so descendants inherit a
 * clean env under every runner — it is a no-op for bun/node. `.mjs` +
 * a top-level `await import` so the runner can never exit before the
 * entry's own code has registered its handlers.
 */
function runnerEntry(dir: string, entry: string): string {
  const shim = join(dir, "lilos-run.mjs");
  const body =
    "delete process.env.ELECTRON_RUN_AS_NODE;\n" +
    `await import(${JSON.stringify(pathToFileURL(entry).href)});\n`;
  try {
    if (readFileSync(shim, "utf8") !== body) writeFileSync(shim, body);
  } catch {
    writeFileSync(shim, body);
  }
  return shim;
}

/**
 * The launch command for a spec, provisioned if needed: an installed
 * binary on PATH wins when its `--version` is not older than the pin;
 * an npm-distributed recipe resolves to a cached `[runner, entry]` —
 * fetching into the LilOS cache on first use. `command` stays the
 * user-visible recipe (`claude-agent-acp`); the result is what actually
 * spawns. Async — a cold install is a real subprocess (r6 review:
 * the spawnSync version froze the harness event loop).
 */
export async function resolveAgentCommand(
  spec: AcpLaunchSpec,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ResolvedAgentCommand> {
  const [bin, ...rest] = spec.command;
  if (!bin) return { ok: false, output: "empty launch command" };
  const resolved = resolveExecutable(bin, env);
  const npm = spec.provision?.npm;
  if (resolved && !npm)
    return {
      ok: true,
      command: [resolved, ...rest],
      probeHead: [resolved],
      output: "",
    };
  if (resolved && npm) {
    /* Version-gate the user install (r6 review): an adapter older than
       the pin predates the access-meta gate — it hard-codes bypass and
       must lose to the provisioned copy. An unparseable or unanswered
       probe counts as unproven, so it loses too; a non-semver pin
       (a `file:` dev recipe) can never prove staleness, so PATH keeps
       the win it always had. */
    const probe = await probeExecutable(
      resolved,
      spec.verify?.args ?? ["--version"],
      {
        env: scrubLilosEnv(env),
        timeoutMs: PATH_VERSION_PROBE_MS,
      },
    );
    const found = probe.ok ? versionIn(probe.output) : undefined;
    const pinned = pinnedVersion(npm.version);
    if (found && (!pinned || cmpVersion(found, pinned) >= 0))
      return {
        ok: true,
        command: [resolved, ...rest],
        probeHead: [resolved],
        output: "",
      };
    /* Stale or unproven — fall through to the provisioned pin. */
  }

  if (!npm)
    return {
      ok: false,
      output: `${bin} not on PATH`,
    };

  const dir = join(provisionRoot(env), cacheKey(npm));
  const runner = resolveRunner(env);
  if (!runner)
    return {
      ok: false,
      output: `${bin} not on PATH and no JS runtime (bun/node) to run ${npm.package}`,
    };
  const entry = () => binEntry(dir, npm);
  if (!(existsSync(join(dir, ".lilos-provisioned")) && entry())) {
    const r = await install(dir, npm, env);
    if (!r.ok) return { ok: false, output: r.output };
    if (!entry())
      return {
        ok: false,
        output: `${npm.package}@${npm.version} fetched but has no "${npm.bin}" entry`,
      };
  }
  const run = runnerEntry(dir, entry() ?? "");
  return {
    ok: true,
    command: [runner.argv0, run, ...rest],
    probeHead: [runner.argv0, run],
    ...(runner.env ? { env: runner.env } : {}),
    output: "",
  };
}

/**
 * The spec's verify probe against a resolved command — `probeHead`
 * (the bare binary/runner+entry) plus the spec's verify args, never the
 * launch args: `devin --version`, not `devin acp --model x --version`
 * (D-#866 r4 — and r6: serve.ts's startup check skipped this path and
 * ran the broken argv itself).
 */
export async function verifyAgentCommand(
  spec: AcpLaunchSpec,
  r: ResolvedAgentCommand,
  env?: NodeJS.ProcessEnv,
): Promise<{ ok: boolean; output: string }> {
  if (!spec.verify) return { ok: true, output: "" };
  const head = r.probeHead ?? r.command;
  if (!r.ok || !head?.length) return { ok: false, output: r.output };
  const [bin, ...args] = head;
  return probeExecutable(bin, [...args, ...spec.verify.args], {
    env: { ...(env ?? process.env), ...(r.env ?? {}) } as NodeJS.ProcessEnv,
    ...(spec.verify.timeoutMs ? { timeoutMs: spec.verify.timeoutMs } : {}),
  });
}

/** Verify the resolved command answers the spec's probe args. */
export async function probeAgentCommand(
  spec: AcpLaunchSpec,
  env?: NodeJS.ProcessEnv,
): Promise<{ ok: boolean; output: string }> {
  const r = await resolveAgentCommand(spec, env);
  return verifyAgentCommand(spec, r, env);
}
