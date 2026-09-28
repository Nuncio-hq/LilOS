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
import { AgentTurn, UserBubble } from "./agent-turn";
import { BackgroundPill } from "./background-sheet";
import { Composer } from "./composer";
import type { PlanAction } from "./plan-card";
import { PrBadge, prHeadline } from "./pr-badges";
import type {
  PullRequestRef,
  SessionState,
  SubagentRow,
  ThreadDetail,
} from "./types";

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
  onApprove,
  onDeny,
  onSend,
  onStop,
  onPickModel,
  onOpenSubagent,
  onOpenBackground,
  onPlan,
  onOpenPlan,
  prefill,
}: {
  t: ThreadDetail;
  model: string;
  /** models.dev slug for the composer's model chip. */
  modelLogo?: string;
  onApprove: (id: string) => void;
  onDeny: (id: string) => void;
  onSend: (text: string) => void;
  onStop: () => void;
  onPickModel: () => void;
  /** A subagent row → its sheet (issue #170). */
  onOpenSubagent?: (a: SubagentRow) => void;
  /** The "N running in background" pill → the background sheet. */
  onOpenBackground?: () => void;
  /** Plan card decisions + the plan sheet (issue #175). */
  onPlan?: (a: PlanAction, planId: string) => void;
  onOpenPlan?: () => void;
  /** Composer text to put in and focus (plan "Change…"). */
  prefill?: { text: string };
}) {
  const insets = useSafeAreaInsets();
  const scroller = useRef<ScrollView>(null);
  const [composerHeight, setComposerHeight] = useState(96);
  const running = t.state === "working";
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
          keyboardDismissMode="interactive"
          contentContainerStyle={{
            flexGrow: 1,
            justifyContent: "flex-end",
            paddingTop: 12,
            paddingBottom: composerHeight + 16 + (pill ? 44 : 0),
            paddingHorizontal: 16,
            gap: 24,
          }}
        >
          {t.entries.map((e) =>
            e.kind === "user" ? (
              <UserBubble
                key={e.id}
                text={e.text}
                time={e.queued ? "Queued · runs next" : e.time}
              />
            ) : (
              <AgentTurn
                key={e.id}
                e={e}
                name={t.employee.name}
                tone={t.employee.tone}
                onApprove={onApprove}
                onDeny={onDeny}
                onOpenSubagent={onOpenSubagent}
                onPlan={onPlan}
                onOpenPlan={onOpenPlan}
              />
            ),
          )}
        </ScrollView>

        <View className="absolute inset-x-0 bottom-0 gap-2">
          {onOpenBackground && (
            <BackgroundPill jobs={t.jobs ?? []} onPress={onOpenBackground} />
          )}
          <Composer
            placeholder={
              running
                ? `Steer ${t.employee.name}`
                : `Reply to ${t.employee.name}`
            }
            model={model}
            modelLogo={modelLogo}
            insetBottom={insets.bottom}
            onSend={onSend}
            onStop={running ? onStop : undefined}
            onPickModel={onPickModel}
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
  onPress,
}: {
  title: string;
  state: SessionState;
  prs?: PullRequestRef[];
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
        <StateChip state={state} />
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
