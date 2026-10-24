import { useEffect, useRef } from "react";
import {
  Animated,
  Easing,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import { RING, STATUS_WORD } from "../status";
import type { Status } from "../types";
import { Avatar } from "./base";

/* Who is who at a glance: the initial in its avatar, and a ring round it that
   says what they are doing. A working ring breathes; an idle one is a rule. */

export type RingPerson = {
  id: string;
  name: string;
  status: Status;
  /** The word under the name; the status word when absent. */
  caption?: string;
  isCeo?: boolean;
  /** An always-on bot reached through a connector: a rounded square. */
  outside?: boolean;
};

const WIDTH = 2.5;
const GAP = 2.5;

export function AvatarRing({
  name,
  status,
  size = 44,
  outside = false,
}: {
  name: string;
  status: Status;
  size?: number;
  outside?: boolean;
}) {
  const v = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (status !== "working") return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(v, {
          toValue: 0.35,
          duration: 900,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(v, {
          toValue: 1,
          duration: 900,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [status, v]);
  const outer = size + (WIDTH + GAP) * 2;
  return (
    <View
      style={{ width: outer, height: outer }}
      className="items-center justify-center"
    >
      <Animated.View
        className={`absolute inset-0 ${RING[status]}`}
        style={{
          borderWidth: WIDTH,
          borderRadius: outside ? outer * 0.3 : outer / 2,
          opacity: v,
        }}
      />
      <Avatar person={{ name, outside }} size={size} />
    </View>
  );
}

function Cell({
  person,
  onPress,
  width,
}: {
  person: RingPerson;
  onPress: (id: string) => void;
  width: number | `${number}%`;
}) {
  const word = person.caption ?? STATUS_WORD[person.status];
  return (
    <Pressable
      testID={`person-${person.id}`}
      accessibilityRole="button"
      accessibilityLabel={`${person.name}, ${word}`}
      onPress={() => onPress(person.id)}
      className="items-center gap-0.5 py-1 active:opacity-60"
      style={{ width }}
    >
      <View>
        <AvatarRing
          name={person.name}
          status={person.status}
          outside={person.outside}
          size={36}
        />
        {person.isCeo ? (
          <View className="absolute -bottom-0.5 self-center rounded border border-rule bg-paper px-1">
            <Text className="font-bold text-[8px] text-ink-2 tracking-wider">
              CEO
            </Text>
          </View>
        ) : null}
      </View>
      <Text
        numberOfLines={1}
        className="max-w-full px-1 font-medium text-[13px] text-ink leading-[17px]"
      >
        {person.name}
      </Text>
      <Text numberOfLines={1} className="max-w-full text-[11.5px] text-ink-3">
        {word}
      </Text>
    </Pressable>
  );
}

/** A horizontal strip of people; it bleeds to the edge of the module it sits in. */
export function AvatarStrip({
  people,
  onPress,
}: {
  people: RingPerson[];
  onPress: (id: string) => void;
}) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      className="-mx-4"
      contentContainerClassName="gap-1 px-3"
    >
      {people.map((p) => (
        <Cell key={p.id} person={p} onPress={onPress} width={76} />
      ))}
    </ScrollView>
  );
}

export function AvatarGrid({
  people,
  columns = 4,
  onPress,
}: {
  people: RingPerson[];
  columns?: number;
  onPress: (id: string) => void;
}) {
  const width = `${100 / columns}%` as const;
  return (
    <View className="-mx-1 flex-row flex-wrap">
      {people.map((p) => (
        <Cell key={p.id} person={p} onPress={onPress} width={width} />
      ))}
    </View>
  );
}
