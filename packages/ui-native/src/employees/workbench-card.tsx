import type { SFSymbol } from "expo-symbols";
import { Pressable, View } from "react-native";
import { AppText } from "../components/app-text";
import { Icon } from "../components/icon";
import type { WbCardTarget } from "./types";

/* The phone's answer to `workbench_open` (#340 AC-2b): the desktop opens
   the Workbench on the target's tab; here a tappable card in the thread
   opens the same thing — the diffs sheet, the PR list, or the URL. */

const LABEL: {
  icon: SFSymbol;
  title: (t: WbCardTarget) => string;
  detail: (t: WbCardTarget) => string | undefined;
} = {
  icon: "rectangle.righthalf.filled",
  title: (t) =>
    "file" in t
      ? `Open ${t.file.split("/").at(-1)}`
      : "diff" in t
        ? "See the changes"
        : "pr" in t
          ? "See the pull request"
          : "Open this page",
  detail: (t) =>
    "file" in t
      ? t.file + (t.line !== undefined ? `:${t.line}` : "")
      : "diff" in t
        ? t.path
        : "url" in t
          ? t.url
          : undefined,
};

export function WorkbenchCard({
  target,
  time,
  onPress,
}: {
  target: WbCardTarget;
  time: string;
  onPress: () => void;
}) {
  return (
    <View className="items-center gap-1">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={LABEL.title(target)}
        onPress={onPress}
        className="max-w-[92%] flex-row items-center gap-2.5 rounded-2xl bg-secondary px-3.5 py-2.5 active:opacity-70"
      >
        <Icon name={LABEL.icon} size={14} tone="primary" />
        <View className="flex-1 gap-0.5">
          <AppText size="sm" weight="medium" numberOfLines={1}>
            {LABEL.title(target)}
          </AppText>
          {!!LABEL.detail(target) && (
            <AppText
              tone="muted"
              size="xs"
              numberOfLines={1}
              className="font-mono"
            >
              {LABEL.detail(target)}
            </AppText>
          )}
        </View>
        <Icon
          name="chevron.right"
          size={11}
          weight="semibold"
          tone="muted-foreground"
        />
      </Pressable>
      <AppText tone="muted" className="text-[11px]">
        {time}
      </AppText>
    </View>
  );
}
