import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import { devinSpec } from "../shims/devin.js";
import type { AcpLaunchSpec } from "../src/launch.js";
import {
  probeAgentCommand,
  provisionRoot,
  resolveAgentCommand,
  verifyAgentCommand,
} from "../src/provision.js";

/**
 * D-#866 — npm-distribution provisioning. The fixture is a local `file:`
 * package so the whole path (staging, install, cache, runner, probe) is
 * exercised offline — CI never fetches from a registry.
 */

/* The test runtime itself (node under vitest, bun under `bun test`)
   stands in as the local JS runtime + installer — PATH carries only it. */
const RUNTIME = process.execPath;

const tmp = () => mkdtempSync(join(tmpdir(), "lilos-prov-test-"));

/** Minimal env: PATH with only bun, HOME fresh (keeps bun's own cache +
    EXTRA_BIN_DIRS' ~/.bun/bin inside the sandbox). */
const env = (home: string): NodeJS.ProcessEnv => ({
  PATH: dirname(RUNTIME),
  HOME: home,
});

/** A fake ACP adapter package on disk — a `file:` version makes npm/bun
    install it without any network. */
const fixturePkg = (root: string): string => {
  const dir = join(root, "fake-agent-pkg");
  mkdirSync(join(dir, "dist"), { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: "lilos-fake-acp-agent",
      version: "1.2.3",
      type: "module",
      bin: { "fake-acp": "dist/index.js" },
    }),
  );
  writeFileSync(
    join(dir, "dist", "index.js"),
    'if (process.argv.includes("--version")) console.log("fake-acp 1.2.3");\n',
  );
  return dir;
};

const spec = (over: Partial<AcpLaunchSpec>): AcpLaunchSpec => ({
  id: "fake",
  command: ["fake-acp"],
  verify: { args: ["--version"] },
  ...over,
});

