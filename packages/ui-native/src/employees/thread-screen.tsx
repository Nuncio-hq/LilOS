import { useEffect, useRef, useState } from "react";
import {
  KeyboardAvoidingView,
  Pressable,
  ScrollView,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppText } from "../components/app-text";
import { StateChip } from "../components/bits";
import { Icon } from "../components/icon";
import { Rise } from "../components/rise";
import { AgentTurn, UserBubble } from "./agent-turn";
import { BackgroundPill } from "./background-sheet";
import { Composer } from "./composer";
import { ContextRing } from "./context-meter";
import { NotSentTray } from "./not-sent-tray";
import type { PlanAction } from "./plan-card";
import { PrBadge, prHeadline } from "./pr-badges";
import type { QuestionAnswer } from "./question-card";
import { waitingOnQuestion } from "./question-gate";
import { threadBottomInset } from "./thread-layout";
import { transcriptItems } from "./transcript-items";
import type {
  ContextUsage,
  GrantOption,
  PullRequestRef,
  SessionState,
  SubagentRow,
  ThreadDetail,
  ThreadEntry,
  WbCardEntry,
} from "./types";
import { WorkbenchCard } from "./workbench-card";

/* #555: a scroll-to-hit row rests this far below the floating header —
   its flash band's rounded top corners never sit flush against the bar. */
const HIT_TOP_GAP = 12;
/* The Remove toast's visible window before the remove stands. */
const REMOVED_TOAST_MS = 5000;
/* Floor for the Undo toast's inset reserve until onLayout reports — the
   pill (py-2 + sm text) lands ~48-56pt tall, so a 0 first frame would
   still park the last row under it. The measured height wins. */
const REMOVED_TOAST_H = 48;
/* Floor for the not-sent tray's inset reserve while its real height is
   unmeasured (onLayout can report 0 or land a frame late — a 0 reserve
   parks the last transcript row under the tray). Header + one wrapped
   item + padding ≈ 88; the measured height wins once it's taller. */
const TRAY_MIN_H = 88;

/* One session opened as a thread (web: ThreadView), iOS style: the native
   nav bar carries the title + state (ThreadHeaderTitle) and an info button
   that opens the session's facts in a sheet (ThreadInfoSheet). The
   conversation fills the screen, newest at the bottom, and scrolls on under
   the floating glass composer, which replies IN this session (model only;
   the folder is fixed). */
