import { View } from "react-native";
import {
  EmptyState,
  Page,
  SectionBlock,
  SerifTitle,
  StatusLabel,
} from "../kit";
import { ThreadRow } from "../rows";
import {
  TicketAsk,
  TicketFacts,
  TicketProgress,
  TicketResult,
  TicketUpdates,
} from "./ticket-parts";
import type { TicketPageVM } from "./ticket-types";

/** A ticket's own page. The native header carries its id; the title is drawn
    here. `page` is absent when the ticket no longer exists. */
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
      <SerifTitle>{page.title}</SerifTitle>
      <View className="px-5 pb-4">
        <StatusLabel status={page.status} label={page.statusWord} />
      </View>
      <TicketFacts
        owner={page.owner}
        facts={page.facts}
        onOpenOwner={onOpenAgent}
      />
      {page.ask ? (
        <TicketAsk
          ask={page.ask}
          onApprove={onApprove}
          onDeny={onDeny}
          onAnswer={onAnswer}
        />
      ) : null}
      {page.progress.length > 0 ? (
        <TicketProgress steps={page.progress} />
      ) : null}
      {page.result ? <TicketResult result={page.result} /> : null}
      {page.updates.length > 0 ? (
        <TicketUpdates updates={page.updates} />
      ) : null}
      {page.threads.length > 0 ? (
        <SectionBlock title="Threads">
          {page.threads.map((r, i) => (
            <ThreadRow
              key={r.id}
              row={r}
              onPress={onOpenThread}
              last={i === page.threads.length - 1}
            />
          ))}
        </SectionBlock>
      ) : null}
    </Page>
  );
}
