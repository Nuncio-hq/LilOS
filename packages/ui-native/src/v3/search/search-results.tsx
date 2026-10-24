import { useState } from "react";
import { Pressable, View } from "react-native";
import { Avatar, CompactRow, Module, Modules, Note, Page, T } from "../kit";
import type { Person } from "../types";
import type { RecentUpdateVM, SearchGroup, SearchResultsProps } from "./types";

/* "Ask the CEO": asking is always the first answer, so it leads whenever
   something is typed; people, threads and tickets that match follow, three
   to a module with the rest behind "n more". With nothing typed the page
   shows what the CEO last told you. */

/** Rows a module shows before "n more". */
const SHOWN = 3;

/** Stands in for the CEO's avatar while the company has nobody in the seat. */
const NO_CEO: Pick<Person, "name" | "outside"> = {
  name: "CEO",
  outside: false,
};

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
    <Pressable
      testID="search-ask-ceo"
      accessibilityRole="button"
      accessibilityLabel={`Ask the CEO: ${query}`}
      onPress={onAsk}
      className="flex-row items-center gap-3 rounded-[22px] bg-paper-soft p-4 active:opacity-60"
      style={{ borderCurve: "continuous" }}
    >
      <Avatar person={ceo ?? NO_CEO} size={34} />
      <T variant="label" numberOfLines={3} className="flex-1">
        {`Ask the CEO: “${query}”`}
      </T>
    </Pressable>
  );
}

/** One result module: the first rows, the rest on "n more". */
function Group<T>({
  title,
  group,
  render,
}: {
  title: string;
  group: SearchGroup<T>;
  render: (row: T) => React.ReactNode;
}) {
  const [all, setAll] = useState(false);
  if (group.rows.length === 0) return null;
  const shown = all ? group.rows : group.rows.slice(0, SHOWN);
  const more = group.total - shown.length;
  return (
    <Module
      title={title}
      count={group.total}
      footer={
        more > 0
          ? { label: `${more} more`, onPress: () => setAll(true) }
          : undefined
      }
    >
      {shown.map(render)}
    </Module>
  );
}

function Recent({
  updates,
  onOpen,
}: {
  updates: RecentUpdateVM[];
  onOpen: () => void;
}) {
  const [all, setAll] = useState(false);
  if (updates.length === 0) return null;
  const shown = all ? updates : updates.slice(0, SHOWN);
  const more = updates.length - shown.length;
  return (
    <Module
      title="Recent from the CEO"
      footer={
        more > 0
          ? { label: `${more} more`, onPress: () => setAll(true) }
          : undefined
      }
    >
      <View className="gap-3">
        {shown.map((u) => (
          <Pressable
            key={u.id}
            accessibilityRole="button"
            accessibilityLabel={`${u.whoName}, ${u.at}: ${u.text}`}
            onPress={onOpen}
            className="flex-row items-start gap-2.5 active:opacity-60"
          >
            {u.who ? (
              <Avatar person={u.who} size={26} />
            ) : (
              <View className="w-[26px]" />
            )}
            <View className="flex-1 gap-0.5">
              <View className="flex-row items-baseline gap-2">
                <T
                  variant="small"
                  numberOfLines={1}
                  className="shrink font-semibold"
                >
                  {u.whoName}
                </T>
                <T variant="caption" tone="ink3">
                  {u.at}
                </T>
                {u.ticketTag ? (
                  <T variant="caption" tone="ink3">
                    {u.ticketTag}
                  </T>
                ) : null}
              </View>
              <T variant="small" tone="ink2" numberOfLines={2}>
                {u.text}
              </T>
            </View>
          </Pressable>
        ))}
      </View>
    </Module>
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
        <Modules>
          <Recent updates={props.recent} onOpen={props.onOpenCeoThread} />
        </Modules>
      </Page>
    );
  }

  return (
    <Page testID="search-results">
      <Modules>
        <AskRow query={query} ceo={props.ceo} onAsk={props.onAsk} />
        <Group
          title="People"
          group={people}
          render={(p) => (
            <CompactRow
              key={p.id}
              title={p.name}
              meta={p.role}
              onPress={() => props.onOpenPerson(p.id)}
            />
          )}
        />
        <Group
          title="Threads"
          group={threads}
          render={(t) => (
            <CompactRow
              key={t.id}
              dot={t.status}
              title={t.title}
              meta={t.agent.name}
              onPress={() => props.onOpenThread(t.id)}
            />
          )}
        />
        <Group
          title="Tickets"
          group={tickets}
          render={(t) => (
            <CompactRow
              key={t.id}
              dot={t.status}
              title={t.title}
              meta={t.id}
              onPress={() => props.onOpenTicket(t.id)}
            />
          )}
        />
      </Modules>
    </Page>
  );
}
