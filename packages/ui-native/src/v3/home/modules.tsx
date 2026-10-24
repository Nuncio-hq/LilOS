import { View } from "react-native";
import type { RingPerson } from "../kit";
import { Avatar, AvatarStrip, Module, PersonName, T } from "../kit";
import type { HomeUpdate } from "./types";

/* Home's other modules: the latest update and the team. */

export function UpdateModule({
  update,
  onOpen,
}: {
  update: HomeUpdate;
  onOpen?: () => void;
}) {
  return (
    <Module
      title="Latest update"
      onOpen={onOpen}
      openWhole
      accessibilityLabel={`Latest update. ${update.by.name}, ${update.at}: ${update.text}`}
      testID="module-update"
    >
      <View className="gap-2">
        <View className="flex-row items-center gap-2">
          <Avatar person={update.by} size={24} />
          <PersonName person={update.by} variant="small" />
          <View className="flex-1" />
          <T variant="caption" tone="ink3">
            {update.at}
          </T>
        </View>
        <T variant="small" numberOfLines={2}>
          {update.text}
        </T>
      </View>
    </Module>
  );
}

export function TeamModule({
  people,
  onOpen,
  onOpenAgent,
}: {
  people: RingPerson[];
  onOpen: () => void;
  onOpenAgent: (id: string) => void;
}) {
  return (
    <Module title="Team" count={people.length} onOpen={onOpen}>
      <AvatarStrip people={people} onPress={onOpenAgent} />
    </Module>
  );
}
