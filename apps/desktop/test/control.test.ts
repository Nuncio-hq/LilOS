import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureLaunchAgents,
  LILOS_AGENTS,
  plistFileName,
} from "@lilos/background";
import { afterEach, describe, expect, it } from "vitest";
import {
  diskVersionStore,
  type HelperExec,
  helperServiceControl,
  parseHelperStatus,
} from "../src/control";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0))
    rmSync(d, { recursive: true, force: true });
});

/** Fake `lilos-svc` CLI: keeps a status word per plist, plus a launchd job
 * model — `loaded` holds "foreign" (bootstrap leftover) or "ours". */
function fakeHelper(
  initial: Record<string, string> = {},
  loaded: Map<string, string> = new Map(),
) {
  const statuses = new Map(Object.entries(initial));
  const calls: string[][] = [];
  const exec: HelperExec = async (_bin, args) => {
    calls.push(args);
    const [verb, plist] = args;
    if (verb === "status") {
      const s = statuses.get(plist) ?? "notRegistered";
      return { stdout: `${plist} status=${s}`, stderr: "", code: 0 };
    }
    if (verb === "spawned") {
      const kind = loaded.get(plist);
      const word =
        kind === "ours" ? "running" : kind === "foreign" ? "foreign" : "absent";
      return { stdout: `${plist} ${word}`, stderr: "", code: 0 };
    }
    if (verb === "bootout") {
      loaded.delete(plist);
      return { stdout: `ok ${plist}`, stderr: "", code: 0 };
    }
    if (verb === "register") {
      statuses.set(plist, "enabled");
      loaded.set(plist, "ours");
      return { stdout: `ok ${plist} status=enabled`, stderr: "", code: 0 };
    }
    if (verb === "unregister") {
      statuses.set(plist, "notRegistered");
      loaded.delete(plist);
      return {
        stdout: `ok ${plist} status=notRegistered`,
        stderr: "",
        code: 0,
      };
    }
    return { stdout: "", stderr: "unknown verb", code: 64 };
  };
  return { exec, statuses, calls, loaded };
}

function tmpFile(): string {
  const d = mkdtempSync(join(tmpdir(), "lilos-desktop-"));
  tmpDirs.push(d);
  return join(d, "service-version");
}

