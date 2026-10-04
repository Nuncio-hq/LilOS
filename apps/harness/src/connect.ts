import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProfileConnection } from "@lilos/contracts/app";
import { scrubLilosEnv } from "@lilos/contracts/env";
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
 * "which employees aren't connected" for the Connect surfaces. On any row
 * change `onChange` fires so the reporter re-sends immediately (#413) —
 * the relay fans the rows out on `connect.changed` and the app patches its
 * status atom live instead of waiting for the next poll.
 */

/** The relay `settings.*` key the Connect step writes once. */
export const CONNECT_APPROVAL_KEY = "connect.hermes";

interface EmployeeRow {
  id: string;
  name: string;
  profile?: string;
}

/** The relay surface every Connect reconciler reads: settings + employees. */
interface ConnectRelay {
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
}

export interface ConnectBaseDeps {
  relay: ConnectRelay;
  /** Fired when the rows `report()` returns change (#413). */
  onChange?: () => void;
  log?: Logger;
}

export interface ConnectDeps extends ConnectBaseDeps {
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

/** Order-insensitive signature of the report rows — `onChange` fires only
    when this changes (#413), so a reordered or identical roster never
    re-pushes. */
const rowsSignature = (rows: Iterable<Row>): string =>
  JSON.stringify([...rows].sort((a, b) => a.profile.localeCompare(b.profile)));

/**
 * Shared Connect reconciler plumbing (#339 + #413): the row map, `report()`
 * snapshots, serialized `reconcile()`, and the `onChange` signature check.
 * Subclasses decide what a row transition *does* — Hermes installs/enables
 * the bundled plugin on the profile; the fake just flips the row's state.
 */
abstract class ConnectBase<D extends ConnectBaseDeps> {
  protected readonly rows = new Map<string, Row>();
  private readonly profileByEmployee = new Map<string, string>();
  /** Employee ids dropped by `employee.removed` — ids are never reused, so
     a stale in-flight roster can't resurrect the row (#413). */
  private readonly removedEmployeeIds = new Set<string>();
  private inflight?: Promise<void>;
  private lastSignature = "[]";

  constructor(protected readonly deps: D) {}

  /** The report rows — one per row state the reconciler knows. */
  report(): ProfileConnection[] {
    return [...this.rows.values()].map((row) => ({ ...row }));
  }

  /** Serialized reconcile — event triggers collapse into one pass. */
  reconcile(): Promise<void> {
    this.inflight ??= this.reconcileInner()
      .then(() => this.emitIfChanged())
      .catch((error) =>
        this.deps.log?.warn("connect reconcile failed", {
          error: String(error),
        }),
      )
      .finally(() => {
        this.inflight = undefined;
      });
    return this.inflight;
  }

  /** `employee.removed` only carries the id — drop via the last map. */
  employeeRemoved(employeeId: string): void {
    this.removedEmployeeIds.add(employeeId);
    const profile = this.profileByEmployee.get(employeeId);
    if (profile === undefined) return;
    this.employeeGone(profile);
    this.rows.delete(profile);
    this.profileByEmployee.delete(employeeId);
    this.emitIfChanged();
  }

  /** What a reconcile actually reconciles — subclass. */
  protected abstract reconcileInner(): Promise<void>;

  /** True when `employee.removed` already landed for this roster row — a
     roster fetched before the removal must not recreate it. */
  protected wasRemoved(employeeId: string): boolean {
    return this.removedEmployeeIds.has(employeeId);
  }

  /** The dropped profile's teardown (plugin disable for Hermes; the fake
     has nothing on disk to undo). */
  protected employeeGone(_profile: string): void {}

  protected row(profile: string, employee?: string): Row {
    let row = this.rows.get(profile);
    if (!row) {
      row = { profile, state: "not-connected" };
      this.rows.set(profile, row);
    }
    if (employee !== undefined) row.employee = employee;
    return row;
  }

  protected async approved(): Promise<boolean> {
    const { value } = (await this.deps.relay.request("settings.get", {
      key: CONNECT_APPROVAL_KEY,
    })) as { value?: unknown };
    return (
      typeof value === "object" &&
      value !== null &&
      (value as { approved?: boolean }).approved === true
    );
  }

  /** `employees.list` → profile→employee map, with `profileByEmployee`
      rebuilt for the next `employee.removed`. */
  protected async employeeRoster(): Promise<Map<string, EmployeeRow>> {
    const { employees } = (await this.deps.relay.request(
      "employees.list",
      {},
    )) as { employees: EmployeeRow[] };
    this.profileByEmployee.clear();
    for (const e of employees)
      if (e.profile) this.profileByEmployee.set(e.id, e.profile);
    return new Map(
      employees.filter((e) => e.profile).map((e) => [e.profile as string, e]),
    );
  }

  /** Emit `onChange` once per distinct row set — the reporter re-reads
      `report()` lazily, so the event only says "the rows moved". */
  private emitIfChanged(): void {
    const sig = rowsSignature(this.rows.values());
    if (sig === this.lastSignature) return;
    this.lastSignature = sig;
    this.deps.onChange?.();
  }
}

export class HermesConnect extends ConnectBase<ConnectDeps> {
  constructor(deps: ConnectDeps) {
    super(deps);
  }

  protected employeeGone(profile: string): void {
    this.disable(profile);
  }

  protected async reconcileInner(): Promise<void> {
    const ok = await this.approved();
    const byProfile = await this.employeeRoster();

    for (const [profile, e] of byProfile) {
      if (this.wasRemoved(e.id)) continue;
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

  /** Hermes' profile home layout: the built-in `default` profile's home is
      HERMES_HOME itself (plugins under `<home>/plugins/`); every named
      profile lives under `<HERMES_HOME>/profiles/<name>/`. */
  private profileHome(profile: string): string {
    return profile === "default"
      ? this.deps.hermesHome
      : join(this.deps.hermesHome, "profiles", profile);
  }

  /** Install + enable the plugin on one profile (version-aware, AC-6). */
  private connect(profile: string, row: Row): void {
    const home = this.profileHome(profile);
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
    if (!this.toolSearch(profile, "off")) {
      row.state = "failed";
      row.reason = "couldn't disable Hermes tool search for this profile";
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
    this.toolSearch(profile, "auto");
  }

  /** LilOS plugin tools must reach the model's tool list directly: Hermes'
      tool search defers every plugin-registered tool behind `tool_search`
      (`tools/tool_search.py` — plugin toolsets are never in its
      `_DIRECT_SURFACE_TOOLSETS`), so a LilOS profile with tool search on
      offers `tool_search` instead of `lilos_context` (#411). The host policy
      names the `lilos_*` tools outright — they must be offered, not
      searched for. Profile-scoped `tools.tool_search.enabled` is the only
      off switch upstream provides; restore the default on disconnect. */
  private toolSearch(profile: string, enabled: "off" | "auto"): boolean {
    const result = this.hermes([
      "-p",
      profile,
      "config",
      "set",
      "tools.tool_search.enabled",
      enabled,
    ]);
    if (result !== undefined && result.status !== 0) {
      this.deps.log.warn("config set tools.tool_search.enabled failed", {
        profile,
        out: result.out.slice(-200),
      });
      return false;
    }
    return true;
  }

  private hermes(argv: string[]): { status: number; out: string } | undefined {
    let bin: string;
    try {
      bin = this.deps.hermesBin();
    } catch (error) {
      this.deps.log.warn("hermes bin unresolved", { error: String(error) });
      return undefined;
    }
    /* #507: `hermes` may load profile plugin code — same allow-list scrub
       as the engine spawn; the explicit Connect env + HERMES_HOME ride on
       top (an explicit grant always wins). */
    const env = {
      ...(scrubLilosEnv(process.env) as Record<string, string>),
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

/**
 * engine-fake's Connect (#413 e2e): the same approval → rows contract as
 * HermesConnect with nothing to install — the fake engine owns no profile
 * homes or plugins, so rows flip purely on the relay approval. This is what
 * lets the e2e stack exercise the live `connect.changed` path.
 */
export class FakeConnect extends ConnectBase<ConnectBaseDeps> {
  protected async reconcileInner(): Promise<void> {
    const ok = await this.approved();
    const byProfile = await this.employeeRoster();
    for (const [profile, e] of byProfile) {
      if (this.wasRemoved(e.id)) continue;
      this.row(profile, e.name).state = ok ? "connected" : "not-connected";
    }
    for (const profile of this.rows.keys()) {
      if (!byProfile.has(profile)) this.rows.delete(profile);
    }
  }
}
