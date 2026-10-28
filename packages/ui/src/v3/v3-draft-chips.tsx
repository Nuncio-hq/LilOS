import { CpuIcon, Loader2Icon, MessageSquareIcon } from "lucide-react";
import { useEffect } from "react";
import { choiceFor, ModelPicker } from "../chat/model-picker";
import type { ModelChoice } from "../types";
import { ChipMenu } from "./v3-chip-menu";
import type { V3Data } from "./v3-data-types";
import { ProjectMark } from "./v3-marks";
import { modelCatalogOf, runtimeOf } from "./v3-model";
import type { V3Actions } from "./v3-page-types";
import type { V3Agent, V3Project } from "./v3-types";

/* The new chat's three working-conditions chips that are not about who: where
   it works (a project, or nowhere), which model (the full picker where the app
   has the engine's catalog), and how much it may do without asking. */

/** The project menu's "No project": a plain chat, working in no folder. A real
    project id is never empty, so it cannot clash. */
export const NO_PROJECT = "";
/** The menu row that asks for a folder and makes a project of it. */
const NEW_PROJECT = "\u0000new-project";

/* #886: the chip row holds only controls — the picked project (or "No
   project"). Git facts used to sit beside it ("direct · no git", the
   branch); they were labels, not controls, so they moved into the chip's
   tooltip — the engine still learns the folder's git state at send time. */
export function folderHint(
  folder: NonNullable<V3Data["folders"]>[number] | undefined,
): string {
  if (folder?.branch) return ` · edits land on ⎇ ${folder.branch}`;
  if (folder?.branch === null)
    return " · not a git repo, edits land in the folder";
  return "";
}

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
    <ChipMenu
      title={`Project · ${project ? project.folder : "none"}${project ? folderHint(folder) : ""}`}
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
            <span className="truncate @max-[560px]:hidden">{project.name}</span>
          </>
        ) : (
          <>
            <MessageSquareIcon className="size-3.5 shrink-0" />
            <span className="truncate @max-[560px]:hidden">No project</span>
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
  );
}

/** The model chip: the engine's full picker (effort, Fast, providers, Edit
    models, Refresh) where the app has the catalog; else the plain menu over
    the model names. `pick` is what the picker last chose, if anything. */
export function ModelChip({
  data,
  act,
  agent,
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
  /** The selected agent — its runtime decides which catalog the picker
      lists (#872): Devin's chip shows SWE-2, never Hermes's list. */
  agent: V3Agent;
  /** The agent's own model id: where the picker starts, never a past pick. */
  agentModelId?: string;
  pick?: ModelChoice;
  onPick: (c: ModelChoice) => void;
  /** The plain menu's choice (a label from the runtime's `models`). */
  label: string;
  onLabel: (label: string) => void;
  /** `/model` opens the picker the box already owns. */
  open: boolean;
  onOpen: (open: boolean) => void;
}) {
  /* The selected agent's own catalog (#872/#890): `modelCatalogOf` is the
     one lookup — a runtime agent reads `modelCatalogs[runtime]`, the default
     engine's agent `modelCatalog`, and an agent whose runtime ROW hasn't
     arrived reads nothing yet (never Hermes's list on its composer). */
  const rt = runtimeOf(data, agent);
  const rtKnown = !agent.runtime || !!rt;
  const own = rtKnown && !!rt && !rt.isDefault;
  const cat = modelCatalogOf(data, agent);
  /* #899: selecting the agent IS opening its runtime's screen — the chip
     asks that runtime's catalog even while the adapter sleeps (the ask
     lazy-starts it). */
  useEffect(() => {
    if (own && rt) act.openRuntimeScreen?.(rt.id);
  }, [own, rt, act]);
  if (!cat) {
    /* A runtime agent whose catalog hasn't landed menus its OWN runtime's
       labels — never the default engine's list on an ACP agent (#872) —
       and keeps its chip even when the runtime lists none: the agent's own
       model, read-only, until its catalog arrives (#890). */
    const choices = !rtKnown ? [] : own ? (rt.models ?? []) : data.modelChoices;
    /* #899: the screen's own ask is in flight or refused — the chip says
       "Loading models…" / "Models unavailable" (click retries), never a
       model this runtime never named. `catalogState` absent means no ask
       fired (a host without the action) — the static label stays. */
    if (own && choices.length === 0 && rt.catalogState) {
      if (rt.catalogState === "failed")
        return (
          <button
            type="button"
            data-slot="model-chip-failed"
            title={`Models unavailable — ${rt.catalogDetail ?? "the engine did not answer"}. Click to retry`}
            onClick={() => act.retryRuntimeCatalog?.(rt.id)}
            className="inline-flex h-6 min-w-0 items-center gap-1.5 px-1.5 @max-[560px]:shrink-0 @max-[560px]:gap-0 @max-[560px]:px-1 text-[12.5px] text-muted-foreground hover:text-foreground"
          >
            <CpuIcon className="size-3.5 shrink-0" />
            <span className="truncate @max-[560px]:hidden">
              Models unavailable
            </span>
          </button>
        );
      return (
        <span
          data-slot="model-chip-loading"
          title={`Asking ${rt.label} for its models`}
          className="inline-flex h-6 min-w-0 items-center gap-1.5 px-1.5 @max-[560px]:shrink-0 @max-[560px]:gap-0 @max-[560px]:px-1 text-[12.5px] text-muted-foreground"
        >
          <Loader2Icon className="size-3.5 shrink-0 animate-spin" />
          <span className="truncate @max-[560px]:hidden">Loading models…</span>
        </span>
      );
    }
    const body = (
      <>
        <CpuIcon className="size-3.5 shrink-0" />
        <span className="truncate @max-[560px]:hidden">{label}</span>
      </>
    );
    if (choices.length > 0)
      return (
        <ChipMenu
          title="Model"
          value={label}
          onPick={onLabel}
          label={body}
          options={(label && !choices.includes(label)
            ? [label, ...choices]
            : choices
          ).map((m) => ({ id: m, node: <span>{m}</span> }))}
        />
      );
    return own && label ? (
      <span
        data-slot="model-chip-static"
        title={`${label} · ${rt.label} lists no other models yet`}
        className="inline-flex h-6 min-w-0 items-center gap-1.5 px-1.5 @max-[560px]:shrink-0 @max-[560px]:gap-0 @max-[560px]:px-1 text-[12.5px] text-muted-foreground"
      >
        {body}
      </span>
    ) : null;
  }
  const refreshOwn = act.refreshRuntimeModels;
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
      /* Hermes's hide list and refresh belong to Hermes's catalog; a
         runtime agent's picker re-asks its own runtime (#895). */
      onVisibility={own ? undefined : act.setModelVisibility}
      onRefresh={
        own
          ? refreshOwn && rt
            ? () => refreshOwn(rt.id)
            : undefined
          : cat.refreshable
            ? act.refreshModels
            : undefined
      }
      open={open}
      onOpenChange={onOpen}
    />
  );
}
