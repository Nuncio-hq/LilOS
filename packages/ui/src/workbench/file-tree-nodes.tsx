import { FileCodeIcon, FilePenIcon } from "lucide-react";
import {
  FileTreeFile,
  FileTreeFolder,
  FileTreeIcon,
  FileTreeName,
} from "../components/ai-elements/file-tree";
import { cn } from "../lib/utils";
import type { Diff } from "../types";
import type { TreeNode } from "./artifacts";

export function TreeNodes({
  node,
  changed,
}: {
  node: TreeNode;
  changed: Map<string, Diff>;
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
            <TreeNodes node={k} changed={changed} />
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
                  "ml-auto pl-2 font-mono text-[10px]",
                  changed.get(k.path)!.status === "added"
                    ? "text-emerald-600"
                    : "text-amber-600",
                )}
              >
                {changed.get(k.path)!.status === "added" ? "A" : "M"}
              </span>
            )}
          </FileTreeFile>
        ),
      )}
    </>
  );
}
