import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { launcherFor, resolveHarnessConfig } from "../src/config";
import { fakeServeCommand, hermesServeCommand } from "../src/engine/launcher";
import { createMemoryLogger } from "../src/log";

/**
 * Issue #85 — release builds run the real engine (Hermes); engine-fake is
 * test/dev only. The config default flips to `hermes`, a dev build stamps
 * `LILOS_ENGINE_DEFAULT=fake` into the bundle, and an unknown kind errors
 * instead of silently faking.
 */

const env = (e: Record<string, string | undefined> = {}) => {
  const home = mkdtempSync(join(tmpdir(), "lilos-cfg-"));
  return {
    LILOS_RELAY_TOKEN: "tok",
    LILOS_RELAY_HOME: home,
    LILOS_HARNESS_HOME: join(home, "harness"),
    ...e,
  };
};

afterEach(() => {
  // Tests exercise the compile-time stamp knob directly.
  delete process.env.LILOS_ENGINE_DEFAULT;
});

/** A repo-root stand-in carrying the engine serve entrypoints. */
const mkRepo = (...adapters: ("engine-hermes" | "engine-fake")[]) => {
  const root = mkdtempSync(join(tmpdir(), "lilos-repo-"));
  for (const a of adapters) {
    const dir = join(root, "packages", a, "scripts");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "serve.ts"), "// serve\n");
  }
  return root;
};

describe("AC-1 (#85) release builds default to the real engine", () => {
  it("engine defaults to hermes when LILOS_ENGINE is unset", () => {
    expect(resolveHarnessConfig(env()).engine.kind).toBe("hermes");
  });

  it("an unknown LILOS_ENGINE value is an error, never a silent fake", () => {
    expect(() => resolveHarnessConfig(env({ LILOS_ENGINE: "bogus" }))).toThrow(
      /LILOS_ENGINE/,
    );
  });

  it("a build-stamped LILOS_ENGINE_DEFAULT applies when LILOS_ENGINE is unset", () => {
    process.env.LILOS_ENGINE_DEFAULT = "fake";
    expect(resolveHarnessConfig(env()).engine.kind).toBe("fake");
  });

  it("LILOS_ENGINE overrides the stamped default", () => {
    process.env.LILOS_ENGINE_DEFAULT = "hermes";
    expect(
      resolveHarnessConfig(env({ LILOS_ENGINE: "fake" })).engine.kind,
    ).toBe("fake");
  });
});

describe("AC-3 (#85) provider and model belong to the engine", () => {
  it("hermes config carries no provider/model by default", () => {
    expect(resolveHarnessConfig(env()).engine).toEqual({ kind: "hermes" });
  });

  it("the hermes serve command has no --provider/--model flags by default", () => {
    const argv = hermesServeCommand({
      repoRoot: mkRepo("engine-hermes"),
      hermesBin: "/home/o/.local/bin/hermes",
    });
    expect(argv).toContain("--hermes-bin");
    expect(argv).not.toContain("--provider");
    expect(argv).not.toContain("--model");
  });

  it("HERMES_PROVIDER/HERMES_MODEL are the only overrides and pass through", () => {
    const cfg = resolveHarnessConfig(
      env({ HERMES_PROVIDER: "openai-codex", HERMES_MODEL: "qwen3.8" }),
    );
    expect(cfg.engine).toEqual({
      kind: "hermes",
      provider: "openai-codex",
      model: "qwen3.8",
    });
    const argv = hermesServeCommand({
      repoRoot: mkRepo("engine-hermes"),
      hermesBin: "/x/hermes",
      provider: "openai-codex",
      model: "qwen3.8",
    });
    expect(argv).toContain("--provider");
    expect(argv).toContain("openai-codex");
    expect(argv).toContain("--model");
  });
});

describe("AC-4 (#85) the fake engine stays behind an explicit setting", () => {
  it("LILOS_ENGINE=fake still selects the fake engine", () => {
    expect(resolveHarnessConfig(env({ LILOS_ENGINE: "fake" })).engine).toEqual({
      kind: "fake",
    });
  });

  it("a bundle without lilos-engine-fake refuses loudly instead of faking", async () => {
    const cfg = resolveHarnessConfig(env({ LILOS_ENGINE: "fake" }));
    const launcher = launcherFor(
      cfg,
      "/nonexistent-repo",
      createMemoryLogger(),
    );
    // No serveBin next to execPath and no repo checkout: must not spawn.
    await expect(launcher.start()).rejects.toThrow(/fake engine/i);
  });

  it("the fake serve command uses the bundled binary when one is passed", () => {
    const argv = fakeServeCommand({
      repoRoot: mkRepo("engine-fake"),
      serveBin: "/app/Contents/MacOS/lilos-engine-fake",
    });
    expect(argv[0]).toBe("/app/Contents/MacOS/lilos-engine-fake");
  });
});

describe("AC-1/AC-2 (#85) the hermes adapter ships in the bundle", () => {
  it("the serve command prefers a bundled lilos-engine-nous binary", () => {
    const argv = hermesServeCommand({
      repoRoot: "/repo",
      serveBin: "/app/Contents/MacOS/lilos-engine-nous",
      hermesBin: "/home/o/.local/bin/hermes",
    });
    expect(argv[0]).toBe("/app/Contents/MacOS/lilos-engine-nous");
  });

  it("a bundle without lilos-engine-nous errors plainly", () => {
    expect(() =>
      hermesServeCommand({
        repoRoot: "/nonexistent-repo",
        hermesBin: "/x/hermes",
      }),
    ).toThrow(/hermes/i);
  });
});
