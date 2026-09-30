import { useState } from "react";
import {
  LayoutAnimation,
  Linking,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppText } from "../components/app-text";
import { Pill } from "../components/bits";
import { Glass } from "../components/glass";
import { Icon } from "../components/icon";
import { Pulse } from "../components/prose";
import { Group, SheetHeader } from "./folder-picker";
import type { BackgroundJobRow } from "./types";

/* Background work of a session (issue #170; web: Workbench → Background).
   The phone has no Workbench, so a small glass pill floats above the
   composer while anything runs, and opens BackgroundSheet: running and
   finished processes, each opening to its output tail, with Stop. */

const DOT: Record<BackgroundJobRow["status"], string> = {
  running: "bg-success",
  exited: "bg-muted-foreground",
  failed: "bg-destructive",
  stopped: "bg-muted-foreground",
};
const LABEL: Record<BackgroundJobRow["status"], string> = {
  running: "Running",
  exited: "Exited",
  failed: "Failed",
  stopped: "Stopped by you",
};

/** "2 running in background" — renders nothing while nothing runs. */
export function BackgroundPill({
  jobs,
  onPress,
}: {
  jobs: BackgroundJobRow[];
  onPress: () => void;
}) {
  const n = jobs.filter((j) => j.status === "running").length;
  if (!n) return null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${n} running in background`}
      onPress={onPress}
      className="self-center active:opacity-70"
    >
      <Glass
        interactive
        className="h-8 flex-row items-center gap-2 px-3.5"
        style={{ borderRadius: 16 }}
      >
        <Pulse>
          <View className="size-2 rounded-full bg-success" />
        </Pulse>
        <AppText size="xs" weight="semibold" className="text-[13px]">
          {`${n} running in background`}
        </AppText>
        <Icon
          name="chevron.up"
          size={10}
          weight="bold"
          tone="muted-foreground"
        />
      </Glass>
    </Pressable>
  );
}

function JobRow({
  j,
  first,
  onStop,
}: {
  j: BackgroundJobRow;
  first: boolean;
  onStop?: (id: string) => void;
}) {
  const [open, setOpen] = useState(j.status === "failed");
  const running = j.status === "running";
  const url = j.url;
  return (
    <View>
      {!first && (
        <View className="absolute top-0 right-0 left-[36px] h-[0.5px] bg-border" />
      )}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${j.command}, ${LABEL[j.status]}`}
        onPress={() => {
          LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
          setOpen(!open);
        }}
        className="flex-row items-center gap-3 py-3 pr-4 pl-4 active:bg-fill"
      >
        <View className={`size-2 rounded-full ${DOT[j.status]}`} />
        <View className="flex-1 gap-0.5">
          <Text
            numberOfLines={1}
            className="font-mono text-[13.5px] text-foreground"
          >
            {j.command}
          </Text>
          <Text
            numberOfLines={1}
            className={`text-[12.5px] ${j.status === "failed" ? "text-destructive" : "text-subtle-foreground"}`}
          >
            {[
              `${LABEL[j.status]}${j.exitCode !== undefined ? ` (exit ${j.exitCode})` : ""}`,
              running ? `up ${j.uptime}` : `ran ${j.uptime}`,
              j.by,
            ]
              .filter(Boolean)
              .join(" · ")}
          </Text>
        </View>
        <Icon
          name={open ? "chevron.up" : "chevron.down"}
          size={11}
          weight="semibold"
          tone="muted-foreground"
        />
      </Pressable>
      {open && (
        <View className="gap-2.5 px-4 pb-3.5">
          <View className="rounded-xl bg-background px-3 py-2.5">
            <Text className="font-mono text-[11.5px] leading-[16px] text-subtle-foreground">
              {stripAnsi(j.log) || "No output yet."}
            </Text>
          </View>
          {running && (
            <View className="flex-row gap-2">
              {/* A `sa:` row is a subagent, not a process — jobs.stop
                  can't kill it (web hides the pill the same way). */}
              {onStop && !j.subagent && (
                <Pill
                  label="Stop"
                  size="sm"
                  variant="soft"
                  onPress={() => onStop(j.id)}
                />
              )}
              {url && (
                <Pill
                  label={url.replace(/^https?:\/\//, "")}
                  size="sm"
                  variant="ghost"
                  onPress={() => void Linking.openURL(url)}
                />
              )}
            </View>
          )}
        </View>
      )}
    </View>
  );
}

export function BackgroundSheet({
  jobs,
  onStop,
  onDone,
}: {
  jobs: BackgroundJobRow[];
  /** Absent = no Stop button. */
  onStop?: (id: string) => void;
  onDone: () => void;
}) {
  const insets = useSafeAreaInsets();
  const running = jobs.filter((j) => j.status === "running");
  const ended = jobs.filter((j) => j.status !== "running");
  return (
    <ScrollView
      contentContainerStyle={{
        paddingHorizontal: 16,
        paddingBottom: Math.max(insets.bottom, 16) + 12,
        gap: 22,
      }}
    >
      <View className="-mx-4">
        <SheetHeader title="Background" onDone={onDone} />
      </View>
      {!jobs.length && (
        <AppText tone="muted" className="text-center">
          Nothing running in the background.
        </AppText>
      )}
      {[
        { title: `Running · ${running.length}`, rows: running },
        { title: `Finished · ${ended.length}`, rows: ended },
      ].map(
        (g) =>
          g.rows.length > 0 && (
            <Group key={g.title} title={g.title}>
              {g.rows.map((j, i) => (
                <JobRow key={j.id} j={j} first={i === 0} onStop={onStop} />
              ))}
            </Group>
          ),
      )}
    </ScrollView>
  );
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
