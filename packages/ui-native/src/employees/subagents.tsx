import type { SFSymbol } from "expo-symbols";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppText } from "../components/app-text";
import { Card, Pill } from "../components/bits";
import { Icon, type IconTone } from "../components/icon";
import { Orb } from "../components/orb";
import { Prose, Pulse } from "../components/prose";
import { Rise } from "../components/rise";
import { Group, SheetHeader } from "./folder-picker";
import { StepRow } from "./step-row";
import type { SubagentRow } from "./types";

/* The helpers a turn spun off (issue #170; web: TurnSubagents). In the turn:
   one card, a row per helper — who, what it's doing now or how it ended,
   how long. Tapping a row opens SubagentSheet: its brief, steps and report;
   an employee helper worked in their own thread, so the sheet links there. */

const STATUS: Record<
  SubagentRow["status"],
  { icon: SFSymbol; tone: IconTone; label: string }
> = {
  running: { icon: "circle.dotted.circle", tone: "work", label: "Working" },
  done: { icon: "checkmark.circle.fill", tone: "success", label: "Done" },
  failed: { icon: "xmark.circle.fill", tone: "destructive", label: "Failed" },
  stopped: {
    icon: "stop.circle.fill",
    tone: "muted-foreground",
    label: "Stopped",
  },
};

const VERB: Record<string, string> = {
  terminal: "Running",
  read_file: "Reading",
  write_file: "Creating",
  patch: "Editing",
  search_files: "Searching",
  web_search: "Searching the web",
};

/** The row's second line: the live step, else the report's first line. */
function nowLine(a: SubagentRow): string {
  if (a.status === "running") {
    if (a.employee) return "Working in their own thread…";
    const s = a.steps.find((x) => x.running) ?? a.steps[a.steps.length - 1];
    if (!s) return "Starting…";
    return `${VERB[s.tool] ?? s.tool} ${s.arg ?? ""}`.trim();
  }
  const first = (a.result ?? "").split("\n").find((l) => l.trim()) ?? "";
  return first.replace(/[*`_#>]/g, "").trim() || STATUS[a.status].label;
}

function Mark({ a, size = 18 }: { a: SubagentRow; size?: number }) {
  if (a.employee) return <Orb tone={a.employee.tone} size={size} />;
  const s = STATUS[a.status];
  const icon = <Icon name={s.icon} size={size - 3} tone={s.tone} />;
  return a.status === "running" ? <Pulse>{icon}</Pulse> : icon;
}

export function SubagentsCard({
  agents,
  onOpen,
}: {
  agents: SubagentRow[];
  onOpen?: (a: SubagentRow) => void;
}) {
  const running = agents.filter((a) => a.status === "running").length;
  const n = `${agents.length} ${agents.length === 1 ? "subagent" : "subagents"}`;
  return (
    <View
      className="overflow-hidden rounded-[18px] bg-card"
      style={{ borderCurve: "continuous" }}
    >
      <View className="h-11 flex-row items-center gap-2 px-3.5">
        {running ? (
          <Pulse>
            <View className="size-2 rounded-full bg-work" />
          </Pulse>
        ) : (
          <Icon name="checkmark" size={11} weight="bold" tone="success" />
        )}
        <AppText size="sm" weight="medium" className="flex-1">
          {running ? `${running} of ${n} working` : n}
        </AppText>
        <Icon
          name="point.3.connected.trianglepath.dotted"
          size={13}
          tone="muted-foreground"
        />
      </View>
      {agents.map((a, i) => (
        <Rise key={a.id} delay={i * 60}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${a.employee ? `${a.employee.name}, ` : ""}${a.name}, ${STATUS[a.status].label}`}
            disabled={!onOpen}
            onPress={() => onOpen?.(a)}
            className="flex-row items-center gap-2.5 px-3.5 py-2.5 active:bg-fill"
          >
            <View className="absolute top-0 right-0 left-[42px] h-[0.5px] bg-border" />
            <View className="w-4 items-center">
              <Mark a={a} size={16} />
            </View>
            <View className="flex-1 gap-0.5">
              <Text numberOfLines={1} className="text-[14px] text-foreground">
                {a.employee ? (
                  <Text className="font-semibold">{`${a.employee.name} · `}</Text>
                ) : null}
                {a.name}
              </Text>
              <Text
                numberOfLines={1}
                className={`text-[12.5px] ${a.status === "failed" ? "text-destructive" : "text-subtle-foreground"} ${a.status === "running" && !a.employee ? "font-mono" : ""}`}
              >
                {nowLine(a)}
              </Text>
            </View>
            {a.dur !== undefined && (
              <AppText size="xs" tone="muted" className="font-mono">
                {`${a.dur}s`}
              </AppText>
            )}
            {onOpen && (
              <Icon
                name="chevron.right"
                size={11}
                weight="semibold"
                tone="muted-foreground"
              />
            )}
          </Pressable>
        </Rise>
      ))}
    </View>
  );
}

export function SubagentSheet({
  a,
  onDone,
  onOpenThread,
}: {
  a: SubagentRow;
  onDone: () => void;
  /** Employee helpers only: jump to their thread. Absent = no button. */
  onOpenThread?: (threadId: string) => void;
}) {
  const insets = useSafeAreaInsets();
  const s = STATUS[a.status];
  const helper = a.employee;
  const thread = helper?.threadId;
  return (
    <ScrollView
      contentContainerStyle={{
        paddingHorizontal: 16,
        paddingBottom: Math.max(insets.bottom, 16) + 12,
        gap: 20,
      }}
    >
      <View className="-mx-4">
        <SheetHeader
          title={a.employee ? a.employee.name : "Subagent"}
          onDone={onDone}
        />
      </View>
      <View className="items-center gap-2">
        {a.employee ? (
          <Orb tone={a.employee.tone} size={48} />
        ) : (
          <Icon
            name="point.3.connected.trianglepath.dotted"
            size={34}
            tone="subtle-foreground"
          />
        )}
        <AppText
          weight="semibold"
          className="px-6 text-center text-[20px] leading-6"
        >
          {a.name}
        </AppText>
        <View className="flex-row items-center gap-1.5">
          <Icon name={s.icon} size={13} tone={s.tone} weight="semibold" />
          <AppText
            size="xs"
            tone="muted"
            weight="semibold"
            className="text-[13px]"
          >
            {a.dur !== undefined ? `${s.label} · ${a.dur}s` : s.label}
          </AppText>
        </View>
      </View>

      <Group title="Brief">
        <View className="px-4 py-3">
          <AppText className="text-[15px] leading-[21px]">{a.task}</AppText>
        </View>
      </Group>

      {a.steps.length > 0 && (
        <Group
          title={`${a.steps.length} ${a.steps.length === 1 ? "step" : "steps"}`}
        >
          {a.steps.map((st) => (
            <StepRow key={st.id} s={st} />
          ))}
        </Group>
      )}

      {a.result && (
        <View className="gap-1.5">
          <AppText size="xs" tone="muted" weight="semibold" className="px-2">
            {a.status === "failed" ? "Why it stopped" : "Report"}
          </AppText>
          <Card>
            <Prose text={a.result} size="sm" />
          </Card>
        </View>
      )}

      {helper && thread && onOpenThread && (
        <View className="items-center">
          <Pill
            label={`Open ${helper.name}'s thread`}
            variant="soft"
            onPress={() => onOpenThread(thread)}
          />
        </View>
      )}
    </ScrollView>
  );
}
