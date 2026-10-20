import { FolderIcon, MessageSquareIcon, PencilLineIcon } from "lucide-react";
import { choiceFor, ModelPicker } from "../chat/model-picker";
import type { ModelChoice } from "../types";
import { ChipMenu } from "./v3-chip-menu";
import type { V3Data } from "./v3-data-types";
import type { V3Actions } from "./v3-page-types";

/* The new chat's three working-conditions chips that are not about who: where
   it works, which model (the full picker where the app has the engine's
   catalog), and how much it may do without asking. */

/** The folder menu's "No folder": a chat that works in no folder, not even
    the newest recent. A real folder path is never empty, so it cannot clash. */
export const NO_FOLDER = "";
/** The menu row that opens the app's own Add a folder dialog. */
const ADD_FOLDER = "\u0000add-folder";

type Folders = NonNullable<V3Data["folders"]>;

export function FolderChip({
  folders,
  folder,
  onPick,
  onAdd,
}: {
  folders: Folders;
  /** The chosen folder; absent = No folder. */
  folder?: Folders[number];
  onPick: (path: string) => void;
  /** Opens the app's Add a folder dialog and picks what it added. */
  onAdd?: () => void;
}) {
  return (
    <>
      <ChipMenu
        title={`Folder · ${folder ? folder.path : "none"}`}
        value={folder ? folder.path : NO_FOLDER}
        onPick={(id) => (id === ADD_FOLDER ? onAdd?.() : onPick(id))}
        label={
          <>
            <FolderIcon className="size-3.5 shrink-0" />
            <span className="truncate">
              {folder ? folder.label : "No folder"}
            </span>
          </>
        }
        options={[
          ...folders.map((f) => ({
            id: f.path,
            node: (
              <>
                <FolderIcon className="size-3.5 shrink-0" />
                <span className="shrink-0">{f.label}</span>
                {f.path !== f.label && (
                  <span className="truncate font-mono text-[12px] text-muted-foreground/70">
                    {f.path}
                  </span>
                )}
              </>
            ),
          })),
          {
            id: NO_FOLDER,
            node: (
              <>
                <MessageSquareIcon className="size-3.5 shrink-0" />
                <span className="truncate">No folder · just chat</span>
              </>
            ),
          },
          ...(onAdd
            ? [
                {
                  id: ADD_FOLDER,
                  action: true,
                  node: <span className="truncate">Add a folder…</span>,
                },
              ]
            : []),
        ]}
      />
      {/* What the folder gives the chat, in the quiet words the old picker
          used: no git means edits land in the folder itself. */}
      {folder?.branch === null && (
        <span
          title="Not a git repo: no branches or worktrees, edits land in the folder"
          className="inline-flex h-6 items-center gap-1.5 px-1.5 text-[12.5px] text-muted-foreground"
        >
          <PencilLineIcon className="size-3.5 shrink-0" />
          direct · no git
        </span>
      )}
      {folder?.branch && (
        <span
          title="Direct mode: edits land on the checked-out branch"
          className="inline-flex h-6 min-w-0 items-center gap-1.5 px-1.5 text-[12.5px] text-muted-foreground"
        >
          <PencilLineIcon className="size-3.5 shrink-0" />
          <span className="min-w-0 truncate font-mono text-[12px]">
            {folder.branch}
          </span>
        </span>
      )}
    </>
  );
}

/** The model chip: the engine's full picker (effort, Fast, providers, Edit
    models, Refresh) where the app has the catalog; else the plain menu over
    the model names. `pick` is what the picker last chose, if anything. */
export function ModelChip({
  data,
  act,
  agentModelId,
  pick,
  onPick,
  label,
  onLabel,
  open,
  onOpen,
}: {
  data: V3Data;
  act: V3Actions;
  /** The agent's own model id: where the picker starts, never a past pick. */
  agentModelId?: string;
  pick?: ModelChoice;
  onPick: (c: ModelChoice) => void;
  /** The plain menu's choice (a label from `data.modelChoices`). */
  label: string;
  onLabel: (label: string) => void;
  /** `/model` opens the picker the box already owns. */
  open: boolean;
  onOpen: (open: boolean) => void;
}) {
  const cat = data.modelCatalog;
  if (!cat) {
    return data.modelChoices.length > 0 ? (
      <ChipMenu
        title="Model"
        value={label}
        onPick={onLabel}
        label={<span className="truncate">{label}</span>}
        options={data.modelChoices.map((m) => ({
          id: m,
          node: <span>{m}</span>,
        }))}
      />
    ) : null;
  }
  // Starts on the agent's own model with its default effort (the engine's
  // default when the agent names none), never a past pick.
  const value =
    pick ??
    choiceFor(
      agentModelId || cat.defaultModel || "",
      cat.options,
      agentModelId ? undefined : cat.defaultProvider,
    );
  return (
    <ModelPicker
      value={value}
      models={cat.options}
      onChoice={onPick}
      providers={cat.providers}
      visibility={cat.visibility}
      onVisibility={act.setModelVisibility}
      onRefresh={cat.refreshable ? act.refreshModels : undefined}
      open={open}
      onOpenChange={onOpen}
    />
  );
}
