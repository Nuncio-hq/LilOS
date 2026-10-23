import { useEffect, useState } from "react";
import { useWindowDimensions, View } from "react-native";
import { EmptyState } from "../kit";
import type { AskVM } from "../types";
import { PEEK, StackCard } from "./stack-card";

/* The deck: the first ask in front, the next two peeking out behind it. The
   front card is in normal flow, so the deck is as tall as it; the others
   stretch over it. The tallest front card so far is kept as a minimum for as
   long as asks remain, so what sits below (Results to look at) does not jump
   while cards fly off. A missed layout event costs that minimum, never the
   deck: every card is visible from its first frame. */

const SIDE_MARGIN = 20;

export function NeedsStack({
  asks,
  emptyBody,
  onApprove,
  onDeny,
  onAnswer,
  onOpenThread,
}: {
  /** In the order they are decided: the first is in front. */
  asks: AskVM[];
  /** The line under "All clear" once nothing waits. */
  emptyBody: string;
  onApprove: (id: string) => void;
  onDeny: (id: string) => void;
  onAnswer: (id: string, option: string) => void;
  onOpenThread: (threadId: string) => void;
}) {
  const window = useWindowDimensions();
  const [tallest, setTallest] = useState(0);
  // The deck's own width once laid out; until then the window's, which is
  // what it is on a phone. Only the swipe thresholds read it.
  const [deckWidth, setDeckWidth] = useState(window.width);
  const empty = asks.length === 0;

  // The next batch of asks starts from its own size.
  useEffect(() => {
    if (empty) setTallest(0);
  }, [empty]);

  if (empty) return <EmptyState title="All clear" body={emptyBody} />;

  return (
    <View
      testID="needs-stack"
      onLayout={(e) => setDeckWidth(e.nativeEvent.layout.width)}
      // Room for the two cards that peek out below the front one.
      style={{ paddingBottom: PEEK * 2 }}
    >
      {asks.map((ask, i) => (
        <StackCard
          key={ask.id}
          ask={ask}
          depth={i}
          count={asks.length}
          width={deckWidth - SIDE_MARGIN * 2}
          minHeight={tallest}
          onMeasureFront={(h) =>
            setTallest((prev) => Math.max(prev, Math.ceil(h)))
          }
          onApprove={onApprove}
          onDeny={onDeny}
          onAnswer={onAnswer}
          onOpenThread={onOpenThread}
        />
      ))}
    </View>
  );
}
