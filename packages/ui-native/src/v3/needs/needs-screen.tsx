import { useState } from "react";
import { Modules, Page, T } from "../kit";
import type { AskVM, ResultVM } from "../types";
import { AskDetailsSheet } from "./ask-details";
import { NeedsStack } from "./needs-stack";
import { ResultsModule } from "./results";

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

/** Results below the stack: three rows, the rest behind "n more" (which
    expands the module in place: this tab is where they are listed). */
const RESULT_ROWS = 3;

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
  const [detailsId, setDetailsId] = useState<string>();
  const [allResults, setAllResults] = useState(false);
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
        onDetails={setDetailsId}
      />
      <Modules>
        <ResultsModule
          rows={results}
          max={allResults ? results.length : RESULT_ROWS}
          onOpen={onOpenResult}
          onMore={() => setAllResults(true)}
        />
      </Modules>
      <AskDetailsSheet
        ask={asks.find((a) => a.id === detailsId)}
        onClose={() => setDetailsId(undefined)}
      />
    </Page>
  );
}
