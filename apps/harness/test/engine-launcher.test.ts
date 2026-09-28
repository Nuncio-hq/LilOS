import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  commandLauncher,
  FatalEngineStart,
  hermesEngineLauncher,
  isFatalEngineStart,
} from "../src/engine/launcher";
import { createMemoryLogger } from "../src/log";

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
