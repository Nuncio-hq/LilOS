import { FileCodeIcon, FilePenIcon } from "lucide-react";
import {
  FileTreeFile,
  FileTreeFolder,
  FileTreeIcon,
  FileTreeName,
} from "../components/ai-elements/file-tree";
import { cn } from "../lib/utils";
import type { Diff, OsApp, OsEditor } from "../types";
import type { TreeNode } from "./artifacts";
import { OpenPathButton } from "./open-path";

export function TreeNodes({
  node,
  changed,
  openPath,
}: {
  node: TreeNode;
  changed: Map<string, Diff>;
  /* os.open wired for the session cwd (issue #110): each file row gets an
     "Open in …/Reveal in Finder" affordance; absent → no controls (D-#19). */
  openPath?: {
    editors: OsEditor[];
    onOpen: (path: string, app: OsApp) => void;
  };
}) {
  const kids = [...node.children.values()].sort(
    (a, b) =>
      Number(b.children.size > 0) - Number(a.children.size > 0) ||
      a.name.localeCompare(b.name),
  );
  return (
    <>
      {kids.map((k) =>
        k.children.size > 0 ? (
          <FileTreeFolder key={k.path} path={k.path} name={k.name}>
            <TreeNodes node={k} changed={changed} openPath={openPath} />
          </FileTreeFolder>
        ) : (
          <FileTreeFile key={k.path} path={k.path} name={k.name}>
            <span className="size-4 shrink-0" />
            <FileTreeIcon>
              {changed.has(k.path) ? (
                <FilePenIcon className="size-4 text-amber-600" />
              ) : (
                <FileCodeIcon className="size-4 text-muted-foreground" />
              )}
            </FileTreeIcon>
            <FileTreeName className={cn(changed.has(k.path) && "font-medium")}>
              {k.name}
            </FileTreeName>
            {changed.has(k.path) && (
              <span
                className={cn(
                  changed.get(k.path)!.status === "added"
                    ? "text-emerald-600"
                    : "text-amber-600",
                  "pl-2 font-mono text-[10px]",
                  !openPath && "ml-auto",
                )}
              >
                {changed.get(k.path)!.status === "added" ? "A" : "M"}
              </span>
            )}
            {openPath && (
              // The row itself selects on click — keep the menu from doing so.
              <span
                className="ml-auto pl-1"
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => e.stopPropagation()}
              >
                <OpenPathButton
                  editors={openPath.editors}
                  onOpen={(app) => openPath.onOpen(k.path, app)}
                  label={`Open ${k.path} in an editor or Finder`}
                />
              </span>
            )}
          </FileTreeFile>
        ),
      )}
    </>
  );
}
