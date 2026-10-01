import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CONNECT_APPROVAL_KEY, HermesConnect } from "../src/connect";
import { createMemoryLogger } from "../src/log";

/**
 * Issue #339 — Connect reconciler.
 * AC-1: one approval installs + enables the bundled plugin per employee
 *       profile; removal disables, never deletes the profile.
 * AC-6: a version drift re-copies and re-enables without asking again.
 * AC-7: declined keeps everything untouched and rows read "not-connected".
 */

interface Call {
  argv: string[];
}

function fixture(version = "0.1.0") {
  const pluginSrc = mkdtempSync(join(tmpdir(), "lilos339-plugin-"));
  writeFileSync(
    join(pluginSrc, "plugin.yaml"),
    `name: lilos\nversion: "${version}"\ndescription: t\n`,
  );
  writeFileSync(join(pluginSrc, "__init__.py"), "def register(ctx): ...\n");
  const hermesHome = mkdtempSync(join(tmpdir(), "lilos339-home-"));
  const settings = new Map<string, unknown>();
  const calls: Call[] = [];
  const employees: { id: string; name: string; profile?: string }[] = [];
  const mkProfile = (p: string) =>
    mkdirSync(join(hermesHome, "profiles", p), { recursive: true });

  const connect = new HermesConnect({
    relay: {
      request: async (method, params) => {
        if (method === "settings.get")
          return { value: settings.get(String(params.key)) };
        if (method === "employees.list") return { employees };
        throw new Error(`unexpected ${method}`);
      },
    },
    hermesBin: () => "/bin/true",
    hermesHome,
    pluginSrc,
    log: createMemoryLogger(),
    run: (argv) => {
      calls.push({ argv });
      return { status: 0, out: "" };
    },
  });

  return {
    pluginSrc,
    hermesHome,
    settings,
    calls,
    employees,
    connect,
    mkProfile,
    approve: () => settings.set(CONNECT_APPROVAL_KEY, { approved: true }),
    installedYaml: (p: string) =>
      existsSync(
        join(hermesHome, "profiles", p, "plugins", "lilos", "plugin.yaml"),
      )
        ? readFileSync(
            join(hermesHome, "profiles", p, "plugins", "lilos", "plugin.yaml"),
            "utf8",
          )
        : undefined,
    enableCalls: (p: string) =>
      calls.filter(
        (c) =>
          c.argv.join(" ") ===
          ["-p", p, "plugins", "enable", "lilos"].join(" "),
      ).length,
    disableCalls: (p: string) =>
      calls.filter(
        (c) =>
          c.argv.join(" ") ===
          ["-p", p, "plugins", "disable", "lilos"].join(" "),
      ).length,
  };
}

describe("AC-1 (#339) approval installs + enables the plugin per profile", () => {
  it("copies the bundled plugin into each employee profile and enables it", async () => {
    const f = fixture();
    f.employees.push(
      { id: "e1", name: "Ada", profile: "ada" },
      { id: "e2", name: "Grace", profile: "grace" },
    );
    f.mkProfile("ada");
    f.mkProfile("grace");
    f.approve();
    await f.connect.reconcile();

    expect(f.installedYaml("ada")).toContain('version: "0.1.0"');
    expect(f.installedYaml("grace")).toContain('version: "0.1.0"');
    expect(f.enableCalls("ada")).toBe(1);
    expect(f.enableCalls("grace")).toBe(1);
    expect(f.connect.report()).toEqual([
      { profile: "ada", employee: "Ada", state: "connected" },
      { profile: "grace", employee: "Grace", state: "connected" },
    ]);
  });

  it("a failed enable marks the row failed with the reason", async () => {
    const f = fixture();
    f.employees.push({ id: "e1", name: "Ada", profile: "ada" });
    f.mkProfile("ada");
    f.approve();
    const failing = new HermesConnect({
      relay: {
        request: async (method) => {
          if (method === "settings.get") return { value: { approved: true } };
          if (method === "employees.list") return { employees: f.employees };
          throw new Error("unexpected");
        },
      },
      hermesBin: () => "/bin/true",
      hermesHome: f.hermesHome,
      pluginSrc: f.pluginSrc,
      log: createMemoryLogger(),
      run: () => ({ status: 2, out: "boom\nplugins: no such plugin" }),
    });
    await failing.reconcile();
    const [row] = failing.report();
    expect(row.state).toBe("failed");
    expect(row.reason).toContain("plugins enable failed");
  });
});

describe("AC-6 (#339) updates replace the plugin without re-asking", () => {
  it("re-copies on version drift and re-enables — same version is a no-op", async () => {
    const f = fixture("0.1.0");
    f.employees.push({ id: "e1", name: "Ada", profile: "ada" });
    f.mkProfile("ada");
    f.approve();
    await f.connect.reconcile();
    expect(f.enableCalls("ada")).toBe(1);

    // Same version, next reconcile: nothing to do.
    await f.connect.reconcile();
    expect(f.enableCalls("ada")).toBe(1);

    // Ship 0.2.0: write the older version into the profile first.
    writeFileSync(
      join(f.hermesHome, "profiles", "ada", "plugins", "lilos", "plugin.yaml"),
      `name: lilos\nversion: "0.0.9"\n`,
    );
    writeFileSync(
      join(f.pluginSrc, "plugin.yaml"),
      `name: lilos\nversion: "0.2.0"\n`,
    );
    await f.connect.reconcile();
    expect(f.installedYaml("ada")).toContain('version: "0.2.0"');
    expect(f.enableCalls("ada")).toBe(2);
    expect(f.connect.report()[0].state).toBe("connected");
  });
});

describe("AC-7 (#339) decline keeps chat working and Connect works later", () => {
  it("no approval: nothing installed, rows read not-connected; later approval connects", async () => {
    const f = fixture();
    f.employees.push({ id: "e1", name: "Ada", profile: "ada" });
    f.mkProfile("ada");
    await f.connect.reconcile();

    expect(f.calls.length).toBe(0);
    expect(f.installedYaml("ada")).toBeUndefined();
    expect(f.connect.report()).toEqual([
      { profile: "ada", employee: "Ada", state: "not-connected" },
    ]);

    f.approve();
    await f.connect.reconcile();
    expect(f.connect.report()[0].state).toBe("connected");
    expect(f.enableCalls("ada")).toBe(1);
  });
});

describe("AC-1 (#339) removal disables the plugin, never deletes the profile", () => {
  it("employee.removed runs plugins disable and drops the row", async () => {
    const f = fixture();
    f.employees.push({ id: "e1", name: "Ada", profile: "ada" });
    f.mkProfile("ada");
    f.approve();
    await f.connect.reconcile();
    expect(f.connect.report()[0].state).toBe("connected");

    f.connect.employeeRemoved("e1");
    expect(f.disableCalls("ada")).toBe(1);
    expect(f.connect.report()).toEqual([]);
    // The profile itself is untouched — only the plugin was disabled.
    expect(existsSync(join(f.hermesHome, "profiles", "ada"))).toBe(true);
  });

  it("a reconcile after the roster shrinks disables the dropped profile", async () => {
    const f = fixture();
    f.employees.push(
      { id: "e1", name: "Ada", profile: "ada" },
      { id: "e2", name: "Grace", profile: "grace" },
    );
    f.mkProfile("ada");
    f.mkProfile("grace");
    f.approve();
    await f.connect.reconcile();

    f.employees.splice(0, 1);
    await f.connect.reconcile();
    expect(f.disableCalls("ada")).toBe(1);
    expect(f.connect.report()).toEqual([
      { profile: "grace", employee: "Grace", state: "connected" },
    ]);
  });
});
