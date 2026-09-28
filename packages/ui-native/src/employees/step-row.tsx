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
};
export const tool = (t: string) =>
  TOOL[t] ?? {
    verb: t,
    now: t,
    icon: "wrench.and.screwdriver" as SFSymbol,
  };

export function StepRow({ s }: { s: ToolStep }) {
  const [open, setOpen] = useState(false);
  const t = tool(s.tool);
  const canOpen = !!s.output && !s.running;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${t.verb} ${s.arg ?? ""}`}
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
            tone={s.running ? "work" : "muted-foreground"}
          />
        </View>
        <Text numberOfLines={1} className="flex-1 text-[14px]">
          <Text className="text-subtle-foreground">{`${s.running ? t.now : t.verb} `}</Text>
          {s.arg && (
            <Text
              className={`font-mono text-[12.5px] ${s.running ? "text-foreground" : "text-subtle-foreground"}`}
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
        {s.running && (
          <Pulse>
            <View className="size-1.5 rounded-full bg-work" />
          </Pulse>
        )}
      </View>
      {open && s.output && (
        <View className="ml-[26px] rounded-xl bg-background px-3 py-2">
          <Text className="font-mono text-[12px] leading-[17px] text-subtle-foreground">
            {s.output}
          </Text>
        </View>
      )}
    </Pressable>
  );
}
