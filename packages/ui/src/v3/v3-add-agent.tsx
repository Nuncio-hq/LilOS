import { UserPlusIcon, XIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useUiLayerEl } from "../chat/ui-layers";
import { cn } from "../lib/utils";
import { Btn } from "./v3-bits";
import type { V3Data } from "./v3-data-types";
import type { V3Actions } from "./v3-page-types";
import type { V3Agent, V3Profile, V3Runtime } from "./v3-types";

/* The add-agent dialog (#870): Who? · Name · Hire — an agent in a few
   seconds, while the company layer is paused. The ＋ beside the sidebar's
   Agents section and "Add agent…" at the bottom of a composer's agent menu
   both open it. No presets, roles, reports-to or channel fields: those stay
   on the ?company=1 Hire page. A Who? row is a kind the machine can run —
   the default engine's profiles, or a whole coding runtime (its seed agent,
   or a fresh profile on it when it has none). After a hire the caller's
   `onHired` selects the new agent where the dialog was opened. */

/** One Who? row: a kind of agent to hire. */
export type HireChoice = {
  key: string;
  /** The row's name — what the Name field starts with. */
  name: string;
  /** A quiet second line: what it is for, or its model. */
  note?: string;
  /** The employee's role starts as this (the profile's own line). */
  role?: string;
  /** Hire by linking this existing engine profile; absent = a fresh profile
     is created on `runtime` first. */
  profile?: string;
  /** The profile's own one-line description — mirrored onto the record at
     hire so an idle runtime's page still reads it (#872). */
  description?: string;
  /** Which runtime the hire lands on; absent = the default engine. */
  runtime?: string;
  /** The plain reason it cannot be hired, when it cannot. */
  unavailable?: string;
};

/** The dialog's model: Who? = the engine's hirable profiles, then one row
   per non-default runtime. A profile an agent already runs on is never
   offered (the Hire page's rule, kept); a runtime still is — hiring it again
   creates a fresh profile there. An unavailable or failed runtime greys its
   row with the reason it reported, never hidden. */
export function hireChoices({
  profiles,
  runtimes,
  agents,
}: {
  /** `agents.list`, merged across runtimes — each row stamped `runtime`. */
  profiles: V3Profile[];
  /** `system.status.runtimes` (`data.runtimes`); absent = profiles only. */
  runtimes?: V3Runtime[];
  /** The roster: a profile already linked to an agent is taken. */
  agents: V3Agent[];
}): HireChoice[] {
  const defaultId = runtimes?.find((r) => r.isDefault)?.id;
  const rowIds = new Set((runtimes ?? []).map((r) => r.id));
  const taken = new Set(agents.map((a) => a.profile));
  /* A roster row stamped with a non-default runtime it names is that
     runtime's seed — the runtime's own row carries it, so it never lists
     twice. Any other row (the default engine's own, or a stamp naming a
     runtime this report does not list) is a plain profile row. */
  const isRuntimeSeed = (p: V3Profile) =>
    !!p.runtime && p.runtime !== defaultId && rowIds.has(p.runtime);
  const choices: HireChoice[] = [];
  for (const p of profiles) {
    if (isRuntimeSeed(p) || taken.has(p.id)) continue;
    choices.push({
      key: `p:${p.id}`,
      name: p.name,
      note: p.description ?? p.model,
      role: p.description ?? "",
      profile: p.id,
      ...(p.description ? { description: p.description } : {}),
      /* The stamp goes through even when no runtime row names it (an older
         harness): the hire still lands where the profile lives. */
      ...(p.runtime ? { runtime: p.runtime } : {}),
    });
  }
  for (const r of runtimes ?? []) {
    if (r.isDefault) continue;
    const seed = profiles.find((p) => p.runtime === r.id);
    const linkable = seed && !taken.has(seed.id) ? seed : undefined;
    choices.push({
      key: `r:${r.id}`,
      name: seed?.name ?? r.label,
      note: seed?.description,
      role: seed?.description ?? "",
      ...(seed?.description ? { description: seed.description } : {}),
      ...(linkable ? { profile: linkable.id } : {}),
      runtime: r.id,
      ...(r.available === false || r.state === "failed"
        ? { unavailable: r.detail ?? `${r.label} is not available` }
        : {}),
    });
  }
  return choices;
}

