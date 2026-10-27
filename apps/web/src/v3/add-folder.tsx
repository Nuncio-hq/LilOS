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
import { relay } from "../lib/runtime";

/* "New project from a folder…" in the new chat's project menu: the app's own
   dialog, the one the old composer's picker opened (D-#113, #208, D-#771).
   `askForFolder` opens it; the folder it adds goes to the app's recents and
   then to `onAdded`, which makes the project. Closing the dialog says
   nothing. */

const asking = atom<{
  onAdded: (path: string, project?: { name: string; key: string }) => void;
  folder?: string;
} | null>(null);

/** Open the dialog; `onAdded` gets the path plus the editable name/key once
    it is in the recents. `folder` pre-picks a path (a chat's "Add as
    project" opens on the folder the chat already runs in, #854). */
export function askForFolder(
  onAdded: (path: string, project?: { name: string; key: string }) => void,
  opts?: { folder?: string },
): void {
  toastOnFail("Couldn't scan for repos", loadDiscovered());
  asking.set({ onAdded, folder: opts?.folder });
}

/** "Add as project" on a chat's folder chip (D-#854): the same dialog the
    sidebar's ＋ opens, pre-picked to the chat's folder — name and key
    prefill and stay editable — then `projects.create`. */
export function addFolderAsProject(folder: string): void {
  askForFolder(
    (path, pick) =>
      toastOnFail(
        "Couldn't create the project",
        relay.createProject({
          folder: path,
          ...(pick?.name ? { name: pick.name } : {}),
          ...(pick?.key ? { key: pick.key } : {}),
        }),
      ),
    { folder },
  );
}

/** Rendered once by the root; draws the dialog while a folder is asked for.
    Portaled to <body>: the dialog is `fixed`, and the peek's container-query
    ancestor would otherwise pin it to its own box. */
export function AddFolderHost() {
  const ask = useAtom(asking);
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
  if (!ask) return null;
  return createPortal(
    <AddFolderDialog
      // Nothing is "already added" here: a folder that has a project simply
      // answers it (`projects.create` returns the one it has).
      folders={[]}
      copy={NEW_PROJECT_COPY}
      projectFields
      folder={ask.folder}
      fs={fsListing}
      discovered={found}
      onNeedDir={loadDir}
      onClose={() => asking.set(null)}
      onAdd={(path, project) => {
        asking.set(null);
        toastOnFail(
          "Couldn't add the folder",
          addToRecents(path).then((f) => {
            if (f)
              ask.onAdded(
                f.path,
                project?.name
                  ? { name: project.name, key: project.key ?? "" }
                  : undefined,
              );
          }),
        );
      }}
    />,
    document.body,
  );
}
