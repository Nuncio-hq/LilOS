import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PLUGIN_CONTENT_HASH_FILE,
  pluginContentHash,
} from "@lilos/engine-hermes";
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
    disabledSetCalls: (p: string) =>
      calls.filter((c) =>
        c.argv
          .join(" ")
          .startsWith(
            ["-p", p, "config", "set", "agent.disabled_toolsets"].join(" "),
          ),
      ),
    disabledUnsetCalls: (p: string) =>
      calls.filter(
        (c) =>
          c.argv.join(" ") ===
          ["-p", p, "config", "unset", "agent.disabled_toolsets"].join(" "),
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

  it("#549: connect adds 'browser' to agent.disabled_toolsets; disconnect restores", async () => {
    const f = fixture();
    f.employees.push({ id: "e1", name: "Ada", profile: "ada" });
    f.mkProfile("ada");
    f.approve();
    await f.connect.reconcile();

    /* The offer-time suppression the live leg asserts: `browser_exec` and
       `browser_vault_*` never reach the tool list. */
    const set = f.disabledSetCalls("ada");
    expect(set).toHaveLength(1);
    expect(JSON.parse(set[0].argv[set[0].argv.length - 1])).toEqual([
      "browser",
    ]);

    f.connect.employeeRemoved("e1");
    expect(f.disabledUnsetCalls("ada")).toBe(1);
  });

  it("#549: an existing disabled_toolsets list is merged, and only our entry is removed", async () => {
    const f = fixture();
    f.employees.push({ id: "e1", name: "Ada", profile: "ada" });
    f.mkProfile("ada");
    f.approve();
    /* `config get` answers with the user's own list — the write must
       append, not clobber. */
    const merged = new HermesConnect({
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
      /* `config get/set/unset` round-trips a list like the real CLI. */
      run: (() => {
        let disabled = ["kanban"];
        return (argv: string[]) => {
          const a = argv.join(" ");
          if (
            a.includes("config get") ||
            (a.includes("config") && a.includes("get"))
          )
            return {
              status: 0,
              out: `${disabled.map((d) => `  - ${d}`).join("\n")}\n`,
            };
          if (
            a.includes("config") &&
            a.includes("set") &&
            a.includes("agent.disabled_toolsets")
          ) {
            disabled = JSON.parse(argv[argv.length - 1]) as string[];
            f.calls.push({ argv });
            return { status: 0, out: "" };
          }
          if (a.includes("config") && a.includes("unset")) {
            disabled = [];
            f.calls.push({ argv });
            return { status: 0, out: "" };
          }
          f.calls.push({ argv });
          return { status: 0, out: "" };
        };
      })(),
    });
    await merged.reconcile();
    const set = f.calls.filter((c) =>
      c.argv.join(" ").includes("agent.disabled_toolsets"),
    );
    expect(set).toHaveLength(1);
    expect(JSON.parse(set[0].argv[set[0].argv.length - 1])).toEqual([
      "kanban",
      "browser",
    ]);

    merged.employeeRemoved("e1");
    const restore = f.calls.filter(
      (c) =>
        c.argv.join(" ").includes("config") &&
        c.argv.join(" ").includes("agent.disabled_toolsets"),
    );
    expect(restore).toHaveLength(2);
    expect(JSON.parse(restore[1].argv[restore[1].argv.length - 1])).toEqual([
      "kanban",
    ]);
  });

  it("a failed tool-search opt-out marks the row failed too (#411)", async () => {
    /* Without `tools.tool_search.enabled=off` the lilos_* tools register
       but are deferred behind `tool_search` — the exact symptom this
       fix ships against, so the row must not report connected. */
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
      run: (argv) =>
        argv.includes("config")
          ? { status: 2, out: "config: unknown key" }
          : { status: 0, out: "" },
    });
    await failing.reconcile();
    const [row] = failing.report();
    expect(row.state).toBe("failed");
    expect(row.reason).toContain("tool search");
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

describe("D-#817 content hash, not plugin.yaml version", () => {
  const installedPy = (home: string, profile: string) =>
    join(home, "profiles", profile, "plugins", "lilos", "__init__.py");
  const hashRecord = (home: string, profile: string) =>
    join(home, "profiles", profile, "plugins", PLUGIN_CONTENT_HASH_FILE);

  it("refreshes an older plugin that still carries the same version string", async () => {
    const f = fixture("0.2.0");
    f.employees.push({ id: "e1", name: "Ada", profile: "ada" });
    f.mkProfile("ada");
    f.approve();
    const pluginDir = join(f.hermesHome, "profiles", "ada", "plugins", "lilos");
    mkdirSync(pluginDir, { recursive: true });
    // Same version the bundle ships. Only the module body is older.
    writeFileSync(
      join(pluginDir, "plugin.yaml"),
      readFileSync(join(f.pluginSrc, "plugin.yaml")),
    );
    writeFileSync(join(pluginDir, "__init__.py"), "def register(ctx): stale\n");

    await f.connect.reconcile();

    expect(readFileSync(installedPy(f.hermesHome, "ada"), "utf8")).toBe(
      readFileSync(join(f.pluginSrc, "__init__.py"), "utf8"),
    );
    expect(readFileSync(hashRecord(f.hermesHome, "ada"), "utf8")).toBe(
      `${pluginContentHash(f.pluginSrc)}\n`,
    );
    expect(f.enableCalls("ada")).toBe(1);
    expect(f.connect.report()[0].state).toBe("connected");
  });

  it("does not recopy an install whose files already match", async () => {
    const f = fixture("0.2.0");
    f.employees.push({ id: "e1", name: "Ada", profile: "ada" });
    f.mkProfile("ada");
    f.approve();
    await f.connect.reconcile();
    const calls = f.calls.length;
    const py = installedPy(f.hermesHome, "ada");
    const record = hashRecord(f.hermesHome, "ada");
    const pyMtime = statSync(py).mtimeMs;
    const recordMtime = statSync(record).mtimeMs;

    await f.connect.reconcile();

    expect(statSync(py).mtimeMs).toBe(pyMtime);
    expect(statSync(record).mtimeMs).toBe(recordMtime);
    expect(f.calls).toHaveLength(calls);
    expect(f.enableCalls("ada")).toBe(1);
  });

  it("ignores __pycache__ so a loaded plugin is not recopied every start", async () => {
    const f = fixture("0.2.0");
    f.employees.push({ id: "e1", name: "Ada", profile: "ada" });
    f.mkProfile("ada");
    f.approve();
    await f.connect.reconcile();
    const py = installedPy(f.hermesHome, "ada");
    const pyMtime = statSync(py).mtimeMs;
    const cache = join(
      f.hermesHome,
      "profiles",
      "ada",
      "plugins",
      "lilos",
      "__pycache__",
    );
    mkdirSync(cache, { recursive: true });
    writeFileSync(join(cache, "lilos.cpython-313.pyc"), "not the plugin");

    await f.connect.reconcile();

    expect(statSync(py).mtimeMs).toBe(pyMtime);
    expect(f.enableCalls("ada")).toBe(1);
  });

  it("a hire after approval gets the current plugin on the next reconcile", async () => {
    const f = fixture("0.2.0");
    f.employees.push({ id: "e1", name: "Ada", profile: "ada" });
    f.mkProfile("ada");
    f.approve();
    await f.connect.reconcile();
    const adaPy = installedPy(f.hermesHome, "ada");
    const adaMtime = statSync(adaPy).mtimeMs;

    // The approval flag is not written again. Bea's home shows up the way
    // a clone of an older profile does: same version string, stale body.
    f.employees.push({ id: "e2", name: "Bea", profile: "bea" });
    f.mkProfile("bea");
    const beaDir = join(f.hermesHome, "profiles", "bea", "plugins", "lilos");
    mkdirSync(beaDir, { recursive: true });
    writeFileSync(
      join(beaDir, "plugin.yaml"),
      readFileSync(join(f.pluginSrc, "plugin.yaml")),
    );
    writeFileSync(join(beaDir, "__init__.py"), "def register(ctx): stale\n");
    writeFileSync(join(beaDir, "leftover.py"), "from the clone\n");

    await f.connect.reconcile();

    expect(readFileSync(installedPy(f.hermesHome, "bea"), "utf8")).toBe(
      readFileSync(join(f.pluginSrc, "__init__.py"), "utf8"),
    );
    expect(existsSync(join(beaDir, "leftover.py"))).toBe(false);
    expect(f.enableCalls("bea")).toBe(1);
    expect(statSync(adaPy).mtimeMs).toBe(adaMtime);
    expect(f.connect.report()).toEqual([
      { profile: "ada", employee: "Ada", state: "connected" },
      { profile: "bea", employee: "Bea", state: "connected" },
    ]);
  });

  it("a profile that appears after the first pass is refreshed without a new approval", async () => {
    const f = fixture("0.2.0");
    f.employees.push({ id: "e1", name: "Bea", profile: "bea" });
    f.approve();
    await f.connect.reconcile();
    expect(f.installedYaml("bea")).toBeUndefined();
    expect(f.connect.report()[0].state).toBe("not-connected");
    expect(f.enableCalls("bea")).toBe(0);

    f.mkProfile("bea");
    const beaDir = join(f.hermesHome, "profiles", "bea", "plugins", "lilos");
    mkdirSync(beaDir, { recursive: true });
    writeFileSync(
      join(beaDir, "plugin.yaml"),
      'name: lilos\nversion: "0.2.0"\n',
    );
    writeFileSync(join(beaDir, "__init__.py"), "def register(ctx): stale\n");

    await f.connect.reconcile();

    expect(readFileSync(installedPy(f.hermesHome, "bea"), "utf8")).toBe(
      readFileSync(join(f.pluginSrc, "__init__.py"), "utf8"),
    );
    expect(f.enableCalls("bea")).toBe(1);
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

describe("AC-2 (#507) hermes CLI runs get the allow-listed env", () => {
  it("plugins enable/disable + config set never see LILOS_* internals; explicit grants win", async () => {
    const f = fixture();
    f.employees.push({ id: "e1", name: "Ada", profile: "ada" });
    f.mkProfile("ada");
    f.approve();
    const prev: Record<string, string | undefined> = {};
    for (const k of [
      "LILOS_RELAY_TOKEN",
      "LILOS_HARNESS_HOME",
      "LILOS_WORKDIR",
    ]) {
      prev[k] = process.env[k];
    }
    process.env.LILOS_RELAY_TOKEN = "relay-secret";
    process.env.LILOS_HARNESS_HOME = "/lilos/harness";
    process.env.LILOS_WORKDIR = "/lilos/harness/work";
    try {
      const seen: { argv: string[]; env: Record<string, string> }[] = [];
      const c = new HermesConnect({
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
        // The Connect grant (surfaces creds) is an explicit env entry — it
        // must survive the same way #505's options.env does.
        env: { LILOS_ENGINE_TOKEN: "eng-grant" },
        log: createMemoryLogger(),
        run: (argv, env) => {
          seen.push({ argv, env });
          return { status: 0, out: "" };
        },
      });
      await c.reconcile();
      // enable + tool_search off both spawn `hermes` — every call scrubs.
      expect(seen.length).toBeGreaterThan(0);
      for (const call of seen) {
        const lilos = Object.keys(call.env)
          .filter((k) => k.startsWith("LILOS_"))
          .sort();
        expect(lilos).toEqual(["LILOS_ENGINE_TOKEN"]);
        expect(call.env.HERMES_HOME).toBe(f.hermesHome);
      }
    } finally {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
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