describe("resolveAgentCommand", () => {
  test("an installed binary on PATH wins over provisioning", async () => {
    const home = tmp();
    const binDir = join(home, "bin");
    mkdirSync(binDir);
    const mine = join(binDir, "fake-acp");
    /* The win now requires a verifiable version ≥ the pin (r6) — the
       stub reports one. */
    writeFileSync(
      mine,
      '#!/bin/sh\n[ "$1" = "--version" ] && echo "fake-acp 9.9.9"\nexit 0\n',
    );
    chmodSync(mine, 0o755);
    const r = await resolveAgentCommand(
      spec({ provision: { npm: { package: "x", version: "1", bin: "b" } } }),
      { ...env(home), PATH: `${binDir}:${dirname(RUNTIME)}` },
    );
    expect(r.ok).toBe(true);
    expect(r.command).toEqual([mine]);
    rmSync(home, { recursive: true, force: true });
  });

  test("a PATH binary at or above the pin wins; below it loses", async () => {
    const home = tmp();
    const binDir = join(home, "bin");
    mkdirSync(binDir);
    const mine = join(binDir, "fake-acp");
    writeFileSync(
      mine,
      '#!/bin/sh\n[ "$1" = "--version" ] && echo "fake-acp 0.5.0"\nexit 0\n',
    );
    chmodSync(mine, 0o755);
    const e = {
      ...env(home),
      PATH: `${binDir}:${dirname(RUNTIME)}`,
      LILOS_ACP_CACHE: join(home, "acp-cache"),
    };
    /* Newer than the pin -> PATH keeps the win it always had. */
    const fresh = await resolveAgentCommand(
      spec({
        provision: { npm: { package: "x", version: "0.4.0", bin: "fake-acp" } },
      }),
      e,
    );
    expect(fresh.command).toEqual([mine]);
    /* Older than the pin -> the PATH binary must lose — an adapter that
       predates the access-meta gate hard-codes bypass (r6). The pin is
       unreachable offline, so resolution fails — but never by picking
       the stale PATH binary. */
    const stale = await resolveAgentCommand(
      spec({
        provision: { npm: { package: "x", version: "0.9.0", bin: "fake-acp" } },
      }),
      e,
    );
    expect(stale.command?.[0]).not.toBe(mine);
    /* An adapter that cannot report a version is unproven — same rule. */
    writeFileSync(mine, "#!/bin/sh\nexit 0\n");
    const silent = await resolveAgentCommand(
      spec({
        provision: { npm: { package: "x", version: "0.9.0", bin: "fake-acp" } },
      }),
      e,
    );
    expect(silent.command?.[0]).not.toBe(mine);
    rmSync(home, { recursive: true, force: true });
  });

  test("missing binary with no provision recipe reports not-on-PATH", async () => {
    const home = tmp();
    const r = await resolveAgentCommand(spec({}), env(home));
    expect(r.ok).toBe(false);
    expect(r.output).toContain("not on PATH");
    rmSync(home, { recursive: true, force: true });
  });

  test("provisions the pinned package into the Lilos cache, then reuses it", {
    timeout: 60_000,
  }, async () => {
    const home = tmp();
    const cache = join(home, "acp-cache");
    const pkg = fixturePkg(home);
    const s = spec({
      provision: {
        npm: {
          package: "lilos-fake-acp-agent",
          version: `file:${pkg}`,
          bin: "fake-acp",
        },
      },
    });
    const e = { ...env(home), LILOS_ACP_CACHE: cache };
    const r1 = await resolveAgentCommand(s, e);
    expect(r1.ok).toBe(true);
    expect(r1.command?.[0]).toBe(RUNTIME);
    /* Provisioned launches ride the generated runner shim — it scopes
       ELECTRON_RUN_AS_NODE to the adapter process (r6). The real entry
       lives inside the shim's import. */
    const shim = r1.command?.[1] ?? "";
    expect(shim.endsWith("lilos-run.mjs")).toBe(true);
    const shimBody = readFileSync(shim, "utf8");
    expect(shimBody).toContain("delete process.env.ELECTRON_RUN_AS_NODE");
    expect(shimBody).toContain(
      join("lilos-fake-acp-agent", "dist", "index.js").replaceAll("\\", "/"),
    );
    expect(shim.startsWith(cache)).toBe(true);
    /* The cache dir holds the provisioned package + its marker. */
    const [key] = readdirSync(cache).filter((d) => !d.startsWith("."));
    expect(existsSync(join(cache, key ?? "", ".lilos-provisioned"))).toBe(true);

    /* The probe answers through the provisioned command. */
    const p = await probeAgentCommand(s, e);
    expect(p.ok).toBe(true);
    expect(p.output).toContain("fake-acp 1.2.3");

    /* The shim really does scrub the runner env for the adapter's
       children: with the var set, the imported entry still sees none. */
    const scrubEntry = join(home, "env-check.mjs");
    writeFileSync(
      scrubEntry,
      'console.log("ERN=" + (process.env.ELECTRON_RUN_AS_NODE ?? "clean"));\n',
    );
    const probe = await resolveAgentCommand(s, e);
    const probeShim = probe.command?.[1] ?? "";
    /* Point the shim at the env-check entry and run it under the var. */
    writeFileSync(
      probeShim,
      "delete process.env.ELECTRON_RUN_AS_NODE;\n" +
        `await import(${JSON.stringify("file://" + scrubEntry)});\n`,
    );
    const run = spawnSync(probe.command?.[0] ?? "", [probeShim], {
      env: { ...e, ELECTRON_RUN_AS_NODE: "1" },
      encoding: "utf8",
    });
    expect(run.stdout).toContain("ERN=clean");

    /* Cache hit: the fixture dir can vanish — the installed tree is used. */
    rmSync(pkg, { recursive: true, force: true });
    const r2 = await resolveAgentCommand(s, e);
    expect(r2.ok).toBe(true);
    expect(r2.command?.[1]).toBe(shim);
    rmSync(home, { recursive: true, force: true });
  });

  test("the installer runs scrubbed, scripted-install-free, off the loop", {
    timeout: 60_000,
  }, async () => {
    const home = tmp();
    const cache = join(home, "acp-cache");
    const capture = join(home, "capture");
    mkdirSync(capture);
    const binDir = join(home, "bin");
    mkdirSync(binDir);
    /* A fake `bun` that satisfies the install contract itself — records
       argv + env, then fabricates the installed package. The probe's
       PATH sees it first, so resolveRunner picks it too. */
    writeFileSync(
      join(binDir, "bun"),
      `#!/bin/sh\nexport PATH="/usr/bin:/bin:$PATH"\necho "$@" > "${capture}/argv"\nenv > "${capture}/env"\nmkdir -p node_modules/lilos-fake-acp-agent/dist\necho '{"name":"lilos-fake-acp-agent","bin":{"fake-acp":"dist/index.js"}}' > node_modules/lilos-fake-acp-agent/package.json\necho 'if (process.argv.includes("--version")) console.log("fake-acp 9.9.9");' > node_modules/lilos-fake-acp-agent/dist/index.js\n`,
    );
    chmodSync(join(binDir, "bun"), 0o755);
    const s = spec({
      provision: {
        npm: {
          package: "lilos-fake-acp-agent",
          version: "9.9.9",
          bin: "fake-acp",
        },
      },
    });
    const e = {
      ...env(home),
      PATH: `${binDir}:${dirname(RUNTIME)}`,
      LILOS_ACP_CACHE: cache,
      LILOS_RELAY_TOKEN: "should-never-reach-the-installer",
    };
    const r = await resolveAgentCommand(s, e);
    expect(r.ok).toBe(true);
    const argv = readFileSync(join(capture, "argv"), "utf8");
    expect(argv).toContain("--ignore-scripts");
    const installerEnv = readFileSync(join(capture, "env"), "utf8");
    expect(installerEnv).not.toContain("LILOS_RELAY_TOKEN");
    rmSync(home, { recursive: true, force: true });
  });

  test("no JS runtime or package manager reports the reason", async () => {
    const home = tmp();
    const r = await resolveAgentCommand(
      spec({ provision: { npm: { package: "x", version: "1", bin: "b" } } }),
      { PATH: "/nonexistent", HOME: home, LILOS_EXTRA_BIN_DIRS: "" },
    );
    expect(r.ok).toBe(false);
    expect(r.output).toContain("no JS runtime");
    rmSync(home, { recursive: true, force: true });
  });

  test("a failed fetch reports why instead of looping", async () => {
    const home = tmp();
    const r = await resolveAgentCommand(
      spec({
        provision: {
          npm: {
            package: "lilos-fake-acp-agent",
            version: "file:/nonexistent-pkg",
            bin: "fake-acp",
          },
        },
      }),
      { ...env(home), LILOS_ACP_CACHE: join(home, "acp-cache") },
    );
    expect(r.ok).toBe(false);
    /* bun fails the resolve; npm stubs a file: dep — either way the
       reason is reported, not retried. */
    expect(r.output).toMatch(/install failed|no "fake-acp" bin entry/);
    /* Nothing half-installed is left behind — the staging dir is
       removed, so the cache holds no package dirs. */
    expect(
      readdirSync(join(home, "acp-cache")).filter((d) => !d.startsWith(".")),
    ).toEqual([]);
    rmSync(home, { recursive: true, force: true });
  });
});

