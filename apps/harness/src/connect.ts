import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProfileConnection } from "@lilos/contracts/app";
import type { Logger } from "./log";

/**
 * Connect (#339): once the user approves Connect (relay setting
 * `connect.hermes.approved`), install the bundled `lilos` plugin into every
 * employee's Hermes profile and enable it (`hermes -p <p> plugins enable`).
 * Thereafter the reconciler keeps it that way: a plugin version drift
 * re-copies + re-enables (AC-6, row shows "updating" meanwhile), a removed
 * employee's profile is disabled — the profile itself is never deleted
 * (AC-1). Without approval nothing is touched and every profile row just
 * reads "not-connected" (AC-7).
 *
 * The latest rows ride `harness.report` so relay `system.status` answers
 * "which employees aren't connected" for the Connect surfaces.
 */

/** The relay `settings.*` key the Connect step writes once. */
export const CONNECT_APPROVAL_KEY = "connect.hermes";

interface EmployeeRow {
  id: string;
  name: string;
  profile?: string;
}

export interface ConnectDeps {
  /** Relay client — `settings.get` + `employees.list` only. */
  relay: {
    request(method: string, params: Record<string, unknown>): Promise<unknown>;
  };
  /** Resolved `hermes` binary (lazy — a missing binary fails rows, not boot). */
  hermesBin: () => string;
  /** HERMES_HOME the engine runs under; profile homes sit in profiles/<p>. */
  hermesHome: string;
  /** Bundled lilos plugin source dir (repo checkout or packaged Resources). */
  pluginSrc: string;
  /** Extra env for `hermes -p` calls — must match the engine's env. */
  env?: Record<string, string>;
  log: Logger;
  /** Injectable subprocess runner for tests. */
  run?: (
    argv: string[],
    env: Record<string, string>,
  ) => {
    status: number;
    out: string;
  };
}

type Row = ProfileConnection;

const pluginVersion = (dir: string): string | undefined => {
  try {
    const yaml = readFileSync(join(dir, "plugin.yaml"), "utf8");
    return /^version:\s*"?([^"\n]+)"?\s*$/m.exec(yaml)?.[1]?.trim();
  } catch {
    return undefined;
  }
};

export class HermesConnect {
  private readonly rows = new Map<string, Row>();
  private readonly profileByEmployee = new Map<string, string>();
  private inflight?: Promise<void>;

  constructor(private readonly deps: ConnectDeps) {}

  /** The report rows — one per row state the reconciler knows. */
  report(): ProfileConnection[] {
    return [...this.rows.values()].map((row) => ({ ...row }));
  }

  /** Serialized reconcile — event triggers collapse into one pass. */
  reconcile(): Promise<void> {
    this.inflight ??= this.reconcileInner()
      .catch((error) =>
        this.deps.log.warn("connect reconcile failed", {
          error: String(error),
        }),
      )
      .finally(() => {
        this.inflight = undefined;
      });
    return this.inflight;
  }

  /** `employee.removed` only carries the id — disable via the last map. */
  employeeRemoved(employeeId: string): void {
    const profile = this.profileByEmployee.get(employeeId);
    if (profile === undefined) return;
    this.disable(profile);
    this.rows.delete(profile);
    this.profileByEmployee.delete(employeeId);
  }

  private async approved(): Promise<boolean> {
    const { value } = (await this.deps.relay.request("settings.get", {
      key: CONNECT_APPROVAL_KEY,
    })) as { value?: unknown };
    return (
      typeof value === "object" &&
      value !== null &&
      (value as { approved?: boolean }).approved === true
    );
  }

  private async reconcileInner(): Promise<void> {
    const ok = await this.approved();
    const { employees } = (await this.deps.relay.request(
      "employees.list",
      {},
    )) as { employees: EmployeeRow[] };
    const byProfile = new Map(
      employees.filter((e) => e.profile).map((e) => [e.profile as string, e]),
    );
    this.profileByEmployee.clear();
    for (const e of employees)
      if (e.profile) this.profileByEmployee.set(e.id, e.profile);

    for (const e of employees) {
      const profile = e.profile;
      if (!profile) continue;
      const row = this.row(profile, e.name);
      if (!ok) {
        // Declined or never asked — leave untouched (AC-7); a previously
        // connected profile whose approval was revoked gets disconnected.
        if (row.state === "connected") this.disable(profile);
        row.state = "not-connected";
        continue;
      }
      this.connect(profile, row);
    }

    // An employee removed between events still gets disabled, never deleted.
    for (const [profile, row] of this.rows) {
      if (byProfile.has(profile)) continue;
      if (row.state === "connected" || row.state === "updating")
        this.disable(profile);
      this.rows.delete(profile);
    }
  }

  private row(profile: string, employee?: string): Row {
    let row = this.rows.get(profile);
    if (!row) {
      row = { profile, state: "not-connected" };
      this.rows.set(profile, row);
    }
    if (employee !== undefined) row.employee = employee;
    return row;
  }

  /** Install + enable the plugin on one profile (version-aware, AC-6). */
  private connect(profile: string, row: Row): void {
    const home = join(this.deps.hermesHome, "profiles", profile);
    if (!existsSync(home)) {
      // Profile not materialized on disk yet — Hermes creates the home on
      // first use; retry on the next reconcile instead of failing.
      row.state = "not-connected";
      return;
    }
    const target = join(home, "plugins", "lilos");
    const bundled = pluginVersion(this.deps.pluginSrc);
    const installed = pluginVersion(target);
    const needsCopy =
      !existsSync(target) || (bundled !== undefined && installed !== bundled);
    if (needsCopy) {
      row.state = "updating";
      row.reason = undefined;
      try {
        mkdirSync(join(home, "plugins"), { recursive: true });
        cpSync(this.deps.pluginSrc, target, { recursive: true });
      } catch (error) {
        row.state = "failed";
        row.reason = `couldn't install the LilOS plugin: ${String(error)}`;
        return;
      }
    }
    if (row.state === "connected" && !needsCopy) return;
    const result = this.hermes(["-p", profile, "plugins", "enable", "lilos"]);
    if (result === undefined) {
      row.state = "failed";
      row.reason = "Hermes isn't installed on this Mac";
      return;
    }
    if (result.status !== 0) {
      row.state = "failed";
      row.reason = `plugins enable failed: ${result.out.slice(-200)}`;
      return;
    }
    row.state = "connected";
    row.reason = undefined;
  }

  /** `plugins disable` — never delete the profile or the plugin dir. */
  private disable(profile: string): void {
    const result = this.hermes(["-p", profile, "plugins", "disable", "lilos"]);
    if (result !== undefined && result.status !== 0) {
      this.deps.log.warn("plugins disable failed", {
        profile,
        out: result.out.slice(-200),
      });
    }
  }

  private hermes(argv: string[]): { status: number; out: string } | undefined {
    let bin: string;
    try {
      bin = this.deps.hermesBin();
    } catch (error) {
      this.deps.log.warn("hermes bin unresolved", { error: String(error) });
      return undefined;
    }
    const env = {
      ...(process.env as Record<string, string>),
      ...this.deps.env,
      HERMES_HOME: this.deps.hermesHome,
    };
    const run =
      this.deps.run ??
      ((args: string[], e: Record<string, string>) => {
        const r = spawnSync(bin, args, {
          env: e,
          encoding: "utf8",
          timeout: 30_000,
        });
        return {
          status: r.status ?? 1,
          out: `${r.stdout ?? ""}${r.stderr ?? ""}`,
        };
      });
    return run(argv, env);
  }
}
