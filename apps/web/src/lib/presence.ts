/**
 * At-the-Mac presence (#561 AC-1): while the human is using this Mac the
 * phone stays silent — the relay's push fan-out suppresses every kind and
 * the Mac's own banners carry the attention. "At the Mac" is the shell's
 * reading: user input in ANY app within `PRESENCE_IDLE_MS`, screen unlocked.
 * The renderer heartbeats `presence.report` to the relay while active and
 * sends one `active: false` when it flips off, so pushes resume at once
 * instead of waiting out the relay's freshness window. Plain web has no
 * presence bridge — no reports, pushes behave exactly as before.
 */
import type { DesktopBridge, DesktopPresence } from "@lilos/contracts/app";

/** "At the Mac" ends after this much input silence — same N the relay
    uses to age a stale report, so the two sides agree on the window. */
export const PRESENCE_IDLE_MS = 5 * 60_000;

const isActive = (p: DesktopPresence): boolean =>
  !p.locked && p.idleSeconds * 1000 < PRESENCE_IDLE_MS;

export interface PresenceWatchOpts {
  bridge: DesktopBridge["presence"];
  report: (active: boolean) => Promise<unknown> | unknown;
  /** Heartbeat cadence — well under the relay's window (default 60s). */
  intervalMs?: number;
}

export function watchPresence(opts: PresenceWatchOpts): () => void {
  const bridge = opts.bridge;
  if (!bridge) return () => {};
  const intervalMs = opts.intervalMs ?? 60_000;
  let last: boolean | undefined;
  let inFlight = false;

  const tick = async (): Promise<void> => {
    if (inFlight) return;
    inFlight = true;
    try {
      const active = isActive(await bridge.current());
      /* Refresh while active so the relay's window never ages out
         mid-session; an inactive report is only worth sending once —
         except the first tick, which seeds the relay either way. */
      if (active || last !== false) {
        await opts.report(active);
        last = active;
      }
    } catch {
      /* A dropped socket or a busy main just skips the tick — the next
         one re-reports; the relay falls back to pushing meanwhile. */
    } finally {
      inFlight = false;
    }
  };

  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  const unsub = bridge.onChange?.(() => void tick());
  return () => {
    clearInterval(timer);
    unsub?.();
  };
}
