import { Page, Section, Title } from "./v3-bits";
import type { V3Update } from "./v3-data-types";
import { AgentAvatar } from "./v3-marks";
import { agentOf, FORMER_AGENT, goalOf } from "./v3-model";
import type { V3PageProps } from "./v3-page-types";

/* Inbox: what the company told you, newest first, as a plain feed. */

const KIND_WORD: Record<V3Update["kind"], string> = {
  plan: "Plan",
  finished: "Finished",
  handed: "Handed off",
  stuck: "Stuck",
  note: "Update",
};

function newer(a: V3Update, b: V3Update): number {
  if (a.atSort !== undefined && b.atSort !== undefined)
    return b.atSort - a.atSort;
  return b.at.localeCompare(a.at);
}

export function V3Inbox({ data, go }: V3PageProps) {
  // "HH:MM" strings sort correctly as text within one day.
  const updates = [...data.updates].sort(newer);

  return (
    <Page>
      <Title small>Inbox</Title>
      <p className="-mt-1 text-[14px] text-muted-foreground">
        Everything the company told you today.
      </p>

      <Section title="Today" count={updates.length} />
      <div className="border-[var(--v3-line)] border-t">
        {updates.map((u) => {
          const system = u.authorKind === "system";
          const by = system ? undefined : agentOf(data, u.by);
          return (
            <div
              key={u.id}
              className="flex gap-3 border-[var(--v3-line)] border-b py-3.5"
            >
              {system ? (
                <span className="mt-px grid size-6 place-items-center rounded-full bg-[var(--v3-soft)] text-[11px] font-semibold text-foreground">
                  L
                </span>
              ) : (
                <AgentAvatar
                  data={data}
                  agent={by}
                  size={24}
                  className="mt-px"
                />
              )}
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2 text-[13.5px]">
                  <b className="font-semibold text-foreground">
                    {system ? "LilOS" : (by?.name ?? FORMER_AGENT)}
                  </b>
                  <span className="text-muted-foreground">
                    {KIND_WORD[u.kind]}
                  </span>
                  <span className="ml-auto text-[13px] text-muted-foreground/70">
                    {u.at}
                  </span>
                </div>
                <p className="mt-0.5 text-[14.5px] leading-[1.6] text-foreground">
                  {u.text}
                </p>
                {(u.ticketId || u.goalId) && (
                  <div className="mt-1 flex flex-wrap gap-x-3">
                    {u.ticketId && (
                      <button
                        type="button"
                        onClick={() =>
                          go({ page: "ticket", id: u.ticketId as string })
                        }
                        className="text-[12.5px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                      >
                        {u.ticketId}
                      </button>
                    )}
                    {u.goalId && (
                      <button
                        type="button"
                        onClick={() =>
                          go({ page: "goal", id: u.goalId as string })
                        }
                        className="text-[12.5px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                      >
                        {goalOf(data, u.goalId)?.title ?? u.goalId}
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </Page>
  );
}
