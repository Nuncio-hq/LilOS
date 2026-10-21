import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
} from "react";
import type { WbProbeData, WbViewFile } from "../lib/wb-probe-cache";
import type { Diff, HostAccessors, WbTab } from "../types";
import type { TreeNode } from "./artifacts";
import { buildTree, countTreeRows, windowedTreePaths } from "./artifacts";

/* The Files tab's tree: built from the folder's listing (or the app's mock
   one) plus every changed path, mounted in slices so a big repo's first frame
   stays fast, with the expanded set and the row-select behaviour. */

export type FileTree = {
  tree: TreeNode;
  /** Paths the current frame mounts (#547 AC-5); undefined = all. */
  included?: Set<string>;
  /** Rows still being revealed (-1 = fully) — a scroll-restore dependency. */
  win: number;
  expanded: Set<string>;
  setExpanded: (s: Set<string>) => void;
  onSelect: (path: string) => void;
};

export function useFileTree({
  files,
  repoFiles,
  changed,
  diffs,
  host,
  liveCwd,
  say,
  setSel,
  setTab,
  setViewFile,
}: {
  /** The live `fs.tree` answer, when there is one. */
  files?: WbProbeData["files"];
  repoFiles?: string[];
  changed: Map<string, Diff>;
  diffs: Diff[];
  host?: HostAccessors;
  liveCwd?: string;
  say?: (t: string) => void;
  setSel: (p: string | null) => void;
  setTab: (t: WbTab) => void;
  setViewFile: (v: WbViewFile) => void;
}): FileTree {
  const fileList = useMemo(
    () => [...new Set([...(files ?? repoFiles ?? []), ...changed.keys()])],
    [files, repoFiles, changed],
  );
  const tree = useMemo(() => buildTree(fileList), [fileList]);
  /* #547 AC-5: a big repo's tree mounts in slices — the first ~160 rows
     paint on the first frame (reopen→row <50 ms on repos like LilOS
     itself, measured 114 ms before), the rest lands over the next frames
     instead of one ~100 ms commit. -1 = fully revealed. */
  const [win, setWin] = useState(160);
  const treeRows = countTreeRows(tree);
  /* The window is a pure Set of paths — computed per render, checked by
     membership — because a mutable counter in render is drained twice by
     StrictMode's double-invoke and the tree comes out empty (#547). */
  const included = useMemo(() => windowedTreePaths(tree, win), [tree, win]);
  useLayoutEffect(() => {
    if (win < 0 || win >= treeRows) return;
    const id = window.requestAnimationFrame(() =>
      setWin((n) => (n + 500 >= treeRows ? -1 : n + 500)),
    );
    return () => cancelAnimationFrame(id);
  }, [win, treeRows]);
  const folders = new Set<string>();
  for (const d of diffs) {
    const parts = d.path.split("/").slice(0, -1);
    parts.forEach((_, i) => {
      folders.add(parts.slice(0, i + 1).join("/"));
    });
  }
  // Folder names expand the tree, file names read the file (or open its diff).
  const dirs = useMemo(() => {
    const out = new Set<string>();
    const walk = (n: TreeNode) => {
      for (const c of n.children.values())
        if (c.children.size > 0) {
          out.add(c.path);
          walk(c);
        }
    };
    walk(tree);
    return out;
  }, [tree]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  /* Stable row-select — the FileTree context value memoizes on it, so a
     fresh closure per render would re-render every row consumer (#547). */
  const onSelect = useCallback(
    (p: string) => {
      if (dirs.has(p)) {
        setExpanded((e) => {
          const n = new Set(e);
          if (n.has(p)) n.delete(p);
          else n.add(p);
          return n;
        });
      } else if (changed.has(p)) {
        setSel(p);
        setTab("changes");
      } else if (host && liveCwd) {
        void host
          .read(liveCwd, p)
          .then((r) =>
            setViewFile(
              r
                ? { path: p, ...r }
                : { path: p, content: "", binary: true, truncated: false },
            ),
          );
      } else say?.(`${p} · unchanged in this thread`);
    },
    [dirs, changed, host, liveCwd, say, setSel, setTab, setViewFile],
  );
  const expandedSeed = new Set(["packages", "apps", ...folders]);
  /* Newly seen folders expand — keyed on the seed's contents, not the probe
     object, so the poll never re-expands folders the user collapsed. */
  const expandedKey = [...expandedSeed].sort().join("\n");
  useEffect(() => {
    setExpanded((e) => {
      const n = new Set(e);
      for (const f of expandedSeed) n.add(f);
      return n;
    });
  }, [expandedKey]);
  return { tree, included, win, expanded, setExpanded, onSelect };
}
