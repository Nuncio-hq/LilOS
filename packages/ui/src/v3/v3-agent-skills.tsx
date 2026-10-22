import { XIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { cn } from "../lib/utils";
import { Section } from "./v3-bits";
import { useMenu } from "./v3-keys";
import type { V3Skill } from "./v3-types";

/* Which company skills this agent uses. Chips stay in the order they were
   attached: attaching appends, detaching removes that one, and neither
   sorts the row. "+ Add skill" lists the library's unused skills. The page
   draws this only when the library and the toggle were both passed
   (D-#19). Names the library does not know stay, so an old attachment can
   still be taken off. */

const CHIP =
  "inline-flex h-[24px] items-center gap-1 rounded-full border border-foreground bg-foreground pr-1 pl-2.5 text-[12.5px] text-background";

/* Fifteen unused skills are taller than the window and land on the Threads
   row. The menu scrolls itself, and opens upward when the button is too
   close to the bottom for that cap to fit. */
const MENU_MAX = 320;

export function AgentSkills({
  skills,
  attached,
  onToggle,
  onLibrary,
}: {
  skills: V3Skill[];
  /** Skill ids currently attached, in the order they were attached. */
  attached: string[];
  onToggle: (skillId: string, attached: boolean) => void;
  onLibrary: () => void;
}) {
  const { open, setOpen, trigger, list, close, onKeyDown } = useMenu();
  const search = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState("");
  const [up, setUp] = useState(false);
  const known = new Map(skills.map((s) => [s.id, s]));
  const using = attached.map(
    (id) => known.get(id) ?? { id, name: id, about: "", text: "" },
  );
  const needle = q.trim().toLowerCase();
  const unused = skills.filter(
    (s) =>
      !attached.includes(s.id) &&
      (needle === "" ||
        s.name.toLowerCase().includes(needle) ||
        s.about.toLowerCase().includes(needle)),
  );

  useEffect(() => {
    if (open) search.current?.focus();
    else setQ("");
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    const r = trigger.current?.getBoundingClientRect();
    if (!r) return;
    const below = window.innerHeight - r.bottom;
    const above = r.top;
    setUp(below < MENU_MAX && above > below);
  }, [open, trigger]);

  return (
    <div data-agent-skills>
      <Section
        title="Skills"
        count={using.length}
        link="Library"
        onLink={onLibrary}
      />
      <p className="mb-3 max-w-[620px] text-[13.5px] text-muted-foreground">
        From the company library. Attached skills are the ones this agent uses.
      </p>
      <div className="text-[13px] text-muted-foreground">Using</div>
      <div
        role="group"
        aria-label="Using"
        className="mt-1.5 flex flex-wrap items-center gap-1.5"
      >
        {using.length === 0 && (
          <span className="text-[13.5px] text-muted-foreground">None yet.</span>
        )}
        {using.map((s) => (
          <span key={s.id} className={CHIP}>
            {s.name}
            <button
              type="button"
              aria-label={`Detach ${s.name}`}
              title={`Detach ${s.name}`}
              onClick={() => onToggle(s.id, false)}
              className="grid size-4 place-items-center rounded-full hover:bg-background/15"
            >
              <XIcon className="size-3" />
            </button>
          </span>
        ))}
        <span className="relative">
          <button
            ref={trigger}
            type="button"
            aria-haspopup="menu"
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
            className="text-[13px] text-muted-foreground/70 hover:text-foreground"
          >
            + Add skill
          </button>
          {open && (
            <div
              ref={list}
              role="menu"
              aria-label="Add a skill"
              data-menu-place={up ? "up" : "down"}
              tabIndex={-1}
              onKeyDown={onKeyDown}
              className={cn(
                "absolute left-0 z-20 w-[240px] max-h-[min(320px,50dvh)] overflow-y-auto rounded-lg border border-[var(--v3-line)] bg-background py-1 text-[13.5px]",
                up ? "bottom-full mb-1" : "top-full mt-1",
              )}
            >
              <div className="sticky top-0 z-10 bg-background px-2 pb-1">
                <input
                  ref={search}
                  aria-label="Find a skill"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Find a skill"
                  className="h-7 w-full rounded-[6px] border border-foreground/15 bg-background px-2 text-[13px] text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-foreground/40"
                />
              </div>
              {unused.length === 0 && (
                <p className="px-3 py-1.5 text-muted-foreground">
                  {needle ? "No skill matches." : "Every skill is attached."}
                </p>
              )}
              {unused.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    onToggle(s.id, true);
                    close();
                  }}
                  className="block w-full px-3 py-1.5 text-left hover:bg-[var(--v3-hover)]"
                >
                  <span className="block text-foreground">{s.name}</span>
                  {s.about && (
                    <span className="block truncate text-[12px] text-muted-foreground">
                      {s.about}
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}
        </span>
      </div>
    </div>
  );
}
