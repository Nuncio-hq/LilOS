import { useMemo, useRef } from "react";
import { ConversationKeepBottom } from "../chat/agent-chat";
import {
  Conversation,
  ConversationContent,
} from "../components/ai-elements/conversation";
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
import { sessionModelId } from "../lib/context-window";
import { cn } from "../lib/utils";
import { MainPane } from "../shell/main-pane";
import {
  focusThreadComposer,
  StuckCard,
  stuckMessageHandler,
} from "../thread/stuck-card";
import { ThreadComposer } from "../thread/thread-composer";
import { Workbench } from "../workbench/workbench";
import { FocusHeader } from "./focus-header";
import type { FocusViewProps } from "./focus-props";
import { PlanTray, usePlanTray } from "./plan-tray";
import { useFocusWorkbench } from "./use-focus-workbench";

/* The session view: the conversation (the same shared pieces as the thread
   panel — header, TurnList, ThreadComposer) beside the Workbench. See
   ThreadView for the frame rule. */
export function FocusView(props: FocusViewProps) {
  const {
    root,
    thread,
    channel,
    emp,
    human,
    resolved,
    setResolved,
    work,
    onBack,
    onStart,
    running,
    models,
    defaultModel,
    defaultProvider,
    transcriptNote,
    onRewind,
    rewindWarning,
    scrollTo,
    onScrolled,
    surfaces,
    banner,
    children,
    findBar,
    bare,
    host,
    say,
    onOpenPath,
    editors,
    pending,
    onStopJob,
    onSend,
  } = props;
  const isDM = !!channel.dm;
  const lead = leadOf(props.lead, thread.replies, emp);
  const wb = useFocusWorkbench({
    thread,
    work,
    host,
    isDM,
    emp,
    running,
    initialTab: props.initialTab,
    onTab: props.onTab,
    wbSpot: props.wbSpot,
    engineHandlers: onStopJob != null,
  });
  const { tab, pickTab, wbOpen, wbClose, wbAvailable } = wb;
  const turnsRef = useRef<HTMLElement>(null);
  const jump = useJumpToHit({
    scope: turnsRef,
    scrollTo,
    replies: thread.replies,
    onScrolled,
  });
  /* The session's model via the one shared resolver (#294) — the DM panel
     resolves the same way, so one session can't show two windows. */
  const model = sessionModelId(
    thread,
    lead?.model,
    models,
    defaultModel,
    defaultProvider,
  );
  const plan = usePlanTray(thread, running);
  const pendingSteers = pending ?? [];
  // The open "asks to start work" card, if any, is the single start-work entry point (issue #15).
  const startCardOpen = openStartRequest(thread, resolved);
  const keyTarget = useThreadKeys({
    thread,
    resolved,
    setResolved,
    human,
    onPlan: props.onPlan,
    running,
    onStop: props.onStop,
    onEscape: onBack,
  });
  const win = useTurnWindow({ frame: "focus", replies: thread.replies, emp });
  const acts = useTurnActs({
    onRetry: props.onRetry,
    onOpen: pickTab,
    onOpenSession: props.onOpenSession,
    onPlan: props.onPlan,
    onRewind,
    setResolved,
    onStart,
    onAnswer: props.onAnswer,
    onCancel: props.onCancel,
  });
  /* The memoized element keeps the whole Workbench subtree out of the
     render when only `wbOpen` flips — otherwise a 2,000-row file tree
     reconciles on every open/close (#547 AC-5). */
  const wbEl = useMemo(
    () => (
      <Workbench
        thread={thread}
        work={work}
        isDM={isDM}
        lead={lead}
        tab={tab}
        setTab={pickTab}
        onClose={wbClose}
        onStart={onStart}
        startYields={startCardOpen}
        onSend={onSend}
        say={say}
        repoFiles={props.repoFiles}
        host={host}
        human={human}
        onPrComment={props.onPrComment}
        onPrMerge={props.onPrMerge}
        live={surfaces}
        onStopJob={onStopJob}
        emp={emp}
        onOpenSession={props.onOpenSession}
        running={running}
        model={model}
        models={models}
        steer={props.steer}
        editors={editors}
        onOpenPath={onOpenPath}
        browser={props.browser}
        spot={props.wbSpot}
        ship={props.ship}
        caps={props.caps}
        onSuggest={props.onSuggest}
        onPr={props.onPr}
        onAllowed={wb.setWbReported}
      />
    ),
    [
      thread,
      work,
      isDM,
      lead,
      tab,
      pickTab,
      wbClose,
      onStart,
      startCardOpen,
      onSend,
      say,
      props.repoFiles,
      host,
      human,
      props.onPrComment,
      props.onPrMerge,
      surfaces,
      onStopJob,
      emp,
      props.onOpenSession,
      running,
      model,
      models,
      props.steer,
      editors,
      onOpenPath,
      props.browser,
      props.wbSpot,
      props.ship,
    ],
  );
  const pr = thread.pr;
  return (
    <MainPane bare={bare}>
      <div
        className={cn(
          "grid min-h-0 flex-1 grid-cols-1",
          /* The 2-col layout follows the shell's own class, not wbOpen —
             it flips in the same frame the panel does (#547 AC-5). */
          wbAvailable &&
            "has-[[data-wb-shell]:not(.hidden)]:lg:grid-cols-[minmax(0,1fr)_minmax(400px,46%)]",
        )}
      >
        <section ref={turnsRef} className="flex min-h-0 min-w-0 flex-col">
          {/* The banner lives in the same column as the messages — never a
              full-bleed strip the action floats away on (#423). */}
          {banner && (
            <div className="mx-auto w-full max-w-[720px] px-8 pt-3">
              {banner}
            </div>
          )}
          {/* #570: a lazy thread's first pin lands instantly — a smooth
             sweep would mount every stub it scrolls past (see
             thread-view); a scrollTo open skips the pin so the jump
             lands first. `resize` stays smooth for the streaming
             chase. */}
          <Conversation
            className="min-h-0"
            pinRef={jump.pin}
            initial={scrollTo ? false : win.lazyRows ? "instant" : "smooth"}
          >
            {/* The column is the thread panel's — 720px, 32px gutters — so the
                composer under it lines up with the turns at every width.
                #649: Focus's composer hugs the port's bottom edge, so a
                decision card as the last row needs the wider bottom pad —
                the bottom lock parks ~1px short and a ~12px pad rests at
                ~11px, tucking the card's border under the composer. The
                thread panel keeps its own pb-3: its composer margin already
                supplies the band, and more pad pushes it past #602's 24px. */}
            <ConversationContent
              data-thread
              className="mx-auto w-full max-w-[720px] gap-7 px-8 pt-0 pb-3 has-[>:last-child_[data-ask-id],>:last-child_[data-plan]]:pb-5"
            >
              <FocusHeader
                p={props}
                model={model}
                live={wb.live}
                startCardOpen={startCardOpen}
                stripOpen={wbAvailable && !wbOpen}
                onOpenTab={pickTab}
              />
              <TurnList
                frame="focus"
                root={root}
                thread={thread}
                emp={emp}
                human={human}
                resolved={resolved}
                work={work}
                repo={channel.repo}
                models={models}
                pr={pr}
                prAuthor={lead?.name ?? pr?.author}
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
            </ConversationContent>
            {/* Same guard as the thread panel — the ↓ never overlaps a
                pending question card (FIX #515 r4). */}
            <QuestionAwareScrollButton />
            <FindUnstubNudge />
            <FindUnstubAnchor lazy={win.lazyRows} />
            {findBar}
            {/* Not-sent tray / plan tray / steer chips grow the area below the conversation;
                re-stick so everything stays visible without scrolling (issue #15). */}
            <ConversationKeepBottom
              signal={`${(thread.queue ?? []).length}:${plan.todos.length}:${pendingSteers.length}:${running}:${plan.open}:${thread.stuck ?? ""}`}
            />
          </Conversation>
          {thread.stuck && (
            <StuckCard
              reason={thread.stuck}
              onStop={props.onStop}
              onMessage={stuckMessageHandler(
                onSend,
                () => focusThreadComposer(turnsRef.current),
                surfaces?.termControl === "user",
              )}
            />
          )}
          <ThreadComposer
            {...props}
            lead={lead}
            /* Terminal takeover (issue #69 AC-2): while the human holds the
               session's terminal, the agent can't run or write there — the
               composer says it's paused rather than inviting input. */
            paused={
              surfaces?.termControl === "user"
                ? `${lead?.name ?? "The agent"} is paused while you use the terminal`
                : undefined
            }
            idleHint={
              pr?.status === "merged"
                ? `#${pr.number} merged, ⎇ ${pr.head} deleted · next edit starts a new branch from main`
                : work?.branch
                  ? `Edits go to ⎇ ${work.branch}`
                  : work
                    ? "Edits land in this folder"
                    : isDM
                      ? `Message ${lead?.name ?? "the agent"}…`
                      : "Read-only on main"
            }
            above={
              <PlanTray
                todos={plan.todos}
                open={plan.open}
                onOpenChange={plan.setOpen}
              />
            }
          />
          {/* The open question card docks below the composer, same place it
              sits under the thread panel (#114 AC-2). */}
          {children}
        </section>

        {wbAvailable && wb.wbEverOpened.current && (
          <>
            {wbOpen && (
              <div
                className="fixed inset-0 z-20 bg-black/20 lg:hidden"
                onClick={wbClose}
              />
            )}
            <aside
              className={cn(
                "lilos-glass min-h-0 flex-col border-l bg-background lg:my-2 lg:mr-2 max-lg:fixed max-lg:inset-y-0 max-lg:right-0 max-lg:z-30 max-lg:w-[min(560px,100vw)] max-lg:shadow-2xl",
                /* Reads the wanted value: an unrelated render landing while
                   a deferred setWbOpen is still pending must not re-hide a
                   panel wbFlip just opened (#547). `flex` and `hidden` are
                   one either/or (never both, so tailwind-merge can't drop
                   `flex`) and wbFlip toggles them as a pair (#736). */
                wb.wbOpenWanted.current ? "flex" : "hidden",
              )}
              data-wb-shell
            >
              {wbEl}
            </aside>
          </>
        )}
      </div>
    </MainPane>
  );
}
