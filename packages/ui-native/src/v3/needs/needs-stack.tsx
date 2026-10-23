import { useEffect, useState } from "react";
import { useWindowDimensions, View } from "react-native";
import { EmptyState } from "../kit";
import type { AskVM } from "../types";
import { PEEK, StackCard } from "./stack-card";

/* The deck: the first ask in front, the next two peeking out behind it. The
   cards are laid on top of each other, so the deck's height is the tallest
   card's, kept for as long as asks remain: what sits below it (Results to
   look at) must not jump while cards fly off. */

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
  const empty = asks.length === 0;

  // The next batch of asks starts from its own size.
  useEffect(() => {
    if (empty) setTallest(0);
  }, [empty]);

  if (empty) return <EmptyState title="All clear" body={emptyBody} />;

  return (
    <View
      testID="needs-stack"
      style={{
        height: tallest + PEEK * 2,
        // Until the first measure the cards sit at their own height: hide the
        // one frame in which they are not yet the same size.
        opacity: tallest === 0 ? 0 : 1,
      }}
    >
      {asks.map((ask, i) => (
        <StackCard
          key={ask.id}
          ask={ask}
          depth={i}
          count={asks.length}
          width={window.width - SIDE_MARGIN * 2}
          minHeight={tallest}
          onMeasure={(h) => setTallest((prev) => Math.max(prev, Math.ceil(h)))}
          onApprove={onApprove}
          onDeny={onDeny}
          onAnswer={onAnswer}
          onOpenThread={onOpenThread}
        />
      ))}
    </View>
  );
}
