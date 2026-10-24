import { Pressable, View } from "react-native";
import { Icon } from "../../components/icon";
import { T } from "../kit";

/** A project's name with how much is open, and what it is about. */
export function GroupHead({
  name,
  caption,
  about,
}: {
  name: string;
  caption: string;
  about?: string;
}) {
  return (
    <View className="px-5 pt-7 pb-1.5">
      <View className="flex-row items-baseline justify-between gap-3">
        <T variant="heading" numberOfLines={1} className="flex-1">
          {name}
        </T>
        <T variant="caption" tone="ink3">
          {caption}
        </T>
      </View>
      {about ? (
        <T variant="caption" tone="ink2" numberOfLines={2} className="pt-0.5">
          {about}
        </T>
      ) : null}
    </View>
  );
}

/** The collapsed "N done" line: done work stays out of sight until asked. */
export function DoneToggle({
  groupId,
  count,
  open,
  onPress,
}: {
  groupId: string;
  count: number;
  open: boolean;
  onPress: () => void;
}) {
  const label = `${count} done`;
  return (
    <Pressable
      testID={`work-done-${groupId}`}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ expanded: open }}
      onPress={onPress}
      className="h-11 flex-row items-center gap-1.5 px-5 active:bg-paper-soft"
    >
      <T variant="small" tone="ink3">
        {label}
      </T>
      <Icon
        name={open ? "chevron.down" : "chevron.right"}
        size={11}
        tone="muted-foreground"
        weight="semibold"
      />
    </Pressable>
  );
}
