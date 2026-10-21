import { useEffect, useMemo, useState } from "react";
import type { HostAccessors, OsApp, OsEditor } from "../types";

/** A failure's first 160 characters, as one line a toast can carry. */
export const ghError = (e: unknown) =>
  (e instanceof Error ? e.message : String(e)).slice(0, 160);

/* Open-in-editor affordances (issue #110): editors detected on this host
   (os.editors) + one bound os.open call. No os.open → no controls (D-#19);
   no editors → the menus offer Reveal in Finder only. */
export function useWbOpen({
  host,
  liveCwd,
  editors: editorsProp,
  onOpenPath,
  say,
}: {
  host?: HostAccessors;
  liveCwd?: string;
  /** The caller's own editor list; undefined asks the host. */
  editors?: OsEditor[];
  onOpenPath?: ((path: string, app: OsApp, line?: number) => void) | null;
  say?: (t: string, opts?: { error?: boolean }) => void;
}) {
  const [hostEditors, setHostEditors] = useState<OsEditor[]>([]);
  useEffect(() => {
    let off = false;
    if (editorsProp === undefined && host?.osEditors && liveCwd)
      void host
        .osEditors()
        .then((e) => !off && setHostEditors(e))
        .catch(() => {});
    else setHostEditors([]);
    return () => {
      off = true;
    };
  }, [liveCwd, editorsProp]);
  const editors = editorsProp ?? hostEditors;
  /* One bound "open this path" for every workbench surface: `line` opens at
     the diff row's new-file line when the editor takes one; "finder" reveals. */
  const openPath = useMemo(
    () =>
      onOpenPath && liveCwd
        ? (path: string, app: OsApp, line?: number) =>
            onOpenPath(path, app, line)
        : onOpenPath === undefined && host?.osOpen && liveCwd
          ? (path: string, app: OsApp, line?: number) => {
              void host
                .osOpen?.(liveCwd, path, app, line)
                .catch((e) =>
                  say?.(`Open failed — ${ghError(e)}`, { error: true }),
                );
            }
          : undefined,
    [onOpenPath, liveCwd, host, say],
  );
  const treeOpenPath = useMemo(
    () =>
      openPath
        ? { editors, onOpen: (p: string, app: OsApp) => openPath(p, app) }
        : undefined,
    [openPath, editors],
  );
  return { editors, openPath, treeOpenPath };
}