describe("AC-1 service registration via lilos-svc", () => {
  it("parses the helper's status word", () => {
    expect(
      parseHelperStatus("com.nuncio.lilos.relay.plist status=enabled"),
    ).toBe("enabled");
    expect(parseHelperStatus("x status=requiresApproval")).toBe(
      "requiresApproval",
    );
    expect(parseHelperStatus("garbage")).toBeUndefined();
  });

  it("first launch registers both agents through the helper CLI", async () => {
    const { exec, calls } = fakeHelper();
    const reports = await ensureLaunchAgents({
      control: helperServiceControl("/bundled/lilos-svc", exec),
      agents: LILOS_AGENTS,
      bundleVersion: "1",
      versions: diskVersionStore(tmpFile()),
    });
    expect(reports.map((r) => r.action)).toEqual(["registered", "registered"]);
    const registered = calls
      .filter(([verb]) => verb === "register")
      .map(([, plist]) => plist);
    expect(registered).toEqual(LILOS_AGENTS.map(plistFileName));
  });

  it("bundle version bump unregisters before re-registering (SP1)", async () => {
    const { exec, calls } = fakeHelper({
      [plistFileName(LILOS_AGENTS[0])]: "enabled",
      [plistFileName(LILOS_AGENTS[1])]: "enabled",
    });
    const store = diskVersionStore(tmpFile());
    for (const agent of LILOS_AGENTS) await store.write(agent.label, "1");
    await ensureLaunchAgents({
      control: helperServiceControl("/bundled/lilos-svc", exec),
      agents: LILOS_AGENTS,
      bundleVersion: "2",
      versions: store,
    });
    for (const agent of LILOS_AGENTS) {
      const plist = plistFileName(agent);
      const un = calls.findIndex(([v, p]) => v === "unregister" && p === plist);
      const re =
        calls
          .map((c, i) => ({ c, i }))
          .filter(({ c: [v, p] }) => v === "register" && p === plist)
          .at(-1)?.i ?? -1;
      expect(un).toBeGreaterThan(-1);
      expect(re).toBeGreaterThan(un);
    }
  });

  it("AC-3 foreign bootstrap jobs get booted out before register (#206)", async () => {
    // Signed path over an ad-hoc install: SMAppService has no record
    // (notFound) but launchd holds bootstrapped jobs (spawned = foreign).
    const loaded = new Map(
      LILOS_AGENTS.map((a) => [plistFileName(a), "foreign"]),
    );
    const { exec, calls } = fakeHelper({}, loaded);
    const reports = await ensureLaunchAgents({
      control: helperServiceControl("/bundled/lilos-svc", exec),
      agents: LILOS_AGENTS,
      bundleVersion: "1",
      versions: diskVersionStore(tmpFile()),
    });
    expect(reports.map((r) => r.action)).toEqual(["registered", "registered"]);
    for (const agent of LILOS_AGENTS) {
      const plist = plistFileName(agent);
      const verbs = calls.filter(([, p]) => p === plist).map(([v]) => v);
      expect(verbs.indexOf("bootout")).toBeGreaterThanOrEqual(0);
      expect(verbs.indexOf("bootout")).toBeLessThan(
        verbs.lastIndexOf("register"),
      );
    }
    expect([...loaded.values()]).not.toContain("foreign");
  });

  it("AC-4 an entitlement failure from unregister still ends registered", async () => {
    // `unregister` on a foreign job fails — the helper surfaces the raw
    // SMAppService error and ensureLaunchAgents must recover via bootout.
    const loaded = new Map(
      LILOS_AGENTS.map((a) => [plistFileName(a), "foreign"]),
    );
    const { exec, calls } = fakeHelper(
      Object.fromEntries(
        LILOS_AGENTS.map((a) => [plistFileName(a), "enabled"]),
      ),
      loaded,
    );
    const entitled: HelperExec = async (bin, args) => {
      if (args[0] === "unregister") {
        calls.push(args);
        return {
          stdout: "",
          stderr: `unregister failed for ${args[1]}: Requestor lacks required entitlement`,
          code: 1,
        };
      }
      return exec(bin, args);
    };
    const store = diskVersionStore(tmpFile());
    for (const agent of LILOS_AGENTS) await store.write(agent.label, "1");
    const reports = await ensureLaunchAgents({
      control: helperServiceControl("/bundled/lilos-svc", entitled),
      agents: LILOS_AGENTS,
      bundleVersion: "2",
      versions: store,
    });
    expect(reports.map((r) => r.action)).toEqual(["registered", "registered"]);
    expect(reports.every((r) => r.status === "enabled")).toBe(true);
    for (const agent of LILOS_AGENTS) {
      const plist = plistFileName(agent);
      const verbs = calls.filter(([, p]) => p === plist).map(([v]) => v);
      expect(verbs).toContain("bootout");
      expect(verbs).toContain("register");
    }
  });

  it("a helper failure is reported per agent and the version is not pinned", async () => {
    const failing: HelperExec = async (_bin, args) =>
      args[0] === "register"
        ? { stdout: "", stderr: "SMAppService denied", code: 1 }
        : { stdout: `${args[1]} status=notRegistered`, stderr: "", code: 0 };
    const file = tmpFile();
    const reports = await ensureLaunchAgents({
      control: helperServiceControl("/bundled/lilos-svc", failing),
      agents: LILOS_AGENTS,
      bundleVersion: "1",
      versions: diskVersionStore(file),
    });
    expect(reports.every((r) => r.action === "failed")).toBe(true);
    expect(reports[0]?.error).toContain("SMAppService denied");
  });

  it("version store round-trips per agent and survives a missing file", async () => {
    const file = tmpFile();
    const store = diskVersionStore(file);
    expect(await store.read("a")).toBeNull();
    await store.write("a", "7");
    await store.write("b", "2");
    const fresh = diskVersionStore(file);
    expect(await fresh.read("a")).toBe("7");
    expect(await fresh.read("b")).toBe("2");
    expect(await fresh.read("c")).toBeNull();
  });
});
