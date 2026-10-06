import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { scrubLilosEnv } from "@lilos/contracts/env";
import {
  HERMES_HOST_CONFLICT_EXIT_CODE,
  HERMES_TOO_OLD_EXIT_CODE,
  hermesTooOldMessage,
  isHermesVersionSupported,
  parseHermesVersion,
} from "@lilos/engine-hermes";
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

/** How the child ended: an exit code, or the signal that killed it. */
export interface EngineExit {
  code: number | null;
  signal: string | null;
}

export interface EngineProcess {
  pid: number | undefined;
  /** Resolves once the child exits — with the code, or the killing signal. */
  exited: Promise<EngineExit>;
  kill(): void;
}

/**
 * A start failure that retrying cannot fix (AC-1, #95) — e.g. a Hermes older
 * than the minimum. The supervisor fails the engine instead of burning the
 * restart budget on a verdict that will not change.
 */
export class FatalEngineStart extends Error {}

export const isFatalEngineStart = (e: unknown): e is FatalEngineStart =>
  e instanceof FatalEngineStart;

/** "killed by SIGKILL" when a signal ended the child, else "code 3". */
const exitReason = (code: number | null, signal: string | null): string =>
  signal ? `killed by ${signal}` : `code ${code}`;

// ANSI color sequences — the string form keeps the control byte out of a
// regex literal (noControlCharactersInRegex).
// biome-ignore lint/complexity/useRegexLiterals: the literal form is lint-rejected
const ANSI_RE = new RegExp("\\u001b\\[[0-9;]*m", "g");

export interface EngineLauncher {
  /** Name used in logs/state reports ("engine-fake", "hermes"). */
  name: string;
  /** Start the engine and return once its protocol endpoint is reachable. */
  start(): Promise<LaunchedEngine>;
}

