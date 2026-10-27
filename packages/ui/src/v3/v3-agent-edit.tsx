import { BellIcon } from "lucide-react";
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { cn } from "../lib/utils";
import { Btn, Prop } from "./v3-bits";
import { ChipMenu } from "./v3-chip-menu";
import { EscLayer } from "./v3-keys";
import type { V3Actions } from "./v3-page-types";
import { Switch } from "./v3-settings-bits";
import type { V3Agent, V3AgentPatch } from "./v3-types";

/* Editing an agent in place, Notion-style (#872): there is no edit mode
   and no page-wide Save/Cancel. A writable field swaps its text for an
   input on click and saves just itself on Enter or blur (Esc cancels);
   the model's menu saves the moment a pick lands, and a held model asks
   in place before it pins. What the owning runtime's engine cannot write
   renders as plain text — never an input that would fail. A landed save
   flashes Saved beside the field; a failed one says why, briefly. */

export type FieldSave = {
  state: "idle" | "saving" | "saved" | "failed";
  /** Why the last write failed, in the app's own words. */
  error?: string;
  /** Writes one field's patch; resolves the engine's `confirmModel` words
      when it held a model back, `undefined` on a failure it reports here. */
  run: (patch: V3AgentPatch) => Promise<{ confirmModel?: string } | undefined>;
};

/** One field's save pipeline: sending, a breath of Saved, or why it failed. */
export function useFieldSave(
  act: V3Actions,
  agentId: string,
): FieldSave | undefined {
  const update = act.updateAgent;
  const [s, set] = useState<{ state: FieldSave["state"]; error?: string }>({
    state: "idle",
  });
  useEffect(() => {
    if (s.state !== "saved" && s.state !== "failed") return;
    const t = setTimeout(() => set({ state: "idle" }), 2800);
    return () => clearTimeout(t);
  }, [s.state]);
  if (!update) return undefined;
  return {
    ...s,
    run: async (patch) => {
      set({ state: "saving" });
      try {
        const r = await update(agentId, patch);
        set({ state: "saved" });
        return r;
      } catch (e) {
        // The app has already toasted why; the note beside the field says it too.
        set({
          state: "failed",
          error: e instanceof Error ? e.message : String(e),
        });
        return undefined;
      }
    },
  };
}

/** The save note beside a field — quiet, gone again in a breath. */
export function SaveNote({
  save,
  className,
}: {
  save?: FieldSave;
  className?: string;
}) {
  if (!save || save.state === "idle") return null;
  return (
    <span
      role="status"
      className={cn(
        "inline-block max-w-[280px] shrink-0 truncate align-middle text-[12.5px]",
        save.state === "failed"
          ? "text-red-600 dark:text-red-400"
          : "text-muted-foreground/75",
        className,
      )}
    >
      {save.state === "saving"
        ? "Saving…"
        : save.state === "saved"
          ? "Saved"
          : `Couldn't save${save.error ? ` — ${save.error}` : ""}`}
    </span>
  );
}

/* One line of text you click to change. The view is the text (a quiet
   button when it can change); the input it swaps to commits on Enter or
   blur, Esc puts the old text back. `onCommit` absent = read-only. */
