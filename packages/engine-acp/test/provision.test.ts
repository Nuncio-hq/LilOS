import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
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
  test("an installed binary on PATH wins over provisioning", () => {
    const home = tmp();
    const binDir = join(home, "bin");
    mkdirSync(binDir);
    const mine = join(binDir, "fake-acp");
    writeFileSync(mine, "#!/bin/sh\nexit 0\n");
    chmodSync(mine, 0o755);
    const r = resolveAgentCommand(
      spec({ provision: { npm: { package: "x", version: "1", bin: "b" } } }),
      { ...env(home), PATH: `${binDir}:${dirname(RUNTIME)}` },
    );
    expect(r.ok).toBe(true);
    expect(r.command).toEqual([mine]);
    rmSync(home, { recursive: true, force: true });
  });

  test("missing binary with no provision recipe reports not-on-PATH", () => {
    const home = tmp();
    const r = resolveAgentCommand(spec({}), env(home));
    expect(r.ok).toBe(false);
    expect(r.output).toContain("not on PATH");
    rmSync(home, { recursive: true, force: true });
  });

  test("provisions the pinned package into the LilOS cache, then reuses it", {
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
    const r1 = resolveAgentCommand(s, e);
    expect(r1.ok).toBe(true);
    expect(r1.command?.[0]).toBe(RUNTIME);
    const entry = r1.command?.[1] ?? "";
    expect(entry).toContain(join("lilos-fake-acp-agent", "dist", "index.js"));
    expect(entry.startsWith(cache)).toBe(true);
    /* The cache dir holds exactly the provisioned package + its marker. */
    const [key] = readdirSync(cache).filter((d) => !d.startsWith("."));
    expect(existsSync(join(cache, key ?? "", ".lilos-provisioned"))).toBe(true);

    /* The probe answers through the provisioned command. */
    const p = await probeAgentCommand(s, e);
    expect(p.ok).toBe(true);
    expect(p.output).toContain("fake-acp 1.2.3");

    /* Cache hit: the fixture dir can vanish — the installed tree is used. */
    rmSync(pkg, { recursive: true, force: true });
    const r2 = resolveAgentCommand(s, e);
    expect(r2.ok).toBe(true);
    expect(r2.command?.[1]).toBe(entry);
    rmSync(home, { recursive: true, force: true });
  });

  test("no JS runtime or package manager reports the reason", () => {
    const home = tmp();
    const r = resolveAgentCommand(
      spec({ provision: { npm: { package: "x", version: "1", bin: "b" } } }),
      { PATH: "/nonexistent", HOME: home, LILOS_EXTRA_BIN_DIRS: "" },
    );
    expect(r.ok).toBe(false);
    expect(r.output).toContain("no JS runtime");
    rmSync(home, { recursive: true, force: true });
  });

  test("a failed fetch reports why instead of looping", () => {
    const home = tmp();
    const r = resolveAgentCommand(
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
    const r = resolveAgentCommand(devinSpec, {
      ...env(home),
      PATH: `${binDir}:${dirname(RUNTIME)}`,
    });
    expect(r.command).toEqual([
      join(binDir, "devin"),
      "acp",
      "--model",
      "swe-2-high",
    ]);
    rmSync(home, { recursive: true, force: true });
  });
});

describe("provisionRoot", () => {
  test("defaults under the app home, honors the env override", () => {
    expect(provisionRoot({ HOME: "/h" })).toBe(join("/h", ".lilos", "acp"));
    expect(provisionRoot({ HOME: "/h", LILOS_ACP_CACHE: "/c" })).toBe("/c");
  });
});
