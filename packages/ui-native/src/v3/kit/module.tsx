import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { Icon } from "../../components/icon";
import { T } from "./base";

/* The unit every overview is built from: a rounded card on the paper with a
   title, its top few items, and a footer that opens the rest. Colour stays on
   status; the card itself is the quiet paper-soft surface (no border, no
   shadow), and nothing inside it draws hairlines. */

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-");

export function Module({
  title,
  count,
  onOpen,
  openWhole = false,
  footer,
  accessibilityLabel,
  children,
  testID,
}: {
  title: string;
  /** A number beside the title ("Goals 3"); the header is the title, not the count. */
  count?: number;
  /** Tapping the header opens the full view. Absent: the header is only a title. */
  onOpen?: () => void;
  /** The whole card is the one control that opens it (a note, an update),
      not just its header: nothing inside may be pressable. */
  openWhole?: boolean;
  /** "2 more": a row under the content that opens what the card does not show. */
  footer?: { label: string; onPress: () => void };
  /** What a screen reader says for a whole-card control. */
  accessibilityLabel?: string;
  children: ReactNode;
  testID?: string;
}) {
  const id = testID ?? `module-${slug(title)}`;
  const header = (
    <View className="min-h-10 flex-row items-center gap-2 px-4 pt-0.5">
      <Text
        accessibilityRole="header"
        className="shrink text-[18px] font-semibold text-ink leading-[24px]"
        style={{ fontFamily: "Charter" }}
        numberOfLines={1}
      >
        {title}
      </Text>
      {count !== undefined ? (
        <T variant="small" tone="ink3" className="font-medium">
          {String(count)}
        </T>
      ) : null}
      <View className="flex-1" />
      {onOpen ? (
        <Icon
          name="chevron.right"
          size={13}
          tone="muted-foreground"
          weight="semibold"
        />
      ) : null}
    </View>
  );
  const card = (
    <>
      {onOpen && !openWhole ? (
        <Pressable
          testID={`${id}-header`}
          accessibilityRole="button"
          accessibilityLabel={
            count === undefined ? title : `${title}, ${count}`
          }
          onPress={onOpen}
          className="active:opacity-60"
        >
          {header}
        </Pressable>
      ) : (
        header
      )}
      <View className="gap-1 px-4 pb-3.5">{children}</View>
      {footer ? (
        <Pressable
          testID={`${id}-footer`}
          accessibilityRole="button"
          accessibilityLabel={footer.label}
          onPress={footer.onPress}
          className="-mt-1.5 min-h-11 flex-row items-center gap-1 px-4 pb-1 active:opacity-60"
        >
          <T variant="small" tone="ink2" className="font-semibold">
            {footer.label}
          </T>
          <Icon
            name="chevron.right"
            size={11}
            tone="muted-foreground"
            weight="semibold"
          />
        </Pressable>
      ) : null}
    </>
  );
  return (
    <View
      testID={id}
      className="overflow-hidden rounded-[22px] bg-paper-soft"
      style={{ borderCurve: "continuous" }}
    >
      {onOpen && openWhole ? (
        <Pressable
          testID={`${id}-open`}
          accessibilityRole="button"
          accessibilityLabel={accessibilityLabel ?? title}
          onPress={onOpen}
          className="active:opacity-60"
        >
          {card}
        </Pressable>
      ) : (
        card
      )}
    </View>
  );
}

/** The gap between modules on a page. */
export function Modules({ children }: { children: ReactNode }) {
  return <View className="gap-2.5 px-4 pt-1 pb-6">{children}</View>;
}
