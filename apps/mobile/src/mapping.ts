import { PairingExchangeFailed, RelayError } from "@lilos/client-runtime";
import { type AppChannel, ProtocolVersionMismatch } from "@lilos/contracts/app";
import type {
  ChannelRow,
  ConnectingState,
  MacLink,
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

/** Which side a `protocol_version_mismatch` says is stale — "phone" when the
   wire's `update` is `client` (this iPhone is behind), "mac" for `server`
   (the relay on the Mac). `#597`. */
export type BlockedUpdate = "phone" | "mac";

/** #597 AC-2: the fatal error → the side that must update, or undefined when
   the fatal isn't a version mismatch / the payload can't be read. */
export function blockedUpdateFor(error: unknown): BlockedUpdate | undefined {
  if (!(error instanceof RelayError)) return undefined;
  if (error.code !== "protocol_version_mismatch") return undefined;
  const data = ProtocolVersionMismatch.safeParse(error.data);
  if (!data.success) return undefined;
  return data.data.update === "client" ? "phone" : "mac";
}

/** #597 AC-1: the body line under a "version mismatch" blocked state. */
export function blockedLine(update: BlockedUpdate | undefined): string {
  if (update === "phone") return "Update LilOS on this iPhone, then try again.";
  if (update === "mac") return "Update LilOS on the Mac, then try again.";
  return "LilOS versions don't match — update LilOS, then try again.";
}

/** #597 AC-1: the supervisor's raw `lastError` → one plain line for the
   "last seen" slot. The unreachable family (refused, closed, timeout, no
   network) all mean the same thing to the person holding the phone:
   the Mac isn't answering. */
export function plainLinkReason(message: string | undefined): string {
  const m = message ?? "";
  if (/protocol.*(version|mismatch)|version mismatch/i.test(m))
    return "LilOS versions don't match — update LilOS, then try again.";
  if (/unauthenticated|unauthorized|device_revoked|forbidden/i.test(m))
    return "This pairing was removed — pair again from the Mac.";
  if (
    /refus|closed|unreach|offline|timed?\s*out|timeout|socket|dns|econn|enet|ehost|network|abort/i.test(
      m,
    )
  )
    return "Mac asleep or offline.";
  return "Can't reach your Mac right now.";
}

/** #597: the thin note above composers / under headers while the Mac can't
   serve: a reach problem vs the version-mismatch update. */
export function unreachableNoteFor(
  link: MacLink,
  macName: string,
): string | undefined {
  if (link === "blocked") return "Update needed";
  if (link === "offline") return `Can't reach ${macName}`;
  return undefined;
}

/** One plain line for a failed send/open/stop — #600: "your Mac", never
   "relay"; no verb baked in (the Alert's own title carries the action). */
export function describeError(e: unknown): string {
  if (
    e instanceof RelayError &&
    (e.code === "not_connected" || e.code === "timeout")
  )
    return "Can't reach your Mac — try again.";
  return "Something went wrong on your Mac — try again.";
}
