import { SquareIcon } from "lucide-react";
import { type ReactNode, type RefObject, useMemo } from "react";
import { Btn, span, Title } from "./v3-bits";
import { Composer } from "./v3-composer";
import { AskCard, Opening, StuckCard, Typing } from "./v3-convo-cards";
import { ConvoTurn, RewoundLine } from "./v3-convo-turn";
import { useFollowBottom } from "./v3-follow";
import { ThreadPill, turnCount } from "./v3-live";
import { agentOf, FORMER_AGENT, projectOf, ticketOf } from "./v3-model";
import type { V3PageProps } from "./v3-page-types";
import { useRenameMenu } from "./v3-thread-menu";
import type { V3Thread } from "./v3-types";

/* The chat half of a thread session: header, turns and composer. It is apart
   from v3-thread.tsx, which owns the session state (draft, rewind, stop key,
   the work tabs) and decides how the chat is laid out beside the work. */

/** The conversation: header, turns, composer. In a session it is a column of
   its own with its own scroller (the composer stays under it); beside the
   list it flows in the peek's scroller with the composer stuck to the
   bottom. Each way is its own element tree, so switching remounts it and the
   follow-scroll binds to the scroller it now lives in. */
export function ChatColumn({
  data,
  go,
  act,
  t,
  draft,
  onDraft,
  composer,
  onRewind,
  session,
  archived,
  children,
}: V3PageProps & {
  t: V3Thread;
  archived: boolean;
  draft: string;
  onDraft: (text: string) => void;
  composer: RefObject<HTMLTextAreaElement | null>;
  onRewind?: (turn: number, text: string) => void;
  session: boolean;
  /** Under the header: the work strip, beside the list. */
  children?: ReactNode;
}) {
  const agent = agentOf(data, t.agentId);
  const ticketId = t.ticketId;
  const ticket = ticketId ? ticketOf(data, ticketId) : undefined;
  const project = t.projectId ? projectOf(data, t.projectId) : undefined;
  const ask = t.askId ? data.asks.find((a) => a.id === t.askId) : undefined;
  // A stuck ticket is handed to the Marketer; with none on the team the card
  // offers no hand-off.
  const handTo = agentOf(data, "marketer");
  const working = t.status === "working";

  // Oldest first, like any chat; the data keeps the newest first.
  const turns = useMemo(
    () => [...t.turns].sort((a, b) => a.n - b.n),
    [t.turns],
  );
  const newest = turns.at(-1);
  // Empty turns means the app does not carry them: no count to print.
  const count = turnCount(t);

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
      Thread · {agent?.name ?? FORMER_AGENT} on{" "}
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
      Chat · {agent?.name ?? FORMER_AGENT}
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

  // Rename where the title shows; the same ⋯ menu the rows on Threads have.
  const { renameThread, archiveThread } = act;
  const { input: titleInput, menu: threadMenu } = useRenameMenu({
    title: t.title,
    archived,
    inputClassName: session ? "h-9 [font-size:24px]" : "h-11 [font-size:28px]",
    onRename: renameThread && ((title) => renameThread(t.id, title)),
    onArchive: archiveThread && ((to) => archiveThread(t.id, to)),
  });

  const header = (
    <header className="pt-7">
      {session ? (
        <>
          <div className="mb-1.5 text-[13px] text-muted-foreground">
            {kicker}
          </div>
          {titleInput ? (
            <div className="mb-3 flex">{titleInput}</div>
          ) : (
            <h1 className="lilos-v3-serif mb-3 font-bold text-[24px] text-foreground leading-[1.2]">
              {t.title}
            </h1>
          )}
        </>
      ) : titleInput ? (
        <>
          <div className="mb-2 text-[13.5px] text-muted-foreground">
            {kicker}
          </div>
          <div className="mb-3.5 flex">{titleInput}</div>
        </>
      ) : (
        <Title small kicker={kicker}>
          {t.title}
        </Title>
      )}
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-2 text-[13.5px] text-muted-foreground">
        <ThreadPill status={t.status} />
        <span>
          Started {t.startedAt}
          {count !== undefined && (
            <>
              {" · "}
              {count} {count === 1 ? "turn" : "turns"}
            </>
          )}
          {" · "}
          {span(t.minutes)}
        </span>
        <span className="ml-auto flex items-center gap-2">
          {threadMenu}
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
                  agent
                    ? `Make a ticket from my chat with ${agent.name}: ${t.title}`
                    : `Make a ticket from this chat: ${t.title}`,
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
          No messages yet.{agent && ` Say something to ${agent.name}.`}
        </p>
      )}
      {ask && <AskCard ask={ask} from={agentOf(data, ask.from)} act={act} />}
      {t.stuck && (
        <StuckCard thread={t} ticket={ticket} handTo={handTo} act={act} />
      )}
      {typing && <Typing agent={agent} text={t.now?.text} />}
    </div>
  );

  // Messaging needs someone on the team to read it.
  const composerEl = agent ? (
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
  ) : (
    <p className="py-2 text-[13.5px] text-muted-foreground">
      This agent is no longer on the team, so there is no one to message.
    </p>
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
