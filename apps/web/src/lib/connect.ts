import { atom } from "nanostores";
import type { ProfileConnection } from "@lilos/contracts/app";
import { relay } from "./runtime";

/**
 * Connect (#339): Oscar's one-time approval that installs the LilOS plugin
 * on every Hermes profile so employees see the app from inside their
 * sessions. The flag lives in the relay's settings KV (`connect.hermes`);
 * the harness reconciles plugin state from it and reports per-profile rows
 * on `system.status` — this module is the app's read/write seam for both.
 */

/** The relay `settings.*` key the Connect step writes once. */
export const CONNECT_KEY = "connect.hermes";

/** `settings.changed` already ran: true once Oscar approved Connect.
    undefined until the first `settings.get` lands. */
export const connectApproved = atom<boolean | undefined>(undefined);

/** Per-profile connection rows off the last `system.status` — undefined on
    non-Hermes engines (the harness never reports `connect`). Callers gate
    every connect surface on this being defined, not on the engine name. */
export function connectRows(): ProfileConnection[] | undefined {
  return relay.status.get().result?.connect;
}

/** The row for one employee's engine profile, if the harness reported it. */
export function rowFor(
  rows: ProfileConnection[] | undefined,
  profile: string | undefined,
): ProfileConnection | undefined {
  if (!rows || !profile) return undefined;
  return rows.find((r) => r.profile === profile);
}

/**
 * Grant the approval once: write the flag, then pull `system.status` a few
 * times so the badges animate through updating → connected rather than
 * waiting a full poll cycle (the harness reconciles within seconds).
 */
export async function requestConnect(): Promise<void> {
  await relay.request("settings.set", {
    key: CONNECT_KEY,
    value: { approved: true },
  });
  connectApproved.set(true);
  const kick = (ms: number) =>
    setTimeout(() => {
      void relay.refreshSystemStatus().catch(() => {});
    }, ms);
  void relay.refreshSystemStatus().catch(() => {});
  kick(1_500);
  kick(5_000);
}

/** Seed the approval flag + follow `settings.changed` (called once at boot
    from `bootRuntime`, next to the other settings seeds). */
export function initConnect(): void {
  void relay
    .request<{ value: unknown }>("settings.get", { key: CONNECT_KEY })
    .then((r) => {
      const v = r.value;
      connectApproved.set(
        typeof v === "object" &&
          v !== null &&
          (v as { approved?: boolean }).approved === true,
      );
    })
    .catch(() => {});
  relay.onEvent((method, params) => {
    if (method !== "settings.changed") return;
    const { key, value } = params as { key?: string; value?: unknown };
    if (key !== CONNECT_KEY) return;
    connectApproved.set(
      typeof value === "object" &&
        value !== null &&
        (value as { approved?: boolean }).approved === true,
    );
  });
}
