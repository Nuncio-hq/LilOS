import type { AppChannel, Employee } from "@lilos/contracts/app";
import type {
  ChannelRow,
  EmployeeRow,
  OrbTone,
  ProjectGroup,
} from "@lilos/ui-native";

/* relay domain -> ui-native view models. The only place this mapping lives;
   kept deliberately thin — presence/activity niceties arrive with the DM
   slice. */

const TONES: OrbTone[] = ["blue", "violet", "sunset", "stone", "mint", "rose"];

/** Deterministic orb tone from the employee id (the web picks a tone per
   employee too; the wire has no color field). */
function toneOf(id: string): OrbTone {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return TONES[h % TONES.length] ?? "blue";
}

export function toEmployeeRow(e: Employee): EmployeeRow {
  return {
    id: e.id,
    name: e.name,
    role: e.role,
    tone: toneOf(e.id),
    state: e.status === "busy" ? "working" : "idle",
    now: e.now || (e.status === "offline" ? "Offline" : "Idle"),
    when: e.status === "busy" ? "now" : "",
  };
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
