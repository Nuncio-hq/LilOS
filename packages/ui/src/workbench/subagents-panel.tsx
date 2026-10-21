import { ScrollArea } from "../components/ui/scroll-area";
import { SubagentRow } from "../conversation/subagents";
import { cn } from "../lib/utils";
import type { EmpFn, Subagent, Thread } from "../types";
import { CARD, PANEL, WbEmpty, WbHead } from "./wb-bits";

/* Workbench → Subagents (#317): every helper the session's turns spun off, in one place that
   stays put while the conversation moves on — running first, then finished. Same row as the
   turn's own block (opens to brief, steps, report; an employee helper links to its session),
   plus which reply started it. */

type Placed = { a: Subagent; from: string };

/** Every subagent of the thread with the time of the reply that started it, oldest first. */
export function sessionSubagents(thread: Thread): Placed[] {
  return thread.replies.flatMap((r) =>
    (r.subagents ?? []).map((a) => ({ a, from: r.time })),
  );
}

export function SubagentsPanel({
  thread,
  emp,
  onOpenSession,
}: {
  thread: Thread;
  emp: EmpFn;
  onOpenSession?: (employeeId: string, session: string) => void;
}) {
  const all = sessionSubagents(thread);
  if (!all.length) return <WbEmpty>No subagents in this thread yet.</WbEmpty>;
  const running = all.filter((p) => p.a.status === "running");
  /* Newest finished first: the one that just reported back is the one you look for. */
  const ended = all.filter((p) => p.a.status !== "running").reverse();
  return (
    <ScrollArea className="h-full">
      <div className={cn(PANEL, "space-y-5")} data-subagents-panel>
        {[
          { label: "Running", rows: running },
          { label: "Finished", rows: ended },
        ].map(
          (g) =>
            g.rows.length > 0 && (
              <section
                key={g.label}
                data-subagents-group={g.label.toLowerCase()}
              >
                <WbHead count={String(g.rows.length)}>{g.label}</WbHead>
                <div className={cn(CARD, "divide-y divide-[var(--v3-line)]")}>
                  {g.rows.map(({ a, from }) => (
                    <div key={a.id} className="min-h-[29px] px-1.5 py-1">
                      <SubagentRow
                        a={a}
                        emp={emp}
                        onOpenSession={onOpenSession}
                      />
                      {from && (
                        <p className="px-2 pb-1 pl-9 text-[12px] text-muted-foreground">
                          from the {from} reply
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              </section>
            ),
        )}
      </div>
    </ScrollArea>
  );
}
