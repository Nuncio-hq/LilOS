import { useState } from "react";
import {
  KeyboardAvoidingView,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppText } from "../components/app-text";
import { SectionTitle } from "../components/bits";
import { Icon } from "../components/icon";
import { Orb, type OrbState, type OrbTone } from "../components/orb";
import { Pulse, plain } from "../components/prose";
import { whatLine } from "./approval-copy";
import { Composer } from "./composer";
import { DM_GROUPS } from "./dm-groups";
import { LifePill } from "./life-pill";
import { PrLine } from "./pr-badges";
import type { SessionState, SessionTurn } from "./types";

/* A DM with one employee, as a Mail-style list of its threads: each message
   you send opens a thread, and the threads group by what they need from
   you — Needs you, Working, Didn't finish, Done — newest first inside each
   group. Tap a thread to open it (approve there, with the context in view).
   The floating glass composer starts a new thread. The header is the native
   nav bar (see DmHeaderTitle). */

export function EmployeeDmScreen({
  name,
  tone,
  turns,
  folder,
  model,
  modelLogo,
  modelUnavailable,
  onOpenSession,
  onSend,
  onPickFolder,
  onPickModel,
  prefill,
  unreachableNote,
}: {
  name: string;
  tone: OrbTone;
  turns: SessionTurn[];
  folder: string;
  /** Omit when the engine reports no models — the composer's chip hides. */
  model?: string;
  /** models.dev slug for the composer's model chip. */
  modelLogo?: string;
  /** #483: chip renders "Models unavailable" dimmed; its press retries. */
  modelUnavailable?: boolean;
  onOpenSession: (id: string) => void;
  onSend: (text: string) => void;
  onPickFolder: () => void;
  onPickModel?: () => void;
  /** Composer text to put in and focus (e.g. a draft a failed send kept). */
  prefill?: { text: string };
  /** #591: a thin line above the composer while the Mac is unreachable
      ("Can't reach <Mac>"). */
  unreachableNote?: string;
}) {
  const insets = useSafeAreaInsets();
  const [composerHeight, setComposerHeight] = useState(96);
  const newest = [...turns].reverse();

  return (
    <KeyboardAvoidingView behavior="padding" className="flex-1 bg-background">
      {/* The keyboard shrinks this box, so the composer pinned to its
          bottom rides up with the keyboard. */}
      <View className="flex-1">
        <ScrollView
          className="flex-1"
          contentInsetAdjustmentBehavior="automatic"
          keyboardDismissMode="interactive"
          contentContainerStyle={{
            flexGrow: 1,
            paddingBottom: composerHeight + 16,
          }}
        >
          {turns.length === 0 && (
            <View className="flex-1 items-center justify-center gap-3 px-10">
              <Orb tone={tone} size={64} />
              <AppText tone="muted" className="text-center text-[15px]">
                {`Each message opens its own thread.\nAsk ${name} something below.`}
              </AppText>
            </View>
          )}
          {DM_GROUPS.map((g) => {
            const rows = newest.filter((t) => g.states.includes(t.state));
            if (!rows.length) return null;
            return (
              <View key={g.title}>
                <SectionTitle title={g.title} />
                {rows.map((t, i) => (
                  <ThreadRow
                    key={t.id}
                    t={t}
                    last={i === rows.length - 1}
                    onPress={() => onOpenSession(t.id)}
                  />
                ))}
              </View>
            );
          })}
        </ScrollView>

        <View className="absolute inset-x-0 bottom-0 gap-2">
          {unreachableNote && (
            <View className="flex-row items-center justify-center gap-1.5">
              <Icon
                name="wifi.exclamationmark"
                size={12}
                tone="muted-foreground"
                weight="medium"
              />
              <AppText size="xs" tone="muted">
                {unreachableNote}
              </AppText>
            </View>
          )}
          <Composer
            placeholder={`New thread with ${name}`}
            folder={folder}
            {...(model !== undefined ? { model } : {})}
            modelLogo={modelLogo}
            modelUnavailable={modelUnavailable}
            insetBottom={insets.bottom}
            onSend={onSend}
            onPickFolder={onPickFolder}
            {...(onPickModel ? { onPickModel } : {})}
            onLayoutHeight={setComposerHeight}
            prefill={prefill}
          />
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

/* One thread, like a message in Mail: a state mark in the gutter (teal dot
   = needs you, pulsing blue = working), title + time, what it needs or said
   last, then where it runs and how many replies. */
function ThreadRow({
  t,
  last,
  onPress,
}: {
  t: SessionTurn;
  last: boolean;
  onPress: () => void;
}) {
  const needs = t.state === "needs-you";
  const failed = t.state === "failed";
  /* #592: a failed turn's body is its reason — the harness's "your Mac
     went to sleep" line in amber for a sleep interrupt, the error text
     in red otherwise — never the last preview pretending all is well. */
  const slept = failed && t.failure?.kind === "sleep";
  const body = failed
    ? (t.failure?.text ?? "Turn failed")
    : needs
      ? t.approval
        ? whatLine(t.approval)
        : plain(t.preview ?? "")
      : t.state === "working"
        ? (t.live ?? plain(t.preview ?? ""))
        : plain(t.preview ?? t.prompt);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${t.title}, ${stateLabel(t.state)}. ${body}`}
      onPress={onPress}
      className="flex-row pl-4 active:bg-fill"
    >
      <View className="w-5 items-start pt-[19px]">
        <StateMark
          state={t.state}
          ringed={!!t.replies && !!t.life}
          slept={slept}
        />
      </View>
      <View className="min-w-0 flex-1 gap-0.5 py-3 pr-4">
        <View className="flex-row items-center gap-2">
          <AppText
            weight="semibold"
            numberOfLines={1}
            className="flex-1 text-[17px] leading-[22px]"
          >
            {t.title}
          </AppText>
          <AppText tone="muted" className="text-[15px]">
            {t.when}
          </AppText>
          <Icon
            name="chevron.right"
            size={11}
            tone="muted-foreground"
            weight="semibold"
          />
        </View>
        {!!body && (
          <Text
            numberOfLines={2}
            className={`text-[15px] leading-5 ${
              needs
                ? "text-foreground"
                : slept
                  ? "text-warning"
                  : failed
                    ? "text-destructive"
                    : "text-muted-foreground"
            }`}
          >
            {body}
          </Text>
        )}
        <View className="mt-0.5 flex-row items-center gap-2">
          {t.folder && (
            <View className="min-w-0 shrink flex-row items-center gap-1">
              <Icon
                name="arrow.triangle.branch"
                size={11}
                tone="muted-foreground"
              />
              <Text
                numberOfLines={1}
                className="shrink text-[13px] text-muted-foreground"
              >
                {t.branch ?? t.folder}
              </Text>
            </View>
          )}
          {t.added !== undefined && (
            <Text
              className="font-medium text-[13px]"
              style={{ fontVariant: ["tabular-nums"] }}
            >
              <Text className="text-success">{`+${t.added}`}</Text>
              <Text className="text-destructive">{` −${t.removed ?? 0}`}</Text>
            </Text>
          )}
          <View className="flex-1" />
          {!!t.replies && (
            <LifePill life={t.life}>
              <Icon name="bubble.left" size={11} tone="muted-foreground" />
              <AppText tone="muted" className="text-[13px]">
                {t.replies}
              </AppText>
            </LifePill>
          )}
        </View>
        {!!t.prs?.length && <PrLine prs={t.prs} />}
        {!last && (
          <View className="absolute right-0 bottom-0 left-0 h-[0.5px] bg-border" />
        )}
      </View>
    </Pressable>
  );
}

function StateMark({
  state,
  ringed,
  slept,
}: {
  state: SessionState;
  ringed?: boolean;
  /** #592: the failure was a sleep interrupt — the ⚠ goes amber. */
  slept?: boolean;
}) {
  if (state === "needs-you")
    return (
      <View className="-mt-1 -ml-1 size-[18px] items-center justify-center rounded-full bg-primary">
        <View className="h-[7px] w-[2px] rounded-full bg-primary-foreground" />
        <View className="mt-[1.5px] size-[2px] rounded-full bg-primary-foreground" />
      </View>
    );
  if (state === "working")
    // #344: with replies, the ring round the replies count says "working";
    // a dot here too would say it twice. No replies yet → the dot.
    return ringed ? null : (
      <Pulse>
        <View className="size-2.5 rounded-full bg-work" />
      </Pulse>
    );
  if (state === "failed")
    return (
      <Icon
        name="exclamationmark.triangle.fill"
        size={11}
        tone={slept ? "warning" : "destructive"}
      />
    );
  return null;
}

function stateLabel(state: SessionState) {
  return state === "needs-you"
    ? "needs you"
    : state === "working"
      ? "working"
      : state;
}

export function DmHeaderTitle({
  name,
  tone,
  state,
  status,
  onPress,
}: {
  name: string;
  tone: OrbTone;
  state: OrbState;
  status: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${name} profile`}
      onPress={onPress}
      className="flex-row items-center gap-2 active:opacity-60"
    >
      <Orb tone={tone} size={26} state={state} badge={false} />
      <View>
        <AppText
          weight="semibold"
          numberOfLines={1}
          className="text-[16px] leading-5"
        >
          {name}
        </AppText>
        <AppText
          tone="muted"
          numberOfLines={1}
          className="text-[12px] leading-[15px]"
        >
          {status}
        </AppText>
      </View>
    </Pressable>
  );
}
