import { ModelPicker } from "../chat/model-picker";
import { WorkspacePicker } from "../dialogs/workspace-picker";
import type {
  Folder,
  ModelChoice,
  ModelOption,
  ModelPickerExtras,
  WsPick,
} from "../types";
import type { V2Project } from "./v2-types";

/* The v1 composer pickers, reused as they are: folder → branch → workstream
   (WorkspacePicker) and model + reasoning + fast (ModelPicker). v2 projects
   map one-to-one onto v1 folders. */

/** Everything the model picker needs, passed down once from the app. */
export type V2ModelKit = { models: ModelOption[] } & ModelPickerExtras;

export const toFolders = (projects: V2Project[]): Folder[] =>
  projects
    .filter((p) => p.path)
    .map((p) => ({
      id: p.id,
      project: p.name,
      path: p.path ?? "",
      branches: p.branches ?? [],
      workstreams: p.workstreams ?? [],
    }));

/** The pick a new thread starts with in a project. */
export const pickFor = (p: V2Project | undefined): WsPick =>
  p?.path
    ? {
        folder: p.id,
        base: p.branches?.[0] ?? "",
        mode: p.branches?.length ? "new" : "direct",
      }
    : { folder: null, base: "main", mode: "new" };

export function V2WorkspacePicker({
  projects,
  pick,
  setPick,
  onAddProject,
}: {
  projects: V2Project[];
  pick: WsPick;
  setPick: (p: WsPick) => void;
  onAddProject: () => void;
}) {
  return (
    <WorkspacePicker
      folders={toFolders(projects)}
      pick={pick}
      setPick={setPick}
      onWorktree={setPick}
      onAddFolder={onAddProject}
    />
  );
}

export function V2ModelPicker({
  kit,
  value,
  onChoice,
}: {
  kit: V2ModelKit;
  value: ModelChoice;
  onChoice: (c: ModelChoice) => void;
}) {
  const { models, ...extras } = kit;
  return (
    <ModelPicker
      value={value}
      models={models}
      onChoice={onChoice}
      {...extras}
    />
  );
}
