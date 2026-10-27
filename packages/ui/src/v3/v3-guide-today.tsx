import { Page, Section, Title } from "./v3-bits";
import { Statuses } from "./v3-guide-bits";
import { companyOn } from "./v3-model";
import { RowButton } from "./v3-open-record";
import type { V3PageProps } from "./v3-page-types";

/* How it works while the company has no tickets (the real app today): the
   few things you actually meet, and where each one lives. Counts come from
   live data so the page matches what you see elsewhere. */

export function V3GuideToday({ data, go }: Pick<V3PageProps, "data" | "go">) {
  const company = companyOn(data);
  const agents = data.agents.filter((a) => a.kind !== "outside").length;
  const threads = data.threads.length;
  const rows: {
    name: string;
    eg?: string;
    df: string;
    to?: () => void;
  }[] = [
    {
      name: "Agent",
      eg: `${agents} ${agents === 1 ? "agent" : "agents"}`,
      df: company
        ? "Someone on your team, with a role and a model. Add more from the sidebar."
        : /* The paused layer (D-#836) has no People page to send you to. */
          "Someone who works for you, with a role and a model.",
      to: company ? () => go({ page: "people" }) : undefined,
    },
    {
      name: "Thread",
      eg: `${threads} ${threads === 1 ? "thread" : "threads"}`,
      df: "One agent working in one folder with one model. It keeps its memory between messages.",
      to: () => go({ page: "threads" }),
    },
    {
      name: "Turn",
      df: "One run, from your message to the answer. Each turn is made of steps: read, edit, run, search, browse.",
    },
  ];
  const places: { name: string; df: string; to: () => void }[] = [
    {
      name: "Needs you",
      df: "Only you can unblock these: an approval or a question. The count beside it in the sidebar is how many are waiting.",
      to: () => go({ page: "needs" }),
    },
    {
      name: "Threads",
      df: "Every thread, live. Look at it by status, by agent, or as a full list.",
      to: () => go({ page: "threads" }),
    },
    {
      name: "Side panel",
      df: "Open an agent or a thread and it appears beside the page. Esc closes it and you are back where you were.",
      to: () => go({ page: "home" }),
    },
    {
      name: "Settings → Phone",
      df: "Pair your iPhone to follow your threads when you are away from your Mac.",
      to: () => go({ page: "settings", view: "phone" }),
    },
  ];

  const table = (list: typeof places | typeof rows) => (
    <div className="border-[var(--v3-line)] border-t">
      {list.map((l) => {
        const row = (
          <div className="grid grid-cols-[150px_minmax(0,1fr)] items-baseline gap-5 py-[11px] text-[13.5px] @max-[760px]:grid-cols-1 @max-[760px]:gap-1">
            <div className="font-semibold text-[14px]">
              {l.name}
              {"eg" in l && l.eg && (
                <span className="ml-2 font-normal text-[13px] text-muted-foreground/70">
                  {l.eg}
                </span>
              )}
            </div>
            <div className="text-muted-foreground">{l.df}</div>
          </div>
        );
        return (
          <div key={l.name} className="border-[var(--v3-line)] border-b">
            {l.to ? (
              <RowButton onClick={l.to}>{row}</RowButton>
            ) : (
              <div className="-mx-2 px-2">{row}</div>
            )}
          </div>
        );
      })}
    </div>
  );

  return (
    <Page wide>
      <Title>{company ? "How the company works" : "How it works"}</Title>
      <p className="-mt-1 text-[15px] text-muted-foreground">
        Agents do the work. You answer when they ask.
      </p>

      <Section title="What you will meet" />
      {table(rows)}

      <Section title="Where to find it" />
      {table(places)}

      <Statuses tickets={false} />
    </Page>
  );
}
