import { SquareIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Btn, Page, span, Tabs, Title } from "./v3-bits";
import { Composer } from "./v3-composer";
import { AskCard, Opening, StuckCard, Typing } from "./v3-convo-cards";
import { ConvoTurn, RewoundLine } from "./v3-convo-turn";
import { useFollowBottom } from "./v3-follow";
import { ThreadPill } from "./v3-live";
import { agentOf, projectOf, ticketOf } from "./v3-model";
import { ThreadRail } from "./v3-thread-rail";
import type { V3PageProps, V3Thread } from "./v3-types";
import { WorkbenchTab, workbenchTabs } from "./v3-workbench";
import type { WbTab } from "./v3-workbench-bits";

/* One thread as a conversation: you (or the CEO) and one agent, oldest turn
   first, the work folded under each message, and a composer that stays at the
   bottom. Details (plan, changes, helpers) sit in a rail on wide screens. */

export function V3ThreadPage(props: V3PageProps & { id: string }) {
  const t = props.data.threads.find((x) => x.id === props.id);
  if (!t) {
    return (
      <Page>
        <Title>Thread not found</Title>
        <button
          type="button"
          onClick={() => props.go({ page: "threads", view: "live" })}
          className="text-[14px] text-muted-foreground hover:text-foreground"
        >
          ← Back to Threads
        </button>
      </Page>
    );
  }
  return <ThreadBody {...props} t={t} />;
}

