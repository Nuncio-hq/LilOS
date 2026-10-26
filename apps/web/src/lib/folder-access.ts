import type { FolderAccessState } from "@lilos/contracts/app";
import { atom } from "nanostores";

/* D-#875: the desktop shell's macOS folder-access state, mirrored for the
   renderer. `pending` folders are the ask step's job ("Allow access" →
   `ask()` touches each one, the real prompts rise); `blocked` folders the
   banner's (System Settings is the remedy). On plain web the bridge is
   absent and the state stays null — no surfaces, no work. */

export const folderAccess = atom<FolderAccessState | null>(null);

/** "Not now" lives only for this window's life — the ask returns next
 *  launch until the folders are granted (they are the app's main job). */
export const folderAccessDismissed = atom(false);

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

/** A folder the app just adopted (project add, thread move): keeps its
 *  protected folder in view — pending asks at the step, blocked at the
 *  banner. Fire-and-forget; a bridge miss is nothing. */
export function ensureFolderAccess(path: string): void {
  void window.lilos?.folderAccess
    ?.ensure(path)
    .then((s) => {
      if (s) folderAccess.set(s);
    })
    .catch(() => {});
}

/** System Settings → Privacy & Security → Files and Folders. */
export function openFolderAccessSettings(): void {
  void window.lilos?.folderAccess?.openSettings();
}
