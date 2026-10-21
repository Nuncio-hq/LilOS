import { CheckIcon, XIcon } from "lucide-react";
import { useMemo, useRef } from "react";
import { ConversationKeepBottom, plain } from "../chat/agent-chat";
import {
  Conversation,
  ConversationContent,
} from "../components/ai-elements/conversation";
import { Button } from "../components/ui/button";
import { openStartRequest } from "../conversation/cards";
import { FindUnstubAnchor, FindUnstubNudge } from "../conversation/find-unstub";
import { QuestionAwareScrollButton } from "../conversation/question-card";
import { TurnList } from "../conversation/turn-list";
import {
  leadOf,
  useJumpToHit,
  useThreadKeys,
  useTurnActs,
  useTurnWindow,
} from "../conversation/use-thread-frame";
import { SessionUsage } from "../focus/session-usage";
import { sessionModelId } from "../lib/context-window";
import type { OsApp, WbTab } from "../types";
import { useRenameMenu } from "../v3/v3-thread-menu";
import type { ThreadFrameProps } from "./frame-props";
import {
  focusThreadComposer,
  StuckCard,
  stuckMessageHandler,
} from "./stuck-card";
import { ThreadComposer } from "./thread-composer";
import { StartWork, sentTurns, ThreadHeader } from "./thread-header";
import { panelFolder, threadKicker } from "./thread-kicker";
import { workTabs } from "./work-strip";

export interface ThreadViewProps extends ThreadFrameProps {
  /* Opens the session view on a Workbench tab: the work strip's buttons and the
     turn's "N subagents · Open" / "N files changed" links (#317). Absent = no
     strip, and those links stay in-place / plain text. The expand control
     itself is the peek header's Widen — the thread draws none. */
  onOpenTab?: (t: WbTab) => void;
  /* The app can open pages in a LilOS Browser tab (desktop): the work strip
     offers it. */
  browser?: boolean;
  /* Esc → close the panel (issue #195 AC-1); absent → Esc does nothing (D-#19). */
  onClose?: () => void;
  repo?: string;
  /* os.open call bound to the session folder (issue #110): the folder badge
     gains an "Open in …/Reveal in Finder" menu only with `editors` too. */
  onOpenPath?: (path: string, app: OsApp, line?: number) => void;
  /* #581: a folder-less DM thread can pick a real folder — the host moves
     the session there (the pick is only offered where the engine can move). */
  onAddFolder?: () => void;
}

/* The right-panel frame around the conversation — channel threads AND DM sessions (issue #19).
   The employee turns render through the shared AgentTurn (identical to Focus); the person's own
   turns through UserTurn. DM-ness comes only from channel.dm — never the display name (AC-3).
   D-#19: a control renders only when its handler is passed, so the app shows only working
   surfaces (no placeholder buttons). Conversation UI = shared pieces (AgentTurn, UserTurn,
   TurnList, ThreadComposer, cards) + thin frames (ThreadView, FocusView); a frame-only feature
   is a piece the frame adds, never a prop of AgentTurn. Not: variant/mode props inside
   AgentTurn, or a god component accumulating optional props. */
