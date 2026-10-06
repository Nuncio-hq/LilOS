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
import type { PlanAction } from "./plan-card";
import { PrBadge, prHeadline } from "./pr-badges";
import type { QuestionAnswer } from "./question-card";
import { waitingOnQuestion } from "./question-gate";
import { threadBottomInset } from "./thread-layout";
import { transcriptItems } from "./transcript-items";
import type {
  ContextUsage,
  PullRequestRef,
  SessionState,
  SubagentRow,
  ThreadDetail,
  WbCardEntry,
} from "./types";
import { WorkbenchCard } from "./workbench-card";

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
  prefill,
  unreachableNote,
  stale,
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
}) {
  const insets = useSafeAreaInsets();
  const scroller = useRef<ScrollView>(null);
  const [composerHeight, setComposerHeight] = useState(96);
  const [pillHeight, setPillHeight] = useState(0);
  const [noteHeight, setNoteHeight] = useState(0);
  const running = t.state === "working" && !stale;
  /* #420: parked on an open QUESTION ask the card can answer — the
     composer says waiting, no steer copy and no stop (Hermes FIX #515).
     `waitingOnQuestion` also requires options/freeText, so a real-app
     question ask (its view-model maps neither) keeps the Reply
     composer; approval asks keep their own flow (the sheet). */
  const waiting = waitingOnQuestion(t.entries);
  // The background pill floats above the composer; keep the last turn clear of it.
  const pill =
    !!onOpenBackground && !!t.jobs?.some((j) => j.status === "running");
  // The composer's height lands after the first layout; once it does, the
  // newest turn (and its Approve) must sit above it, not under it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-scroll is triggered by the composer height change, not read in the body
  useEffect(() => {
    const id = setTimeout(
      () => scroller.current?.scrollToEnd({ animated: false }),
      50,
    );
    return () => clearTimeout(id);
  }, [composerHeight]);

  return (
    <KeyboardAvoidingView behavior="padding" className="flex-1 bg-background">
      {/* The keyboard shrinks this box, so the composer pinned to its
          bottom rides up with the keyboard. */}
      <View className="flex-1">
        <ScrollView
          ref={scroller}
          className="flex-1"
          onContentSizeChange={() =>
            scroller.current?.scrollToEnd({ animated: true })
          }
          contentInsetAdjustmentBehavior="automatic"
          /* #182 + #181: the bottom stack floats over this scroll view —
             the inset must clear ALL of it: the measured composer plus,
             while a background pill shows, the pill and its stack gap.
             Composer-only leaves the newest line under the pill. */
          contentInset={{
            bottom: threadBottomInset(
              composerHeight,
              pill ? pillHeight : 0,
              unreachableNote ? noteHeight : 0,
            ),
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
          {transcriptItems(t).map((e) => (
            <Rise key={e.id}>
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
                  onAnswer={onAnswer}
                  onOpenSubagent={onOpenSubagent}
                  onOpenSubagents={onOpenSubagents}
                  onPlan={onPlan}
                  onOpenPlan={onOpenPlan}
                />
              )}
            </Rise>
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
              className="flex-row items-center justify-center gap-1.5"
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
  state: SessionState;
  /** #592: "sleep" failures read amber "Mac slept mid-turn" in the chip. */
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
    </Pressable>
  );
}
