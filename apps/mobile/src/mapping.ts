import { PairingExchangeFailed, RelayError } from "@lilos/client-runtime";
import type { AppChannel } from "@lilos/contracts/app";
import type {
  ChannelRow,
  ConnectingState,
  OrbTone,
  ProjectGroup,
} from "@lilos/ui-native";

/* relay domain -> ui-native view models. The only place this mapping lives;
   kept deliberately thin — row derivation with state moved to home-model.ts
   with the live Home slice (#155). */

const TONES: OrbTone[] = ["blue", "violet", "sunset", "stone", "mint", "rose"];

/** Deterministic orb tone from the employee id (the web picks a tone per
   employee too; the wire has no color field). */
export function toneOf(id: string): OrbTone {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return TONES[h % TONES.length] ?? "blue";
}

/**
 * Channels only exist as employee-bound DMs on the wire today (`kind: "dm"`),
 * so Home's Slack-style sections stay empty — the screen hides the header
 * when there's nothing to list rather than drawing an empty "Channels".
 */
export function toHomeChannels(_channels: AppChannel[]): {
  company: ChannelRow[];
  projects: ProjectGroup[];
} {
  return { company: [], projects: [] };
}

/** #593: an exchange error → the Connecting screen's next state. Every
   refusal the relay actually speaks gets its own words — a wrong code is
   not "can't reach", a throttle says its wait — and anything outside the
   protocol (offline, timeout, a 500 page) stays "unreachable". */
export function connectingOutcome(error: unknown): {
  state: ConnectingState;
  retryAfterSeconds?: number;
} {
  if (error instanceof PairingExchangeFailed) {
    if (error.reason === "expired" || error.reason === "used")
      return { state: "expired" };
    if (error.reason === "throttled")
      return {
        state: "throttled",
        /* The relay's lock is 60s (#568); when it didn't send Retry-After
           we still say a wait — the documented budget. */
        retryAfterSeconds: Math.ceil((error.retryAfterMs ?? 60_000) / 1000),
      };
    return { state: "mismatch" };
  }
  return { state: "unreachable" };
}

/** One plain line for a failed send/open — same mapping as web's. */
export function describeError(e: unknown): string {
  if (e instanceof RelayError) {
    if (e.code === "not_connected" || e.code === "timeout")
      return "Couldn't reach the relay — try again.";
    if (e.code === "invalid_params") return "Couldn't send that. Try again.";
  }
  return "Couldn't send that. Try again.";
}
