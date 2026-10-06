import type { SessionState } from "./types";

/* DM thread grouping — Needs you, Working, Didn't finish, Done — newest
   first inside each group (#592: a turn that died is not Done). Kept out
   of dm-screen.tsx so the app's Vitest can reach it without react-native. */
export const DM_GROUPS: { title: string; states: SessionState[] }[] = [
  { title: "Needs you", states: ["needs-you"] },
  { title: "Working", states: ["working"] },
  { title: "Didn't finish", states: ["failed", "stopped"] },
  { title: "Done", states: ["done"] },
];

/** Which DM section a thread lands in (kept in sync with DM_GROUPS). */
export function dmSectionFor(state: SessionState): string {
  return DM_GROUPS.find((g) => g.states.includes(state))?.title ?? "Done";
}