describe("probeAgentCommand", () => {
  test("a PATH binary's probe drops the launch args — `devin --version`, never `devin acp … --version`", async () => {
    /* r4 regression: merging spec.command args into the verify probe
       produced `devin acp --model swe-2-high --version`, which the real
       CLI rejects — the runtime reported available:false on a healthy
       install. The fake fails if its first arg is not --version, so only
       the bare binary + verify args pass. */
    const home = tmp();
    const binDir = join(home, "bin");
    mkdirSync(binDir);
    writeFileSync(
      join(binDir, "devin"),
      '#!/bin/sh\n[ "$1" = "--version" ] || { echo "unexpected argument $1" >&2; exit 2; }\necho "devin acp 9.9.9"\n',
    );
    chmodSync(join(binDir, "devin"), 0o755);
    const p = await probeAgentCommand(devinSpec, {
      ...env(home),
      PATH: `${binDir}:${dirname(RUNTIME)}`,
    });
    expect(p.ok).toBe(true);
    expect(p.output).toContain("devin acp 9.9.9");
    /* The launch form keeps the spec's args — only the probe drops them. */
    const r = await resolveAgentCommand(devinSpec, {
      ...env(home),
      PATH: `${binDir}:${dirname(RUNTIME)}`,
    });
    expect(r.command).toEqual([
      join(binDir, "devin"),
      "acp",
      "--model",
      "swe-2-high",
    ]);
    /* r6: serve.ts's own startup check runs the SAME probe through
       verifyAgentCommand — `devin --version`, never the launch argv +
       --version (the real CLI rejected that and serve exited 1 while
       the status row read available). */
    const v = await verifyAgentCommand(devinSpec, r, {
      ...env(home),
      PATH: `${binDir}:${dirname(RUNTIME)}`,
    });
    expect(v.ok).toBe(true);
    expect(v.output).toContain("devin acp 9.9.9");
    rmSync(home, { recursive: true, force: true });
  });
});

describe("provisionRoot", () => {
  test("defaults under the app home, honors the env override", () => {
    expect(provisionRoot({ HOME: "/h" })).toBe(join("/h", ".lilos", "acp"));
    expect(provisionRoot({ HOME: "/h", LILOS_ACP_CACHE: "/c" })).toBe("/c");
  });
});
