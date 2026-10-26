import { MessageSquareIcon, PencilLineIcon } from "lucide-react";
import { choiceFor, ModelPicker, type PickerAgent } from "../chat/model-picker";
import type { ModelChoice } from "../types";
import { ChipMenu } from "./v3-chip-menu";
import type { V3Data } from "./v3-data-types";
import { ProjectMark } from "./v3-marks";
import type { V3Actions } from "./v3-page-types";
import type { V3Project } from "./v3-types";

/* The new chat's three working-conditions chips that are not about who: where
   it works (a project, or nowhere), which model (the full picker where the app
   has the engine's catalog), and how much it may do without asking. */

/** The project menu's "No project": a plain chat, working in no folder. A real
    project id is never empty, so it cannot clash. */
export const NO_PROJECT = "";
/** The menu row that asks for a folder and makes a project of it. */
const NEW_PROJECT = "\u0000new-project";

export function ProjectChip({
  projects,
  project,
  folder,
  onPick,
  onNew,
}: {
  projects: V3Project[];
  /** The chosen project; absent = No project (just chat). */
  project?: V3Project;
  /** What the app knows of the chosen project's folder (`data.folders`). */
  folder?: NonNullable<V3Data["folders"]>[number];
  onPick: (projectId: string) => void;
  /** Asks for a folder and makes a project of it, then picks that project. */
  onNew?: () => void;
}) {
  return (
    <>
      <ChipMenu
        title={`Project · ${project ? project.folder : "none"}`}
        value={project ? project.id : NO_PROJECT}
        onPick={(id) => (id === NEW_PROJECT ? onNew?.() : onPick(id))}
        label={
          project ? (
            <>
              <ProjectMark
                name={project.name}
                tone={project.tone}
                className="size-4 text-[9px]"
              />
              <span className="truncate">{project.name}</span>
            </>
          ) : (
            <>
              <MessageSquareIcon className="size-3.5 shrink-0" />
              <span className="truncate">No project</span>
            </>
          )
        }
        options={[
          ...projects.map((p) => ({
            id: p.id,
            node: (
              <>
                <ProjectMark name={p.name} tone={p.tone} />
                <span className="shrink-0">{p.name}</span>
                <span className="truncate font-mono text-[12px] text-muted-foreground/70">
                  {p.folder}
                </span>
              </>
            ),
          })),
          {
            id: NO_PROJECT,
            node: (
              <>
                <MessageSquareIcon className="size-3.5 shrink-0" />
                <span className="truncate">No project · just chat</span>
              </>
            ),
          },
          ...(onNew
            ? [
                {
                  id: NEW_PROJECT,
                  action: true,
                  node: (
                    <span className="truncate">New project from a folder…</span>
                  ),
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

/** The one quiet pill (D-#868): who · model · effort in the engine's full
    picker where the app has the catalog — the agent is a pane inside it, so
    there is one pill to open, not two. Else the plain menu over the model
    names (the agent keeps its own chip then). `pick` is what the picker
    last chose, if anything. */
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
  agent,
  agents,
  agentActions,
  onAgent,
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
  /** Who the pill speaks for and the team its Agent pane lists. */
  agent?: string;
  agents?: PickerAgent[];
  agentActions?: { id: string; node: React.ReactNode }[];
  onAgent?: (id: string) => void;
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
      agent={agent}
      agents={agents}
      agentActions={agentActions}
      onAgent={onAgent}
    />
  );
}
