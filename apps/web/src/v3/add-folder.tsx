import { AddFolderDialog } from "@lilos/ui";
import { atom } from "nanostores";
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

/* "Add a folder…" in the new chat's folder menu: the app's own dialog, the one
   the old composer's picker opened (D-#113, #208). `askForFolder` opens it;
   the folder it adds goes to the app's recents and then to `onAdded`. Closing
   the dialog says nothing. */

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
  const folderRows = useAtom(folders);
  const fsListing = useAtom(fsRows);
  const discoveredRows = useAtom(discovered);
  if (!onAdded) return null;
  return createPortal(
    <AddFolderDialog
      folders={folderRows}
      fs={fsListing}
      discovered={discoveredRows}
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
