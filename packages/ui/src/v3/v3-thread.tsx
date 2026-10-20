import { SquareIcon } from "lucide-react";
import {
  type ReactNode,
  type RefObject,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Btn, Page, PeekWidth, span, Title } from "./v3-bits";
import { Composer } from "./v3-composer";
import { AskCard, Opening, StuckCard, Typing } from "./v3-convo-cards";
import { ConvoTurn, RewoundLine } from "./v3-convo-turn";
import { useFollowBottom } from "./v3-follow";
import { ThreadPill } from "./v3-live";
import { agentOf, projectOf, ticketOf } from "./v3-model";
import { WorkPanel, WorkStrip, workTabs } from "./v3-thread-work";
import type { V3PageProps, V3Thread } from "./v3-types";
import type { SessionTab } from "./v3-workbench-bits";

/* One thread as a session: the chat is always on screen. Beside the list it
   is the conversation alone with a quiet strip of the work the thread has;
   widened, it is a split: the chat on the left, its work (browser, changes,
   files, terminal…) on the right. */

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
  const peek = useContext(PeekWidth);
  const tabs = workTabs(data, t);
  const [picked, setPicked] = useState<SessionTab>();
  // Widened, the session opens on the browser unless you chose a tab; a tab
  // that has gone (its job ended, say) falls back to the browser too.
  const wanted = picked ?? "browser";
  const tab = tabs.some((x) => x.id === wanted) ? wanted : "browser";
  const session = peek ? peek.full : picked !== undefined;

  const open = (next: SessionTab) => {
    setPicked(next);
    peek?.setFull(true);
  };
  const close = () => {
    setPicked(undefined);
    peek?.setFull(false);
  };

  const [draft, setDraft] = useState("");
  const composer = useRef<HTMLTextAreaElement>(null);
  // The composer is always mounted; a state change that fills it must land
  // before it takes the focus.
  const [wantFocus, setWantFocus] = useState(false);
  useEffect(() => {
    if (wantFocus) {
      composer.current?.focus();
      setWantFocus(false);
    }
  }, [wantFocus]);
  // Rewind: the files and conversation go back, the message returns to the
  // composer to be edited and sent again.
  const rewind = (turn: number, text: string) => {
    act.rewind(t.id, turn);
    setDraft(text);
    setWantFocus(true);
  };

  const { markSeen } = act;
  useEffect(() => {
    if (t.unseen) markSeen(t.id);
  }, [t.unseen, t.id, markSeen]);

  // ⌘. stops a working thread, wherever the focus is.
  const working = t.status === "working";
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

  const chat = {
    data,
    go,
    act,
    t,
    draft,
    onDraft: setDraft,
    composer,
    onRewind: rewind,
  };

  if (!session)
    return (
      <ChatColumn {...chat} session={false}>
        <WorkStrip tabs={tabs} onOpen={open} />
      </ChatColumn>
    );
  return (
    <div className="flex h-full min-h-0">
      <ChatColumn {...chat} session />
      <WorkPanel
        data={data}
        go={go}
        act={act}
        thread={t}
        tabs={tabs}
        tab={tab}
        onTab={setPicked}
        onAsk={() => composer.current?.focus()}
        onClose={close}
      />
    </div>
  );
}

/** The conversation: header, turns, composer. In a session it is a column of
   its own with its own scroller (the composer stays under it); beside the
   list it flows in the peek's scroller with the composer stuck to the
   bottom. Each way is its own element tree, so switching remounts it and the
   follow-scroll binds to the scroller it now lives in. */
function ChatColumn({
  data,
  go,
  act,
  t,
  draft,
  onDraft,
  composer,
  onRewind,
  session,
  children,
}: V3PageProps & {
  t: V3Thread;
  draft: string;
  onDraft: (text: string) => void;
  composer: RefObject<HTMLTextAreaElement | null>;
  onRewind: (turn: number, text: string) => void;
  session: boolean;
  /** Under the header: the work strip, beside the list. */
  children?: ReactNode;
}) {
  const agent = agentOf(data, t.agentId);
  const ticketId = t.ticketId;
  const ticket = ticketId ? ticketOf(data, ticketId) : undefined;
  const project = t.projectId ? projectOf(data, t.projectId) : undefined;
  const ask = t.askId ? data.asks.find((a) => a.id === t.askId) : undefined;
  const handTo = agentOf(data, "marketer");
  const working = t.status === "working";

  // Oldest first, like any chat; the data keeps the newest first.
  const turns = useMemo(
    () => [...t.turns].sort((a, b) => a.n - b.n),
    [t.turns],
  );
  const newest = turns.at(-1);
  const count = turns.reduce((m, u) => Math.max(m, u.n), 0);

  // Anything that makes the conversation taller bumps this, so the scroller
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

  const header = (
    <header className="pt-7">
      {session ? (
        <>
          <div className="mb-1.5 text-[13px] text-muted-foreground">
            {kicker}
          </div>
          <h1 className="lilos-v3-serif mb-3 font-bold text-[24px] text-foreground leading-[1.2]">
            {t.title}
          </h1>
        </>
      ) : (
        <Title small kicker={kicker}>
          {t.title}
        </Title>
      )}
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
      {children}
    </header>
  );

  const convo = (
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
          onRewind={onRewind}
        />
      ))}
      {t.rewound && <RewoundLine rewound={t.rewound} />}
      {turns.length === 0 && !working && (
        <p className="text-[13.5px] text-muted-foreground/70">
          No messages yet. Say something to {agent.name}.
        </p>
      )}
      {ask && <AskCard ask={ask} from={agentOf(data, ask.from)} act={act} />}
      {t.stuck && (
        <StuckCard thread={t} ticket={ticket} handTo={handTo} act={act} />
      )}
      {typing && <Typing agent={agent} text={t.now?.text} />}
    </div>
  );

  const composerEl = (
    <Composer
      data={data}
      agent={agent}
      model={t.model}
      folder={t.folder}
      branch={t.branch}
      working={working}
      value={draft}
      onChange={onDraft}
      onSend={(text) => {
        follow();
        act.message(t.id, text);
      }}
      onAgent={() => go({ page: "agent", id: agent.id })}
      inputRef={composer}
    />
  );

  if (session)
    return (
      <div className="@container flex w-[min(520px,42%)] min-w-[340px] shrink-0 flex-col border-[var(--v3-line)] border-r">
        <div data-v3-scroller className="min-h-0 flex-1 overflow-y-auto">
          <div ref={anchor} className="flex min-h-full flex-col px-5">
            {header}
            {convo}
          </div>
        </div>
        <div className="shrink-0 border-[var(--v3-line)] border-t bg-[var(--v3-main)] px-5 pt-3 pb-4">
          {composerEl}
        </div>
      </div>
    );
  return (
    <div
      ref={anchor}
      className="mx-auto flex min-h-full w-full max-w-[720px] flex-col px-8"
    >
      {header}
      {convo}
      {/* The surface colour, opaque, so the conversation scrolls under the
          composer instead of through it. */}
      <div className="sticky bottom-0 border-[var(--v3-line)] border-t bg-[var(--v3-main)] pt-3 pb-5">
        {composerEl}
      </div>
    </div>
  );
}
