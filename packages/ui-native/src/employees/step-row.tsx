import type { SFSymbol } from "expo-symbols";
import { useState } from "react";
import { LayoutAnimation, Pressable, Text, View } from "react-native";
import { Icon } from "../components/icon";
import { Pulse } from "../components/prose";
import type { ToolStep } from "./types";

/* One tool call as a row (web: StepRow) — verb + argument, tap for its
   output. Shared by a turn's "N steps" block and a subagent's sheet. */

const ease = () =>
  LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);

const TOOL: Record<string, { verb: string; now: string; icon: SFSymbol }> = {
  terminal: { verb: "Ran", now: "Running", icon: "terminal" },
  read_file: { verb: "Read", now: "Reading", icon: "doc.text" },
  write_file: { verb: "Created", now: "Creating", icon: "doc.badge.plus" },
  patch: { verb: "Edited", now: "Editing", icon: "pencil" },
  search_files: {
    verb: "Searched",
    now: "Searching",
    icon: "magnifyingglass",
  },
  web_search: {
    verb: "Searched the web",
    now: "Searching the web",
    icon: "globe",
  },
  view_image: { verb: "Looked at", now: "Looking at", icon: "photo" },
  delegate_task: {
    verb: "Dispatched",
    now: "Dispatching",
    icon: "person.2",
  },
};
export const tool = (t: string) =>
  TOOL[t] ?? {
    verb: t,
    now: t,
    icon: "wrench.and.screwdriver" as SFSymbol,
  };

export function StepRow({
  s,
  waiting,
}: {
  s: ToolStep;
  /** Kind of ask the turn is blocked on (#264): a step still marked running
     is actually gated, so it reads as awaiting you, never "Running". */
  waiting?: "approval" | "plan" | "question";
}) {
  const [open, setOpen] = useState(false);
  const t = tool(s.tool);
  const blocked = !!s.running && waiting !== undefined;
  const verb = blocked
    ? waiting === "approval"
      ? "Waiting for approval"
      : "Waiting for you"
    : s.running
      ? t.now
      : t.verb;
  const canOpen = (!!s.output || !!s.patch) && !s.running;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${verb} ${s.arg ?? ""}`}
      disabled={!canOpen}
      onPress={() => {
        ease();
        setOpen(!open);
      }}
      className="gap-2 px-3.5 py-2.5 active:bg-fill"
    >
      {/* Hairline inset to the text, like an iOS list. */}
      <View className="absolute top-0 right-0 left-[42px] h-[0.5px] bg-border" />
      <View className="flex-row items-center gap-2.5">
        <View className="w-4 items-center">
          <Icon
            name={t.icon}
            size={13}
            tone={blocked ? "primary" : s.running ? "work" : "muted-foreground"}
          />
        </View>
        <Text numberOfLines={1} className="flex-1 text-[14px]">
          <Text className="text-subtle-foreground">{`${verb} `}</Text>
          {s.arg && (
            <Text
              className={`font-mono text-[12.5px] ${s.running && !blocked ? "text-foreground" : "text-subtle-foreground"}`}
            >
              {s.tool === "terminal" ? `$ ${s.arg}` : s.arg}
            </Text>
          )}
        </Text>
        {s.add !== undefined && (
          <Text className="font-mono text-[12px]">
            <Text className="text-success">{`+${s.add}`}</Text>
            {!!s.del && (
              <Text className="text-destructive">{` −${s.del}`}</Text>
            )}
          </Text>
        )}
        {s.running &&
          (blocked ? (
            <View className="size-1.5 rounded-full bg-primary" />
          ) : (
            <Pulse>
              <View className="size-1.5 rounded-full bg-work" />
            </Pulse>
          ))}
      </View>
      {open && <StepDetail s={s} />}
    </Pressable>
  );
}

/* What an opened step shows — the thing itself (web: StepDetail): an edit's
   coloured diff, a command's dark terminal, else what came back. */
function StepDetail({ s }: { s: ToolStep }) {
  if (s.patch)
    return (
      <View className="ml-[26px] overflow-hidden rounded-xl bg-background py-1.5">
        {s.patch.split("\n").map((line, i) => {
          const tone = line.startsWith("@@")
            ? "bg-work-soft text-work"
            : line.startsWith("+")
              ? "bg-success/12 text-success"
              : line.startsWith("-")
                ? "bg-destructive/10 text-destructive"
                : "text-subtle-foreground";
          return (
            <Text
              // biome-ignore lint/suspicious/noArrayIndexKey: diff lines are positional
              key={i}
              numberOfLines={1}
              className={`px-3 font-mono text-[11.5px] leading-[18px] ${tone}`}
            >
              {line || " "}
            </Text>
          );
        })}
      </View>
    );
  if (s.tool === "terminal")
    return (
      <View
        className="ml-[26px] gap-1 rounded-xl bg-[#1c1c20] px-3 py-2.5"
        style={{ borderCurve: "continuous" }}
      >
        <Text className="font-mono text-[12px] leading-[17px] text-[#5fd6ce]">
          {`$ ${s.arg ?? ""}`}
        </Text>
        {!!s.output && (
          <Text className="font-mono text-[12px] leading-[17px] text-[#e5e5ea]">
            {s.output}
          </Text>
        )}
      </View>
    );
  return (
    <View className="ml-[26px] rounded-xl bg-background px-3 py-2">
      <Text className="text-[13px] leading-[18px] text-subtle-foreground">
        {s.output}
      </Text>
    </View>
  );
}
