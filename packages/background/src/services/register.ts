import { type LaunchAgentSpec, plistFileName } from "./launchd.js";

/**
 * Registration orchestration (AC-1). The desktop app calls this on launch;
 * SMAppService itself lives behind the `lilos-svc` helper binary in the app
 * bundle, injected here as `ServiceControl`.
 *
 * SP1 finding baked in: when the bundle version changes, a plain `register()`
 * leaves launchd pinned to the old copy — update requires
 * `unregister()` → `register()`. The last-registered bundle version is
 * persisted by the caller (`VersionStore`).
 */
export interface ServiceControl {
  /** `lilos-svc status <plist>` → status word (notRegistered/enabled/...). */
  status(plistName: string): Promise<string>;
  register(plistName: string): Promise<void>;
  unregister(plistName: string): Promise<void>;
  /**
   * `lilos-svc spawned <plist>` → launchd job state ("running",
   * "spawn failed", "absent"). Optional: only set where the helper provides
   * it; used to repair a stale-launch-constraint registration after swap.
   */
  spawned?(plistName: string): Promise<string>;
}

/**
 * Pin of the bundle version each agent was last registered with — per agent,
 * so an agent that fails to register is retried on next launch without
 * churning the healthy ones (their pins already match).
 */
export interface VersionStore {
  read(agent: string): Promise<string | null>;
  write(agent: string, version: string): Promise<void>;
}

export type AgentAction = "registered" | "replaced" | "already" | "failed";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll launchd until the job is running, fails, or ~6s pass. */
async function pollSpawnState(
  spawned: NonNullable<ServiceControl["spawned"]>,
  plist: string,
): Promise<string> {
  let last = "unknown";
  for (let i = 0; i < 24; i++) {
    await sleep(250);
    try {
      last = await spawned(plist);
    } catch {
      last = "unknown";
    }
    if (last === "running" || last === "spawn failed") return last;
  }
  return last;
}

export interface AgentReport {
  plist: string;
  label: string;
  status: string;
  action: AgentAction;
  error?: string;
}

export async function ensureLaunchAgents(opts: {
  control: ServiceControl;
  agents: readonly LaunchAgentSpec[];
  bundleVersion: string;
  versions: VersionStore;
}): Promise<AgentReport[]> {
  const reports: AgentReport[] = [];

  for (const agent of opts.agents) {
    const plist = plistFileName(agent);
    try {
      const before = await opts.control.status(plist);
      const versionChanged =
        (await opts.versions.read(agent.label)) !== opts.bundleVersion;
      let action: AgentAction = "registered";
      if (
        versionChanged &&
        before !== "notFound" &&
        before !== "notRegistered"
      ) {
        await opts.control.unregister(plist);
        action = "replaced";
      } else if (before === "enabled" || before === "requiresApproval") {
        action = "already";
      }
      if (action !== "already") {
        await opts.control.register(plist);
      }
      // After a bundle swap, launchd's first spawn can fail on a stale launch
      // constraint (OS_REASON_CODESIGNING); the repair is a second
      // unregister→register once BTM has dropped the old record. Applies to
      // any fresh register: post-swap `status` reads notFound, so the action
      // is "registered", not "replaced".
      if (action !== "already" && opts.control.spawned) {
        for (let attempt = 0; attempt < 3; attempt++) {
          const state = await pollSpawnState(opts.control.spawned, plist);
          if (state === "running") break;
          if (attempt < 2) {
            await opts.control.unregister(plist);
            await opts.control.register(plist);
          }
        }
      }
      const status = await opts.control.status(plist);
      await opts.versions.write(agent.label, opts.bundleVersion);
      reports.push({ plist, label: agent.label, status, action });
    } catch (e) {
      reports.push({
        plist,
        label: agent.label,
        status: "unknown",
        action: "failed",
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return reports;
}
