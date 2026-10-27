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
import { useUiLayerEl } from "../chat/ui-layers";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { baseName, parentOf, plural } from "../lib/helpers";
import { cn } from "../lib/utils";
import type { Folder, FsDir } from "../types";

/** The dialog's words when it makes a project of the folder (the sidebar's
    ＋, a chat's "Add as project"), instead of just adding it (#854). */
export const NEW_PROJECT_COPY = {
  title: "New project from a folder",
  hint: "a folder whose threads file under it",
  add: "Create project",
};

/* With the company layer paused (D-#836) there are no tickets for a key to
   prefix and no key on screen to explain — the hint just says what the
   pick is (#854). */
export const NEW_PROJECT_PAUSED_COPY = {
  ...NEW_PROJECT_COPY,
  hint: "Pick a folder for this project",
};

/** The ticket key a project name suggests: its letters, uppercased —
    "journal-app" → "JOU". The caller still dedupes (two projects can both
    want "JO"). */
export const suggestProjectKey = (name: string): string =>
  (name.replace(/[^a-z0-9]/gi, "").toUpperCase() || "P").slice(0, 3);

/* D-#854 round 2: the key the wire accepts — 1–8 ASCII capitals or
   digits. A typed key lands verbatim on the relay, so the dialog is where
   a bad one is refused with words, not silently reshaped. */
export const PROJECT_KEY_RE = /^[A-Z0-9]{1,8}$/;