export function ThreadView(props: ThreadViewProps) {
  const {
    root,
    thread,
    channel,
    emp,
    human,
    resolved,
    setResolved,
    onOpenTab,
    threadStatus,
    browser = false,
    onClose,
    work,
    repo,
    onStart,
    running,
    models,
    defaultModel,
    defaultProvider,
    transcriptNote,
    editors,
    onOpenPath,
    onRewind,
    rewindWarning,
    onAddFolder,
    onCompact,
    onContinue,
    onRename,
    onArchive,
    findBar,
    scrollTo,
    onScrolled,
    pending = [],
  } = props;
  const leadEmp = leadOf(props.lead, thread.replies, emp);
  const isDM = !!channel.dm;
  const { input: titleInput, menu: threadMenu } = useRenameMenu({
    title: thread.title || plain(root.text),
    archived: thread.archived,
    inputClassName: "h-8 [font-size:22px]",
    onRename,
    onArchive,
  });
  const keyTarget = useThreadKeys({
    thread,
    resolved,
    setResolved,
    human,
    onPlan: props.onPlan,
    running,
    onStop: props.onStop,
    onEscape: onClose,
  });
  const folder = !!thread.ws || !!work?.path;
  const { replies, pr, jobs } = thread;
  const prPending = pr?.checks.some((c) => c.status === "pending");
  const stripTabs = useMemo(
    () => workTabs({ replies, pr, jobs }, { folder, browser, prPending }),
    [replies, pr, jobs, folder, browser, prPending],
  );
  const startCardOpen = openStartRequest(thread, resolved);
  const bodyRef = useRef<HTMLDivElement>(null);
  const jump = useJumpToHit({
    scope: bodyRef,
    scrollTo,
    replies,
    onScrolled,
  });
  /* #583 AC-3: background processes still running under this thread. */
  const runningJobs = jobs?.filter((j) => j.status === "running").length ?? 0;
  const win = useTurnWindow({ frame: "panel", replies, emp });
  const acts = useTurnActs({
    onRetry: props.onRetry,
    onOpen: onOpenTab,
    onOpenSession: props.onOpenSession,
    onPlan: props.onPlan,
    onRewind,
    setResolved,
    onStart,
    onAnswer: props.onAnswer,
    onCancel: props.onCancel,
  });
  return (
    <div ref={bodyRef} className="flex min-h-0 flex-1 flex-col">
      {/* #570: the first pin on a lazy thread must land instantly — the
          default smooth sweep would scroll through the whole stub field
          and mount every row it passes, recreating the open-time freeze.
          A scrollTo open skips the pin outright (initial=false): the jump
          would otherwise race the pin's first write before the escape
          check lands. `resize` stays smooth: the streaming chase is
          unchanged. `initial` is read once at mount while the replies are
          still streaming, so it keys on the jump REQUEST, not the row's
          presence: an engaged pin would sweep the port to the bottom before
          `landJump` could run. A stale id pays a top-open instead — the
          rare case, and readable — rather than a broken jump every time. */}
      <Conversation
        className="min-h-0"
        pinRef={jump.pin}
        initial={scrollTo ? false : win.lazyRows ? "instant" : "smooth"}
      >
        {/* The composer sits below the scroller in normal flow — nothing
            overlays the last turn, so only a small bottom pad is needed;
            the question card's Skip row stays fully visible on its own row
            (#515, #602). No decision-card pad here (unlike Focus): the
            composer's own margin already supplies the #649 clearance, and
            a wider pad pushed the at-rest band past #602's 24px. The
            column is the prototype's: 720px, 32px gutters, 28px between
            turns — the header is its first child and scrolls with it. */}
        <ConversationContent className="mx-auto w-full max-w-[720px] gap-7 p-0 px-8 pb-3">
          <ThreadHeader
            session={false}
            title={thread.title || "Thread"}
            titleInput={titleInput}
            kicker={threadKicker({
              title: `Thread ${thread.session}`,
              channel: isDM ? undefined : `#${channel.name}`,
              folder: panelFolder({
                thread,
                work,
                repo,
                isDM,
                onAddFolder,
                openMenu: onOpenPath
                  ? {
                      editors: editors ?? [],
                      onOpen: (app) => onOpenPath(".", app),
                    }
                  : undefined,
              }),
            })}
            status={threadStatus}
            started={root.time}
            turns={sentTurns(root.from, thread, human)}
            note={
              /* #583 AC-3: a live background job says so right under the
                 title — "1 running in background". */
              runningJobs > 0 ? (
                <span data-bg-jobs className="text-work">
                  {" "}
                  · {runningJobs} running in background
                </span>
              ) : undefined
            }
            meter={
              thread.usage && leadEmp ? (
                /* The SESSION's model — never the employee's (#294): the
                   panel and Focus resolve through the same helper and the
                   window comes engine-reported on the usage/catalog, not
                   an employee row. */
                <SessionUsage
                  usage={thread.usage}
                  model={sessionModelId(
                    thread,
                    leadEmp.model,
                    models,
                    defaultModel,
                    defaultProvider,
                  )}
                  models={models}
                  onCompact={onCompact}
                  compactDisabled={running}
                  onContinue={onContinue}
                />
              ) : undefined
            }
            start={
              !work && !isDM && onStart ? (
                <StartWork onStart={onStart} yields={startCardOpen} />
              ) : undefined
            }
            menu={threadMenu}
            close={
              /* #577 AC-2: a visible ✕ — the way back to the DM list beside
                 Esc (which the same onClose owns). */
              onClose ? (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="ml-0.5"
                  title="Close"
                  aria-label="Close thread panel"
                  onClick={onClose}
                >
                  <XIcon />
                </Button>
              ) : undefined
            }
            strip={onOpenTab && { tabs: stripTabs, onOpen: onOpenTab }}
          />
          <TurnList
            frame="panel"
            root={root}
            thread={thread}
            emp={emp}
            human={human}
            resolved={resolved}
            work={work}
            repo={repo}
            models={models}
            pr={pr}
            prAuthor={leadEmp?.name ?? pr?.author}
            running={running}
            flash={jump.flash}
            win={win}
            scrollTo={scrollTo}
            rewindWarning={rewindWarning}
            keyTarget={keyTarget}
            acts={acts}
            onRewind={onRewind}
            transcriptNote={transcriptNote}
          />
          {work?.by && (
            <div className="rounded-[10px] border border-[var(--v3-line)] px-4 py-3.5 text-[13.5px]">
              <div className="flex items-center gap-2 text-muted-foreground">
                <CheckIcon className="size-3.5 text-emerald-600 dark:text-emerald-400" />
                {work.by} started work · {work.ticket}
              </div>
              <ul className="mt-2 space-y-1 text-muted-foreground">
                <li>
                  Ticket{" "}
                  <span className="font-mono text-[12.5px] text-foreground">
                    {work.ticket}
                  </span>{" "}
                  created from this thread
                </li>
                {work.branch && (
                  <li className="min-w-0 break-all font-mono text-[12.5px]">
                    git worktree add .lilos/wt/{work.ticket.toLowerCase()} -b{" "}
                    {work.branch}
                  </li>
                )}
                {work.branch && (
                  <li>
                    Thread{" "}
                    <span className="font-mono text-[12.5px]">
                      {thread.session}
                    </span>{" "}
                    moved to the worktree. Same thread, no history lost.
                  </li>
                )}
              </ul>
            </div>
          )}
        </ConversationContent>
        {/* The ↓ never overlaps a pending question card — the guard hides
            it while an open card intersects the port (FIX #515 r4). */}
        <QuestionAwareScrollButton />
        <FindUnstubNudge />
        <FindUnstubAnchor lazy={win.lazyRows} />
        {findBar}
        {/* The not-sent tray and pending-steer chips grow the composer area below; re-stick so the
           stopped turn + tray are both fully visible (issue #15). Inside <Conversation> so it can
           use the stick-to-bottom context. */}
        <ConversationKeepBottom
          signal={`${(thread.queue ?? []).length}:${pending.length}:${thread.stuck ?? ""}`}
        />
      </Conversation>
      {thread.stuck && (
        <StuckCard
          reason={thread.stuck}
          onStop={props.onStop}
          onMessage={stuckMessageHandler(props.onSend, () =>
            focusThreadComposer(bodyRef.current),
          )}
        />
      )}
      <ThreadComposer
        {...props}
        lead={leadEmp}
        idleHint={
          work?.branch
            ? `Edits go to ⎇ ${work.branch}`
            : work
              ? "Ticket only. No repo on this channel."
              : repo
                ? "Read-only on main. Start work to edit code."
                : isDM
                  ? `Message ${leadEmp?.name ?? "the employee"}…`
                  : `thread ${thread.session}`
        }
      />
    </div>
  );
}
