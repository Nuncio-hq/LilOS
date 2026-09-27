import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "../log";
import { resolveHermesBin } from "./discover";

/**
 * Engine-launcher seam (AC-2): the harness knows how to start an engine and
 * where to find its protocol socket — never how the engine works inside.
 * `packages/engine-hermes` plugs in via `hermesEngineLauncher` once #7 lands;
 * tests and the fake leg use `fakeEngineLauncher`.
 */

export interface LaunchedEngine {
  /** The ws:// endpoint serving the LilOS engine protocol. */
  url: string;
  /** Present when the harness owns the process (undefined for external urls). */
  process?: EngineProcess;
}

export interface EngineProcess {
  pid: number | undefined;
  /** Resolves with the exit code once the child exits. */
  exited: Promise<number | null>;
  kill(): void;
}

export interface EngineLauncher {
  /** Name used in logs/state reports ("engine-fake", "hermes"). */
  name: string;
  /** Start the engine and return once its protocol endpoint is reachable. */
  start(): Promise<LaunchedEngine>;
}

export interface CommandLauncherOptions {
  name: string;
  command: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  /**
   * Readiness probe: a regex matched against the child's combined stdout.
   * First capture group = the protocol ws url; when the pattern has no
   * capture group, `url` must be supplied.
   */
  readyPattern: RegExp;
  url?: string;
  startupTimeoutMs?: number;
  log: Logger;
}

/**
 * Launch an engine from a child process: waits for `readyPattern` on stdout,
 * then exposes the printed ws url plus kill/exited for supervision. Any
 * engine behind `serve`-style CLIs (engine-fake, engine-hermes' serve script,
 * a Codex adapter) works through this one launcher.
 */
export function commandLauncher(
  options: CommandLauncherOptions,
): EngineLauncher {
  return {
    name: options.name,
    start: () =>
      new Promise<LaunchedEngine>((resolve, reject) => {
        const [bin, ...args] = options.command;
        const timeout = options.startupTimeoutMs ?? 60_000;
        options.log.info("launching engine", {
          engine: options.name,
          command: options.command.join(" "),
        });
        const child = spawn(bin, args, {
          cwd: options.cwd,
          env: { ...process.env, ...options.env } as NodeJS.ProcessEnv,
          stdio: ["ignore", "pipe", "pipe"],
        });
        const exited = new Promise<number | null>((r) => {
          child.once("exit", (code) => r(code));
        });
        const proc: EngineProcess = {
          pid: child.pid,
          exited,
          kill: () => {
            try {
              child.kill("SIGTERM");
            } catch {
              // already gone
            }
          },
        };
        let out = "";
        let err = "";
        const timer = setTimeout(() => {
          proc.kill();
          reject(
            new Error(
              `engine ${options.name} did not report ready within ${timeout}ms`,
            ),
          );
        }, timeout);
        const onLine = (chunk: Buffer, into: "out" | "err") => {
          const text = chunk.toString();
          if (into === "out") out += text;
          else err += text;
          const match = options.readyPattern.exec(out);
          if (match) {
            clearTimeout(timer);
            const url = match[1] ?? options.url;
            if (!url) {
              proc.kill();
              reject(
                new Error(
                  `engine ${options.name} readiness regex has no url capture`,
                ),
              );
              return;
            }
            resolve({ url, process: proc });
          }
        };
        child.stdout?.on("data", (c) => onLine(c as Buffer, "out"));
        child.stderr?.on("data", (c) => {
          err += c.toString();
        });
        child.once("error", (error) => {
          clearTimeout(timer);
          reject(new Error(`engine ${options.name} spawn failed: ${error}`));
        });
        child.once("exit", (code) => {
          clearTimeout(timer);
          reject(
            new Error(
              `engine ${options.name} exited before ready (code ${code}): ${err
                .trim()
                .split("\n")
                .slice(-3)
                .join(" | ")}`,
            ),
          );
        });
      }),
  };
}

/**
 * The fake engine's argv (#85): a bundled `lilos-engine-fake` binary when the
 * packaged app ships one, else `bun serve.ts` inside the repo. A build that
 * has neither errors out plainly — a release bundle never quietly substitutes
 * another engine.
 */
