/**
 * Settings pane state (issue #132): the pure helpers behind the wired
 * Settings — the stored default editor's place in detected lists, the ⌘,
 * shortcut, About's version lines. `defaultEditor` itself lives in the
 * relay's settings KV like `modelVisibility` (#92) — seeded in runtime.ts,
 * written via actions.ts.
 */
import type { ProfileSettings } from "@lilos/contracts/app";
import type { ConversationAccess } from "@lilos/contracts/engine";
import { atom } from "nanostores";

/** The picked default editor (relay `settings` key `defaultEditor`); null
 *  means "first detected" — D-#110's pre-#132 behavior. */
export const defaultEditor = atom<string | null>(null);

/** #106 AC-3: Settings' "Default access for new conversations" (relay
 *  `settings` key `defaultAccess`); a conversation opens on it and never
 *  remembers a previous session's level. */
export const defaultAccess = atom<ConversationAccess>("ask");

/** #884: the engine's global approval policy says `off` — it auto-answers
 *  everything, so the app's "Ask before risky commands" can never produce
 *  a card. Read from `describe` (the `approval_policy` capability's
 *  `detail.current`); Settings and the access pill warn with a one-click
 *  Fix — the value is never written without the user's click. */
export function engineNeverAsks(
  description:
    | { capabilities?: { id: string; detail?: Record<string, unknown> }[] }
    | undefined,
): boolean {
  const cap = description?.capabilities?.find(
    (c) => c.id === "approval_policy",
  );
  return cap?.detail?.current === "off";
}

/** ⌘, on macOS / Ctrl+, elsewhere — the platform's Settings shortcut. */
export function isSettingsShortcut(e: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
}): boolean {
  return (e.metaKey || e.ctrlKey) && e.key === ",";
}

/** The stored default leads every editor list (Open-in-editor menus pick
 *  the first entry); detection order is kept for the rest. */
export function orderEditors<T extends { id: string }>(
  list: T[],
  defaultId: string | null | undefined,
): T[] {
  const i = defaultId ? list.findIndex((e) => e.id === defaultId) : -1;
  if (i <= 0) return list;
  return [list[i], ...list.slice(0, i), ...list.slice(i + 1)];
}

/** What Settings → About shows: the app version the shell reports (desktop
 *  bridge), else the relay's on plain web; the detail line lists every live
 *  version — build · relay · harness. */
export function aboutLines(input: {
  app?: { version?: string; build?: number } | null;
  versions?: { relay?: string; harness?: string } | null;
}): { version?: string; build?: string } {
  const version = input.app?.version ?? input.versions?.relay;
  const build = [
    input.app?.build ? `build ${input.app.build}` : undefined,
    input.versions?.relay ? `relay ${input.versions.relay}` : undefined,
    input.versions?.harness ? `harness ${input.versions.harness}` : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  return { version, build: build || undefined };
}

/** "Check for updates" reports its outcome plainly (AC-4). */
export function updateOutcomeMessage(outcome: string): string {
  switch (outcome) {
    case "none":
      return "LilOS is up to date.";
    case "apply-ready":
      return "Update ready — LilOS restarts to install it.";
    case "busy":
      return "An update check is already running.";
    case "failed":
      return "Update check failed — try again.";
    default:
      return "Updates are off on this build.";
  }
}

/* The schema's min(1) (#118): an emptied field isn't sent — the derived
   identity keeps showing elsewhere, same as first run. */
export function profilePatch(d: {
  name?: string;
  company?: string;
}): ProfileSettings {
  const patch: ProfileSettings = {};
  if (d.name?.trim()) patch.userName = d.name;
  if (d.company?.trim()) patch.companyName = d.company;
  return patch;
}
