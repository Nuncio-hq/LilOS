import { AddFolderDialog, NEW_PROJECT_COPY } from "@lilos/ui";
import { atom } from "nanostores";
import { useMemo } from "react";
import { createPortal } from "react-dom";
import { toastOnFail } from "../lib/actions";
import {
  addFolder as addToRecents,
  discovered,
  folders,
  fsRows,
  loadDir,
  loadDiscovered,
} from "../lib/folders";
import { useAtom } from "../lib/hooks";

/* "New project from a folder…" in the new chat's project menu: the app's own
   dialog, the one the old composer's picker opened (D-#113, #208, D-#771).
   `askForFolder` opens it; the folder it adds goes to the app's recents and
   then to `onAdded`, which makes the project. Closing the dialog says
   nothing. */

const asking = atom<((path: string) => void) | null>(null);

/** Open the dialog; `onAdded` gets the path once it is in the recents. */
export function askForFolder(onAdded: (path: string) => void): void {
  toastOnFail("Couldn't scan for repos", loadDiscovered());
  asking.set(onAdded);
}

/** Rendered once by the root; draws the dialog while a folder is asked for.
    Portaled to <body>: the dialog is `fixed`, and the peek's container-query
    ancestor would otherwise pin it to its own box. */
export function AddFolderHost() {
  const onAdded = useAtom(asking);
  const recents = useAtom(folders);
  const fsListing = useAtom(fsRows);
  const discoveredRows = useAtom(discovered);
  /* The folders the app already knows come first, one click each, then what
     the scan found: a folder given earlier but never used has no project
     yet, and this is where it becomes one. */
  const found = useMemo(() => {
    const known = recents.filter((f) => !f.missing).map((f) => f.path);
    return [...known, ...discoveredRows.filter((d) => !known.includes(d))];
  }, [recents, discoveredRows]);
  if (!onAdded) return null;
  return createPortal(
    <AddFolderDialog
      // Nothing is "already added" here: a folder that has a project simply
      // answers it (`projects.create` returns the one it has).
      folders={[]}
      copy={NEW_PROJECT_COPY}
      fs={fsListing}
      discovered={found}
      onNeedDir={loadDir}
      onClose={() => asking.set(null)}
      onAdd={(path) => {
        asking.set(null);
        toastOnFail(
          "Couldn't add the folder",
          addToRecents(path).then((f) => {
            if (f) onAdded(f.path);
          }),
        );
      }}
    />,
    document.body,
  );
}
