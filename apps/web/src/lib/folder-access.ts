import type { FolderAccessState } from "@lilos/contracts/app";
import { atom } from "nanostores";

/* D-#875: the desktop shell's macOS folder-access state, mirrored for the
   renderer. `pending` folders are the ask step's job ("Allow access" →
   `ask()` touches each one, the real prompts rise); `blocked` folders the
   banner's (System Settings is the remedy). On plain web the bridge is
   absent and the state stays null — no surfaces, no work. */

export const folderAccess = atom<FolderAccessState | null>(null);

/** "Not now" persists across relaunches (a deliberate defer isn't a
 *  per-window accident); a real FOLDER_ACCESS answer un-defers it —
 *  something the user just tried needs the access. */
const NOT_NOW_KEY = "lilos-fa-notnow";
export const folderAccessDismissed = atom(readFlag(NOT_NOW_KEY));

/** Banner lines the user dismissed — a deliberately denied folder (or one
 *  that simply doesn't exist on this Mac) shouldn't nag forever. */
const BANNER_X_KEY = "lilos-fa-banner-x";
export const folderAccessBannerDismissed = atom<Set<string>>(
  new Set(readList(BANNER_X_KEY)),
);

function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function readList(key: string): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(raw) ? raw.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode — dismissal just lives for this window */
  }
}

let watched = false;

/** Subscribe to the bridge once (effects.ts); no-op off the desktop. */
export function watchFolderAccess(): void {
  const bridge = window.lilos?.folderAccess;
  if (!bridge || watched) return;
  watched = true;
  void bridge
    .state()
    .then((s) => folderAccess.set(s))
    .catch(() => {});
  bridge.onChange?.((s) => folderAccess.set(s));
}

/** Touch every unsettled folder — the step's "Allow access". */
export async function askFolderAccess(): Promise<void> {
  const s = await window.lilos?.folderAccess?.ask();
  if (s) folderAccess.set(s);
}

/** The step's "Not now" — persisted; the ask doesn't keep returning for
 *  the same set of folders. */
export function dismissFolderAccessStep(): void {
  folderAccessDismissed.set(true);
  write(NOT_NOW_KEY, "1");
}

/** Hide the banner for these folders — persisted per folder. */
export function dismissFolderAccessBanner(names: string[]): void {
  const next = new Set(folderAccessBannerDismissed.get());
  for (const n of names) next.add(n);
  folderAccessBannerDismissed.set(next);
  write(BANNER_X_KEY, JSON.stringify([...next]));
}

/** A folder the app just adopted (project add, thread move): the caller
 *  awaits this, and the desktop's `ensure` resolves on the OS's answer —
 *  a grant lets the add/move proceed, a denial makes it hear
 *  FOLDER_ACCESS and resurface the step; a prompt left open just holds
 *  the call, like a modal (D-#875). Off the desktop, no wait. */
export async function ensureFolderAccess(path: string): Promise<void> {
  const s = await window.lilos?.folderAccess
    ?.ensure(path)
    .catch(() => undefined);
  if (s) folderAccess.set(s);
}

/** A relay/host answer that says a protected folder blocked the call —
 *  resurface the ask step if it was snoozed: something the user just did
 *  needs the access (D-#875). Host errors ride `error.data.host`. */
export function noteFolderAccessError(e: unknown): void {
  const host = (e as { data?: { host?: { folder?: string } } }).data?.host;
  if (host?.folder) folderAccessDismissed.set(false);
}

/** System Settings → Privacy & Security → Files and Folders. */
export function openFolderAccessSettings(): void {
  void window.lilos?.folderAccess?.openSettings();
}
