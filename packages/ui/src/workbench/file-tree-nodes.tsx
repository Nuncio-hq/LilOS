import { FileTextIcon } from "lucide-react";
import { memo } from "react";
import {
  FileTreeFile,
  FileTreeFolder,
  FileTreeIcon,
  FileTreeName,
} from "../components/ai-elements/file-tree";
import { cn } from "../lib/utils";
import type { Diff, OsApp, OsEditor } from "../types";
import type { TreeNode } from "./artifacts";
import { countTreeRows, sortedTreeKids } from "./artifacts";
import { OpenPathButton } from "./open-path";

const TREE_CHUNK = 50;
const TREE_ROW_PX = 26;

/* The prototype's compact row: 26px, 13px quiet text, --v3-hover on hover.
   FileTreeFile merges className after its own classes, so these win. */
const FILE_ROW =
  "h-[26px] gap-1.5 rounded-md px-1.5 py-0 text-[13px] text-muted-foreground hover:bg-[var(--v3-hover)] hover:text-foreground";

/* FileTreeFolder only exposes className on its outer wrapper; its header
   row, folder icon and indent guide are reached by selector. Same look as
   FILE_ROW, the blue folder icon goes neutral, and the guide is a
   hairline at a 12px indent. */
const FOLDER_ROW =
  "text-[13px] text-muted-foreground [&>div:first-child]:h-[26px] [&>div:first-child]:gap-1.5 [&>div:first-child]:rounded-md [&>div:first-child]:px-1.5 [&>div:first-child]:py-0 [&>div:first-child:hover]:bg-[var(--v3-hover)] [&>div:first-child:hover]:text-foreground [&_.text-blue-500]:text-muted-foreground [&_.border-l]:border-[var(--v3-line)] [&_.ml-4]:ml-[9px] [&_.pl-2]:pl-1.5";

/* #547 AC-5: memoized — feed-event renders hit the Workbench constantly,
   and a plain re-render reconciles every row. Props are stable
   (diffs/changed/openPath/included are all memoized upstream), so a
   render with unchanged inputs skips the whole subtree. */
export const TreeNodes = memo(function TreeNodes({
  node,
  changed,
  openPath,
  included,
  expanded,
}: {
  node: TreeNode;
  changed: Map<string, Diff>;
  /* os.open wired for the session cwd (issue #110): each file row gets an
     "Open in …/Reveal in Finder" affordance; absent → no controls (D-#19). */
  openPath?: {
    editors: OsEditor[];
    onOpen: (path: string, app: OsApp) => void;
  };
  /* #547 AC-5: windowed first frame — the Set of paths this frame mounts
     (from windowedTreePaths). Membership is a pure check, safe under
     StrictMode's render double-invoke; absent = render all. */
  included?: Set<string>;
  /* #547 AC-5: expansion state from the FileTree — needed to size the
     content-visibility chunks below (a collapsed folder contributes only
     its own row). */
  expanded: Set<string>;
}) {
  const kids = sortedTreeKids(node);
  const renderKid = (k: TreeNode) => {
    if (included && !included.has(k.path)) return null;
    return k.children.size > 0 ? (
      <FileTreeFolder
        key={k.path}
        path={k.path}
        name={k.name}
        className={FOLDER_ROW}
      >
        <TreeNodes
          node={k}
          changed={changed}
          openPath={openPath}
          included={included}
          expanded={expanded}
        />
      </FileTreeFolder>
    ) : (
      <FileTreeFile
        key={k.path}
        path={k.path}
        name={k.name}
        /* #547 AC-5: content-visibility skips layout/paint for rows
               outside the viewport — un-hiding a 2,000-row panel only
               lays out the ~30 on screen (reopen→row <50 ms). */
        className={cn(
          "content-auto [contain-intrinsic-size:auto_26px]",
          FILE_ROW,
        )}
      >
        <span className="size-4 shrink-0" />
        <FileTreeIcon>
          <FileTextIcon className="size-4 text-muted-foreground" />
        </FileTreeIcon>
        <FileTreeName
          className={cn(
            "min-w-0 flex-1",
            changed.has(k.path) && "font-medium text-foreground",
          )}
        >
          {k.name}
        </FileTreeName>
        {changed.has(k.path) && (
          // A dot, not a letter chip: status colour is the only signal left.
          <span
            role="img"
            aria-label={
              changed.get(k.path)!.status === "added" ? "Added" : "Modified"
            }
            title={
              changed.get(k.path)!.status === "added" ? "Added" : "Modified"
            }
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              changed.get(k.path)!.status === "added"
                ? "bg-emerald-500"
                : "bg-amber-500",
            )}
          />
        )}
        {openPath && (
          // The row itself selects on click — keep the menu from doing so.
          <span
            className="pl-1"
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
    );
  };
  /* #547 AC-5: un-hiding the panel forces style+layout over every row in
     the DOM — measured ~84 ms for 2,400 rows. Chunking sibling runs into
     content-visibility blocks lets the browser skip whole off-screen
     chunks instead; contain-intrinsic-size is the exact rendered height
     (rows are ~26 px; `auto` corrects once rendered). Chunks form on the
     full kid list so the growing first-frame window doesn't shift
     boundaries. */
  if (kids.length <= TREE_CHUNK) return <>{kids.map(renderKid)}</>;
  const chunks: TreeNode[][] = [];
  for (let i = 0; i < kids.length; i += TREE_CHUNK)
    chunks.push(kids.slice(i, i + TREE_CHUNK));
  return (
    <>
      {chunks.map((c) => {
        let rows = 0;
        for (const k of c)
          rows += 1 + (expanded.has(k.path) ? countTreeRows(k) : 0);
        return (
          <div
            key={c[0].path}
            style={{
              contentVisibility: "auto",
              containIntrinsicSize: `auto ${rows * TREE_ROW_PX}px`,
            }}
          >
            {c.map(renderKid)}
          </div>
        );
      })}
    </>
  );
});
