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
import {
  CONNECT_APPROVAL_KEY,
  FakeConnect,
  HermesConnect,
} from "../src/connect";
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

function fixture(version = "0.1.0", onChange?: () => void) {
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
    ...(onChange ? { onChange } : {}),
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
    toolSearchCalls: (p: string, enabled: string) =>
      calls.filter(
        (c) =>
          c.argv.join(" ") ===
          ["-p", p, "config", "set", "tools.tool_search.enabled", enabled].join(
            " ",
          ),
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
    /* #411: lilos_* must be offered directly — Hermes tool search defers
       every plugin tool behind `tool_search`, so the profile opts out. */
    expect(f.toolSearchCalls("ada", "off")).toBe(1);
    expect(f.toolSearchCalls("grace", "off")).toBe(1);
    expect(f.connect.report()).toEqual([
      { profile: "ada", employee: "Ada", state: "connected" },
      { profile: "grace", employee: "Grace", state: "connected" },
    ]);
  });

  it("the built-in default profile installs at the home root", async () => {
    const f = fixture();
    f.employees.push({ id: "e1", name: "Default", profile: "default" });
    f.approve();
    await f.connect.reconcile();

    // Hermes' `default` home is HERMES_HOME itself (plugins under
    // `<home>/plugins/`); `profiles/default` is never created.
    expect(
      existsSync(join(f.hermesHome, "plugins", "lilos", "plugin.yaml")),
    ).toBe(true);
    expect(existsSync(join(f.hermesHome, "profiles", "default"))).toBe(false);
    expect(f.enableCalls("default")).toBe(1);
    expect(f.connect.report()).toEqual([
      { profile: "default", employee: "Default", state: "connected" },
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

describe("AC-1 (#413) a removal landing mid-reconcile can't resurrect the row", () => {
  it("the stale in-flight roster skips the removed employee", async () => {
    const f = fixture();
    f.employees.push({ id: "e1", name: "Ada", profile: "ada" });
    f.mkProfile("ada");
    f.approve();

    // Gate the second reconcile's roster fetch so employee.removed lands
    // while it still holds the pre-removal list.
    let employeesCalls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const gated = new HermesConnect({
      relay: {
        request: async (method) => {
          if (method === "settings.get") return { value: { approved: true } };
          if (method === "employees.list") {
            employeesCalls++;
            if (employeesCalls > 1) await gate;
            return { employees: f.employees }; // stale: still lists e1
          }
          throw new Error(`unexpected ${method}`);
        },
      },
      hermesBin: () => "/bin/true",
      hermesHome: f.hermesHome,
      pluginSrc: f.pluginSrc,
      log: createMemoryLogger(),
      run: () => ({ status: 0, out: "" }),
    });

    await gated.reconcile(); // row connected, roster map knows e1→ada
    expect(gated.report()).toEqual([
      { profile: "ada", employee: "Ada", state: "connected" },
    ]);

    const second = gated.reconcile();
    gated.employeeRemoved("e1");
    release();
    await second;

    // Without the tombstone the stale roster recreates + re-enables ada.
    expect(gated.report()).toEqual([]);
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
    // The tool-search opt-out connect wrote is restored on the way out.
    expect(f.toolSearchCalls("ada", "auto")).toBe(1);
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

describe("AC-1 (#413) reconcile emits onChange only when the rows change", () => {
  it("fires on row transitions, not on a no-op reconcile", async () => {
    let emitted = 0;
    const f = fixture("0.1.0", () => emitted++);
    f.employees.push({ id: "e1", name: "Ada", profile: "ada" });
    f.mkProfile("ada");

    await f.connect.reconcile();
    expect(emitted).toBe(1); // the rows exist now: not-connected

    await f.connect.reconcile();
    expect(emitted).toBe(1); // same rows — nothing to re-report

    f.approve();
    await f.connect.reconcile();
    expect(emitted).toBe(2); // the flip to connected is the live event
  });

  it("a roster shrink emits too", async () => {
    let emitted = 0;
    const f = fixture("0.1.0", () => emitted++);
    f.employees.push({ id: "e1", name: "Ada", profile: "ada" });
    f.mkProfile("ada");
    await f.connect.reconcile();
    expect(emitted).toBe(1);

    f.employees.splice(0, 1);
    await f.connect.reconcile();
    expect(emitted).toBe(2);
    expect(f.connect.report()).toEqual([]);
  });
});

describe("AC-2 (#413) FakeConnect rows follow the approval on engine-fake", () => {
  function fakeFixture(onChange?: () => void) {
    const settings = new Map<string, unknown>();
    const employees: { id: string; name: string; profile?: string }[] = [];
    const connect = new FakeConnect({
      relay: {
        request: async (method, params) => {
          if (method === "settings.get")
            return { value: settings.get(String(params.key)) };
          if (method === "employees.list") return { employees };
          throw new Error(`unexpected ${method}`);
        },
      },
      ...(onChange ? { onChange } : {}),
    });
    return {
      settings,
      employees,
      connect,
      approve: () => settings.set(CONNECT_APPROVAL_KEY, { approved: true }),
    };
  }

  it("reports not-connected until Connect is approved, then connected", async () => {
    const f = fakeFixture();
    f.employees.push({ id: "e1", name: "Default", profile: "default" });
    await f.connect.reconcile();
    expect(f.connect.report()).toEqual([
      { profile: "default", employee: "Default", state: "not-connected" },
    ]);

    f.approve();
    await f.connect.reconcile();
    expect(f.connect.report()).toEqual([
      { profile: "default", employee: "Default", state: "connected" },
    ]);
  });

  it("emits onChange on the approval flip and drops removed employees", async () => {
    let emitted = 0;
    const f = fakeFixture(() => emitted++);
    f.employees.push(
      { id: "e1", name: "Default", profile: "default" },
      { id: "e2", name: "Ada", profile: "ada" },
    );
    await f.connect.reconcile();
    expect(emitted).toBe(1);

    f.approve();
    await f.connect.reconcile();
    expect(emitted).toBe(2);
    expect(f.connect.report().every((r) => r.state === "connected")).toBe(true);

    // The relay dropped e2 before employee.removed reached the harness.
    f.employees.splice(1, 1);
    f.connect.employeeRemoved("e2");
    await f.connect.reconcile();
    expect(emitted).toBe(3);
    expect(f.connect.report()).toEqual([
      { profile: "default", employee: "Default", state: "connected" },
    ]);
  });
});
