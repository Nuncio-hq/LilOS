/**
 * Settings pane state (issue #132): the pure helpers behind the wired
 * SettingsView — which sections exist (D-#19: only with real data), the
 * stored default editor's place in detected lists, the ⌘, shortcut, and
 * General's draft-vs-relay reconciliation. `defaultEditor` itself lives in
 * the relay's settings KV like `modelVisibility` (#92) — seeded in
 * runtime.ts, written via actions.ts.
 */
import type { ProfileSettings } from "@lilos/contracts/app";
import type { ConversationAccess } from "@lilos/contracts/engine";
import type { DetectedEditor } from "@lilos/ui/types";
import { atom } from "nanostores";

/** The picked default editor (relay `settings` key `defaultEditor`); null
 *  means "first detected" — D-#110's pre-#132 behavior. */
export const defaultEditor = atom<string | null>(null);

/** #106 AC-3: Settings' "Default access for new conversations" (relay
 *  `settings` key `defaultAccess`); a conversation opens on it and never
 *  remembers a previous session's level. */
export const defaultAccess = atom<ConversationAccess>("ask");

/** ⌘, on macOS / Ctrl+, elsewhere — the platform's Settings shortcut. */
export function isSettingsShortcut(e: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
}): boolean {
  return (e.metaKey || e.ctrlKey) && e.key === ",";
}

/** The host's os.editors row (issue #110) — `app` is the bundle path. */
export interface DetectedEditorWire {
  id: string;
  name: string;
  app?: string;
}

export function toDetectedEditor(e: DetectedEditorWire): DetectedEditor {
  return { id: e.id, name: e.name, ...(e.app ? { path: e.app } : {}) };
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

/** Editors section props — undefined when nothing is installed (D-#19).
 *  `defaultId` falls back to the first detected editor so the section always
 *  shows which editor is in effect. `editors` arrives already ordered
 *  (orderEditors inside the host client). */
export function editorsProps(
  editors: DetectedEditorWire[] | null | undefined,
  defaultId: string | null,
): { detected: DetectedEditor[]; defaultId: string | null } | undefined {
  if (!editors?.length) return undefined;
  const detected = editors.map(toDetectedEditor);
  const stored = defaultId && editors.some((e) => e.id === defaultId);
  return {
    detected,
    defaultId: stored ? defaultId : detected[0].id,
  };
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

/** General's fields are controlled inputs (AC-3): keystrokes edit a local
 *  draft, a debounce posts profile.update, and the relay's echo (or another
 *  window's edit) drops each field once the stored value catches up — so
 *  typing never fights the round trip. */
export interface SettingsDraft {
  name?: string;
  company?: string;
  color?: string;
}

/** Draft minus the fields the relay now stores at the same value. */
export function settledDrafts(
  drafts: SettingsDraft,
  current: { name: string; company: string; color: string },
): SettingsDraft {
  const next = { ...drafts };
  if (next.name !== undefined && next.name === current.name) delete next.name;
  if (next.company !== undefined && next.company === current.company)
    delete next.company;
  if (next.color !== undefined && next.color === current.color)
    delete next.color;
  return next;
}

/* The schema's min(1) (#118): an emptied field isn't sent — the derived
   identity keeps showing elsewhere, same as first run. */
export function profilePatch(d: SettingsDraft): ProfileSettings {
  const patch: ProfileSettings = {};
  if (d.name?.trim()) patch.userName = d.name;
  if (d.company?.trim()) patch.companyName = d.company;
  if (d.color) patch.avatarColor = d.color;
  return patch;
}
