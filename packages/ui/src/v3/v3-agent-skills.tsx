import { cn } from "../lib/utils";
import { Section } from "./v3-bits";
import type { V3Skill } from "./v3-types";

/* Which company skills this agent uses. A pressed chip is attached; clicking
   it detaches. An outline chip attaches. The page draws this only when the
   library and the toggle were both passed (D-#19). Names the library does
   not know stay, so an old attachment can still be taken off. */

const CHIP =
  "inline-flex h-[24px] items-center rounded-full border px-2.5 text-[12.5px] transition-colors";

function Chip({
  name,
  on,
  onClick,
}: {
  name: string;
  on: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      title={`${on ? "Detach" : "Attach"} ${name}`}
      onClick={onClick}
      className={cn(
        CHIP,
        on
          ? "border-foreground bg-foreground text-background"
          : "border-[var(--v3-line)] text-muted-foreground hover:bg-[var(--v3-hover)] hover:text-foreground",
      )}
    >
      {name}
    </button>
  );
}

export function AgentSkills({
  skills,
  attached,
  onToggle,
  onLibrary,
}: {
  skills: V3Skill[];
  /** Skill ids currently attached, library order first. */
  attached: string[];
  onToggle: (skillId: string, attached: boolean) => void;
  onLibrary: () => void;
}) {
  const known = new Set(skills.map((s) => s.id));
  const using = [
    ...skills.filter((s) => attached.includes(s.id)),
    ...attached.filter((id) => !known.has(id)).map((id) => ({ id, name: id })),
  ];
  const rest = skills.filter((s) => !attached.includes(s.id));
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
      <div>
        <div className="text-[13px] text-muted-foreground">Using</div>
        <div
          role="group"
          aria-label="Using"
          className="mt-1.5 flex flex-wrap gap-1.5"
        >
          {using.length === 0 && (
            <span className="text-[13.5px] text-muted-foreground">
              None yet.
            </span>
          )}
          {using.map((s) => (
            <Chip
              key={s.id}
              name={s.name}
              on
              onClick={() => onToggle(s.id, false)}
            />
          ))}
        </div>
      </div>
      <div className="mt-3">
        <div className="text-[13px] text-muted-foreground">Not using</div>
        <div
          role="group"
          aria-label="Not using"
          className="mt-1.5 flex flex-wrap gap-1.5"
        >
          {rest.length === 0 && (
            <span className="text-[13.5px] text-muted-foreground">
              Every skill is attached.
            </span>
          )}
          {rest.map((s) => (
            <Chip
              key={s.id}
              name={s.name}
              on={false}
              onClick={() => onToggle(s.id, true)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
