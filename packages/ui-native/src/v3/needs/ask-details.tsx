import { Modal, Pressable, ScrollView, View } from "react-native";
import { Icon } from "../../components/icon";
import { T } from "../kit";
import type { AskVM } from "../types";

/* Everything an ask says, behind the card's "Details": the reasons in full,
   what it costs, what happens if you do nothing. A native page sheet. */

function Block({ label, text }: { label: string; text?: string }) {
  if (!text) return null;
  return (
    <View className="gap-1">
      <T variant="caption" tone="ink3" className="font-semibold uppercase">
        {label}
      </T>
      <T variant="body">{text}</T>
    </View>
  );
}

export function AskDetailsSheet({
  ask,
  onClose,
}: {
  /** The ask whose details show; absent: the sheet is closed. */
  ask?: AskVM;
  onClose: () => void;
}) {
  return (
    <Modal
      visible={!!ask}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <View testID="ask-details" className="flex-1 bg-paper">
        <View className="flex-row items-center justify-between px-5 pt-5 pb-2">
          <T variant="heading">Details</T>
          <Pressable
            testID="ask-details-close"
            accessibilityRole="button"
            accessibilityLabel="Close details"
            onPress={onClose}
            hitSlop={10}
            className="size-11 items-center justify-center rounded-full bg-paper-soft active:opacity-60"
          >
            <Icon
              name="xmark"
              size={15}
              weight="semibold"
              tone="muted-foreground"
            />
          </Pressable>
        </View>
        {ask ? (
          <ScrollView contentContainerClassName="gap-5 px-5 pt-2 pb-10">
            <View className="gap-1">
              <T variant="label">{ask.title}</T>
              <T variant="small" tone="ink2">
                {`${ask.from.name} · ${ask.tag} · waiting ${ask.waiting}`}
              </T>
            </View>
            <Block label="What is asked" text={ask.ask} />
            <Block label="Why" text={ask.why} />
            <Block label="If you approve" text={ask.ifYes} />
            <Block label="If you deny" text={ask.ifNo} />
            <Block label="Cost" text={ask.spend} />
            <Block label="If you do nothing" text={ask.fallback} />
          </ScrollView>
        ) : null}
      </View>
    </Modal>
  );
}
