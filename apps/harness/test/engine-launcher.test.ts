import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LILOS_ENV_ALLOW_LIST } from "@lilos/contracts/env";
import { SURFACES_ENV } from "@lilos/surfaces";
import { describe, expect, it } from "vitest";
import {
  commandLauncher,
  FatalEngineStart,
  hermesEngineLauncher,
  isFatalEngineStart,
} from "../src/engine/launcher";
import { createMemoryLogger } from "../src/log";
import { ptySpawnEnv } from "../src/surfaces/pty";

/**
 * Issue #95 — engine start failures read plainly.
 * AC-2: a child killed by a signal reports `killed by SIG…`, not `code null`.
 * AC-1: an adapter exit on the reserved too-old code is fatal — no retries.
 */

const log = () => createMemoryLogger();

/** A tiny executable script in a temp dir. */
function stubBin(name: string, body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "lilos-bin-"));
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

describe("AC-2 (#95) the exit reason carries the signal", () => {
  it("a child SIGKILLed before ready reports 'killed by SIGKILL'", async () => {
    const launcher = commandLauncher({
      name: "victim",
      command: ["sh", "-c", "kill -9 $$"],
      readyPattern: /NEVER/,
      log: log(),
    });
    await expect(launcher.start()).rejects.toThrow(/killed by SIGKILL/);
  });

  it("a clean exit still reports the code", async () => {
    const launcher = commandLauncher({
      name: "victim",
      command: ["sh", "-c", "exit 3"],
      readyPattern: /NEVER/,
      log: log(),
    });
    await expect(launcher.start()).rejects.toThrow(/code 3/);
  });

  it("exited resolves {code, signal} after ready", async () => {
    const launcher = commandLauncher({
      name: "longlived",
      command: ["sh", "-c", "echo LISTENING ws://x; sleep 30"],
      readyPattern: /LISTENING (ws:\/\/\S+)/,
      startupTimeoutMs: 10_000,
      log: log(),
    });
    const launched = await launcher.start();
    launched.process?.kill(); // SIGTERM
    await expect(launched.process?.exited).resolves.toMatchObject({
      code: null,
      signal: "SIGTERM",
    });
  });
});

describe("AC-1 (#95) a too-old Hermes is fatal — no retry loop", () => {
  it("a child exiting on the reserved too-old code fails fatally with its stderr line", async () => {
    const launcher = commandLauncher({
      name: "hermes",
      command: [
        "sh",
        "-c",
        "echo 'Hermes 0.20.2 is too old — LilOS needs 0.21.5 or newer. Run `hermes update`.' >&2; exit 86",
      ],
      readyPattern: /NEVER/,
      fatalExitCodes: [86],
      log: log(),
    });
    const err = await launcher.start().catch((e) => e);
    expect(isFatalEngineStart(err)).toBe(true);
    expect(err).toBeInstanceOf(FatalEngineStart);
    expect(String(err)).toContain("too old");
    expect(String(err)).toContain("hermes update");
  });

  it("the same exit code is an ordinary crash when not declared fatal", async () => {
    const launcher = commandLauncher({
      name: "hermes",
      command: ["sh", "-c", "exit 86"],
      readyPattern: /NEVER/,
      log: log(),
    });
    const err = await launcher.start().catch((e) => e);
    expect(isFatalEngineStart(err)).toBe(false);
  });

  it("hermesEngineLauncher probes `hermes --version` and refuses an old Hermes before spawning the adapter", async () => {
    // Stub reports an old version; it also records every invocation.
    const dir = mkdtempSync(join(tmpdir(), "lilos-bin-"));
    const calls = join(dir, "calls.log");
    const bin = join(dir, "hermes");
    writeFileSync(
      bin,
      `#!/bin/sh\necho "$@" >> "${calls}"\nif [ "$1" = "--version" ]; then echo "Hermes Agent v0.20.2"; exit 0; fi\nexit 0\n`,
    );
    chmodSync(bin, 0o755);

    const launcher = hermesEngineLauncher({
      repoRoot: "/nonexistent-repo", // adapter spawn would throw its own error
      hermesBin: bin,
      log: log(),
    });
    const err = await launcher.start().catch((e) => e);
    expect(isFatalEngineStart(err)).toBe(true);
    expect(String(err)).toBe(
      "Error: Hermes 0.20.2 is too old — LilOS needs 0.21.5 or newer. Run `hermes update`.",
    );
  });

  it("a Hermes at the minimum version proceeds to launch", async () => {
    const bin = stubBin(
      "hermes",
      `if [ "$1" = "--version" ]; then echo "Hermes Agent v9.9.9"; exit 0; fi\nexit 0`,
    );
    const launcher = hermesEngineLauncher({
      repoRoot: "/nonexistent-repo",
      hermesBin: bin,
      log: log(),
    });
    // A supported version moves past the probe — the next failure is the
    // missing adapter script, not the too-old verdict.
    const err = await launcher.start().catch((e) => e);
    expect(isFatalEngineStart(err)).toBe(false);
    expect(String(err)).toMatch(/not part of this build/);
  });
});

