import { Pressable, Text, View } from "react-native";
import { Avatar, PersonName, StatusLabel, T } from "../kit";
import { DecisionButtons, ListRow } from "../rows";
import { INK } from "../status";
import type { AskVM } from "../types";
import type {
  HomeCountKey,
  HomeCounts,
  HomeTeamRow,
  HomeUpdate,
} from "./types";

/* The pieces Home is built from. Each one is a single tap target or a list
   row; the page puts hairlines between them. */

/** The CEO's latest word. The whole block opens the thread it came from. */
export function UpdateBlock({
  update,
  onPress,
}: {
  update: HomeUpdate;
  onPress: () => void;
}) {
  return (
    <Pressable
      testID="home-update"
      accessibilityRole="button"
      accessibilityLabel={`${update.by.name}${update.by.isCeo ? ", CEO" : ""}, ${update.at}: ${update.text}`}
      onPress={onPress}
      className="border-rule border-b px-5 py-3 active:bg-paper-soft"
    >
      <View className="flex-row items-center gap-3">
        <Avatar person={update.by} size={36} />
        <View className="flex-1 flex-row items-center justify-between gap-2">
          <View className="shrink">
            <PersonName person={update.by} />
          </View>
          <T variant="caption" tone="ink3">
            {update.at}
          </T>
        </View>
      </View>
      <T variant="body" numberOfLines={6} className="mt-2">
        {update.text}
      </T>
    </Pressable>
  );
}

const COUNT_WORD: Record<HomeCountKey, string> = {
  working: "working",
  needs: "needs you",
  stuck: "stuck",
};

const COUNT_KEYS: HomeCountKey[] = ["working", "needs", "stuck"];

/** Working / needs you / stuck: a quiet number over its word. The number
    takes its status ink only when there is something to see. */
export function CountStrip({
  counts,
  onOpen,
}: {
  counts: HomeCounts;
  onOpen: (key: HomeCountKey) => void;
}) {
  return (
    <View className="mt-3 flex-row border-rule border-y">
      {COUNT_KEYS.map((key, i) => {
        const n = counts[key];
        return (
          <Pressable
            key={key}
            testID={`home-count-${key}`}
            accessibilityRole="button"
            accessibilityLabel={`${n} ${COUNT_WORD[key]}`}
            onPress={() => onOpen(key)}
            className={`flex-1 py-3 active:bg-paper-soft ${
              i === 0 ? "pl-5" : "border-rule border-l pl-4"
            }`}
          >
            <Text
              className={`font-semibold text-[30px] leading-[34px] ${
                n > 0 ? INK[key] : "text-ink-3"
              }`}
            >
              {n}
            </Text>
            <T variant="caption" tone="ink2">
              {COUNT_WORD[key]}
            </T>
          </Pressable>
        );
      })}
    </View>
  );
}

/** One ask waiting on you. An approval is decided right here; a question or
    a plan needs more than a tap, so its row says what it takes and opens it
    in Needs. */
export function AskRow({
  ask,
  last,
  onOpen,
  onApprove,
  onDeny,
}: {
  ask: AskVM;
  last?: boolean;
  onOpen: (id: string) => void;
  onApprove: (id: string) => void;
  onDeny: (id: string) => void;
}) {
  const decide = ask.kind === "approval";
  return (
    <View
      className={`px-5 py-3 ${last ? "" : "border-rule border-b"}`}
      testID={`home-ask-${ask.id}`}
    >
      <Pressable
        testID={`home-ask-${ask.id}-open`}
        accessibilityRole="button"
        accessibilityLabel={`${ask.title}, ${ask.from.name}`}
        onPress={() => onOpen(ask.id)}
        className="active:opacity-60"
      >
        <View className="flex-row items-start justify-between gap-3">
          <T variant="label" numberOfLines={2} className="flex-1">
            {ask.title}
          </T>
          {decide ? null : (
            <T variant="small" tone="ink2" className="font-semibold">
              {ask.kind === "plan" ? "Review" : "Answer"}
            </T>
          )}
        </View>
        <T variant="caption" tone="ink2" numberOfLines={1}>
          {`${ask.from.name} · ${ask.tag} · waiting ${ask.waiting}`}
        </T>
      </Pressable>
      {decide ? (
        <View className="mt-2.5">
          <DecisionButtons
            size="sm"
            testIDPrefix={`home-ask-${ask.id}`}
            onApprove={() => onApprove(ask.id)}
            onDeny={() => onDeny(ask.id)}
          />
        </View>
      ) : null}
    </View>
  );
}

/** One person: who, their state, what they are on and for how long. Each
    fact once; the role is the one line that never changes. */
export function TeamRow({
  row,
  last,
  onPress,
}: {
  row: HomeTeamRow;
  last?: boolean;
  onPress: (id: string) => void;
}) {
  const { person } = row;
  return (
    <ListRow
      testID={`home-agent-${person.id}`}
      last={last}
      onPress={() => onPress(person.id)}
      label={`${person.name}, ${person.role}, ${row.statusWord}`}
    >
      <View className="flex-row items-start gap-3">
        <Avatar person={person} size={36} />
        <View className="flex-1 gap-0.5">
          <View className="flex-row items-center justify-between gap-2">
            <View className="shrink">
              <PersonName person={person} />
            </View>
            <StatusLabel status={row.dot} label={row.statusWord} />
          </View>
          {person.role ? (
            <T variant="caption" tone="ink2" numberOfLines={1}>
              {person.role}
            </T>
          ) : null}
          {row.on ? (
            <View className="flex-row items-center gap-2">
              <T
                variant="caption"
                tone="ink2"
                numberOfLines={1}
                className="flex-1"
              >
                {row.on}
              </T>
              {row.since ? (
                <T variant="caption" tone="ink3">
                  {row.since}
                </T>
              ) : null}
            </View>
          ) : null}
          {row.next ? (
            <T variant="caption" tone="ink2" numberOfLines={1}>
              {row.next}
            </T>
          ) : null}
        </View>
      </View>
    </ListRow>
  );
}
