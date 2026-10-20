import { BellIcon, PencilIcon } from "lucide-react";
import { type KeyboardEvent, useState } from "react";
import { useUiLayer } from "../chat/ui-layers";
import { cn } from "../lib/utils";
import { Btn, Prop, Section } from "./v3-bits";
import { ChipMenu } from "./v3-chip-menu";
import { Switch } from "./v3-settings-bits";
import type { V3Actions, V3Agent, V3AgentPatch, V3Data } from "./v3-types";

/* Editing an agent from its own page. An Edit button turns the title, the
   role line, the model and the instructions into fields in place (no dialog);
   Save writes only what changed, Cancel puts everything back. The page draws
   none of this unless the app can save (`act.updateAgent`); the model and
   the instructions only where the engine lets the app write them
   (`data.agentFields`). Notifications are not part of the edit: a switch
   applies at once. */

type Draft = {
  name: string;
  role: string;
  description: string;
  model: string;
  instructions: string;
};

export type AgentEditor = {
  /** Null while reading; the fields' text while editing. */
  draft: Draft | null;
  set: (p: Partial<Draft>) => void;
  start: () => void;
  cancel: () => void;
  save: () => void;
  saving: boolean;
  /** A name is the one thing a save cannot do without. */
  valid: boolean;
  canModel: boolean;
  canInstructions: boolean;
  canDescription: boolean;
  /** The engine's words when it held the new model back until confirmed. */
  held?: string;
  pin: () => void;
  keep: () => void;
};

const FIELD =
  "rounded-[7px] border border-foreground/15 bg-background text-foreground outline-none focus:border-foreground/40";

/** Esc closes the editor, not the peek behind it: the layer stack marks the
    key as handled, and the shell leaves keys a panel already used alone.
    Mounted only while there is something to close. */
export function EscLayer({ onEscape }: { onEscape: () => void }) {
  useUiLayer({ onEscape });
  return null;
}

/** The editing state of one agent; undefined where the page cannot edit it
    (the app has no save, or the agent is an outside worker LilOS only watches). */
export function useAgentEditor(
  data: V3Data,
  agent: V3Agent,
  act: V3Actions,
): AgentEditor | undefined {
  const update = act.updateAgent;
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [held, setHeld] = useState<string>();
  if (!update || agent.kind === "outside") return undefined;

  const fields = data.agentFields ?? [];
  const canModel = fields.includes("model") && data.modelChoices.length > 0;
  const canInstructions = fields.includes("instructions");
  const canDescription = fields.includes("description");
  const text = agent.instructions.join("\n\n");

  const cancel = () => {
    setDraft(null);
    setHeld(undefined);
  };
  const patchOf = (d: Draft): V3AgentPatch => ({
    ...(d.name.trim() !== agent.name && { name: d.name.trim() }),
    ...(d.role.trim() !== agent.role && { role: d.role.trim() }),
    ...(canDescription &&
      d.description.trim() !== (agent.description ?? "") && {
        description: d.description.trim(),
      }),
    ...(canModel && d.model !== agent.model && { model: d.model }),
    ...(canInstructions &&
      d.instructions.trim() !== text && {
        instructions: d.instructions.trim(),
      }),
  });

  const save = async () => {
    if (!draft || saving || !draft.name.trim()) return;
    const patch = patchOf(draft);
    if (Object.keys(patch).length === 0) return cancel();
    setSaving(true);
    try {
      const r = await update(agent.id, patch);
      if (r?.confirmModel) setHeld(r.confirmModel);
      else cancel();
    } catch {
      // The app has said why it could not save; the fields stay as typed.
    } finally {
      setSaving(false);
    }
  };

  return {
    draft,
    set: (p) => setDraft((d) => d && { ...d, ...p }),
    start: () => {
      setHeld(undefined);
      setDraft({
        name: agent.name,
        role: agent.role,
        description: agent.description ?? "",
        model: agent.model,
        instructions: text,
      });
    },
    cancel,
    save: () => void save(),
    saving,
    valid: !!draft?.name.trim(),
    canModel,
    canInstructions,
    canDescription,
    held,
    // Everything else the save held was written already: only the model is left.
    pin: () => {
      if (!draft) return;
      void update(agent.id, { model: draft.model, confirmModel: true }).then(
        cancel,
        () => {},
      );
    },
    keep: () => {
      setHeld(undefined);
      setDraft((d) => d && { ...d, model: agent.model });
    },
  };
}

export function EditButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-[7px] px-2 text-[13px] text-muted-foreground transition-colors hover:bg-[var(--v3-hover)] hover:text-foreground [&_svg]:size-3.5"
    >
      <PencilIcon />
      Edit
    </button>
  );
}

