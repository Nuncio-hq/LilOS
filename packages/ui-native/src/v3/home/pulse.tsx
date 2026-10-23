import { Pressable, View } from "react-native";
import { Avatar, StatusDot, T } from "../kit";
import type { Person, Status } from "../types";

/* The company pulse, as the tab bar's bottom accessory (the Music mini-player
   slot): the CEO's state and what is moving. The system draws the glass, so
   the content sits on a transparent background. The accessory is rendered
   twice — `regular` above the bar, `inline` beside the minimized bar. */
export function Pulse({
  placement,
  person,
  state,
  stateWord,
  detail,
  onPress,
}: {
  placement: "regular" | "inline";
  /** The CEO. */
  person: Person;
  /** The CEO's own state, ignoring `needs` (that is on you). */
  state: Status;
  /** The state as a lower-case word: "working". */
  stateWord: string;
  /** "3 tickets moving" / "no tickets moving". */
  detail: string;
  onPress: () => void;
}) {
  const label =
    placement === "inline"
      ? `Company pulse: ${person.name} · ${stateWord}`
      : `Company pulse: ${person.name} · ${stateWord} · ${detail}`;
  if (placement === "inline")
    return (
      <Pressable
        testID="pulse-inline"
        accessibilityRole="button"
        accessibilityLabel={label}
        onPress={onPress}
        className="flex-1 flex-row items-center gap-2 px-3"
      >
        <Avatar person={person} size={22} />
        <T variant="small" numberOfLines={1} className="flex-1 font-semibold">
          {`${person.name} · ${stateWord}`}
        </T>
      </Pressable>
    );
  return (
    <Pressable
      testID="pulse"
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      className="flex-1 flex-row items-center gap-3 pr-3 pl-3"
    >
      <Avatar person={person} size={30} />
      <View className="min-w-0 flex-1">
        <View className="flex-row items-center gap-1.5">
          <T variant="small" numberOfLines={1} className="shrink font-semibold">
            {`${person.name} · ${stateWord}`}
          </T>
          <StatusDot status={state} size={7} />
        </View>
        <T variant="caption" tone="ink2" numberOfLines={1}>
          {detail}
        </T>
      </View>
    </Pressable>
  );
}
