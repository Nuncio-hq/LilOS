import { AddFolderDialog } from "@lilos/ui";
import { createPortal } from "react-dom";
import { moveConversationFolder, toastOnFail } from "../lib/actions";
import { discovered, folders, fsRows, loadDir } from "../lib/folders";
import { useAtom } from "../lib/hooks";

/* #581 AC-2: "Add a folder" on a folder-less thread opens the same dialog
   the composer's picker uses — but picks a MOVE target for that session, not
   a recents entry for the next send. Portaled to <body>: the dialog is
   `fixed`, and a surface hosting the thread inside a container-query or
   transformed ancestor would otherwise pin it to that ancestor's box. */
export function MoveFolderDialog({
  conversationId,
  onClose,
}: {
  conversationId: string;
  onClose: () => void;
}) {
  const folderRows = useAtom(folders);
  const fsListing = useAtom(fsRows);
  const discoveredRows = useAtom(discovered);
  return createPortal(
    <AddFolderDialog
      folders={folderRows}
      fs={fsListing}
      discovered={discoveredRows}
      onNeedDir={loadDir}
      onClose={onClose}
      onAdd={(path) => {
        onClose();
        toastOnFail(
          "Couldn't move the session to that folder",
          moveConversationFolder(conversationId, path),
        );
      }}
    />,
    document.body,
  );
}
