import { plistFileName, type LaunchAgentSpec } from "./launchd.js";

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

export interface VersionStore {
  read(): Promise<string | null>;
  write(version: string): Promise<void>;
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
  const lastVersion = await opts.versions.read();
  const versionChanged = lastVersion !== opts.bundleVersion;
  const reports: AgentReport[] = [];

  for (const agent of opts.agents) {
    const plist = plistFileName(agent);
    try {
      const before = await opts.control.status(plist);
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
  if (reports.every((r) => r.action !== "failed")) {
    await opts.versions.write(opts.bundleVersion);
  }
  return reports;
}