export function V3AddAgent({
  data,
  act,
  onHired,
  onClose,
}: {
  data: V3Data;
  act: V3Actions;
  onHired: (agentId: string) => void;
  onClose: () => void;
}) {
  /* Esc closes this dialog, not the peek behind it (the layer stack owns the
     key while the dialog is top-most). */
  const layerRef = useUiLayerEl<HTMLDivElement>({ onEscape: onClose });
  const [profiles, setProfiles] = useState<V3Profile[]>();
  /* The selection is the row's key, not its index: `act` changes whenever
     data emits (which refires the roster fetch below and rebuilds the
     list), and an index would then point at a different kind. */
  const [picked, setPicked] = useState<string>();
  const [name, setName] = useState("");
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);

  /* The roster is read fresh as the dialog opens (the Hire page's rule):
     a profile made or freed elsewhere shows up. */
  useEffect(() => {
    let live = true;
    void act.listProfiles?.().then(
      (p) => live && setProfiles(p),
      () => live && setProfiles([]),
    );
    return () => {
      live = false;
    };
  }, [act]);

  const choices = useMemo(
    () =>
      hireChoices({
        profiles: profiles ?? [],
        runtimes: data.runtimes,
        agents: data.agents,
      }),
    [profiles, data.runtimes, data.agents],
  );
  const choice =
    choices.find((c) => c.key === picked) ??
    choices.find((c) => !c.unavailable) ??
    choices[0];
  /* A name you have not typed IS the picked kind's name — derived, not
     synced, so it is never a frame behind the choice list filling in. */
  const shownName = touched ? name : (choice?.name ?? "");

  const submit = async () => {
    /* Loading matters for runtime rows: until the roster answers, a
       runtime's seed profile is not known and Hire would create a fresh
       profile instead of linking it. */
    if (loading || !choice || choice.unavailable || !shownName.trim() || busy)
      return;
    setBusy(true);
    try {
      const id = choice.profile
        ? await act.hireProfile?.({
            profile: choice.profile,
            name: shownName.trim(),
            role: choice.role ?? "",
            ...(choice.runtime ? { runtime: choice.runtime } : {}),
            ...(choice.description ? { description: choice.description } : {}),
          })
        : await act.hire?.({
            name: shownName.trim(),
            role: choice.role ?? "",
            /* No model asked for: "" = the runtime's own default. */
            model: "",
            ...(choice.runtime ? { runtime: choice.runtime } : {}),
            ...(choice.description ? { description: choice.description } : {}),
          });
      if (id !== undefined) onHired(id);
    } catch {
      // The app has already said why; the dialog stays as typed.
    } finally {
      setBusy(false);
    }
  };

  const loading = profiles === undefined && !!act.listProfiles;
  const canHire =
    !loading && !!choice && !choice.unavailable && !!shownName.trim() && !busy;
  return (
    <div
      className="fixed inset-0 z-40 grid place-items-center bg-black/30 p-4 sm:p-6"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Add agent"
        ref={layerRef}
        onClick={(e) => e.stopPropagation()}
        data-addagent
        className="flex max-h-[90dvh] w-full max-w-sm flex-col overflow-hidden rounded-2xl border bg-background shadow-2xl"
      >
        <div className="flex items-center gap-2 border-b px-4 py-3">
          <UserPlusIcon className="size-4" />
          <div className="font-semibold">Add agent</div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="ml-auto grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-[var(--v3-hover)] hover:text-foreground"
          >
            <XIcon className="size-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
          <div>
            <div className="mb-1.5 text-muted-foreground text-xs">Who?</div>
            <div
              role="radiogroup"
              aria-label="Who?"
              className="overflow-hidden rounded-lg border"
            >
              {loading && choices.length === 0 && (
                <p className="px-3 py-3 text-center text-muted-foreground text-xs">
                  Checking who can be added…
                </p>
              )}
              {!loading && choices.length === 0 && (
                <p className="px-3 py-3 text-center text-muted-foreground text-xs">
                  No agent kinds to add.
                </p>
              )}
              {choices.map((c, i) => (
                <button
                  key={c.key}
                  type="button"
                  role="radio"
                  aria-checked={c === choice}
                  disabled={!!c.unavailable}
                  onClick={() => setPicked(c.key)}
                  data-choice={c.key}
                  className={cn(
                    "flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors",
                    i > 0 && "border-[var(--v3-line)] border-t",
                    c.unavailable
                      ? "cursor-not-allowed text-muted-foreground/60"
                      : "hover:bg-[var(--v3-hover)]",
                    c === choice && "bg-[var(--v3-hover)]",
                  )}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium text-[13.5px]">
                      {c.name}
                    </span>
                    {(c.unavailable ?? c.note) && (
                      <span className="block truncate text-[12px] text-muted-foreground/80">
                        {c.unavailable ?? c.note}
                      </span>
                    )}
                  </span>
                  {c === choice && !c.unavailable && (
                    <span
                      aria-hidden
                      className="size-2 shrink-0 rounded-full bg-foreground"
                    />
                  )}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label
              htmlFor="add-agent-name"
              className="mb-1.5 block text-muted-foreground text-xs"
            >
              Name
            </label>
            <input
              id="add-agent-name"
              value={shownName}
              // biome-ignore lint/a11y/noAutofocus: the name is the one thing left after Who?
              autoFocus
              onFocus={(e) => e.currentTarget.select()}
              onChange={(e) => {
                setName(e.target.value);
                setTouched(true);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void submit();
                }
              }}
              className="h-8 w-full rounded-[7px] border border-foreground/15 bg-background px-2.5 text-[14px] text-foreground outline-none focus:border-foreground/40"
            />
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 border-t px-4 py-3">
          <Btn small onClick={onClose}>
            Cancel
          </Btn>
          <Btn small primary disabled={!canHire} onClick={() => void submit()}>
            {busy ? "Adding…" : "Add"}
          </Btn>
        </div>
      </div>
    </div>
  );
}