export function ThreadScreen({
  t,
  model,
  modelLogo,
  modelUnavailable,
  onApprove,
  onDeny,
  onGrant,
  onAnswer,
  onSend,
  onStop,
  onPickModel,
  onOpenSubagent,
  onOpenSubagents,
  onOpenBackground,
  onPlan,
  onOpenPlan,
  onOpenWorkbench,
  onRetry,
  onSendNow,
  onRemoveNotSent,
  onUndoNotSent,
  scrollToEntry,
  hitQuery,
  prefill,
  unreachableNote,
  stale,
  asksStale,
  answerHint,
}: {
  t: ThreadDetail;
  /** Omit when the engine reports no models — the composer's chip hides. */
  model?: string;
  /** models.dev slug for the composer's model chip. */
  modelLogo?: string;
  /** #483: chip renders "Models unavailable" dimmed; its press retries. */
  modelUnavailable?: boolean;
  onApprove: (id: string) => void;
  onDeny: (id: string) => void;
  /** #601: the tapped option on an approval card — one of the ask's own
      grantOptions (Once / This session / Always / Deny). */
  onGrant?: (id: string, option: GrantOption) => void;
  /** #420: a question ask's answer — a question's Cancel rides `onDeny`. */
  onAnswer?: (id: string, answer: QuestionAnswer) => void;
  onSend: (text: string) => void;
  onStop: () => void;
  onPickModel?: () => void;
  /** A subagent row → its sheet (issue #170). */
  onOpenSubagent?: (a: SubagentRow) => void;
  /** The turn's "N subagents · Open" line → the session's Subagents sheet
     (#319 AC-4); passed, the turn shows only that line. */
  onOpenSubagents?: () => void;
  /** The "N running in background" pill → the background sheet. */
  onOpenBackground?: () => void;
  /** Plan card decisions + the plan sheet (issue #175). */
  onPlan?: (a: PlanAction, planId: string) => void;
  onOpenPlan?: () => void;
  /** A `workbench_open` card's tap → the target's phone view (#340). */
  onOpenWorkbench?: (e: WbCardEntry) => void;
  /** #555: re-runs the last failed turn — its card carries the Retry. */
  onRetry?: () => void;
  /** #555: the Not-sent tray's Send now / Remove (web: NotSentTray). */
  onSendNow?: (entryId: string) => void;
  onRemoveNotSent?: (entryId: string) => void;
  /** #555: Remove's Undo toast rides this — the removed send re-parks in
     its old slot. Absent, Remove is plain (no toast). */
  onUndoNotSent?: (
    entry: Extract<ThreadEntry, { kind: "user" }>,
    index: number,
  ) => void;
  /** #555: a search hit opened this thread — scroll to that row and
     flash it (web: scrollTo + the amber flash, #138). */
  scrollToEntry?: string;
  /** #555: the hit's term — bolded inside the row `scrollToEntry` lands
     on (web: the <mark> on the scrolled hit). */
  hitQuery?: string;
  /** Composer text to put in and focus (plan "Change…"). */
  prefill?: { text: string };
  /** #591: a thin line directly above the composer while the Mac is
      unreachable ("Can't reach <Mac>") — the cached thread stays
      readable, the hint explains why nothing new lands. */
  unreachableNote?: string;
  /** #591: the Mac is unreachable and this thread claims a live turn —
     the header degrades to "Last seen working" and Stop renders disabled
     (a press can't be delivered until the Mac is back). */
  stale?: boolean;
  /** #652: the Mac is unreachable — open ask cards (approval, plan,
     question) render their pills disabled; `answerHint` is the card's
     "Answer once <Mac> is back" line. Any state, not only `stale`. */
  asksStale?: boolean;
  answerHint?: string;
}) {
  const insets = useSafeAreaInsets();
  const scroller = useRef<ScrollView>(null);
  /* #555: the scroll view's own height — the search-hit scroll CENTRES
     the row (never under the header or the composer stack). */
  const viewH = useRef(0);
  const [composerHeight, setComposerHeight] = useState(96);
  /* #555: the Remove toast's entry — it re-parks on Undo inside ~5s. */
  const [removed, setRemoved] = useState<{
    entry: Extract<ThreadEntry, { kind: "user" }>;
    index: number;
  } | null>(null);
  const [pillHeight, setPillHeight] = useState(0);
  const [noteHeight, setNoteHeight] = useState(0);
  const [trayHeight, setTrayHeight] = useState(0);
  const [toastHeight, setToastHeight] = useState(0);
  /* #555: search-hit navigation — each row's scroll offset lands here;
     while the pending target is pending, EVERY scroll keeps it centred
     (content still grows under it — scrollToEnd would steal it back),
     then it flashes once settled. */
  const offsets = useRef(new Map<string, number>());
  const rowHeights = useRef(new Map<string, number>());
  const contentH = useRef(0);
  const pendingScroll = useRef<string | undefined>(scrollToEntry);
  /* Once the hit lands it stays centred as content keeps sizing under it
     — scrollToEnd would steal the scroll right back to the bottom. */
  const hitAnchor = useRef<string | undefined>(undefined);
  const hitSettle = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const [flashId, setFlashId] = useState<string>();
  const running = t.state === "working" && !stale;
  /* #420: parked on an open QUESTION ask the card can answer — the
     composer says waiting, no steer copy and no stop (Hermes FIX #515).
     `waitingOnQuestion` also requires options/freeText, so a real-app
     question ask (its view-model maps neither) keeps the Reply
     composer; approval asks keep their own flow (the sheet). */
  const waiting = waitingOnQuestion(t.entries);
  /* #555: a send parked by Stop leaves the transcript for the tray — it
     was never delivered, so it renders nowhere until Send now / Remove
     (web: the rows stay out of the list and live in NotSentTray). */
  const parked = t.entries.filter(
    (e): e is Extract<ThreadEntry, { kind: "user" }> =>
      e.kind === "user" && !!e.notSent,
  );
  const items = transcriptItems(t).filter(
    (e) => !(e.kind === "user" && e.notSent),
  );
  /* #555: the Retry rides the last TURN like web's `last` (#419) — an
     earlier failed turn is history; AgentTurn gates on `failed` itself. */
  const lastAgentId = [...t.entries]
    .reverse()
    .find((e) => e.kind === "agent")?.id;
  // The background pill floats above the composer; keep the last turn clear of it.
  const pill =
    !!onOpenBackground && !!t.jobs?.some((j) => j.status === "running");
  // The composer's height lands after the first layout; once it does, the
  // newest turn (and its Approve) must sit above it, not under it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-scroll is triggered by the composer height change, not read in the body
  useEffect(() => {
    const id = setTimeout(
      () =>
        !pendingScroll.current &&
        !hitAnchor.current &&
        scroller.current?.scrollToEnd({ animated: false }),
      50,
    );
    return () => clearTimeout(id);
  }, [composerHeight]);
  /* The flash outlives the scroll to the hit row, then fades on its
     own — 6s so Oscar still sees the amber when he lands. */
  useEffect(() => {
    if (flashId === undefined) return;
    const id = setTimeout(() => setFlashId(undefined), 6000);
    return () => clearTimeout(id);
  }, [flashId]);
  /* #555: the Undo toast auto-dismisses — the remove stands once it
     leaves, the entry stays deleted. */
  useEffect(() => {
    if (!removed) return;
    const id = setTimeout(() => setRemoved(null), REMOVED_TOAST_MS);
    return () => clearTimeout(id);
  }, [removed]);
  /* A Remove pulls the row from the tray and offers Undo for ~5s — the
     engine already dropped the entry, so the toast keeps its copy. */
  const removeParked = (id: string) => {
    const index = t.entries.findIndex((e) => e.id === id);
    const entry = index >= 0 ? t.entries[index] : undefined;
    onRemoveNotSent?.(id);
    if (entry?.kind === "user" && onUndoNotSent) setRemoved({ entry, index });
  };
  /* #555: centre the hit row in the scroll view — never under the header
     or the composer stack; falls back to a top offset before the view
     height lands. The transparent chat header floats over the top, so
     the floor is the top inset, not 0 — a first-row hit rests 12pt
     below the bar, its rounded corners clear. And it never scrolls past
     the rest position: scrolling up further would only drag the last
     transcript row under the floating tray/toast. */
  const scrollToHit = (eid: string) => {
    const top = offsets.current.get(eid);
    if (top === undefined) return;
    const row = rowHeights.current.get(eid) ?? 0;
    const floor = -(insets.top + 44 + HIT_TOP_GAP);
    /* Never scroll without real geometry: before the view and content
       heights land, any offset is a guess. The pending hit re-fires on
       the next layout pass, so waiting costs nothing. */
    if (!viewH.current || !contentH.current) return;
    /* Content that fits takes the rest position — scrolling up to
       centre would only drag the tail under the floating stack. The
       container can report a hair over the view height when it hugs it,
       so "fits" gets the bottom inset's worth of slack. scrollToEnd
       lands the proven rest position rather than a computed offset. */
    if (contentH.current <= viewH.current + bottomInset) {
      scroller.current?.scrollToEnd({ animated: false });
      return;
    }
    const rest = Math.max(
      floor,
      contentH.current - viewH.current + bottomInset,
    );
    const y = Math.min(Math.max(floor, top - (viewH.current - row) / 2), rest);
    scroller.current?.scrollTo({ y, animated: false });
  };
  /* #555: the whole floating bottom stack feeds the transcript's bottom
     inset — composer plus the pill/note/tray and the Undo toast's fixed
     reserve, each with its stack gap, so the last row always rests ≥8pt
     above whatever floats. Shared by the scroll clamp and the inset. */
  const bottomInset = threadBottomInset(
    composerHeight,
    pill ? pillHeight : 0,
    unreachableNote ? noteHeight : 0,
    parked.length ? Math.max(trayHeight, TRAY_MIN_H) : 0,
    removed ? Math.max(toastHeight, REMOVED_TOAST_H) : 0,
  );
  /* The pending hit re-centres on each layout pass until the content
     settles; a beat after the first centre it flashes and stands down. */
  const onHitLayout = (eid: string) => {
    scrollToHit(eid);
    if (!hitSettle.current) {
      hitSettle.current = setTimeout(() => {
        pendingScroll.current = undefined;
        hitAnchor.current = eid;
        hitSettle.current = undefined;
        setFlashId(eid);
      }, 350);
    }
  };
  /* #555: navigate() reuses the mounted screen — a new scrollTo param
     re-arms the pending hit (no remount, no ref init). A warm offset
     scrolls right away; a cold one waits for the row's layout. */
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-arms on the param only — the scroll helpers re-read the latest refs every call
  useEffect(() => {
    pendingScroll.current = scrollToEntry;
    hitAnchor.current = undefined;
    setFlashId(undefined);
    if (scrollToEntry && offsets.current.has(scrollToEntry))
      onHitLayout(scrollToEntry);
  }, [scrollToEntry]);

  return (
    <KeyboardAvoidingView behavior="padding" className="flex-1 bg-background">
      {/* The keyboard shrinks this box, so the composer pinned to its
          bottom rides up with the keyboard. */}
      <View className="flex-1">
        <ScrollView
          ref={scroller}
          className="flex-1"
          onLayout={(ev) => {
            viewH.current = ev.nativeEvent.layout.height;
          }}
          onContentSizeChange={(_w, h) => {
            contentH.current = h;
            if (pendingScroll.current) scrollToHit(pendingScroll.current);
            else if (hitAnchor.current) scrollToHit(hitAnchor.current);
            else scroller.current?.scrollToEnd({ animated: true });
          }}
          contentInsetAdjustmentBehavior="never"
          /* The chat header is transparent + floats — content must rest
             BELOW it, not start under it (the top inset is the header's
             height plus a 12pt gap; scrolling still carries turns under
             the blurred bar). */
          contentInset={{
            top: insets.top + 44 + HIT_TOP_GAP,
            /* #182 + #181: the bottom stack floats over this scroll view —
               the inset must clear ALL of it: the measured composer plus,
               while a background pill shows, the pill and its stack gap.
               Composer-only leaves the newest line under the pill. */
            bottom: bottomInset,
          }}
          /* A manual scroll ends the pin — the hit's anchor stands down. */
          onScrollBeginDrag={() => {
            pendingScroll.current = undefined;
            hitAnchor.current = undefined;
          }}
          keyboardDismissMode="interactive"
          contentContainerStyle={{
            flexGrow: 1,
            justifyContent: "flex-end",
            paddingTop: 12,
            paddingBottom: 16,
            paddingHorizontal: 16,
            gap: 24,
          }}
        >
          {items.map((e) => (
            <View
              key={e.id}
              onLayout={(ev) => {
                offsets.current.set(e.id, ev.nativeEvent.layout.y);
                rowHeights.current.set(e.id, ev.nativeEvent.layout.height);
                if (pendingScroll.current === e.id) onHitLayout(e.id);
              }}
              className={`-mx-2 -my-1 rounded-xl px-2 py-1.5 ${flashId === e.id ? "bg-amber-100 dark:bg-amber-800/60" : ""}`}
            >
              <Rise>
                {/* #514: a transcript state note heads the scroll — the
                  trimmed note describes history missing ABOVE the first
                  entry, so it renders first, a centered divider (not the
                  bottom box web uses for the #28 'unavailable' note).
                  The text shrinks + wraps to 2 lines inside the thread
                  gutter; the hairlines keep ≥24px so the divider reads at
                  any Dynamic Type size. */}
                {e.kind === "transcript-note" ? (
                  <View className="flex-row items-center gap-3">
                    <View
                      className="h-px flex-1 bg-border"
                      style={{ minWidth: 24 }}
                    />
                    <AppText
                      tone="muted"
                      numberOfLines={2}
                      className="shrink text-center text-[12px] leading-[16px]"
                    >
                      {e.text}
                    </AppText>
                    <View
                      className="h-px flex-1 bg-border"
                      style={{ minWidth: 24 }}
                    />
                  </View>
                ) : e.kind === "user" ? (
                  <UserBubble
                    text={e.text}
                    mark={e.id === scrollToEntry ? hitQuery : undefined}
                    time={
                      e.queued
                        ? e.waiting
                          ? "Waiting for you"
                          : "Queued · runs next"
                        : e.time
                    }
                  />
                ) : e.kind === "workbench" ? (
                  <WorkbenchCard
                    target={e.target}
                    time={e.time}
                    onPress={() => onOpenWorkbench?.(e)}
                  />
                ) : (
                  <AgentTurn
                    e={e}
                    name={t.employee.name}
                    tone={t.employee.tone}
                    onApprove={onApprove}
                    onDeny={onDeny}
                    onGrant={onGrant}
                    onAnswer={onAnswer}
                    onOpenSubagent={onOpenSubagent}
                    onOpenSubagents={onOpenSubagents}
                    onPlan={onPlan}
                    onOpenPlan={onOpenPlan}
                    onRetry={e.id === lastAgentId ? onRetry : undefined}
                    mark={e.id === scrollToEntry ? hitQuery : undefined}
                    stale={asksStale}
                    answerHint={answerHint}
                  />
                )}
              </Rise>
            </View>
          ))}
        </ScrollView>

        <View className="absolute inset-x-0 bottom-0 gap-2">
          {onOpenBackground && pill && (
            <View onLayout={(e) => setPillHeight(e.nativeEvent.layout.height)}>
              <BackgroundPill jobs={t.jobs ?? []} onPress={onOpenBackground} />
            </View>
          )}
          {unreachableNote && (
            <View
              /* #652 AC-3: its own 8px of breathing room above — flush
                 against the last row it read as that card's footer. */
              className="flex-row items-center justify-center gap-1.5 pt-2"
              onLayout={(e) => setNoteHeight(e.nativeEvent.layout.height)}
            >
              <Icon
                name="wifi.exclamationmark"
                size={12}
                tone="muted-foreground"
                weight="medium"
              />
              <AppText size="xs" tone="muted">
                {/* #591: the note names the disabled Stop when the cached
                    thread still claims a turn — the one control that
                    looks live but can't be delivered. */}
                {`${unreachableNote}${stale ? " · Stop works once the Mac is back" : ""}`}
              </AppText>
            </View>
          )}
          {parked.length > 0 && (
            <View onLayout={(e) => setTrayHeight(e.nativeEvent.layout.height)}>
              <NotSentTray
                items={parked.map((m) => ({ id: m.id, text: m.text }))}
                onSendNow={onSendNow}
                onRemove={removeParked}
              />
            </View>
          )}
          {removed && (
            /* #555: Remove's ~5s Undo — an inverted pill above the
               composer, gone on its own (web keeps the deleted row's
               toast slot). Its measured height reserves room in the
               bottom inset — the last row never sits under it. */
            <View
              className="mx-4 items-center"
              onLayout={(e) => setToastHeight(e.nativeEvent.layout.height)}
            >
              <View className="flex-row items-center gap-3 rounded-full bg-foreground/95 px-4 py-2">
                <AppText size="sm" className="text-background">
                  Message removed
                </AppText>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Undo remove"
                  onPress={() => {
                    onUndoNotSent?.(removed.entry, removed.index);
                    setRemoved(null);
                  }}
                  className="min-h-11 items-center justify-center active:opacity-70"
                >
                  <AppText
                    size="sm"
                    weight="semibold"
                    className="text-background underline"
                  >
                    Undo
                  </AppText>
                </Pressable>
              </View>
            </View>
          )}
          <Composer
            placeholder={
              running
                ? /* #308: a leg is engine work — sends queue behind it. */
                  t.agentWorking
                  ? `Queue for ${t.employee.name}`
                  : `Steer ${t.employee.name}`
                : waiting
                  ? `${t.employee.name} is waiting for your answer`
                  : `Reply to ${t.employee.name}`
            }
            {...(model !== undefined ? { model } : {})}
            modelLogo={modelLogo}
            modelUnavailable={modelUnavailable}
            insetBottom={insets.bottom}
            onSend={onSend}
            /* #591: stale keeps the ■ visible but disabled — hiding it
               would pretend the thread was never mid-turn. */
            onStop={t.state === "working" ? onStop : undefined}
            stopHint={stale ? "Stop works once the Mac is back" : undefined}
            {...(onPickModel ? { onPickModel } : {})}
            onLayoutHeight={setComposerHeight}
            prefill={prefill}
          />
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

/* The nav bar's title view: the session title with its state under it.
   Tapping it opens the session info, like a contact name in Messages. */
export function ThreadHeaderTitle({
  title,
  state,
  prs,
  context,
  waiting,
  stale,
  onPress,
  failureKind,
}: {
  title: string;
  /** #596: optional — a thread still loading (or gone) claims no state,
      so the title alone renders. */
  state?: SessionState;
  /** #592: "sleep" failures read amber "Mac went to sleep" in the chip. */
  failureKind?: "model" | "sleep" | "generic";
  prs?: PullRequestRef[];
  /** Adds the context gauge beside the state. */
  context?: ContextUsage;
  /** #420: needs-you is a question the card can answer (waitingOnQuestion)
      — waiting is not working, so the ring hides. Omitted (the real app)
      the ring renders on needs-you exactly as before. */
  waiting?: boolean;
  /** #591: the Mac is unreachable — a live "working" chip degrades to
     neutral "Last seen working". Terminal states stay as-is. */
  stale?: boolean;
  onPress: () => void;
}) {
  const one = prs?.length === 1 ? prs[0] : undefined;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${title}, session info`}
      onPress={onPress}
      className="max-w-[240px] items-center gap-0.5 active:opacity-60"
    >
      <AppText
        weight="semibold"
        numberOfLines={1}
        className="text-[16px] leading-5"
      >
        {title}
      </AppText>
      {state === undefined ? null : (
        <View className="flex-row items-center gap-1.5">
          <StateChip
            state={stale && state === "working" ? "last-seen" : state}
            failureKind={failureKind}
          />
          {/* Waiting is not working — no progress ring next to "Needs you"
            while a question the card can answer is open (Hermes FIX #515).
            Other needs-you asks keep the ring: they ARE still working. */}
          {context && (state !== "needs-you" || !waiting) && (
            <ContextRing c={context} />
          )}
          {!!prs?.length && (
            <>
              <AppText tone="muted" className="text-[13px]">
                ·
              </AppText>
              {one ? (
                <PrBadge pr={one} />
              ) : (
                <AppText tone="muted" weight="medium" className="text-[13px]">
                  {prHeadline(prs)}
                </AppText>
              )}
            </>
          )}
        </View>
      )}
    </Pressable>
  );
}
