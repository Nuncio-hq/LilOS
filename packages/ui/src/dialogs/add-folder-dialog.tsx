import {
  ArrowLeftIcon,
  CheckIcon,
  ChevronRightIcon,
  FolderGit2Icon,
  FolderIcon,
  FolderPlusIcon,
  GitBranchIcon,
  XIcon,
} from "lucide-react";
import { Fragment, useEffect, useState } from "react";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { baseName, parentOf, plural, slugOf } from "../lib/helpers";
import { cn } from "../lib/utils";
import type { Folder, FsDir } from "../types";

/* Add a local folder to a project. Browse or type a path (complete.path), see whether it is a repo and on which
   branch (projects.for_cwd), then attach it: projects.add_folder { id, path } or projects.create { name, folders }.
   `fs` is the machine's folder listing (gateway data in the real app; mock in the prototype) passed in. */
export function AddFolderDialog({
  folders,
  projects,
  defaultProject,
  fs,
  discovered,
  onClose,
  onAdd,
  onNeedDir,
}: {
  folders: Folder[];
  /* Project targets (prototype #18). Absent = plain "add a folder"
     (the real app until channels exist, #113): the section hides and the
     footer becomes `folders.add { path }`. */
  projects?: string[];
  defaultProject?: string;
  fs: Record<string, FsDir>;
  discovered: string[];
  onClose: () => void;
  onAdd: (path: string, project?: { existing?: string; name: string }) => void;
  /* Called when the listing needs a dir the `fs` map doesn't have yet — the
     app answers with a host `fs.list` (real app: the harness). Without it the
     dialog renders purely off `fs` (mock). */
  onNeedDir?: (path: string) => void;
}) {
  const [path, setPath] = useState("~/Desktop/Oscar");
  const [target, setTarget] = useState<string>(defaultProject ?? "__new");
  const [newName, setNewName] = useState("");
  const clean = path.trim().replace(/\/+$/, "") || "~";
  const exact = fs[clean];
  // complete.path: list the typed dir, or the parent filtered by the partial last segment
  const listDir = exact ? clean : parentOf(clean);
  const listed = fs[listDir]?.children;
  // Lazy listing: ask the host for every dir we navigate to — even one the
  // `fs` map already holds, since mock seeds must give way to real listings.
  // The app dedupes repeat requests for the same dir.
  useEffect(() => {
    onNeedDir?.(listDir);
  }, [onNeedDir, listDir]);
  const prefix = exact ? "" : baseName(clean).toLowerCase();
  const entries = (fs[listDir]?.children ?? [])
    .filter((c) => c.toLowerCase().startsWith(prefix))
    .map((c) => `${listDir === "/" ? "" : listDir}/${c}`);
  const attached = folders.find((f) => f.path === clean);
  const git = exact?.git;
  const suggestedName = baseName(clean);
  const projName =
    target === "__new" ? newName.trim() || suggestedName : target;
  const crumbs = clean.split("/").map((_, i, a) => a.slice(0, i + 1).join("/"));
  const canAdd = !!exact && clean !== "~" && !attached;
  return (
    <div
      className="fixed inset-0 z-40 grid place-items-center bg-black/30 p-4 sm:p-6"
      onClick={onClose}
    >
      <div
        className="flex max-h-[90dvh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border bg-background shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        data-addfolder
      >
        <div className="flex items-center gap-2 border-b px-5 py-3">
          <FolderPlusIcon className="size-4" />
          <div className="font-semibold">Add a folder</div>
          <span className="text-muted-foreground text-xs">
            sessions can run in it
          </span>
          <Button
            variant="ghost"
            size="icon-sm"
            className="ml-auto"
            onClick={onClose}
          >
            <XIcon />
          </Button>
        </div>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
          <div>
            <div className="mb-1.5 text-muted-foreground text-xs">
              Found on this Mac
            </div>
            <div className="flex flex-wrap gap-1.5">
              {discovered
                .filter((d) => !folders.some((f) => f.path === d))
                .map((d) => (
                  <button
                    key={d}
                    type="button"
                    onClick={() => setPath(d)}
                    data-discovered={d}
                    className={cn(
                      "flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs hover:border-foreground/30",
                      clean === d &&
                        "border-foreground bg-muted ring-1 ring-foreground",
                    )}
                  >
                    <FolderGit2Icon className="size-3.5 text-muted-foreground" />
                    <span className="font-medium">{baseName(d)}</span>
                    <span className="font-mono text-muted-foreground">
                      {fs[d]?.git?.branches[0]}
                    </span>
                  </button>
                ))}
            </div>
          </div>

          <div className="overflow-hidden rounded-lg border">
            <div className="flex items-center gap-1 border-b bg-muted/30 px-2 py-1.5">
              <Button
                variant="ghost"
                size="icon-xs"
                title="Up"
                disabled={clean === "~"}
                onClick={() => setPath(parentOf(exact ? clean : listDir))}
              >
                <ArrowLeftIcon />
              </Button>
              <Input
                value={path}
                onChange={(e) => setPath(e.target.value)}
                spellCheck={false}
                data-pathinput
                onKeyDown={(e) => {
                  if (
                    (e.key === "Tab" || e.key === "Enter") &&
                    !exact &&
                    entries[0]
                  ) {
                    e.preventDefault();
                    setPath(entries[0]);
                  }
                }}
                placeholder="Type a path… Tab completes"
                className="h-7 border-0 bg-transparent px-1 font-mono text-xs shadow-none focus-visible:ring-0"
              />
            </div>
            <div className="flex flex-wrap items-center gap-0.5 border-b px-3 py-1 font-mono text-[11px] text-muted-foreground">
              {crumbs.map((c, i) => (
                <Fragment key={c}>
                  {i > 0 && <span>/</span>}
                  <button
                    type="button"
                    className="rounded px-0.5 hover:bg-muted hover:text-foreground"
                    onClick={() => setPath(c)}
                  >
                    {baseName(c)}
                  </button>
                </Fragment>
              ))}
            </div>
            <div className="max-h-56 overflow-y-auto p-1" data-fslist>
              {entries.length === 0 && (
                <p className="px-2 py-3 text-center text-muted-foreground text-xs">
                  {listed === undefined && onNeedDir
                    ? "Reading folder…"
                    : fs[listDir]
                      ? "No subfolders"
                      : "No such folder"}
                </p>
              )}
              {entries.map((e) => {
                const d = fs[e];
                const on = folders.find((f) => f.path === e);
                return (
                  <button
                    key={e}
                    type="button"
                    onClick={() => setPath(e)}
                    data-fsrow={baseName(e)}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-muted"
                  >
                    {d?.git ? (
                      <FolderGit2Icon className="size-4 shrink-0 text-emerald-600" />
                    ) : (
                      <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
                    )}
                    <span className="min-w-0 flex-1 truncate">
                      {baseName(e)}
                    </span>
                    {d?.git && (
                      <span className="flex items-center gap-1 font-mono text-[11px] text-muted-foreground">
                        <GitBranchIcon className="size-3" />
                        {d.git.branches[0]}
                      </span>
                    )}
                    {on && (
                      <Badge
                        variant="secondary"
                        className="h-4 px-1.5 text-[10px]"
                      >
                        {on.project || "added"}
                      </Badge>
                    )}
                    {(d?.children?.length ?? 0) > 0 && (
                      <ChevronRightIcon className="size-3.5 text-muted-foreground" />
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          {exact && clean !== "~" && (
            <div
              className={cn(
                "flex items-start gap-2 rounded-lg border px-3 py-2 text-[13px] leading-5",
                attached
                  ? "border-amber-300 bg-amber-50 text-amber-900"
                  : "bg-muted/40",
              )}
              data-folderinfo
            >
              {git ? (
                <FolderGit2Icon className="mt-0.5 size-4 shrink-0 text-emerald-600" />
              ) : (
                <FolderIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              )}
              <div className="min-w-0">
                <div className="truncate font-medium">{baseName(clean)}</div>
                {attached ? (
                  <div>
                    {attached.project
                      ? `Already in ${attached.project}.`
                      : "Already added."}
                  </div>
                ) : git ? (
                  <div>
                    Git repo
                    {git.remote ? (
                      <>
                        {" "}
                        · <span className="font-mono">{git.remote}</span>
                      </>
                    ) : null}{" "}
                    ·{" "}
                    {plural(git.branches.length, "branch").replace(
                      "branchs",
                      "branches",
                    )}
                    :{" "}
                    <span className="font-mono">{git.branches.join(", ")}</span>
                    . Sessions can open a workstream (worktree) or edit a branch
                    directly.
                  </div>
                ) : (
                  <div>
                    Not a git repo. Sessions edit files here directly; no
                    branches, worktrees or PRs.
                  </div>
                )}
              </div>
            </div>
          )}

          {projects && (
            <div>
              <div className="mb-1.5 text-muted-foreground text-xs">
                Project
              </div>
              <div className="grid gap-1.5 sm:grid-cols-2">
                {projects.map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setTarget(p)}
                    data-project={p}
                    className={cn(
                      "flex items-center gap-2 rounded-lg border px-3 py-2 text-left",
                      target === p
                        ? "border-foreground bg-muted/50"
                        : "hover:border-foreground/30",
                    )}
                  >
                    <FolderGit2Icon className="size-4 text-muted-foreground" />
                    <span className="font-medium">{p}</span>
                    <span className="ml-auto text-muted-foreground text-xs">
                      {plural(
                        folders.filter((f) => f.project === p).length,
                        "folder",
                      )}
                    </span>
                    {target === p && <CheckIcon className="size-4" />}
                  </button>
                ))}
                <div
                  className={cn(
                    "flex items-center gap-2 rounded-lg border px-3 py-1 sm:col-span-2",
                    target === "__new"
                      ? "border-foreground bg-muted/50 [&_input]:bg-transparent dark:[&_input]:bg-transparent"
                      : "hover:border-foreground/30",
                  )}
                  onClick={() => setTarget("__new")}
                  data-project="__new"
                >
                  <FolderPlusIcon className="size-4 shrink-0 text-muted-foreground" />
                  <Input
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    onFocus={() => setTarget("__new")}
                    placeholder={`New project · ${suggestedName}`}
                    className="h-7 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0"
                  />
                </div>
              </div>
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2 border-t px-5 py-3">
          <span
            className="min-w-0 flex-1 basis-60 truncate font-mono text-[11px] text-muted-foreground"
            title="Hermes call"
          >
            {projects === undefined
              ? `folders.add { path: "${clean}" }`
              : target === "__new"
                ? `projects.create { name: "${projName}", folders: ["${clean}"] }`
                : `projects.add_folder { id: "${slugOf(projName)}", path: "${clean}" }`}
          </span>
          <Button
            variant="outline"
            size="sm"
            className="ml-auto"
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={!canAdd}
            onClick={() =>
              projects === undefined
                ? onAdd(clean)
                : onAdd(
                    clean,
                    target === "__new"
                      ? { name: projName }
                      : { existing: target, name: target },
                  )
            }
            data-addbtn
          >
            {projects === undefined
              ? "Add folder"
              : target === "__new"
                ? `Create ${projName}`
                : `Add to ${projName}`}
          </Button>
        </div>
      </div>
    </div>
  );
}
