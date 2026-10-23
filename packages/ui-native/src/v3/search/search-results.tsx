import { View } from "react-native";
import { Avatar, Note, Page, PersonName, SectionBlock, T, Tag } from "../kit";
import { ListRow, ThreadRow, TicketRow } from "../rows";
import type { Person } from "../types";
import type { RecentUpdateVM, SearchGroup, SearchResultsProps } from "./types";

/* "Ask the CEO": asking is always the first answer, so it leads whenever
   something is typed; people, threads and tickets that match follow. With
   nothing typed the page shows what the CEO last told you. */

// Same width as an avatar, so a note from LilOS lines up with the rest.
const AVATAR = 34;

/** Stands in for the CEO's avatar while the company has nobody in the seat. */
const NO_CEO: Pick<Person, "name" | "outside"> = {
  name: "CEO",
  outside: false,
};

function heading(title: string, group: SearchGroup<unknown>): string {
  return `${title} · ${group.total}`;
}

/** Said when a group holds more matches than it shows. */
function More({ group }: { group: SearchGroup<unknown> }) {
  if (group.total <= group.rows.length) return null;
  return (
    <Note>
      {`Showing the first ${group.rows.length}. Type more to narrow it.`}
    </Note>
  );
}

function AskRow({
  query,
  ceo,
  onAsk,
}: {
  query: string;
  ceo?: Person;
  onAsk: () => void;
}) {
  return (
    <ListRow
      testID="search-ask-ceo"
      label={`Ask the CEO: ${query}`}
      onPress={onAsk}
    >
      <View className="flex-row items-center gap-3">
        <Avatar person={ceo ?? NO_CEO} size={AVATAR} />
        <T variant="label" numberOfLines={3} className="flex-1">
          {`Ask the CEO: “${query}”`}
        </T>
      </View>
    </ListRow>
  );
}

function PersonRow({
  person,
  onPress,
  last,
}: {
  person: Person;
  onPress: (id: string) => void;
  last: boolean;
}) {
  return (
    <ListRow
      onPress={() => onPress(person.id)}
      last={last}
      label={person.role ? `${person.name}, ${person.role}` : person.name}
    >
      <View className="flex-row items-center gap-3">
        <Avatar person={person} size={AVATAR} />
        <View className="flex-1 gap-0.5">
          <PersonName person={person} />
          {person.role ? (
            <T variant="caption" tone="ink2" numberOfLines={1}>
              {person.role}
            </T>
          ) : null}
        </View>
      </View>
    </ListRow>
  );
}

function RecentRow({
  update,
  onPress,
  last,
}: {
  update: RecentUpdateVM;
  onPress: () => void;
  last: boolean;
}) {
  return (
    <ListRow
      onPress={onPress}
      last={last}
      label={`${update.whoName}, ${update.at}: ${update.text}`}
    >
      <View className="flex-row items-start gap-3">
        {update.who ? (
          <Avatar person={update.who} size={AVATAR} />
        ) : (
          <View style={{ width: AVATAR }} />
        )}
        <View className="flex-1 gap-0.5">
          <View className="flex-row items-baseline gap-2">
            <T variant="label" numberOfLines={1} className="shrink">
              {update.whoName}
            </T>
            <T variant="caption" tone="ink3">
              {update.at}
            </T>
          </View>
          <T variant="small" tone="ink2" numberOfLines={3}>
            {update.text}
          </T>
          {update.ticketTag ? (
            <View className="pt-1">
              <Tag>{update.ticketTag}</Tag>
            </View>
          ) : null}
        </View>
      </View>
    </ListRow>
  );
}

export function SearchResults(props: SearchResultsProps) {
  const { query, people, threads, tickets } = props;

  if (!query) {
    return (
      <Page testID="search-results">
        <Note>
          Ask the CEO anything, or search people, threads and tickets.
        </Note>
        {props.recent.length > 0 ? (
          <SectionBlock title="Recent from the CEO">
            {props.recent.map((u, i) => (
              <RecentRow
                key={u.id}
                update={u}
                onPress={props.onOpenCeoThread}
                last={i === props.recent.length - 1}
              />
            ))}
          </SectionBlock>
        ) : null}
      </Page>
    );
  }

  return (
    <Page testID="search-results">
      <AskRow query={query} ceo={props.ceo} onAsk={props.onAsk} />
      {people.rows.length > 0 ? (
        <SectionBlock title={heading("People", people)}>
          {people.rows.map((p, i) => (
            <PersonRow
              key={p.id}
              person={p}
              onPress={props.onOpenPerson}
              last={i === people.rows.length - 1}
            />
          ))}
          <More group={people} />
        </SectionBlock>
      ) : null}
      {threads.rows.length > 0 ? (
        <SectionBlock title={heading("Threads", threads)}>
          {threads.rows.map((t, i) => (
            <ThreadRow
              key={t.id}
              row={t}
              onPress={props.onOpenThread}
              last={i === threads.rows.length - 1}
            />
          ))}
          <More group={threads} />
        </SectionBlock>
      ) : null}
      {tickets.rows.length > 0 ? (
        <SectionBlock title={heading("Tickets", tickets)}>
          {tickets.rows.map((t, i) => (
            <TicketRow
              key={t.id}
              row={t}
              onPress={props.onOpenTicket}
              last={i === tickets.rows.length - 1}
            />
          ))}
          <More group={tickets} />
        </SectionBlock>
      ) : null}
    </Page>
  );
}