export function InlineText({
  value,
  onCommit,
  save,
  placeholder,
  ariaLabel,
  className,
}: {
  value: string;
  onCommit?: (next: string) => void;
  save?: FieldSave;
  placeholder?: string;
  ariaLabel: string;
  className?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const back = useRef<HTMLButtonElement>(null);
  /* Leaving the box also fires blur once Enter or Esc already decided.
     A key finish owes the keyboard the field's button — but the button
     remounts after this render, so the focus lands in the effect below. */
  const decided = useRef(false);
  const wantFocus = useRef(false);
  const wasEditing = useRef(editing);
  useEffect(() => {
    if (wasEditing.current && !editing && wantFocus.current)
      back.current?.focus();
    wantFocus.current = false;
    wasEditing.current = editing;
  }, [editing]);
  const finish = (commit: boolean, byKey: boolean) => {
    if (decided.current) return;
    decided.current = true;
    wantFocus.current = byKey;
    setEditing(false);
    const next = draft.trim();
    if (commit && next !== value) onCommit?.(next);
  };
  return (
    <span className="inline-flex min-w-0 max-w-full items-baseline gap-2">
      {editing ? (
        <>
          {/* Esc through the layer stack: a peek behind must not take it. */}
          <EscLayer onEscape={() => finish(false, true)} />
          <input
            // biome-ignore lint/a11y/noAutofocus: it opens because you asked to edit
            autoFocus
            aria-label={ariaLabel}
            value={draft}
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => setDraft(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
              e.preventDefault();
              finish(true, true);
            }}
            onBlur={() => finish(true, false)}
            className={cn(
              "h-[1.5em] min-w-0 flex-1 rounded-[5px] border border-foreground/25 bg-background px-1 text-foreground outline-none [font:inherit] focus:border-foreground/45",
              className,
            )}
          />
        </>
      ) : onCommit ? (
        <button
          ref={back}
          type="button"
          title="Edit"
          onClick={() => {
            decided.current = false;
            setDraft(value);
            setEditing(true);
          }}
          className={cn(
            "-mx-1 min-w-0 rounded-[5px] px-1 text-left outline-none transition-colors hover:bg-[var(--v3-hover)] focus-visible:bg-[var(--v3-hover)]",
            className,
          )}
        >
          {value || (
            <span className="text-muted-foreground/60">
              {placeholder ?? "Add…"}
            </span>
          )}
        </button>
      ) : (
        <span className={cn("min-w-0", className)}>{value}</span>
      )}
      <SaveNote save={save} />
    </span>
  );
}

/* The model prop's chip: the runtime's own picker, saving the pick the
   moment it lands (#872). A guarded model the engine held back asks in
   place — Pin anyway re-sends it with the confirm. */
export function ModelProp({
  icon,
  agent,
  choices,
  save,
}: {
  icon: ReactNode;
  agent: V3Agent;
  /** The owning runtime's picker labels; empty = the model stays text. */
  choices: string[];
  save?: FieldSave;
}) {
  const [held, setHeld] = useState<{ words: string; model: string }>();
  const canPick = !!save && choices.length > 0;
  return (
    <>
      <Prop icon={icon} label="Default model">
        {canPick ? (
          <ChipMenu
            below
            title="Default model"
            ariaLabel="Default model"
            value={agent.model}
            onPick={(model) => {
              if (model === agent.model) return;
              void save
                .run({ model })
                .then(
                  (r) =>
                    r?.confirmModel &&
                    setHeld({ words: r.confirmModel, model }),
                );
            }}
            label={<span className="truncate">{agent.model}</span>}
            options={choices.map((m) => ({ id: m, node: <span>{m}</span> }))}
          />
        ) : (
          agent.model
        )}
        <SaveNote save={save} />
      </Prop>
      {held && (
        <div className="mt-1 mb-2 rounded-lg border border-[var(--v3-line)] bg-[var(--v3-soft)] px-3 py-2.5 text-[13.5px]">
          <div className="font-semibold text-foreground">
            The engine asks before pinning this model
          </div>
          <p className="mt-1 text-muted-foreground">{held.words}</p>
          <div className="mt-2 flex gap-2">
            <Btn
              small
              primary
              onClick={() => {
                const model = held.model;
                setHeld(undefined);
                void save?.run({ model, confirmModel: true });
              }}
            >
              Pin anyway
            </Btn>
            <Btn small onClick={() => setHeld(undefined)}>
              Keep current model
            </Btn>
          </div>
        </div>
      )}
    </>
  );
}

