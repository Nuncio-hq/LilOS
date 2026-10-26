import { spawnSync } from "node:child_process";
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
import type { AcpLaunchSpec, NpmDistribution } from "./launch.js";
import { probeExecutable, resolveExecutable } from "./launch.js";

/**
 * D-#866 — install-on-first-use for agents the ACP registry distributes
 * as npm packages (`npx <pkg>@<ver>`). A user install on PATH always wins;
 * otherwise the exact pinned version lands once in a LilOS-owned cache and
 * a local JS runtime runs the package's own bin entry. The desktop app
 * ships no package manager, so fetch goes through whatever the machine
 * has — `bun` first, then `npm`; a machine with neither reports the
 * runtime unavailable with the reason, never a retry loop.
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

/** One fetch+install into the cache; returns the failure text or ok.
    Stages in a temp dir and renames once — a reader never sees a
    half-written tree, and a crashed install leaves no marker. */
function install(
  dir: string,
  npm: NpmDistribution,
  env: NodeJS.ProcessEnv,
): { ok: boolean; output: string } {
  const bun = resolveExecutable("bun", env);
  const npmBin = resolveExecutable("npm", env);
  const installer = bun
    ? { bin: bun, args: ["install", "--production"] }
    : npmBin
      ? {
          bin: npmBin,
          args: [
            "install",
            "--omit=dev",
            "--no-audit",
            "--no-fund",
            "--loglevel=error",
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
    const r = spawnSync(installer.bin, installer.args, {
      cwd: stage,
      env,
      encoding: "utf8",
      timeout: INSTALL_TIMEOUT_MS,
    });
    if (r.status !== 0)
      return {
        ok: false,
        output:
          `${installer.bin.split("/").pop()} install failed` +
          ` (${r.status ?? r.error?.message ?? "?"}): ` +
          `${(r.stderr || r.stdout || "").trim().slice(0, 400)}`,
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
  /** Verified argv — `[bin, ...]` or `[runner, entry, ...]`. */
  command?: string[];
  /** Extra env the resolved command needs (Electron-as-node). */
  env?: Record<string, string>;
  /** Why resolution failed — goes on the runtime's status detail. */
  output: string;
}

/**
 * The launch command for a spec, provisioned if needed: an installed
 * binary on PATH wins unchanged; an npm-distributed recipe resolves to a
 * cached `[runner, entry]` — fetching into the LilOS cache on first use.
 * `command` stays the user-visible recipe (`claude-agent-acp`); the
 * result is what actually spawns.
 */
export function resolveAgentCommand(
  spec: AcpLaunchSpec,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedAgentCommand {
  const [bin, ...rest] = spec.command;
  if (!bin) return { ok: false, output: "empty launch command" };
  const resolved = resolveExecutable(bin, env);
  if (resolved) return { ok: true, command: [resolved, ...rest], output: "" };

  const npm = spec.provision?.npm;
  if (!npm) return { ok: false, output: `${bin} not on PATH` };

  const dir = join(provisionRoot(env), cacheKey(npm));
  const runner = resolveRunner(env);
  if (!runner)
    return {
      ok: false,
      output: `${bin} not on PATH and no JS runtime (bun/node) to run ${npm.package}`,
    };
  const entry = () => binEntry(dir, npm);
  if (!(existsSync(join(dir, ".lilos-provisioned")) && entry())) {
    const r = install(dir, npm, env);
    if (!r.ok) return { ok: false, output: r.output };
    if (!entry())
      return {
        ok: false,
        output: `${npm.package}@${npm.version} fetched but has no "${npm.bin}" entry`,
      };
  }
  return {
    ok: true,
    command: [runner.argv0, entry() ?? "", ...rest],
    ...(runner.env ? { env: runner.env } : {}),
    output: "",
  };
}

/** Verify the resolved command answers the spec's probe args. */
export async function probeAgentCommand(
  spec: AcpLaunchSpec,
  env?: NodeJS.ProcessEnv,
): Promise<{ ok: boolean; output: string }> {
  const r = resolveAgentCommand(spec, env);
  if (!r.ok || !r.command) return { ok: false, output: r.output };
  const [bin, ...args] = r.command;
  return probeExecutable(
    bin,
    [...args, ...(spec.verify?.args ?? ["--version"])],
    {
      env: { ...(env ?? process.env), ...(r.env ?? {}) } as NodeJS.ProcessEnv,
      ...(spec.verify?.timeoutMs ? { timeoutMs: spec.verify.timeoutMs } : {}),
    },
  );
}
