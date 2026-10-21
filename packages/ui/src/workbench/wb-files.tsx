import { FolderGit2Icon } from "lucide-react";
import { FileTree } from "../components/ai-elements/file-tree";
import { ScrollArea } from "../components/ui/scroll-area";
import { plural, prettyPath } from "../lib/helpers";
import type { WbViewFile } from "../lib/wb-probe-cache";
import type { Diff, OsApp, OsEditor } from "../types";
import type { TreeNode } from "./artifacts";
import { TreeNodes } from "./file-tree-nodes";
import { OpenPathButton } from "./open-path";
import { PANEL, WbBtn } from "./wb-bits";

/* Workbench → Files: the folder's tree, and one file's content when a row is
   opened. The path row and the file view keep their ink classes — the dark
   contrast spec (#609) reads them. */

/** `dir/` truncates on the left, the file name (the bit that matters) stays. */
function ViewPath({ path }: { path: string }) {
  const shown = prettyPath(path);
  const i = shown.lastIndexOf("/");
  const dir = i >= 0 ? shown.slice(0, i) : "";
  const base = i >= 0 ? shown.slice(i) : shown;
  return (
    <span
      className="flex min-w-0 font-mono text-[12px] text-muted-foreground"
      title={path}
    >
      {dir !== "" && (
        <span className="min-w-0 truncate" dir="rtl">
          {dir}
        </span>
      )}
      <span className="shrink-0 font-medium text-foreground">
        {dir !== "" ? base : shown}
      </span>
    </span>
  );
}

const PRE =
  "max-h-[60vh] overflow-auto rounded-[10px] border border-[var(--v3-line)] bg-[var(--v3-soft)] p-3 font-mono text-[12px] leading-[1.65]";

export function FilesTab({
  cwd,
  diffs,
  liveMode,
  probing,
  viewFile,
  onCloseFile,
  openPath,
  editors,
  expanded,
  onExpandedChange,
  sel,
  onSelect,
  tree,
  changed,
  included,
  treeOpenPath,
}: {
  cwd: string;
  diffs: Diff[];
  liveMode: boolean;
  /** Live mode and the first host read hasn't landed. */
  probing: boolean;
  viewFile: WbViewFile | null;
  onCloseFile: () => void;
  openPath?: (path: string, app: OsApp, line?: number) => void;
  editors: OsEditor[];
  expanded: Set<string>;
  onExpandedChange: (s: Set<string>) => void;
  sel: string | null;
  onSelect: (path: string) => void;
  tree: TreeNode;
  changed: Map<string, Diff>;
  included?: Set<string>;
  treeOpenPath?: {
    editors: OsEditor[];
    onOpen: (p: string, app: OsApp) => void;
  };
}) {
  return (
    <ScrollArea className="h-full" data-wb-scroll="files">
      <div className={PANEL}>
        {/* #587: the path truncates on the left so the folder's TAIL stays
            visible; the file count never wraps to a second line. */}
        <div className="mb-3 flex items-center gap-1.5 text-[13px] text-muted-foreground">
          <FolderGit2Icon className="size-3.5 shrink-0" />
          <span
            className="min-w-0 truncate font-mono text-[12px]"
            dir="rtl"
            title={cwd}
          >
            {prettyPath(cwd)}
          </span>
          {openPath && (
            <OpenPathButton
              editors={editors}
              onOpen={(app) => openPath(".", app)}
              label="Open this folder in an editor or Finder"
            />
          )}
          {diffs.length > 0 && (
            <span className="shrink-0 whitespace-nowrap">
              · {plural(diffs.length, "file")}{" "}
              {liveMode ? "changed" : "touched by this thread"}
            </span>
          )}
        </div>
        {probing ? (
          <div
            data-wb-probing
            className="text-[13.5px] text-muted-foreground/70"
          >
            Reading <span className="font-mono">{prettyPath(cwd)}</span>…
          </div>
        ) : viewFile ? (
          <div data-fileview className="space-y-2">
            <div className="flex items-center gap-2">
              <WbBtn onClick={onCloseFile}>← Files</WbBtn>
              <ViewPath path={viewFile.path} />
              {openPath && (
                <OpenPathButton
                  editors={editors}
                  onOpen={(app) => openPath(viewFile.path, app)}
                  label={`Open ${viewFile.path} in an editor or Finder`}
                />
              )}
            </div>
            {viewFile.binary ? (
              <p className="text-[13.5px] text-muted-foreground/70">
                Binary file — not shown.
              </p>
            ) : viewFile.line !== undefined ? (
              /* #340: `workbench_open` pointed at a line — per-line rows so
                 that one is highlighted and scrolled into view. */
              <pre className={PRE}>
                {viewFile.content.split("\n").map((ln, i) => (
                  <div
                    key={i}
                    ref={
                      i + 1 === viewFile.line
                        ? (el) => el?.scrollIntoView({ block: "center" })
                        : undefined
                    }
                    className={
                      i + 1 === viewFile.line
                        ? "-mx-1 rounded bg-work/15 px-1 text-work"
                        : undefined
                    }
                  >
                    {ln || " "}
                  </div>
                ))}
                {viewFile.truncated && (
                  <div className="pt-2 text-muted-foreground">… truncated</div>
                )}
              </pre>
            ) : (
              <pre className={PRE}>
                {viewFile.content}
                {viewFile.truncated && (
                  <div className="pt-2 text-muted-foreground">… truncated</div>
                )}
              </pre>
            )}
          </div>
        ) : (
          <FileTree
            expanded={expanded}
            onExpandedChange={onExpandedChange}
            selectedPath={sel ?? undefined}
            onSelect={onSelect}
            className="border-0 text-[13px]"
          >
            <TreeNodes
              node={tree}
              changed={changed}
              openPath={treeOpenPath}
              included={included}
              expanded={expanded}
            />
          </FileTree>
        )}
      </div>
    </ScrollArea>
  );
}
