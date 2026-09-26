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
