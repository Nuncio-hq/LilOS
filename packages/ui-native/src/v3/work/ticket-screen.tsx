import { EmptyState, Modules, Page } from "../kit";
import {
  TicketDetailsModule,
  TicketResultModule,
  TicketThreadsModule,
  TicketUpdatesModule,
} from "./ticket-lists";
import { DecisionModule, ProgressModule, TicketHeader } from "./ticket-parts";
import type { TicketPageVM } from "./ticket-types";

/** A ticket's own page: a header card, then the modules that answer "where
    does it stand". What waits on you comes first. The native header carries
    the ticket's id. `page` is absent when the ticket no longer exists. */
export function TicketScreen({
  page,
  onOpenAgent,
  onOpenThread,
  onApprove,
  onDeny,
  onAnswer,
}: {
  page: TicketPageVM | undefined;
  onOpenAgent: (agentId: string) => void;
  onOpenThread: (threadId: string) => void;
  onApprove: (askId: string) => void;
  onDeny: (askId: string) => void;
  onAnswer: (askId: string, option: string) => void;
}) {
  if (!page) {
    return (
      <Page testID="ticket-screen">
        <EmptyState
          title="Ticket not found"
          body="It is no longer on the board."
        />
      </Page>
    );
  }
  return (
    <Page testID="ticket-screen">
      <Modules>
        <TicketHeader page={page} onOpenOwner={onOpenAgent} />
        {page.ask ? (
          <DecisionModule
            ask={page.ask}
            onApprove={onApprove}
            onDeny={onDeny}
            onAnswer={onAnswer}
          />
        ) : null}
        {page.progress.length > 0 ? (
          <ProgressModule steps={page.progress} />
        ) : null}
        {page.result ? <TicketResultModule result={page.result} /> : null}
        {page.threads.length > 0 ? (
          <TicketThreadsModule
            threads={page.threads}
            onOpenThread={onOpenThread}
          />
        ) : null}
        {page.updates.length > 0 ? (
          <TicketUpdatesModule updates={page.updates} />
        ) : null}
        {page.facts.length > 0 ? (
          <TicketDetailsModule facts={page.facts} />
        ) : null}
      </Modules>
    </Page>
  );
}
