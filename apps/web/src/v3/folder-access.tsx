import { FolderAccessBanner, FolderAccessStep } from "@lilos/ui";
import { useState } from "react";
import { createPortal } from "react-dom";
import {
  askFolderAccess,
  dismissFolderAccessBanner,
  dismissFolderAccessStep,
  folderAccess,
  folderAccessBannerDismissed,
  folderAccessDismissed,
  openFolderAccessSettings,
} from "../lib/folder-access";
import { useAtom } from "../lib/hooks";

/* D-#875: the desktop bridge's folder-access state drawn by the shell.
   The step is a portal beside AddFolderHost — it asks while the user is
   looking, then `ask()` makes main touch each folder so the real macOS
   prompts rise. The banner is a V3Shell banner row (blocked reads). */

/** Banner row for the shell's `banner` slot — asked folders still blocked
 *  and not dismissed. */
export function FolderAccessBannerHost() {
  const state = useAtom(folderAccess);
  const dismissed = useAtom(folderAccessBannerDismissed);
  if (!state) return null;
  const show = state.blocked.filter((f) => !dismissed.has(f));
  if (show.length === 0) return null;
  return (
    <FolderAccessBanner
      folders={show}
      onSettings={openFolderAccessSettings}
      onDismiss={() => dismissFolderAccessBanner(show)}
    />
  );
}

/** The ask step — until the pending set is empty or "Not now" (which
 *  persists; a real FOLDER_ACCESS error un-defers it). Draws over any page
 *  (first run included). */
export function FolderAccessStepHost() {
  const state = useAtom(folderAccess);
  const dismissed = useAtom(folderAccessDismissed);
  const [busy, setBusy] = useState(false);
  if (!state || state.pending.length === 0 || dismissed) return null;
  return createPortal(
    <FolderAccessStep
      folders={state.pending}
      busy={busy}
      onAllow={() => {
        setBusy(true);
        void askFolderAccess().finally(() => setBusy(false));
      }}
      onLater={dismissFolderAccessStep}
    />,
    document.body,
  );
}