describe("AC-3 (#548) a host-owner conflict is fatal — no retry loop", () => {
  it("a child exiting on the reserved conflict code fails fatally with its stderr line", async () => {
    const launcher = commandLauncher({
      name: "hermes",
      command: [
        "sh",
        "-c",
        "echo 'another Hermes backend is already running on this Mac (PID 96194, port 55066)' >&2; exit 87",
      ],
      readyPattern: /NEVER/,
      fatalExitCodes: [87],
      log: log(),
    });
    const err = await launcher.start().catch((e) => e);
    expect(isFatalEngineStart(err)).toBe(true);
    expect(err).toBeInstanceOf(FatalEngineStart);
    expect(String(err)).toContain("another Hermes backend is already running");
  });
});

describe("#521 engine output mirrors into the harness log", () => {
  it("stdout lines keep landing in the logger after ready (#521)", async () => {
    const logger = log();
    const launcher = commandLauncher({
      name: "hermes",
      command: [
        "sh",
        "-c",
        "echo LISTENING ws://x; echo 'hermes backend down: gateway socket closed'; sleep 0.2",
      ],
      readyPattern: /LISTENING (ws:\/\/\S+)/,
      startupTimeoutMs: 10_000,
      log: logger,
    });
    await launcher.start();
    await new Promise((r) => setTimeout(r, 400));
    expect(logger.lines.join("\n")).toContain(
      "engine hermes: hermes backend down: gateway socket closed",
    );
  });

  it("stderr mirrors at warn and the trailing partial line flushes on exit", async () => {
    const logger = log();
    const launcher = commandLauncher({
      name: "victim",
      command: [
        "sh",
        "-c",
        "echo 'warn-one' >&2; printf 'tail-partial' >&2; exit 2",
      ],
      readyPattern: /NEVER/,
      log: logger,
    });
    await expect(launcher.start()).rejects.toThrow(/code 2/);
    const lines = logger.lines.join("\n");
    expect(lines).toContain("engine victim stderr: warn-one");
    expect(lines).toContain("engine victim stderr: tail-partial");
  });
});

