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
): ServiceControl & { calls: string[] } {
  const statuses = { ...initial };
  const calls: string[] = [];
  return {
    calls,
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

function memStore(v: string | null = null): VersionStore & {
  readonly v: string | null;
} {
  const s = {
    v,
    read: async () => s.v,
    write: async (nv: string) => {
      s.v = nv;
    },
  };
  return s;
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
    expect(control.calls).toContain(
      `register ${HARNESS_AGENT.label}.plist`,
    );
    expect(versions.v).toBe("1");
  });

  it("AC-1 a bundle version change unregisters before re-registering (SP1 stale-pin rule)", async () => {
    const control = fakeControl({
      "com.nuncio.lilos.relay.plist": "enabled",
      "com.nuncio.lilos.harness.plist": "enabled",
    });
    const versions = memStore("1");
    const reports = await ensureLaunchAgents({
      control,
      agents: LILOS_AGENTS,
      bundleVersion: "2",
      versions,
    });
    expect(reports.map((r) => r.action)).toEqual(["replaced", "replaced"]);
    // SP1: unregister MUST precede register or launchd keeps the stale bundle pin.
    for (const label of ["com.nuncio.lilos.relay", "com.nuncio.lilos.harness"]) {
      const calls = control.calls.filter((c) => c.endsWith(`${label}.plist`));
      expect(calls.indexOf(`unregister ${label}.plist`)).toBeLessThan(
        calls.lastIndexOf(`register ${label}.plist`),
      );
    }
    expect(versions.v).toBe("2");
  });

  it("AC-1 same version + already enabled → no churn", async () => {
    const control = fakeControl({
      "com.nuncio.lilos.relay.plist": "enabled",
      "com.nuncio.lilos.harness.plist": "enabled",
    });
    const versions = memStore("1");
    const reports = await ensureLaunchAgents({
      control,
      agents: LILOS_AGENTS,
      bundleVersion: "1",
      versions,
    });
    expect(reports.map((r) => r.action)).toEqual(["already", "already"]);
    expect(control.calls.filter((c) => c.startsWith("unregister"))).toHaveLength(0);
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
    expect(versions.v).toBeNull();
  });
});