/* #412/#507: the engine spawn — and every agent shell under it — gets the
   allow-listed env from `@lilos/contracts/env` (an agent running
   `env | grep LILOS` must not be handed the relay token or pointers into
   ~/.lilos). Entries a session legitimately needs (the gateway URL +
   engine token the lilos plugin reads) ride `options.env` — merged AFTER
   the scrub, so an explicit grant always wins. */

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
  /**
   * Reserved exit codes that mean "retrying won't help" (#95): a child
   * exiting with one rejects with FatalEngineStart — the supervisor fails
   * the engine immediately instead of counting a restartable crash.
   */
  fatalExitCodes?: number[];
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
          env: {
            ...scrubLilosEnv(process.env),
            ...options.env,
          } as NodeJS.ProcessEnv,
          // stdin stays an open pipe: engines that watch it (serve.ts
          // --watch-stdin) see EOF the moment this process dies — even via
          // SIGKILL, which skips every shutdown handler (#84).
          stdio: ["pipe", "pipe", "pipe"],
        });
        const exited = new Promise<EngineExit>((r) => {
          child.once("exit", (code, signal) => r({ code, signal }));
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
        let readyMatched = false;
        /* #521: the child's output mirrors into the harness log — the
           adapter's `hermes backend down:`/`up` diagnostics live only on
           this stream, so without forwarding they never reach
           harness.log. `out` itself stops growing once ready matched. */
        let outLine = "";
        let errLine = "";
        const mirrorLine = (line: string, into: "out" | "err") => {
          const text = line.replace(ANSI_RE, "").trimEnd();
          if (!text) return;
          const clipped = text.length > 500 ? `${text.slice(0, 500)}…` : text;
          if (into === "out")
            options.log.info(`engine ${options.name}: ${clipped}`);
          else options.log.warn(`engine ${options.name} stderr: ${clipped}`);
        };
        const mirrorChunk = (text: string, into: "out" | "err") => {
          let buf = (into === "out" ? outLine : errLine) + text;
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";
          if (into === "out") outLine = buf;
          else errLine = buf;
          for (const line of lines) mirrorLine(line, into);
        };
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
          mirrorChunk(text, into);
          if (into !== "out") {
            err += text;
            // The exit tail needs only the last few lines — bound the buffer.
            if (err.length > 32_000) err = err.slice(-16_000);
            return;
          }
          if (readyMatched) return;
          out += text;
          const match = options.readyPattern.exec(out);
          if (match) {
            readyMatched = true;
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
        child.stderr?.on("data", (c) => onLine(c as Buffer, "err"));
        child.once("error", (error) => {
          clearTimeout(timer);
          reject(new Error(`engine ${options.name} spawn failed: ${error}`));
        });
        child.once("exit", (code, signal) => {
          clearTimeout(timer);
          // Flush the trailing partial line — a killed child ends mid-line.
          if (outLine) mirrorLine(outLine, "out");
          if (errLine) mirrorLine(errLine, "err");
          const why = exitReason(code, signal);
          const tail = err
            .replace(ANSI_RE, "") // keep color junk out of status text
            .trim()
            .split("\n")
            .slice(-3)
            .join(" | ");
          // A reserved fatal code carries its plain verdict on stderr (#95);
          // otherwise the generic reason names the signal it died from.
          if (code !== null && options.fatalExitCodes?.includes(code)) {
            reject(
              new FatalEngineStart(
                tail || `engine ${options.name} exited before ready (${why})`,
              ),
            );
            return;
          }
          reject(
            new Error(
              `engine ${options.name} exited before ready (${why})${tail ? `: ${tail}` : ""}`,
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
  /**
   * Argv marker for e2e leak assertions (`pgrep -f "--tag <tag>">`).
   */
  tag?: string;
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
  return [
    ...serve,
    "--port",
    "0",
    "--tick",
    String(options.tick ?? 25),
    // Die with the harness: stdin EOF means the launcher process is gone.
    "--watch-stdin",
    ...(options.tag ? ["--tag", options.tag] : []),
  ];
}

/** `fake serve` through the command launcher — the CI/dev engine. */
export function fakeEngineLauncher(options: {
  repoRoot: string;
  tick?: number;
  bun?: string;
  serveBin?: string;
  tag?: string;
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
 * The Hermes adapter's argv (#85): a bundled `lilos-engine-nous` binary or
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
  /** #288: persisted session registry — restart resumes, not rebinds. */
  sessionsFile?: string;
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
            "The Hermes engine adapter (lilos-engine-nous) is not part of this build — it should ship in every bundle.",
          );
        })();
  const command = [...serve, "--port", "0", "--hermes-bin", options.hermesBin];
  if (options.provider) command.push("--provider", options.provider);
  if (options.model) command.push("--model", options.model);
  if (options.sessionsFile)
    command.push("--sessions-file", options.sessionsFile);
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
  /** #288: where the adapter persists its resumable session rows. */
  sessionsFile?: string;
  /** Extra env for the adapter (and, through it, `hermes serve`) — the #339
     gateway surfaces credentials ride this so the lilos plugin can reach
     the gateway from inside Hermes. */
  env?: Record<string, string>;
  log: Logger;
}): EngineLauncher {
  return {
    name: "hermes",
    start: async () => {
      const hermesBin = options.hermesBin ?? resolveHermesBin();
      // Up-front gate (AC-1, #95): a Hermes older than the minimum would die
      // on the handshake anyway — fail fatally now with the plain verdict
      // instead of looping retries. An unreadable probe never blocks: the
      // adapter's reserved exit code still catches it on the handshake.
      const found = probeHermesVersion(hermesBin);
      if (found !== undefined && !isHermesVersionSupported(found)) {
        options.log.warn("hermes too old", { hermesBin, found });
        throw new FatalEngineStart(hermesTooOldMessage(found));
      }
      const command = hermesServeCommand({ ...options, hermesBin });
      options.log.info("hermes binary", { hermesBin });
      return commandLauncher({
        name: "hermes",
        command,
        readyPattern: /LISTENING (ws:\/\/\S+)/,
        startupTimeoutMs: 300_000, // hermes serve cold-starts ACP tooling
        fatalExitCodes: [
          HERMES_TOO_OLD_EXIT_CODE,
          HERMES_HOST_CONFLICT_EXIT_CODE,
        ],
        env: options.env,
        log: options.log,
      }).start();
    },
  };
}

/** `hermes --version`, best-effort; undefined when the answer has no semver. */
function probeHermesVersion(hermesBin: string): string | undefined {
  try {
    const r = spawnSync(hermesBin, ["--version"], {
      encoding: "utf8",
      timeout: 10_000,
      env: scrubLilosEnv(process.env), // hermes runs LilOS profile code (#507)
    });
    return parseHermesVersion(`${r.stdout ?? ""}\n${r.stderr ?? ""}`);
  } catch {
    return undefined;
  }
}

/** Connect to an engine the harness does not supervise (e.g. the user's own). */
export function externalEngineLauncher(url: string): EngineLauncher {
  return {
    name: "external",
    start: async () => ({ url }),
  };
}