describe("AC-1 (#412) the engine env is allow-listed — no LilOS internals", () => {
  it("the shared allow-list names exactly the surfaces creds it must pass", () => {
    /* LILOS_ENV_ALLOW_LIST lives in @lilos/contracts so packages/host can
       share it (#507) — its literal names must stay equal to SURFACES_ENV
       or the engine silently loses a grant. */
    expect(LILOS_ENV_ALLOW_LIST).toEqual([
      SURFACES_ENV.baseUrl,
      SURFACES_ENV.engineToken,
    ]);
  });

  it("the child sees only the documented LILOS_* names; options.env grants survive", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lilos-env-"));
    const out = join(dir, "env.txt");
    const poison = [
      "LILOS_RELAY_TOKEN",
      "LILOS_RELAY_HOME",
      "LILOS_HARNESS_HOME",
      "LILOS_WORKDIR",
      "LILOS_INTERNAL_MARKER",
    ];
    const prev = Object.fromEntries(poison.map((k) => [k, process.env[k]]));
    process.env.LILOS_RELAY_TOKEN = "relay-secret";
    process.env.LILOS_RELAY_HOME = "/lilos/relay";
    process.env.LILOS_HARNESS_HOME = "/lilos/harness";
    process.env.LILOS_WORKDIR = "/lilos/harness/work";
    process.env.LILOS_INTERNAL_MARKER = "not-for-agents";
    try {
      const launcher = commandLauncher({
        name: "envtest",
        command: ["sh", "-c", `env > "${out}"; echo LISTENING ws://x`],
        readyPattern: /LISTENING (ws:\/\/\S+)/,
        env: {
          LILOS_SURFACES_URL: "http://127.0.0.1:9/gw",
          LILOS_ENGINE_TOKEN: "eng-token",
        },
        log: log(),
      });
      await launcher.start();
      const childEnv = readFileSync(out, "utf8");
      const lilos = childEnv
        .split("\n")
        .filter((l) => l.startsWith("LILOS_"))
        .sort();
      // The whole harness LILOS_* set — relay token, homes, workdir, any
      // future internal marker — never reaches the engine; only the
      // documented pair (granted via options.env) does.
      expect(lilos).toEqual([
        "LILOS_ENGINE_TOKEN=eng-token",
        "LILOS_SURFACES_URL=http://127.0.0.1:9/gw",
      ]);
      // Non-LILOS_* env is the process environment, not LilOS state — it
      // passes through so providers/PATH keep working.
      expect(childEnv).toContain("PATH=");
    } finally {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it("a LILOS_* name in options.env is an explicit grant, not a leak", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lilos-env-"));
    const out = join(dir, "env.txt");
    const prev = process.env.LILOS_RELAY_TOKEN;
    process.env.LILOS_RELAY_TOKEN = "still-secret";
    try {
      await commandLauncher({
        name: "envtest",
        command: ["sh", "-c", `env > "${out}"; echo LISTENING ws://x`],
        readyPattern: /LISTENING (ws:\/\/\S+)/,
        // A caller that deliberately forwards a LILOS_* var (the gateway
        // creds today, any future engine-facing knob) keeps it.
        env: { LILOS_FUTURE_KNOB: "granted" },
        log: log(),
      }).start();
      const lilos = readFileSync(out, "utf8")
        .split("\n")
        .filter((l) => l.startsWith("LILOS_"))
        .sort();
      expect(lilos).toEqual(["LILOS_FUTURE_KNOB=granted"]);
    } finally {
      if (prev === undefined) delete process.env.LILOS_RELAY_TOKEN;
      else process.env.LILOS_RELAY_TOKEN = prev;
    }
  });

  it("ptySpawnEnv carries the same allow-list — the agent-facing terminal is scrubbed too", () => {
    const prevToken = process.env.LILOS_RELAY_TOKEN;
    const prevSurfaces = process.env.LILOS_SURFACES_URL;
    process.env.LILOS_RELAY_TOKEN = "pty-secret";
    process.env.LILOS_SURFACES_URL = "http://127.0.0.1:9/gw";
    try {
      const env = ptySpawnEnv();
      // The surfaces/browser + PTY spawns share the engine's allow-list:
      // the relay token and harness internals must not be `ps eww`-readable.
      expect(env.LILOS_RELAY_TOKEN).toBeUndefined();
      expect(env.LILOS_SURFACES_URL).toBe("http://127.0.0.1:9/gw");
      expect(env.TERM).toBe("xterm-256color");
      expect(env.COLORTERM).toBe("truecolor");
    } finally {
      if (prevToken === undefined) delete process.env.LILOS_RELAY_TOKEN;
      else process.env.LILOS_RELAY_TOKEN = prevToken;
      if (prevSurfaces === undefined) delete process.env.LILOS_SURFACES_URL;
      else process.env.LILOS_SURFACES_URL = prevSurfaces;
    }
  });
});
