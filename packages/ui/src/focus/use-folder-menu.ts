import { useEffect, useState } from "react";
import type { HostAccessors, OsApp, OsEditor, Thread } from "../types";

/* The folder badge's "Open in …/Reveal in Finder" menu (issue #110): the
   editors on the session's host, and the open call — the session's own
   `onOpenPath`, else the host's os.open. D-#19: the badge is a menu only when
   something can open the path; `onOpenPath === null` means the caller probed
   and os.open is absent, so the badge stays a plain label even when the
   accessors object statically carries the method. */
export function useFolderMenu({
  thread,
  host,
  editors: editorsProp,
  onOpenPath,
  say,
}: {
  thread: Thread;
  host?: HostAccessors;
  editors?: OsEditor[];
  onOpenPath?: ((path: string, app: OsApp, line?: number) => void) | null;
  say?: (t: string, opts?: { error?: boolean }) => void;
}): { editors: OsEditor[]; onOpen: (app: OsApp) => void } | undefined {
  const wsCwd = thread.ws?.cwd;
  const [hostEditors, setHostEditors] = useState<OsEditor[]>([]);
  useEffect(() => {
    let off = false;
    if (editorsProp === undefined && host?.osEditors && wsCwd)
      void host
        .osEditors()
        .then((e) => !off && setHostEditors(e))
        .catch(() => {});
    else setHostEditors([]);
    return () => {
      off = true;
    };
  }, [wsCwd, editorsProp]);
  const editors = editorsProp ?? hostEditors;
  if (onOpenPath) return { editors, onOpen: (app) => onOpenPath(".", app) };
  if (onOpenPath === undefined && host?.osOpen && thread.ws)
    return {
      editors,
      onOpen: (app) =>
        void host
          .osOpen?.(thread.ws?.cwd ?? "", ".", app)
          .catch((e) =>
            say?.(
              `Open failed — ${e instanceof Error ? e.message : String(e)}`,
              { error: true },
            ),
          ),
    };
  return undefined;
}
