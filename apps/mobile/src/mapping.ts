import { RelayError } from "@lilos/client-runtime";
import type { AppChannel } from "@lilos/contracts/app";
import type { ChannelRow, OrbTone, ProjectGroup } from "@lilos/ui-native";

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

/** One plain line for a failed send/open — same mapping as web's. */
export function describeError(e: unknown): string {
  if (e instanceof RelayError) {
    if (e.code === "not_connected" || e.code === "timeout")
      return "Couldn't reach the relay — try again.";
    if (e.code === "invalid_params") return "Couldn't send that. Try again.";
  }
  return "Couldn't send that. Try again.";
}