export function fakeServeCommand(options: {
  repoRoot: string;
  tick?: number;
  bun?: string;
  /** Pre-compiled fake-engine binary; replaces the `bun serve.ts` command. */
  serveBin?: string;
}): string[] {
  const script = join(
    options.repoRoot,
    "packages/engine-fake/scripts/serve.ts",
  );
  const serve = options.serveBin
    ? [options.serveBin]
    : existsSync(script)
      ? [options.bun ?? "bun", script]
      : (() => {
          throw new Error(
            "The fake engine is not part of this build — it ships in dev bundles only. Remove LILOS_ENGINE=fake or use a dev build.",
          );
        })();
  return [...serve, "--port", "0", "--tick", String(options.tick ?? 25)];
}

/** `fake serve` through the command launcher — the CI/dev engine. */
export function fakeEngineLauncher(options: {
  repoRoot: string;
  tick?: number;
  bun?: string;
  serveBin?: string;
  log: Logger;
}): EngineLauncher {
  return {
    name: "engine-fake",
    // Build argv inside start(): a bundle without the fake binary fails as a
    // supervised crash with a plain reason, not an opaque harness boot error.
    start: async () =>
      commandLauncher({
        name: "engine-fake",
        command: fakeServeCommand(options),
        readyPattern: /LISTENING (ws:\/\/\S+)/,
        log: options.log,
      }).start(),
  };
}

/**
 * The Hermes adapter's argv (#85): a bundled `lilos-engine-hermes` binary or
 * the repo's serve script, always handed the discovered `hermes` binary via
 * `--hermes-bin` (launchd's PATH does not reach `~/.local/bin`). Provider and
 * model ride only when the operator set them — the engine owns its defaults
 * (AC-3); the #30 picker overrides per turn.
 */
export function hermesServeCommand(options: {
  repoRoot: string;
  /** Resolved Hermes binary (from `resolveHermesBin`). */
  hermesBin: string;
  /** Pre-compiled adapter binary inside the packaged app. */
  serveBin?: string;
  bun?: string;
  provider?: string;
  model?: string;
}): string[] {
  const script = join(
    options.repoRoot,
    "packages/engine-hermes/scripts/serve.ts",
  );
  const serve = options.serveBin
    ? [options.serveBin]
    : existsSync(script)
      ? [options.bun ?? "bun", script]
      : (() => {
          throw new Error(
            "The Hermes engine adapter (lilos-engine-hermes) is not part of this build — it should ship in every bundle.",
          );
        })();
  const command = [...serve, "--port", "0", "--hermes-bin", options.hermesBin];
  if (options.provider) command.push("--provider", options.provider);
  if (options.model) command.push("--model", options.model);
  return command;
}

/**
 * The real engine: its serve entry owns `hermes serve` itself (generated
 * token on 127.0.0.1, per AC-2) and serves the LilOS engine protocol at /ws.
 * Hermes resolution runs inside `start()` so a missing binary lands as a
 * supervised crash with a plain reason — visible in status — not a harness
 * boot crash nobody sees.
 */
export function hermesEngineLauncher(options: {
  repoRoot: string;
  bun?: string;
  /** Pre-compiled adapter binary inside the packaged app. */
  serveBin?: string;
  /** Skip discovery when the caller already resolved a binary. */
  hermesBin?: string;
  provider?: string;
  model?: string;
  log: Logger;
}): EngineLauncher {
  return {
    name: "hermes",
    start: async () => {
      const hermesBin = options.hermesBin ?? resolveHermesBin();
      const command = hermesServeCommand({ ...options, hermesBin });
      options.log.info("hermes binary", { hermesBin });
      return commandLauncher({
        name: "hermes",
        command,
        readyPattern: /LISTENING (ws:\/\/\S+)/,
        startupTimeoutMs: 300_000, // hermes serve cold-starts ACP tooling
        log: options.log,
      }).start();
    },
  };
}

/** Connect to an engine the harness does not supervise (e.g. Oscar's own). */
export function externalEngineLauncher(url: string): EngineLauncher {
  return {
    name: "external",
    start: async () => ({ url }),
  };
}
