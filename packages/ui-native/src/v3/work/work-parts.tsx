import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { Icon } from "../../components/icon";
import { Avatar, CompactRow, StatusLabel, T } from "../kit";
import type { Person, Status } from "../types";
import type { WorkItemVM } from "./work-types";

/** One line of open work: status dot, title, who holds it. `showWhere` adds
    the project, for the lists that mix projects. */
export function WorkItemRow({
  item,
  showWhere,
  onPress,
}: {
  item: WorkItemVM;
  showWhere?: boolean;
  onPress: (item: WorkItemVM) => void;
}) {
  return (
    <CompactRow
      testID={`work-item-${item.key}`}
      dot={item.status}
      title={item.title}
      meta={showWhere ? item.where : undefined}
      trailing={<Avatar person={item.who} size={22} />}
      onPress={() => onPress(item)}
    />
  );
}

/** A thread or a ticket on a project's page: who, what, its state, and the
    one line that says why. Roomier than a module line, still no box. */
export function ProjectRow({
  who,
  title,
  status,
  statusWord,
  where,
  detail,
  unseen,
  label,
  testID,
  onPress,
}: {
  who: Person;
  title: string;
  status: Status;
  statusWord: string;
  /** Ticket id, project or "Chat"; absent when the page already says it. */
  where?: string;
  detail: string;
  unseen?: boolean;
  label: string;
  testID: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      className="flex-row items-start gap-3 py-2 active:opacity-60"
    >
      <Avatar person={who} size={30} />
      <View className="flex-1 gap-0.5">
        <View className="flex-row items-center gap-2">
          <T variant="small" numberOfLines={2} className="flex-1 font-semibold">
            {title}
          </T>
          {unseen ? <View className="size-2 rounded-full bg-st-done" /> : null}
        </View>
        <View className="flex-row items-center gap-1.5">
          {/* Done work sits in the Done module: its word would only repeat. */}
          {status === "done" ? null : (
            <StatusLabel status={status} label={statusWord} />
          )}
          {where ? (
            <T
              variant="caption"
              tone="ink3"
              numberOfLines={1}
              className="flex-1"
            >
              {status === "done" ? where : `· ${where}`}
            </T>
          ) : null}
        </View>
        <T variant="caption" tone="ink3" numberOfLines={1}>
          {detail}
        </T>
      </View>
    </Pressable>
  );
}

/** A module that stays shut until you open it: the finished work, so it
    never competes with the open work. */
export function FoldModule({
  title,
  count,
  open,
  onToggle,
  children,
  testID,
}: {
  title: string;
  count: number;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
  testID: string;
}) {
  return (
    <View
      testID={testID}
      className="overflow-hidden rounded-[22px] bg-paper-soft"
      style={{ borderCurve: "continuous" }}
    >
      <Pressable
        testID={`${testID}-header`}
        accessibilityRole="button"
        accessibilityLabel={`${title}, ${count}`}
        accessibilityState={{ expanded: open }}
        onPress={onToggle}
        className="min-h-12 flex-row items-center gap-2 px-4 active:opacity-60"
      >
        <Text
          accessibilityRole="header"
          className="shrink font-semibold text-[18px] text-ink leading-[24px]"
          style={{ fontFamily: "Charter" }}
          numberOfLines={1}
        >
          {title}
        </Text>
        <T variant="small" tone="ink3" className="font-medium">
          {String(count)}
        </T>
        <View className="flex-1" />
        <Icon
          name={open ? "chevron.down" : "chevron.right"}
          size={13}
          tone="muted-foreground"
          weight="semibold"
        />
      </Pressable>
      {open ? <View className="gap-1 px-4 pb-3">{children}</View> : null}
    </View>
  );
}
