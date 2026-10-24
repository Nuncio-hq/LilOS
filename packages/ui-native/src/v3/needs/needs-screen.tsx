import { Page, T } from "../kit";
import type { AskVM } from "../types";
import { NeedsStack } from "./needs-stack";
import { ResultsToLookAt, type ResultVM } from "./results";

export type NeedsScreenProps = {
  /** Open asks in the order they are decided: the first is in front. */
  asks: AskVM[];
  /** The front ask's place among all open asks, 1-based ("1 of 2"). */
  position: number;
  /** The "All clear" line: what is going on now that nothing waits. */
  emptyBody: string;
  results: ResultVM[];
  onApprove: (askId: string) => void;
  onDeny: (askId: string) => void;
  onAnswer: (askId: string, option: string) => void;
  onOpenThread: (threadId: string) => void;
  onOpenResult: (key: string) => void;
};

export function NeedsScreen({
  asks,
  position,
  emptyBody,
  results,
  onApprove,
  onDeny,
  onAnswer,
  onOpenThread,
  onOpenResult,
}: NeedsScreenProps) {
  return (
    <Page testID="needs-screen">
      {asks.length > 0 ? (
        <T variant="small" tone="ink2" className="px-5 pb-3">
          {`${position} of ${asks.length}`}
        </T>
      ) : null}
      <NeedsStack
        asks={asks}
        emptyBody={emptyBody}
        onApprove={onApprove}
        onDeny={onDeny}
        onAnswer={onAnswer}
        onOpenThread={onOpenThread}
      />
      <ResultsToLookAt rows={results} onOpen={onOpenResult} />
    </Page>
  );
}
