import { ScrollArea } from "../components/ui/scroll-area";
import { SubagentRow } from "../conversation/subagents";
import type { EmpFn, Subagent, Thread } from "../types";

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
  if (!all.length)
    return (
      <div className="grid h-full place-items-center p-8 text-center text-muted-foreground text-xs">
        No subagents in this thread yet.
      </div>
    );
  const running = all.filter((p) => p.a.status === "running");
  /* Newest finished first: the one that just reported back is the one you look for. */
  const ended = all.filter((p) => p.a.status !== "running").reverse();
  return (
    <ScrollArea className="h-full">
      <div className="space-y-4 p-3" data-subagents-panel>
        {[
          { label: "Running", rows: running },
          { label: "Finished", rows: ended },
        ].map(
          (g) =>
            g.rows.length > 0 && (
              <section
                key={g.label}
                className="space-y-1"
                data-subagents-group={g.label.toLowerCase()}
              >
                <h3 className="px-1 font-medium text-[11.5px] text-muted-foreground uppercase tracking-wide">
                  {g.label} · {g.rows.length}
                </h3>
                {g.rows.map(({ a, from }) => (
                  <div
                    key={a.id}
                    className="rounded-xl border bg-background px-1 py-0.5"
                  >
                    <SubagentRow
                      a={a}
                      emp={emp}
                      onOpenSession={onOpenSession}
                    />
                    {from && (
                      <p className="px-2 pb-1 pl-9 text-[11.5px] text-muted-foreground">
                        from the {from} reply
                      </p>
                    )}
                  </div>
                ))}
              </section>
            ),
        )}
      </div>
    </ScrollArea>
  );
}