function ThreadBody({ data, go, act, t }: V3PageProps & { t: V3Thread }) {
  const agent = agentOf(data, t.agentId);
  const ticketId = t.ticketId;
  const ticket = ticketId ? ticketOf(data, ticketId) : undefined;
  const project = t.projectId ? projectOf(data, t.projectId) : undefined;
  const ask = t.askId ? data.asks.find((a) => a.id === t.askId) : undefined;
  const handTo = agentOf(data, "marketer");
  const working = t.status === "working";
  const [draft, setDraft] = useState("");
  const composer = useRef<HTMLTextAreaElement>(null);

  // The Workbench rides on the record as tabs; a thread with none has no row.
  const tabs = t.workbench ? workbenchTabs(t.workbench) : undefined;
  const [picked, setTab] = useState<"chat" | WbTab>("chat");
  // A tab that has gone (its job ended, say) falls back to the conversation.
  const tab = !tabs || tabs.some((x) => x.id === picked) ? picked : "chat";
  // "Ask the agent to change…" comes back to Chat; the composer mounts a
  // render later, so focus waits for it.
  const [wantFocus, setWantFocus] = useState(false);
  useEffect(() => {
    if (tab === "chat" && wantFocus) {
      composer.current?.focus();
      setWantFocus(false);
    }
  }, [tab, wantFocus]);
  const askAgent = () => {
    setTab("chat");
    setWantFocus(true);
  };
  // Rewind: the files and conversation go back, the message returns to the
  // composer to be edited and sent again.
  const rewind = (turn: number, text: string) => {
    act.rewind(t.id, turn);
    setDraft(text);
    setWantFocus(true);
  };

  // Oldest first, like any chat; the data keeps the newest first.
  const turns = useMemo(
    () => [...t.turns].sort((a, b) => a.n - b.n),
    [t.turns],
  );
  const newest = turns.at(-1);
  const count = turns.reduce((m, u) => Math.max(m, u.n), 0);

  // Anything that makes the conversation taller bumps this, so the page
  // follows it down: a turn, a step, a word of the answer, a card.
  const grown =
    turns.reduce(
      (n, u) =>
        n +
        1 +
        (u.steps?.length ?? 0) +
        (u.answer?.length ?? 0) +
        (u.attachments?.length ?? 0) +
        (u.queued?.length ?? 0),
      0,
    ) +
    (ask ? 1 : 0) +
    (t.stuck ? 1 : 0);
  const [anchor, follow] = useFollowBottom(grown);

  const { markSeen } = act;
  useEffect(() => {
    if (t.unseen) markSeen(t.id);
  }, [t.unseen, t.id, markSeen]);

  // ⌘. stops a working thread, wherever the focus is.
  const { stop } = act;
  useEffect(() => {
    if (!working) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === ".") {
        e.preventDefault();
        stop(t.id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [working, stop, t.id]);

  const link = "hover:text-foreground hover:underline";
  const kicker = ticketId ? (
    <>
      Thread · {agent.name} on{" "}
      <button
        type="button"
        onClick={() => go({ page: "ticket", id: ticketId })}
        className={link}
      >
        {ticketId}
      </button>
    </>
  ) : (
    <>
      Chat · {agent.name}
      {project && (
        <>
          {" · "}
          <button
            type="button"
            onClick={() => go({ page: "project", id: project.id })}
            className={link}
          >
            {project.name}
          </button>
        </>
      )}
    </>
  );

  // The typing row is for the gaps: nothing is spinning (a running step has
  // its own spinner), nothing is streaming (the answer has a caret), and
  // nothing else is waiting on you.
  const typing =
    working &&
    !ask &&
    !t.stuck &&
    !newest?.streaming &&
    !newest?.steps?.some((s) => s.running);

  return (
    <div
      ref={anchor}
      className="mx-auto flex min-h-full w-full max-w-[1064px] justify-center gap-12 px-8"
    >
      <div className="flex min-w-0 max-w-[720px] flex-1 flex-col">
        <header className="pt-8">
          <Title small kicker={kicker}>
            {t.title}
          </Title>
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-2 text-[13.5px] text-muted-foreground">
            <ThreadPill status={t.status} />
            <span>
              Started {t.startedAt} · {count} {count === 1 ? "turn" : "turns"} ·{" "}
              {span(t.minutes)}
            </span>
            <span className="ml-auto flex items-center gap-2">
              {working && (
                <Btn small onClick={() => act.stop(t.id)} title="Stop (⌘.)">
                  <SquareIcon className="size-3 fill-current" />
                  Stop
                </Btn>
              )}
              {ticketId ? (
                <Btn small onClick={() => go({ page: "ticket", id: ticketId })}>
                  Open ticket
                </Btn>
              ) : (
                <Btn
                  small
                  onClick={() =>
                    act.ask(
                      `Make a ticket from my chat with ${agent.name}: ${t.title}`,
                    )
                  }
                >
                  Make it a ticket
                </Btn>
              )}
            </span>
          </div>
        </header>

        {tabs && (
          <Tabs
            tabs={[{ id: "chat", label: "Chat" }, ...tabs]}
            value={tab}
            onChange={setTab}
          />
        )}

        {tab === "chat" ? (
          <div className="flex-1 space-y-7 pt-8 pb-8">
            <Opening data={data} thread={t} first={turns[0]} />
            {turns.map((turn) => (
              <ConvoTurn
                key={turn.n}
                turn={turn}
                thread={t}
                data={data}
                agent={agent}
                newest={turn === newest}
                go={go}
                onRewind={rewind}
              />
            ))}
            {t.rewound && <RewoundLine rewound={t.rewound} />}
            {turns.length === 0 && !working && (
              <p className="text-[13.5px] text-muted-foreground/70">
                No messages yet. Say something to {agent.name}.
              </p>
            )}
            {ask && (
              <AskCard ask={ask} from={agentOf(data, ask.from)} act={act} />
            )}
            {t.stuck && (
              <StuckCard thread={t} ticket={ticket} handTo={handTo} act={act} />
            )}
            {typing && <Typing agent={agent} text={t.now?.text} />}
          </div>
        ) : (
          <WorkbenchTab
            thread={t}
            tab={tab}
            data={data}
            go={go}
            act={act}
            onTab={setTab}
            onAsk={askAgent}
          />
        )}

        {/* The surface colour, opaque, so the conversation scrolls under the
            composer instead of through it. Only Chat has a composer; the
            Workbench tabs bring their own bar. */}
        {tab === "chat" && (
          <div className="sticky bottom-0 border-[var(--v3-line)] border-t bg-[var(--v3-main)] pt-3 pb-5">
            <Composer
              data={data}
              agent={agent}
              model={t.model}
              folder={t.folder}
              branch={t.branch}
              working={working}
              value={draft}
              onChange={setDraft}
              onSend={(text) => {
                follow();
                act.message(t.id, text);
              }}
              onAgent={() => go({ page: "agent", id: agent.id })}
              inputRef={composer}
            />
          </div>
        )}
      </div>

      {/* The rail needs about 980px of its pane (a column of ~620px beside
          it); a side peek is narrower, so there it is left out unless the
          peek is widened. */}
      <div className="hidden w-[232px] shrink-0 @min-[980px]:block">
        <div className="no-scrollbar sticky top-0 max-h-[calc(100dvh-46px)] overflow-y-auto pt-8">
          <ThreadRail
            data={data}
            t={t}
            agent={agent}
            project={project}
            go={go}
          />
        </div>
      </div>
    </div>
  );
}
