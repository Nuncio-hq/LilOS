import { Avatar, Page, Section, Title } from "./v3-bits";
import { agentOf } from "./v3-model";
import type { V3PageProps, V3Update } from "./v3-types";

/* Inbox: what the company told you, newest first, as a plain feed. */

const KIND_WORD: Record<V3Update["kind"], string> = {
  brief: "Update",
  done: "Finished",
  handoff: "Handed off",
  stuck: "Stuck",
  plan: "Plan",
};

export function V3Inbox({ data, go }: V3PageProps) {
  // "HH:MM" strings sort correctly as text within one day.
  const updates = [...data.updates].sort((a, b) => b.at.localeCompare(a.at));

  return (
    <Page>
      <Title small>Inbox</Title>
      <p className="-mt-1 text-[14px] text-muted-foreground">
        Everything the company told you today.
      </p>

      <Section title="Today" count={updates.length} />
      <div className="border-[var(--v3-line)] border-t">
        {updates.map((u) => {
          const by = agentOf(data, u.by);
          return (
            <div
              key={u.id}
              className="flex gap-3 border-[var(--v3-line)] border-b py-3.5"
            >
              <Avatar
                name={by.name}
                tone={by.tone}
                size={24}
                className="mt-px"
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2 text-[13.5px]">
                  <b className="font-semibold text-foreground">{by.name}</b>
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
                {u.ticketId && (
                  <button
                    type="button"
                    onClick={() =>
                      go({ page: "ticket", id: u.ticketId as string })
                    }
                    className="mt-1 text-[12.5px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                  >
                    {u.ticketId}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </Page>
  );
}