/* #872 — the agent's standing effort pick: the levels its runtime reports
   for its model, plus "Model default" which clears the pin (`effort: ""`
   on the record). Saved the moment a pick lands; a runtime that reports
   no levels gets no row at all (the caller checks `ladder`). */
export function EffortProp({
  icon,
  agent,
  ladder,
  save,
}: {
  icon: ReactNode;
  agent: V3Agent;
  /** The current model's effort ladder — the engine's own ordering. */
  ladder: { efforts: string[]; defaultEffort?: string };
  save?: FieldSave;
}) {
  const shown = agent.effort ?? "Model default";
  return (
    <Prop icon={icon} label="Default effort">
      {save ? (
        <ChipMenu
          below
          title="Default effort"
          ariaLabel="Default effort"
          value={shown}
          onPick={(next) => {
            if (next !== shown)
              void save.run({ effort: next === "Model default" ? "" : next });
          }}
          label={<span className="truncate">{shown}</span>}
          options={["Model default", ...ladder.efforts].map((e) => ({
            id: e,
            node: <span>{e}</span>,
          }))}
        />
      ) : (
        shown
      )}
      <SaveNote save={save} />
    </Prop>
  );
}

const escapeRestores =
  (cancel: () => void) => (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    cancel();
    e.currentTarget.blur();
  };

/* The Instructions section: an auto-growing text block that saves on
   blur (#872). `locked` is why the runtime can't take it — shown under
   the read-only text instead of an editor. */
export function InstructionsBlock({
  paragraphs,
  editable,
  locked,
  save,
  onCommit,
}: {
  /** The agent's instructions as paragraphs (how the read view splits them). */
  paragraphs: string[];
  editable: boolean;
  /** Why it is read-only, in the runtime's own words where known. */
  locked?: string;
  save?: FieldSave;
  onCommit: (text: string) => void;
}) {
  const value = paragraphs.join("\n\n");
  const [draft, setDraft] = useState<string>();
  /* Keep showing the typed text until the store catches up (the relay's
     echo is a beat behind the save), then drop the draft. */
  useEffect(() => {
    if (draft !== undefined && draft.trim() === value.trim())
      setDraft(undefined);
  }, [value, draft]);
  const lines = (draft ?? value).split("\n").length;
  const readonlyNote =
    !editable && paragraphs.length > 0 ? (locked ?? null) : null;
  if (!editable && paragraphs.length === 0) return null;
  return (
    <>
      <h3 className="mt-10 mb-1.5 flex items-baseline gap-2 font-semibold text-[15px] text-foreground">
        Instructions
        <SaveNote save={save} />
      </h3>
      {editable ? (
        <textarea
          aria-label="Instructions"
          value={draft ?? value}
          placeholder="What it should always do — its standing brief."
          rows={Math.min(18, Math.max(4, lines + 1))}
          onFocus={(e) => setDraft(e.currentTarget.value)}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={escapeRestores(() => setDraft(undefined))}
          onBlur={() => {
            const next = (draft ?? value).trim();
            setDraft(undefined);
            if (next !== value.trim()) onCommit(next);
          }}
          className={cn(
            "w-full resize-none border-[var(--v3-line)] border-l-2 bg-transparent pl-4 text-[14.5px] leading-relaxed text-foreground outline-none transition-colors placeholder:text-muted-foreground/50",
            "hover:border-foreground/25 focus:border-foreground/40",
          )}
        />
      ) : (
        <div className="space-y-2.5 border-[var(--v3-line)] border-l-2 pl-4 text-[14.5px] leading-relaxed text-foreground">
          {paragraphs.map((p) => (
            <p key={p}>{p}</p>
          ))}
        </div>
      )}
      {readonlyNote && (
        <p className="mt-1.5 text-[13px] text-muted-foreground/70">
          {readonlyNote}
        </p>
      )}
    </>
  );
}

/** Mute one agent's notifications (banners and pushes alike). Applies at
    once: it is a setting, not part of the page's fields. */
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