export function SaveButtons({ ed }: { ed: AgentEditor }) {
  const ready = ed.valid && !ed.saving;
  return (
    <>
      <Btn
        primary
        onClick={ed.save}
        className={cn(!ready && "pointer-events-none opacity-40")}
      >
        {ed.saving ? "Saving…" : "Save"}
      </Btn>
      <Btn onClick={ed.cancel}>Cancel</Btn>
    </>
  );
}

/** Enter saves from a one-line field; ⌘↵ from the instructions. */
const enterSaves =
  (ed: AgentEditor, withModifier = false) =>
  (e: KeyboardEvent) => {
    if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
    if (withModifier !== (e.metaKey || e.ctrlKey)) return;
    e.preventDefault();
    ed.save();
  };

/** The title, as a field in the title's own type. */
export function NameField({ ed, draft }: { ed: AgentEditor; draft: Draft }) {
  return (
    <input
      aria-label="Name"
      value={draft.name}
      // biome-ignore lint/a11y/noAutofocus: it opens because you asked to edit
      autoFocus
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => ed.set({ name: e.target.value })}
      onKeyDown={enterSaves(ed)}
      className="lilos-v3-serif w-full border-[var(--v3-line)] border-b bg-transparent font-bold text-[38px] text-foreground leading-[1.15] outline-none focus:border-foreground/40"
    />
  );
}

export function RoleField({ ed, draft }: { ed: AgentEditor; draft: Draft }) {
  return (
    <input
      aria-label="Role"
      value={draft.role}
      onChange={(e) => ed.set({ role: e.target.value })}
      onKeyDown={enterSaves(ed)}
      className={cn(FIELD, "h-6 w-[220px] px-2 text-[13.5px]")}
    />
  );
}

export function DescriptionField({
  ed,
  draft,
}: {
  ed: AgentEditor;
  draft: Draft;
}) {
  return (
    <input
      aria-label="Description"
      value={draft.description}
      placeholder="Describe what it is for"
      onChange={(e) => ed.set({ description: e.target.value })}
      onKeyDown={enterSaves(ed)}
      className={cn(FIELD, "mb-1 h-8 w-full px-2.5 text-[14.5px]")}
    />
  );
}

export function ModelField({
  ed,
  draft,
  choices,
}: {
  ed: AgentEditor;
  draft: Draft;
  choices: string[];
}) {
  return (
    <ChipMenu
      below
      title="Model"
      ariaLabel="Model"
      value={draft.model}
      onPick={(model) => ed.set({ model })}
      label={<span className="truncate">{draft.model}</span>}
      options={choices.map((m) => ({ id: m, node: <span>{m}</span> }))}
      className={cn(FIELD, "h-7 px-2.5 text-[14px]")}
    />
  );
}

export function InstructionsField({
  ed,
  draft,
}: {
  ed: AgentEditor;
  draft: Draft;
}) {
  const lines = draft.instructions.split("\n").length;
  return (
    <>
      <Section title="Instructions" />
      <textarea
        aria-label="Instructions"
        value={draft.instructions}
        rows={Math.min(18, Math.max(6, lines + 1))}
        onChange={(e) => ed.set({ instructions: e.target.value })}
        onKeyDown={enterSaves(ed, true)}
        className={cn(
          FIELD,
          "w-full resize-y px-3 py-2 text-[14.5px] leading-relaxed",
        )}
      />
      <p className="mt-1.5 text-[13px] text-muted-foreground/70">
        Applies to new threads. A thread already running keeps the instructions
        and model it started with.
      </p>
    </>
  );
}

/** The engine asked before pinning this model; the rest of the save landed. */
export function HeldModel({ ed }: { ed: AgentEditor }) {
  if (!ed.held) return null;
  return (
    <div className="mt-4 rounded-lg border border-[var(--v3-line)] bg-[var(--v3-soft)] px-3 py-2.5 text-[13.5px]">
      <div className="font-semibold text-foreground">
        The engine asks before pinning this model
      </div>
      <p className="mt-1 text-muted-foreground">{ed.held}</p>
      <div className="mt-2 flex gap-2">
        <Btn small primary onClick={ed.pin}>
          Pin anyway
        </Btn>
        <Btn small onClick={ed.keep}>
          Keep current model
        </Btn>
      </div>
    </div>
  );
}

/** Mute one agent's notifications (banners and pushes alike). Applies at
    once: it is a setting, not part of the edit. */
export function NotificationsRow({
  agent,
  act,
}: {
  agent: V3Agent;
  act: V3Actions;
}) {
  const update = act.updateAgent;
  if (!update) return null;
  const on = agent.muted !== true;
  return (
    <Prop icon={<BellIcon />} label="Notifications">
      <Switch
        on={on}
        label={`Notifications for ${agent.name}`}
        // A failed write has been explained by the app; the switch follows data.
        onChange={(next) =>
          void update(agent.id, { muted: !next }).catch(() => {})
        }
      />
      <span className="text-muted-foreground">{on ? "On" : "Muted"}</span>
    </Prop>
  );
}
