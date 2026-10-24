import { useEffect, useRef } from "react";
import { Animated, Easing, Text, View } from "react-native";
import { Avatar, PersonName, T } from "../kit";
import type { Person } from "../types";
import { Attachments } from "./attachments";
import { hasAnswerSide } from "./author-runs";
import { Glyph } from "./glyph";
import { PlanCard } from "./plan-card";
import { V3Prose } from "./prose";
import { WorkFold } from "./steps";
import type { PromptVM, TurnVM } from "./types";

/** The blinking mark at the end of text that is still being written. */
function Caret() {
  const v = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(v, {
          toValue: 0.15,
          duration: 520,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(v, {
          toValue: 1,
          duration: 520,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [v]);
  return (
    <Animated.View
      accessibilityLabel="Still writing"
      className="mt-1.5 h-[16px] w-[2px] rounded-full bg-ink-3"
      style={{ opacity: v }}
    />
  );
}

/** Your message: right-aligned, an ink bubble with paper text. */
function YouBubble({ prompt }: { prompt: PromptVM }) {
  return (
    <View className="items-end gap-1.5 px-5">
      {prompt.text ? (
        <View className="max-w-[84%] rounded-[20px] bg-ink px-3.5 py-2.5">
          <Text selectable className="text-[16px] text-paper leading-[22px]">
            {prompt.text}
          </Text>
        </View>
      ) : null}
      {prompt.files.map((name) => (
        <View key={name} className="max-w-[84%] flex-row items-center gap-1.5">
          <Glyph name="paperclip" token="ink-3" size={12} />
          <T variant="caption" tone="ink2" numberOfLines={1} className="shrink">
            {name}
          </T>
        </View>
      ))}
    </View>
  );
}

/** Someone else started the turn (the CEO, another agent): a quiet line, not a bubble. */
function AskedLine({ prompt }: { prompt: PromptVM }) {
  return (
    <View className="gap-1 px-5">
      <T variant="caption" tone="ink3">
        {`${prompt.who} asked · ${prompt.at}`}
      </T>
      <T variant="small" tone="ink2">
        {prompt.text}
      </T>
    </View>
  );
}

export function TurnView({
  turn,
  agent,
  showAuthor,
}: {
  turn: TurnVM;
  agent: Person;
  /** First message of a run by this agent: draw who is speaking. */
  showAuthor: boolean;
}) {
  const { prompt } = turn;
  return (
    <View className="gap-3" testID={`turn-${turn.key}`}>
      {prompt ? (
        prompt.fromYou ? (
          <YouBubble prompt={prompt} />
        ) : (
          <AskedLine prompt={prompt} />
        )
      ) : null}
      {hasAnswerSide(turn) ? (
        <View className="gap-3 px-5">
          {showAuthor ? (
            <View className="flex-row items-center gap-2">
              <Avatar person={agent} size={24} />
              <PersonName person={agent} variant="small" />
            </View>
          ) : null}
          <WorkFold
            steps={turn.steps}
            took={turn.took}
            live={turn.live}
            testID={`fold-${turn.key}`}
          />
          {turn.answer || turn.streaming ? (
            <View>
              {turn.answer ? <V3Prose text={turn.answer} /> : null}
              {turn.streaming ? <Caret /> : null}
            </View>
          ) : turn.summary ? (
            <T variant="body">{turn.summary}</T>
          ) : null}
          {turn.plan ? <PlanCard plan={turn.plan} /> : null}
          <Attachments items={turn.attachments} />
        </View>
      ) : null}
      {turn.queued.map((q) => (
        <View key={q.key} className="items-end px-5 opacity-60">
          <View className="max-w-[84%] rounded-[20px] bg-ink px-3.5 py-2.5">
            <Text className="text-[16px] text-paper leading-[22px]">
              {q.text}
            </Text>
          </View>
          <T variant="caption" tone="ink3" className="pt-1">
            {`Queued · ${q.at}`}
          </T>
        </View>
      ))}
    </View>
  );
}