/** Why the typed key can't be used — the inline line under the field. */
export const projectKeyError = (
  key: string,
  takenKeys: readonly string[],
): string | undefined =>
  !PROJECT_KEY_RE.test(key)
    ? "1–8 letters and digits (A–Z, 0–9)"
    : takenKeys.includes(key)
      ? `Key ${key} is already taken — pick another`
      : undefined;

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
  copy,
  projectFields,
  folder,
  company = true,
  takenKeys,
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
  /* D-#854 round 2: a promise's rejection lands inline — the dialog stays
     open so a taken key or a refused folder can be fixed and retried. */
  onAdd: (
    path: string,
    project?: { existing?: string; name: string; key?: string },
  ) => void | Promise<unknown>;
  /* Called when the listing needs a dir the `fs` map doesn't have yet — the
     app answers with a host `fs.list` (real app: the harness). Without it the
     dialog renders purely off `fs` (mock). */
  onNeedDir?: (path: string) => void;
  /* Its own words where the dialog serves something other than "add a folder"
     (the new chat's "New project from a folder…"). */
  copy?: { title: string; hint: string; add: string };
  /* The picked folder becomes a project (#854): once one resolves, its name
     and key show prefilled from it and stay editable, and onAdd carries
     them. Absent: the folder is added as picked. */
  projectFields?: boolean;
  /* The company layer is on (D-#836): the key field and the ticket words
     show. Paused, both stay off and the key derives from the name silently
     — onAdd still carries it. */
  company?: boolean;
  /* Live project keys — the typed key is checked against them before the
     create call so a conflict is an inline line, not a relay error
     (D-#854 round 2). */
  takenKeys?: readonly string[];
  /* Pre-picked path (a chat's "Add as project" opens on the folder the
     chat already runs in). */
  folder?: string;
}) {
  const title = copy?.title ?? "Add a folder";
  /* #581 AC-3: open with NOTHING picked (home listing, Add disabled until
     a real dir resolves) — a default like ~/Desktop reads as a selection
     the user never made. A `folder` passed in IS a pick the caller made. */
  const [path, setPath] = useState(folder ?? "");
  const [target, setTarget] = useState<string>(defaultProject ?? "__new");
  const [newName, setNewName] = useState("");
  /* The project fields belong to the picked folder: they prefill from it,
   your edits stay while the folder does, and picking another folder
   prefills again. The key follows the edited name until you touch it. */
  const [nameEdit, setNameEdit] = useState<{ for: string; v: string }>();
  const [keyEdit, setKeyEdit] = useState<{ for: string; v: string }>();
  /* A rejected onAdd lands here — the dialog stays open and the line under
     the footer says what the caller reported (D-#854 round 2). */
  const [submitError, setSubmitError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const clean = path.trim().replace(/\/+$/, "") || "~";
  const exact = fs[clean];
  // complete.path: list the typed dir, or the parent filtered by the partial last segment
  const listDir = exact ? clean : parentOf(clean);
  const listed = fs[listDir]?.children;
  // Lazy listing: ask the host for every dir we navigate to — even one the
  // `fs` map already holds, since mock seeds must give way to real listings
  // and a dir's contents change while the app is open (#418). The app
  // dedupes only in-flight repeats; settled listings always refetch.
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
  /* #854: the project's name and key, prefilled from the folder's name until
     the field has been edited for this pick. */
  const projFields = !!projectFields;
  const fieldName = nameEdit?.for === clean ? nameEdit.v : suggestedName;
  const fieldKey =
    keyEdit?.for === clean ? keyEdit.v : suggestProjectKey(fieldName);
  /* The typed key's refusal line (company mode only — paused derives it
     silently, so it can never be invalid or taken on screen). */
  const keyError =
    projFields && company && fieldKey.trim() !== ""
      ? projectKeyError(fieldKey.trim(), takenKeys ?? [])
      : undefined;
  const crumbs = clean.split("/").map((_, i, a) => a.slice(0, i + 1).join("/"));
  const canAdd =
    !!exact &&
    clean !== "~" &&
    !attached &&
    !submitting &&
    (!projFields ||
      (fieldName.trim() !== "" && fieldKey.trim() !== "" && !keyError));
  /* #576: Esc closes this dialog while it is the top-most layer. */
  const layerRef = useUiLayerEl<HTMLDivElement>({ onEscape: onClose });
  return (
    <div
      className="fixed inset-0 z-40 grid place-items-center bg-black/30 p-4 sm:p-6"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={layerRef}
        className="flex max-h-[90dvh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border bg-background shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        data-addfolder
      >
        <div className="flex items-center gap-2 border-b px-5 py-3">
          <FolderPlusIcon className="size-4" />
          <div className="font-semibold">{title}</div>
          <span className="text-muted-foreground text-xs">
            {copy?.hint ?? "sessions can run in it"}
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
                    . Sessions edit files here directly.
                  </div>
                ) : (
                  <div>Not a git repo. Sessions edit files here directly.</div>
                )}
              </div>
            </div>
          )}

          {projFields && exact && clean !== "~" && !attached && (
            <div data-projectfields>
              <div className="mb-1.5 text-muted-foreground text-xs">
                Project
              </div>
              <div
                className={cn(
                  "grid items-end gap-3",
                  company && "sm:grid-cols-[1fr_7rem]",
                )}
              >
                <div>
                  <div className="mb-1 text-muted-foreground text-[11px]">
                    Name
                  </div>
                  <Input
                    value={fieldName}
                    onChange={(e) =>
                      setNameEdit({ for: clean, v: e.target.value })
                    }
                    spellCheck={false}
                    data-projectname
                    className="h-8 text-sm"
                  />
                </div>
                {/* Paused (D-#836): no Key field — fieldKey already derives
                    from the name on its own, and onAdd carries it. */}
                {company && (
                  <div>
                    <div className="mb-1 text-muted-foreground text-[11px]">
                      Key
                    </div>
                    <Input
                      value={fieldKey}
                      onChange={(e) =>
                        setKeyEdit({
                          for: clean,
                          v: e.target.value.toUpperCase(),
                        })
                      }
                      spellCheck={false}
                      data-projectkey
                      aria-invalid={!!keyError}
                      className="h-8 font-mono text-sm"
                    />
                  </div>
                )}
              </div>
              {keyError && (
                <p
                  className="mt-1.5 text-destructive text-[11px] leading-4"
                  data-keyerror
                >
                  {keyError}
                </p>
              )}
              {company && (
                <p className="mt-1.5 text-muted-foreground text-[11px] leading-4">
                  The key prefixes the project&apos;s tickets, like{" "}
                  {fieldKey || "KEY"}
                  -12. Both stay editable; the folder is what the project is.
                </p>
              )}
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
          {submitError ? (
            <span
              className="min-w-0 flex-1 basis-60 text-left text-[11px] text-destructive"
              data-submiterror
            >
              {submitError}
            </span>
          ) : (
            /* #581 AC-3: the footer names the folder being added, never the
               wire call — no `folders.add {…}` JSON-RPC on screen. */
            /* rtl truncates from the left: the pick's own name is the part
               worth keeping on screen (the crumbs above carry the rest). */
            <span
              className="min-w-0 flex-1 basis-60 truncate text-left font-mono text-[11px] text-muted-foreground"
              dir="rtl"
              title={clean !== "~" ? clean : undefined}
            >
              {clean !== "~" ? clean : ""}
            </span>
          )}
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
            onClick={() => {
              const result =
                projects === undefined
                  ? onAdd(
                      clean,
                      projFields
                        ? {
                            name: fieldName.trim(),
                            /* Paused sends no key — the relay derives one
                               and dedupes it silently; a taken suggestion
                               can never become an error for a field the
                               user can't see (D-#854 round 2). */
                            ...(company
                              ? { key: fieldKey.trim().toUpperCase() }
                              : {}),
                          }
                        : undefined,
                    )
                  : onAdd(
                      clean,
                      target === "__new"
                        ? { name: projName }
                        : { existing: target, name: target },
                    );
              /* A void onAdd is the plain folder add — the caller closes
                 the dialog itself. A promise means a project create is in
                 flight: resolving closes here, a rejection stays open with
                 its message inline. */
              if (result) {
                setSubmitting(true);
                setSubmitError(undefined);
                Promise.resolve(result)
                  .then(() => onClose())
                  .catch((e) => {
                    setSubmitError(
                      e instanceof Error && e.message
                        ? e.message
                        : "Couldn’t create the project — try again",
                    );
                  })
                  .finally(() => setSubmitting(false));
              }
            }}
            data-addbtn
          >
            {projects === undefined
              ? (copy?.add ?? "Add folder")
              : target === "__new"
                ? `Create ${projName}`
                : `Add to ${projName}`}
          </Button>
        </div>
      </div>
    </div>
  );
}
