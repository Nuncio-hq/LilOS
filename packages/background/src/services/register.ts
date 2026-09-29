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
   * "spawn failed", "foreign", "absent"). Optional: only set where the helper
   * provides it; used to repair a stale-launch-constraint registration after
   * swap and to spot jobs SMAppService doesn't own (#206).
   */
  spawned?(plistName: string): Promise<string>;
  /**
   * `lilos-svc bootout <plist>` — remove whatever holds the label in
   * launchd plus its `~/Library/LaunchAgents` plist, regardless of who
   * registered it. Optional: only set where the helper provides it.
   */
  bootout?(plistName: string): Promise<void>;
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

/** Poll launchd until the job is running, fails, or ~2.5s pass. */
async function pollSpawnState(
  spawned: NonNullable<ServiceControl["spawned"]>,
  plist: string,
): Promise<string> {
  let last = "unknown";
  for (let i = 0; i < 10; i++) {
    await sleep(250);
    try {
      last = await spawned(plist);
    } catch {
      last = "unknown";
    }
    if (last === "running" || last === "spawn failed" || last === "foreign")
      return last;
    // Nothing is launching this label — don't burn the window on absent.
    if ((last === "absent" || last === "unknown") && i >= 1) return last;
  }
  return last;
}

/** launchd's view of the label via `spawned` — one shot, "unknown" when the
 * helper can't say (older lilos-svc or a launchd hiccup). */
async function launchdState(
  control: ServiceControl,
  plist: string,
): Promise<string> {
  if (!control.spawned) return "unknown";
  try {
    return (await control.spawned(plist)) || "unknown";
  } catch {
    return "unknown";
  }
}

const jobLoaded = (state: string) => state !== "absent" && state !== "unknown";

/** SMAppService's "this record/job isn't yours" — a launchd job it doesn't
 * own holds the label (#206). Bootout is the repair, not a failure. */
const isNotOursError = (e: unknown) =>
  e instanceof Error && /entitle/i.test(e.message);

/** Remove whatever still holds the label — foreign bootstrap jobs or
 * leftovers of a failed unregister. Throws when the helper can't clean. */
async function bootoutLeftovers(
  control: ServiceControl,
  plist: string,
): Promise<void> {
  const still = await launchdState(control, plist);
  if (!jobLoaded(still)) return;
  if (!control.bootout) {
    throw new Error(
      `${plist}: launchd job held by another owner (${still}), lilos-svc has no bootout`,
    );
  }
  await control.bootout(plist);
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
      const smaOwned = before !== "notFound" && before !== "notRegistered";
      // launchd can hold a job SMAppService doesn't own — an ad-hoc build's
      // `launchctl bootstrap` leftover, or a stale program from another
      // bundle ("foreign"). Registering over it keeps the OLD binary running
      // and pins the version store so nothing ever repairs it (#206).
      const stateBefore = await launchdState(opts.control, plist);
      const foreign =
        stateBefore === "foreign" || (!smaOwned && jobLoaded(stateBefore));

      let action: AgentAction = "registered";
      if ((versionChanged && smaOwned) || foreign) {
        let unregistered = false;
        if (smaOwned) {
          try {
            await opts.control.unregister(plist);
            unregistered = true;
          } catch (e) {
            // "Requestor lacks required entitlement": the record exists but
            // the live job isn't ours — clean it via bootout below (#206).
            // Also recoverable when nothing owns the label afterwards or the
            // survivor is a foreign job. A genuinely owned job that fails to
            // unregister still fails — rollback is not weakened.
            const still = await launchdState(opts.control, plist);
            if (
              !isNotOursError(e) &&
              still !== "foreign" &&
              still !== "absent"
            ) {
              throw e;
            }
          }
        }
        await bootoutLeftovers(opts.control, plist);
        action = unregistered ? "replaced" : "registered";
      } else if (before === "enabled" || before === "requiresApproval") {
        action = "already";
      }
      if (action !== "already") {
        await opts.control.register(plist);
      }
      // After a bundle swap, launchd's first spawn can fail on a stale launch
      // constraint (OS_REASON_CODESIGNING); the repair is another
      // unregister→register once BTM has dropped the old record. Applies to
      // any fresh register: post-swap `status` reads notFound, so the action
      // is "registered", not "replaced". A still-foreign job gets the same
      // treatment plus bootout. "absent"/"unknown" are not failures —
      // keepalive spawns lazily and needs no repair.
      if (action !== "already" && opts.control.spawned) {
        for (let attempt = 0; attempt < 3; attempt++) {
          const state = await pollSpawnState(opts.control.spawned, plist);
          if (state === "spawn failed" || state === "foreign") {
            if (attempt < 2) {
              // The record may already be gone (entitlement) — unregister is
              // best-effort here; bootout is what frees a foreign label.
              await opts.control.unregister(plist).catch(() => {});
              await bootoutLeftovers(opts.control, plist);
              await opts.control.register(plist);
            }
            continue;
          }
          break;
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
