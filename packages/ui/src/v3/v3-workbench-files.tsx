import { ChevronRightIcon, FileTextIcon } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { cn } from "../lib/utils";
import { Diff } from "./v3-bits";
import {
  CARD,
  Panel,
  Quiet,
  WbBtn,
  type WbPanelProps,
} from "./v3-workbench-bits";

/* Files: the folder as a compact tree, and what the selected file says. */

type Node = { name: string; path: string; dir: boolean; kids: Node[] };

/** Nest the flat list ("dir/" ends with /). Folders a file implies are made
   even when the list leaves them out. */
function buildTree(files: string[]): Node[] {
  const root: Node = { name: "", path: "", dir: true, kids: [] };
  const index = new Map<string, Node>([["", root]]);
  const ensure = (path: string, dir: boolean): Node => {
    const hit = index.get(path);
    if (hit) return hit;
    const cut = path.lastIndexOf("/");
    const parent = cut < 0 ? root : ensure(path.slice(0, cut), true);
    const node: Node = { name: path.slice(cut + 1), path, dir, kids: [] };
    parent.kids.push(node);
    index.set(path, node);
    return node;
  };
  for (const f of files) {
    if (f.endsWith("/")) ensure(f.slice(0, -1), true);
    else ensure(f, false);
  }
  const order = (nodes: Node[]) => {
    nodes.sort(
      (a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name),
    );
    for (const n of nodes) order(n.kids);
  };
  order(root.kids);
  return root.kids;
}

/** "a/b/c.ts" → ["a", "a/b"]. */
function ancestors(path: string): string[] {
  const parts = path.split("/").slice(0, -1);
  return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
}

function Row({
  node,
  depth,
  open,
  selected,
  changed,
  onClick,
}: {
  node: Node;
  depth: number;
  open: boolean;
  selected: boolean;
  changed: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={node.dir ? open : undefined}
      style={{ paddingLeft: 6 + depth * 12 }}
      className={cn(
        "flex h-[26px] w-full items-center gap-1.5 rounded-md pr-2 text-left text-[13px] text-muted-foreground transition-colors hover:bg-[var(--v3-hover)] hover:text-foreground",
        selected && "bg-[var(--v3-hover)] font-medium text-foreground",
      )}
    >
      {node.dir ? (
        <ChevronRightIcon
          className={cn(
            "size-3.5 shrink-0 transition-transform",
            open && "rotate-90",
          )}
        />
      ) : (
        <FileTextIcon className="size-3.5 shrink-0" />
      )}
      <span className="min-w-0 flex-1 truncate">{node.name}</span>
      {changed && (
        <span
          role="img"
          aria-label="Changed"
          title="Changed"
          className="size-1.5 shrink-0 rounded-full bg-foreground/45"
        />
      )}
    </button>
  );
}

export function FilesTab({ wb, data, act }: WbPanelProps) {
  const tree = useMemo(() => buildTree(wb.files), [wb.files]);
  const changed = useMemo(
    () => new Set(wb.diffs.map((d) => d.path)),
    [wb.diffs],
  );
  // A folder is marked while shut if something changed inside it.
  const changedDirs = useMemo(
    () => new Set(wb.diffs.flatMap((d) => ancestors(d.path))),
    [wb.diffs],
  );
  const [open, setOpen] = useState<Set<string>>(
    () =>
      new Set(
        changedDirs.size
          ? changedDirs
          : tree.filter((n) => n.dir).map((n) => n.path),
      ),
  );
  // Start on a changed file we can show; else any we can; else the first change.
  const [path, setPath] = useState<string | undefined>(
    () =>
      wb.diffs.map((d) => d.path).find((p) => wb.fileText[p] !== undefined) ??
      Object.keys(wb.fileText)[0] ??
      wb.diffs[0]?.path,
  );
  const diff = wb.diffs.find((d) => d.path === path);
  const text = path ? wb.fileText[path] : undefined;

  const rows = (nodes: Node[], depth: number): ReactNode =>
    nodes.map((n) => {
      const isOpen = open.has(n.path);
      return (
        <div key={n.path}>
          <Row
            node={n}
            depth={depth}
            open={isOpen}
            selected={!n.dir && n.path === path}
            changed={
              n.dir ? !isOpen && changedDirs.has(n.path) : changed.has(n.path)
            }
            onClick={() =>
              n.dir
                ? setOpen((s) => {
                    const next = new Set(s);
                    if (!next.delete(n.path)) next.add(n.path);
                    return next;
                  })
                : setPath(n.path)
            }
          />
          {n.dir && isOpen && rows(n.kids, depth + 1)}
        </div>
      );
    });

  if (wb.files.length === 0)
    return (
      <Panel>
        <Quiet>This folder is empty.</Quiet>
      </Panel>
    );

  return (
    <Panel>
      <div className="flex flex-col gap-4 @min-[640px]:flex-row">
        <div className="no-scrollbar max-h-56 shrink-0 overflow-y-auto @min-[640px]:max-h-[560px] @min-[640px]:w-[210px]">
          {rows(tree, 0)}
        </div>
        <div className={cn(CARD, "min-w-0 flex-1 overflow-hidden")}>
          {path ? (
            <>
              <div className="flex items-center gap-2.5 border-[var(--v3-line)] border-b px-3.5 py-2">
                <span
                  title={path}
                  className="min-w-0 flex-1 truncate font-mono text-[12px] text-foreground"
                >
                  {path}
                </span>
                {diff && <Diff add={diff.add} del={diff.del} />}
                {/* Without a configured editor there is nothing to open it in. */}
                {data.settings.editor && (
                  <WbBtn onClick={() => act.ask(`Open ${path} in my editor`)}>
                    Open in {data.settings.editor}
                  </WbBtn>
                )}
              </div>
              {text === undefined ? (
                <div className="px-4 py-10 text-center text-[13.5px] text-muted-foreground/70">
                  Preview not loaded in the prototype
                </div>
              ) : (
                <div className="overflow-x-auto">
                  {/* min-w-max keeps the rows as wide as the longest line. */}
                  <div className="min-w-max py-2 font-mono text-[12px] leading-[1.65]">
                    {text.split("\n").map((line, i) => (
                      <div key={i} className="flex gap-3 px-3.5">
                        <span className="w-6 shrink-0 select-none text-right text-muted-foreground/50">
                          {i + 1}
                        </span>
                        <span className="whitespace-pre text-foreground/90">
                          {line}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="px-4 py-10 text-center text-[13.5px] text-muted-foreground/70">
              Pick a file to read it.
            </div>
          )}
        </div>
      </div>
    </Panel>
  );
}
