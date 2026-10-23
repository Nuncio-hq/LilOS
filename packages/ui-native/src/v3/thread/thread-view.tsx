import { useMemo, useRef } from "react";
import { ScrollView, View } from "react-native";
import { StatusDot, T } from "../kit";
import { ThreadAskCard } from "./ask-card";
import { turnAuthorLines } from "./author-runs";
import { ThreadComposer } from "./composer";
import { ThreadHeader } from "./header";
import { TurnView } from "./turn";
import type { ThreadVM } from "./types";

/* How close to the end still counts as "reading the end": a streaming answer
   keeps scrolling only for someone who has not scrolled up to read. */
const NEAR_END = 80;

export function ThreadView({
  thread,
  onSend,
  onApprove,
  onDeny,
  onAnswer,
}: {
  thread: ThreadVM;
  onSend: (text: string) => void;
  onApprove: (askId: string) => void;
  onDeny: (askId: string) => void;
  onAnswer: (askId: string, option: string) => void;
}) {
  const scroller = useRef<ScrollView>(null);
  const pinned = useRef(true);
  const { ask } = thread;
  // The header under the native bar names the agent, so the run that opens
  // the transcript needs no author line of its own; every later run does,
  // because the header scrolls away.
  const authorLines = useMemo(
    () => turnAuthorLines(thread.turns, thread.agent.id, true),
    [thread.turns, thread.agent.id],
  );
  return (
    <View testID="thread-screen" className="flex-1 bg-paper">
      <ScrollView
        ref={scroller}
        className="flex-1"
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        scrollEventThrottle={32}
        onScroll={(e) => {
          const { contentOffset, contentSize, layoutMeasurement } =
            e.nativeEvent;
          pinned.current =
            contentSize.height - (contentOffset.y + layoutMeasurement.height) <
            NEAR_END;
        }}
        onLayout={() => {
          if (pinned.current)
            scroller.current?.scrollToEnd({ animated: false });
        }}
        onContentSizeChange={() => {
          if (pinned.current)
            scroller.current?.scrollToEnd({ animated: false });
        }}
        contentContainerStyle={{ paddingBottom: 24 }}
      >
        <ThreadHeader thread={thread} />
        <View className="gap-7 pt-6">
          {thread.turns.map((turn, i) => (
            <TurnView
              key={turn.key}
              turn={turn}
              agent={thread.agent}
              showAuthor={authorLines[i] === true}
            />
          ))}
          {thread.stuck ? (
            <View testID="thread-stuck" className="gap-1 px-5">
              <T variant="small" className="font-semibold text-st-stuck-ink">
                {`Stuck: ${thread.stuck.what}`}
              </T>
              {thread.stuck.detail.map((line) => (
                <T key={line} variant="caption" tone="ink2">
                  {line}
                </T>
              ))}
            </View>
          ) : null}
          {thread.failure ? (
            <View testID="thread-failed" className="gap-1 px-5">
              <T variant="small" className="font-semibold text-st-stuck-ink">
                Failed
              </T>
              <T variant="small" className="text-st-stuck-ink">
                {thread.failure}
              </T>
            </View>
          ) : null}
          {thread.now ? (
            <View
              testID="thread-now"
              className="flex-row items-center gap-2 px-5"
            >
              <StatusDot status="working" size={7} />
              <T
                variant="small"
                tone="ink2"
                numberOfLines={2}
                className="flex-1"
              >
                {`${thread.now.text} · ${thread.now.elapsed}`}
              </T>
            </View>
          ) : null}
          {ask ? (
            <ThreadAskCard
              ask={ask}
              onApprove={() => onApprove(ask.id)}
              onDeny={() => onDeny(ask.id)}
              onAnswer={(option) => onAnswer(ask.id, option)}
            />
          ) : null}
        </View>
      </ScrollView>
      <ThreadComposer
        placeholder={`Message ${thread.agent.name}`}
        onSend={(text) => {
          // Your own message always brings you to the end, even from scrolled up.
          pinned.current = true;
          onSend(text);
        }}
      />
    </View>
  );
}
