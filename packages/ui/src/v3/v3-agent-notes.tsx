import { useEffect, useRef, useState } from "react";
import { MessageResponse } from "../components/ai-elements/message";
import { cn } from "../lib/utils";
import { ToastView } from "../shell/toast-view";
import { Btn, Section } from "./v3-bits";
import { EscLayer } from "./v3-keys";
import { OPEN_ROW } from "./v3-open-record";
import type { V3Note } from "./v3-types";

/* An agent's memory files: a list, the open file, and an editor. One list —
   the old Remembers lines were a second copy of these files and drifted
   after an edit. The page draws this only when it was given the files and
   a save (D-#19), so a build that does not own agent files yet shows
   nothing here. A note is one file in a flat folder — a path would be a
   second place to look. */

const FIELD =
  "rounded-[7px] border border-foreground/15 bg-background text-foreground outline-none focus:border-foreground/40";

/** How long "Note saved" stays, matching the shell's notice. */
const SAVED_MS = 2600;

type Draft = { name: string; text: string };

/** The row's summary: the file's first line, so it cannot drift from the
    file. A markdown heading mark is not part of the sentence. */
function noteSummary(text: string): string {
  const line = text.split("\n").find((l) => l.trim() !== "") ?? "";
  return line.replace(/^#{1,6}\s+/, "").trim();
}

/** Why this name cannot be saved, or null when it can. */
function nameProblem(
  name: string,
  notes: V3Note[],
  currentId: string | null,
): "empty" | "path" | "taken" | null {
  const n = name.trim();
  if (!n) return "empty";
  if (/[/\\]/.test(n)) return "path";
  if (notes.some((x) => x.name === n && x.id !== currentId)) return "taken";
  return null;
}

const PROBLEM: Record<
  Exclude<ReturnType<typeof nameProblem>, "empty" | null>,
  string
> = {
  path: "A note is one file name, not a path.",
  taken: "A note already has that name.",
};

export function AgentNotes({
  notes,
  onSave,
}: {
  notes: V3Note[];
  onSave: (note: { id?: string; name: string; text: string }) => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [tried, setTried] = useState(false);
  const [saved, setSaved] = useState(0);
  const open = notes.find((n) => n.id === openId);
  const creating = editing && openId === null;
  const problem = draft ? nameProblem(draft.name, notes, openId) : null;
  const canSave = problem === null;
  const shown =
    problem === "path" || problem === "taken"
      ? PROBLEM[problem]
      : tried && problem === "empty"
        ? "Give the file a name."
        : null;

  useEffect(() => {
    if (!saved) return;
    const t = window.setTimeout(() => setSaved(0), SAVED_MS);
    return () => window.clearTimeout(t);
  }, [saved]);

  const startNew = () => {
    setOpenId(null);
    setEditing(true);
    setDraft({ name: "", text: "" });
    setTried(false);
  };
  const closeEdit = () => {
    setEditing(false);
    setDraft(null);
    setTried(false);
  };
  const save = () => {
    if (!draft || !canSave) {
      setTried(true);
      return;
    }
    onSave({
      ...(openId ? { id: openId } : {}),
      name: draft.name.trim(),
      text: draft.text,
    });
    closeEdit();
    setSaved((n) => n + 1);
  };

  return (
    <div ref={panel} data-agent-notes className="@container">
      <Section
        title="Notes"
        count={notes.length}
        link={creating ? undefined : "New note"}
        onLink={startNew}
      />
      <p className="mb-2 max-w-[620px] text-[13.5px] text-muted-foreground">
        This agent's memory. The files stay with the agent when its runtime
        changes.
      </p>
      <ul aria-label="Notes" className="border-[var(--v3-line)] border-t">
        {notes.length === 0 && !creating && (
          <li className="py-3 text-[14px] text-muted-foreground">
            No notes yet.
          </li>
        )}
        {notes.map((n) => {
          const on = n.id === openId;
          return (
            <li key={n.id} className="border-[var(--v3-line)] border-b">
              <button
                type="button"
                aria-current={on ? "true" : undefined}
                onClick={() => {
                  setOpenId(n.id);
                  closeEdit();
                }}
                className={cn(
                  "flex w-full items-baseline gap-3 rounded-md px-2 py-2 text-left text-[14px] hover:bg-[var(--v3-hover)]",
                  on && OPEN_ROW,
                )}
              >
                <span className="w-[7.5rem] shrink-0 truncate font-mono text-[13px] text-foreground">
                  {n.name}
                </span>
                <span className="min-w-0 flex-1 truncate text-[13.5px] text-muted-foreground">
                  {noteSummary(n.text)}
                </span>
                <span className="shrink-0 text-[12.5px] text-muted-foreground/70">
                  {n.updated}
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      {open && !editing && (
        <article className="mt-4">
          <div className="flex items-center gap-3">
            <h4 className="min-w-0 flex-1 truncate font-mono text-[13.5px] text-foreground">
              {open.name}
            </h4>
            <Btn
              small
              onClick={() => {
                setEditing(true);
                setDraft({ name: open.name, text: open.text });
                setTried(false);
              }}
            >
              Edit
            </Btn>
          </div>
          <div className="mt-2 border-[var(--v3-line)] border-l-2 pl-4">
            <MessageResponse className="lilos-prose text-[14.5px] text-foreground leading-relaxed">
              {open.text}
            </MessageResponse>
          </div>
        </article>
      )}

      {editing && draft && (
        <form
          className="mt-4 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <EscLayer onEscape={closeEdit} />
          <label className="block">
            <span className="text-[13px] text-muted-foreground">File name</span>
            <input
              aria-label="File name"
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              placeholder="readers.md"
              spellCheck={false}
              className={`${FIELD} mt-1 h-8 w-full px-2.5 font-mono text-[13px]`}
            />
          </label>
          {shown && <p className="text-[13px] text-foreground">{shown}</p>}
          <label className="block">
            <span className="text-[13px] text-muted-foreground">Note</span>
            <textarea
              aria-label="Note"
              value={draft.text}
              rows={8}
              onChange={(e) => setDraft({ ...draft, text: e.target.value })}
              className={`${FIELD} mt-1 w-full resize-y px-3 py-2 text-[14.5px] leading-relaxed`}
            />
          </label>
          <div className="flex items-center gap-2">
            <Btn
              primary
              onClick={save}
              className={
                !canSave ? "pointer-events-none opacity-40" : undefined
              }
            >
              Save
            </Btn>
            <Btn onClick={closeEdit}>Cancel</Btn>
          </div>
        </form>
      )}
      {saved > 0 && panel.current && (
        <ToastView toast={{ text: "Note saved" }} anchor={panel.current} />
      )}
    </div>
  );
}
