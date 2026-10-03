import { atom } from "nanostores";
import { relay } from "./runtime";

/**
 * Connect (#339): the one-time approval that installs the LilOS plugin
 * on every Hermes profile so employees see the app from inside their
 * sessions. The flag lives in the relay's settings KV (`connect.hermes`);
 * the harness reconciles plugin state from it and reports per-profile rows
 * on `system.status` — this module is the app's read/write seam for both.
 */

/** The relay `settings.*` key the Connect step writes once. */
const CONNECT_KEY = "connect.hermes";

/** `settings.changed` already ran: true once Connect was approved.
    undefined until the first `settings.get` lands. */
export const connectApproved = atom<boolean | undefined>(undefined);

/**
 * Grant the approval once: write the flag. The rows themselves arrive on
 * `connect.changed` (#413) — the relay broadcasts them the moment the
 * harness's reconcile flips a profile, and the client's status atom
 * patches in place. No extra status pulls needed here.
 */
export async function requestConnect(): Promise<void> {
  await relay.request("settings.set", {
    key: CONNECT_KEY,
    value: { approved: true },
  });
  connectApproved.set(true);
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
