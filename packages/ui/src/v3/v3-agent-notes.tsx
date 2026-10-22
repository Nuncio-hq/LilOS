import { useState } from "react";
import { Btn, Section } from "./v3-bits";
import { EscLayer } from "./v3-keys";
import type { V3Note } from "./v3-types";

/* An agent's memory files: a list, the open file, and an editor. The page
   draws this only when it was given the files and a save (D-#19), so a build
   that does not own agent files yet shows nothing here. A note is one file
   in a flat folder — a path would be a second place to look. */

const FIELD =
  "rounded-[7px] border border-foreground/15 bg-background text-foreground outline-none focus:border-foreground/40";

type Draft = { name: string; text: string };

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
  const [openId, setOpenId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [tried, setTried] = useState(false);
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
  };

  return (
    <div data-agent-notes className="@container">
      <Section
        title="Notes"
        count={notes.length}
        link={creating ? undefined : "New note"}
        onLink={startNew}
      />
      <p className="mb-2 max-w-[620px] text-[13.5px] text-muted-foreground">
        Files this agent keeps. They stay with the agent when its runtime
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
                className="flex w-full items-baseline gap-4 py-2 text-left text-[14px] hover:bg-[var(--v3-hover)]"
              >
                <span
                  className={`min-w-0 flex-1 truncate font-mono text-[13px] ${on ? "text-foreground" : "text-foreground/90"}`}
                >
                  {n.name}
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
          <div className="mt-2 whitespace-pre-wrap border-[var(--v3-line)] border-l-2 pl-4 text-[14.5px] text-foreground leading-relaxed">
            {open.text}
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
    </div>
  );
}
