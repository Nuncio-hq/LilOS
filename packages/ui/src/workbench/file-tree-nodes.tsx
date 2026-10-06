import { FileCodeIcon, FilePenIcon } from "lucide-react";
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
      <FileTreeFolder key={k.path} path={k.path} name={k.name}>
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
        className="content-auto [contain-intrinsic-size:auto_26px]"
      >
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
