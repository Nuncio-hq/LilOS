import { describe, expect, it } from "vitest";
import {
  ensureLaunchAgents,
  HARNESS_AGENT,
  LILOS_AGENTS,
  plistFileName,
  RELAY_AGENT,
  renderLaunchAgentPlist,
  type ServiceControl,
  type VersionStore,
} from "../src/index.js";

function fakeControl(
  initial: Record<string, string> = {},
): ServiceControl & { calls: string[]; statuses: Record<string, string> } {
  const statuses = { ...initial };
  const calls: string[] = [];
  return {
    calls,
    statuses,
    async status(plist) {
      calls.push(`status ${plist}`);
      return statuses[plist] ?? "notFound";
    },
    async register(plist) {
      calls.push(`register ${plist}`);
      statuses[plist] = "enabled";
    },
    async unregister(plist) {
      calls.push(`unregister ${plist}`);
      statuses[plist] = "notRegistered";
    },
  };
}

function memStore(
  initial: Record<string, string> = {},
): VersionStore & { readonly all: Record<string, string> } {
  const all = { ...initial };
  return {
    all,
    read: async (agent: string) => all[agent] ?? null,
    write: async (agent: string, v: string) => {
      all[agent] = v;
    },
  };
}

describe("launch agents (AC-1)", () => {
  it("AC-1 each service plist is a launchd agent pinned to a bundle binary", () => {
    for (const spec of [RELAY_AGENT, HARNESS_AGENT]) {
      const xml = renderLaunchAgentPlist(spec);
      expect(xml).toContain(`<string>${spec.label}</string>`);
      expect(xml).toContain(`<string>${spec.bundleProgram}</string>`);
      expect(xml).toContain("<key>KeepAlive</key>");
      expect(xml).toContain("<key>RunAtLoad</key>");
      expect(spec.bundleProgram).toMatch(/^Contents\/MacOS\//);
      expect(plistFileName(spec)).toBe(`${spec.label}.plist`);
    }
    expect(LILOS_AGENTS.map((a) => a.label)).toEqual([
      "com.nuncio.lilos.relay",
      "com.nuncio.lilos.harness",
    ]);
  });

  it("AC-1 the harness agent carries a user PATH — launchd's default hides Homebrew tools like gh", () => {
    const xml = renderLaunchAgentPlist(HARNESS_AGENT);
    expect(xml).toContain("<key>EnvironmentVariables</key>");
    expect(xml).toContain("<key>PATH</key>");
    expect(xml).toContain("/opt/homebrew/bin");
  });

  it("AC-1 first launch registers both agents", async () => {
    const control = fakeControl();
    const versions = memStore();
    const reports = await ensureLaunchAgents({
      control,
      agents: LILOS_AGENTS,
      bundleVersion: "1",
      versions,
    });
    expect(reports.map((r) => r.action)).toEqual(["registered", "registered"]);
    expect(control.calls).toContain(`register ${HARNESS_AGENT.label}.plist`);
    expect(versions.all).toEqual({
      "com.nuncio.lilos.relay": "1",
      "com.nuncio.lilos.harness": "1",
    });
  });

  it("AC-1 a bundle version change unregisters before re-registering (SP1 stale-pin rule)", async () => {
    const control = fakeControl({
      "com.nuncio.lilos.relay.plist": "enabled",
      "com.nuncio.lilos.harness.plist": "enabled",
    });
    const versions = memStore({
      "com.nuncio.lilos.relay": "1",
      "com.nuncio.lilos.harness": "1",
    });
    const reports = await ensureLaunchAgents({
      control,
      agents: LILOS_AGENTS,
      bundleVersion: "2",
      versions,
    });
    expect(reports.map((r) => r.action)).toEqual(["replaced", "replaced"]);
    // SP1: unregister MUST precede register or launchd keeps the stale bundle pin.
    for (const label of [
      "com.nuncio.lilos.relay",
      "com.nuncio.lilos.harness",
    ]) {
      const calls = control.calls.filter((c) => c.endsWith(`${label}.plist`));
      expect(calls.indexOf(`unregister ${label}.plist`)).toBeLessThan(
        calls.lastIndexOf(`register ${label}.plist`),
      );
    }
    expect(versions.all).toEqual({
      "com.nuncio.lilos.relay": "2",
      "com.nuncio.lilos.harness": "2",
    });
  });

  it("AC-1 same version + already enabled → no churn", async () => {
    const control = fakeControl({
      "com.nuncio.lilos.relay.plist": "enabled",
      "com.nuncio.lilos.harness.plist": "enabled",
    });
    const versions = memStore({
      "com.nuncio.lilos.relay": "1",
      "com.nuncio.lilos.harness": "1",
    });
    const reports = await ensureLaunchAgents({
      control,
      agents: LILOS_AGENTS,
      bundleVersion: "1",
      versions,
    });
    expect(reports.map((r) => r.action)).toEqual(["already", "already"]);
    expect(
      control.calls.filter((c) => c.startsWith("unregister")),
    ).toHaveLength(0);
  });

  it("AC-1 a failing agent retries without churning the healthy one", async () => {
    // Regression (VM finding): an all-or-nothing version pin meant one broken
    // agent restarted the healthy relay on every launch — dropping in-flight
    // relay state. Pins are per-agent: relay stays pinned, harness retried.
    const control = fakeControl({
      "com.nuncio.lilos.relay.plist": "enabled",
    });
    control.register = async (plist) => {
      control.calls.push(`register ${plist}`);
      if (plist.includes("harness")) throw new Error("plist not in bundle");
    };
    const versions = memStore({ "com.nuncio.lilos.relay": "1" });
    const reports = await ensureLaunchAgents({
      control,
      agents: LILOS_AGENTS,
      bundleVersion: "1",
      versions,
    });
    expect(reports.map((r) => r.action)).toEqual(["already", "failed"]);
    expect(control.calls.filter((c) => c.includes("unregister"))).toHaveLength(
      0,
    );
    expect(versions.all["com.nuncio.lilos.relay"]).toBe("1");
    expect(versions.all["com.nuncio.lilos.harness"]).toBeUndefined();
  });

  it("AC-3 signed path: SMAppService notFound but a live launchd job → bootout then register (#206)", async () => {
    // An ad-hoc install leaves `launchctl bootstrap` jobs SMAppService has no
    // record of: status reads notFound while `spawned` sees the job running.
    // Registering over it keeps the OLD binary alive, so the foreign job must
    // be booted out first.
    const loaded = new Map<string, string>([
      ["com.nuncio.lilos.relay.plist", "foreign"],
      ["com.nuncio.lilos.harness.plist", "foreign"],
    ]);
    const control = fakeControl();
    control.spawned = async (plist) => {
      control.calls.push(`spawned ${plist}`);
      const kind = loaded.get(plist);
      return kind === "ours"
        ? "running"
        : kind === "foreign"
          ? "foreign"
          : "absent";
    };
    control.bootout = async (plist) => {
      control.calls.push(`bootout ${plist}`);
      loaded.delete(plist);
    };
    control.register = async (plist) => {
      control.calls.push(`register ${plist}`);
      loaded.set(plist, "ours");
      control.statuses[plist] = "enabled";
    };
    const versions = memStore();
    const reports = await ensureLaunchAgents({
      control,
      agents: LILOS_AGENTS,
      bundleVersion: "2",
      versions,
    });
    expect(reports.map((r) => r.action)).toEqual(["registered", "registered"]);
    expect(reports.every((r) => r.status === "enabled")).toBe(true);
    expect(
      control.calls.filter((c) => c.startsWith("unregister")),
    ).toHaveLength(0);
    for (const label of [
      "com.nuncio.lilos.relay",
      "com.nuncio.lilos.harness",
    ]) {
      const calls = control.calls.filter((c) => c.endsWith(`${label}.plist`));
      expect(calls.indexOf(`bootout ${label}.plist`)).toBeGreaterThanOrEqual(0);
      expect(calls.indexOf(`bootout ${label}.plist`)).toBeLessThan(
        calls.lastIndexOf(`register ${label}.plist`),
      );
    }
    expect(versions.all["com.nuncio.lilos.relay"]).toBe("2");
  });

  it("AC-3 spawn-failed foreign job (old bundle trashed) is also booted out", async () => {
    // Same leak, different symptom: the old bundle is gone, so the leftover
    // job spawn-fails. Still not ours — bootout then register.
    const loaded = new Map<string, string>([
      ["com.nuncio.lilos.relay.plist", "foreign"],
      ["com.nuncio.lilos.harness.plist", "foreign"],
    ]);
    const control = fakeControl();
    control.spawned = async (plist) =>
      loaded.has(plist)
        ? loaded.get(plist) === "ours"
          ? "running"
          : "spawn failed"
        : "absent";
    control.bootout = async (plist) => {
      control.calls.push(`bootout ${plist}`);
      loaded.delete(plist);
    };
    control.register = async (plist) => {
      control.calls.push(`register ${plist}`);
      loaded.set(plist, "ours");
    };
    const reports = await ensureLaunchAgents({
      control,
      agents: LILOS_AGENTS,
      bundleVersion: "2",
      versions: memStore(),
    });
    expect(reports.map((r) => r.action)).toEqual(["registered", "registered"]);
    expect(control.calls.filter((c) => c.startsWith("bootout"))).toHaveLength(
      2,
    );
  });

  it("AC-4 unregister throwing 'lacks required entitlement' means not-ours → bootout + register, not failed (#206)", async () => {
    // Auto-update leg: the version pin changed and SMAppService has a record
    // (enabled), but the running job is the ad-hoc bootstrap — unregister()
    // then fails with "Requestor lacks required entitlement". That is a
    // foreign job, not a failure: bootout + register must still succeed or
    // the updater's boot-ok never lands and the build rolls back.
    const loaded = new Map<string, string>([
      ["com.nuncio.lilos.relay.plist", "foreign"],
      ["com.nuncio.lilos.harness.plist", "foreign"],
    ]);
    const control = fakeControl({
      "com.nuncio.lilos.relay.plist": "enabled",
      "com.nuncio.lilos.harness.plist": "enabled",
    });
    control.spawned = async (plist) =>
      loaded.has(plist)
        ? loaded.get(plist) === "ours"
          ? "running"
          : "foreign"
        : "absent";
    control.unregister = async (plist) => {
      control.calls.push(`unregister ${plist}`);
      throw new Error(
        `lilos-svc unregister ${plist}: unregister failed: Requestor lacks required entitlement`,
      );
    };
    control.bootout = async (plist) => {
      control.calls.push(`bootout ${plist}`);
      loaded.delete(plist);
    };
    control.register = async (plist) => {
      control.calls.push(`register ${plist}`);
      loaded.set(plist, "ours");
    };
    const versions = memStore({
      "com.nuncio.lilos.relay": "1",
      "com.nuncio.lilos.harness": "1",
    });
    const reports = await ensureLaunchAgents({
      control,
      agents: LILOS_AGENTS,
      bundleVersion: "2",
      versions,
    });
    expect(reports.map((r) => r.action)).toEqual(["registered", "registered"]);
    expect(reports.every((r) => r.status === "enabled")).toBe(true);
    for (const label of [
      "com.nuncio.lilos.relay",
      "com.nuncio.lilos.harness",
    ]) {
      const calls = control.calls.filter((c) => c.endsWith(`${label}.plist`));
      expect(calls).toContain(`bootout ${label}.plist`);
      expect(calls).toContain(`register ${label}.plist`);
    }
    expect(versions.all).toEqual({
      "com.nuncio.lilos.relay": "2",
      "com.nuncio.lilos.harness": "2",
    });
  });

  it("AC-4 a non-entitlement unregister failure while a job holds the label still fails", async () => {
    // Rollback must not be weakened: a real unregister failure leaving a
    // live, non-foreign job is still reported failed and pins no version.
    const control = fakeControl({
      "com.nuncio.lilos.relay.plist": "enabled",
      "com.nuncio.lilos.harness.plist": "enabled",
    });
    control.spawned = async () => "running";
    control.unregister = async () => {
      throw new Error("SMAppService: connection interrupted");
    };
    control.bootout = async () => {
      throw new Error("bootout should not run");
    };
    const reports = await ensureLaunchAgents({
      control,
      agents: LILOS_AGENTS,
      bundleVersion: "2",
      versions: memStore({ "com.nuncio.lilos.relay": "1" }),
    });
    expect(reports.map((r) => r.action)).toEqual(["failed", "failed"]);
  });

  it("AC-4 an unregister error that leaves the label free still recovers", async () => {
    // The goal of unregister is a free label: if the error came after the
    // job was already gone, registering fresh is correct — not a failure.
    const control = fakeControl({
      "com.nuncio.lilos.relay.plist": "enabled",
      "com.nuncio.lilos.harness.plist": "enabled",
    });
    const loaded = new Set<string>();
    control.spawned = async (plist) =>
      loaded.has(plist) ? "running" : "absent";
    control.unregister = async () => {
      throw new Error("SMAppService: connection interrupted");
    };
    control.register = async (plist) => {
      loaded.add(plist);
    };
    const reports = await ensureLaunchAgents({
      control,
      agents: LILOS_AGENTS,
      bundleVersion: "2",
      versions: memStore({ "com.nuncio.lilos.relay": "1" }),
    });
    expect(reports.map((r) => r.action)).toEqual(["registered", "registered"]);
  });

  it("AC-1 a helper failure is reported, not thrown, and the version is not pinned", async () => {
    const control = fakeControl();
    control.register = async () => {
      throw new Error("SMJobBless denied");
    };
    const versions = memStore();
    const reports = await ensureLaunchAgents({
      control,
      agents: LILOS_AGENTS,
      bundleVersion: "1",
      versions,
    });
    expect(reports.every((r) => r.action === "failed")).toBe(true);
    expect(versions.all).toEqual({});
  });
});
