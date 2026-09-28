import type { SFSymbol } from "expo-symbols";
import { useState } from "react";
import { LayoutAnimation, Pressable, Text, View } from "react-native";
import { AppText } from "../components/app-text";
import { Card, CommandLine, Pill } from "../components/bits";
import { Icon } from "../components/icon";
import { Orb, type OrbTone } from "../components/orb";
import { Prose, Pulse } from "../components/prose";
import type { AgentEntry, Approval, ToolStep } from "./types";

/* One conversation turn — the mobile twin of the web AgentTurn/UserTurn
   (packages/ui/src/conversation/turns.tsx): who + time, "Thought for Ns"
   (collapsible reasoning), the turn's tool calls collapsed into one
   "N steps" block (open while live), the reply, the approval card, and a
   quiet footer. Yours are tinted bubbles on the right; the employee's sit
   on the page under its orb, so the two never read alike. */

const ease = () =>
  LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);

export function UserBubble({ text, time }: { text: string; time?: string }) {
  return (
    <View className="items-end gap-1 pl-14">
      <View
        className="rounded-[20px] rounded-br-[6px] bg-primary px-3.5 py-2"
        style={{ borderCurve: "continuous" }}
      >
        <AppText tone="inverse" className="text-[17px] leading-[22px]">
          {text}
        </AppText>
      </View>
      {time && (
        <AppText size="xs" tone="muted" className="pr-1">
          {time.startsWith("Queued") ? time : `You · ${time}`}
        </AppText>
      )}
    </View>
  );
}

export function AgentTurn({
  e,
  name,
  tone,
  onApprove,
  onDeny,
}: {
  e: AgentEntry;
  name: string;
  tone: OrbTone;
  onApprove: (id: string) => void;
  onDeny: (id: string) => void;
}) {
  const steps = e.steps ?? [];
  // Thinking = reasoning is still streaming (no "Thought for" yet).
  const thinking =
    !!e.live && e.reasoning !== undefined && e.thought === undefined;
  const writing = !!e.live && !!e.writing && !e.text?.trim();
  return (
    <View className="gap-2.5">
      <View className="flex-row items-center gap-2">
        <Orb tone={tone} size={20} />
        <AppText weight="semibold" className="text-[15px]">
          {name}
        </AppText>
        <AppText size="xs" tone="muted">
          {e.time}
        </AppText>
      </View>
      {e.reasoning !== undefined && (
        <Reasoning
          text={e.reasoning}
          seconds={e.thought}
          thinking={!!thinking}
        />
      )}
      {steps.length > 0 && (
        <Steps steps={steps} live={!!e.live && !e.writing} />
      )}
      {e.text ? (
        <Prose text={e.text} />
      ) : (
        writing && (
          <Pulse>
            <AppText size="sm" tone="muted" weight="medium">
              Writing…
            </AppText>
          </Pulse>
        )
      )}
      {e.decided && <Receipt d={e.decided} />}
      {e.stopped && (
        <View className="flex-row items-center gap-1.5">
          <View className="size-2.5 rounded-[2px] bg-muted-foreground" />
          <AppText size="xs" tone="muted" weight="medium">
            You stopped this turn
          </AppText>
        </View>
      )}
      {e.approval && (
        <ApprovalCard a={e.approval} onApprove={onApprove} onDeny={onDeny} />
      )}
      {e.footer && !e.live && !e.stopped && <Footer f={e.footer} />}
    </View>
  );
}

function Reasoning({
  text,
  seconds,
  thinking,
}: {
  text: string;
  seconds?: number;
  thinking: boolean;
}) {
  const [open, setOpen] = useState(false);
  const shown = open || thinking;
  return (
    <View className="gap-2">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={thinking ? "Thinking" : `Thought for ${seconds}s`}
        disabled={thinking}
        onPress={() => {
          ease();
          setOpen(!open);
        }}
        hitSlop={6}
        className="flex-row items-center gap-1.5 self-start active:opacity-60"
      >
        {thinking ? (
          <Pulse>
            <AppText size="sm" tone="muted" weight="medium">
              Thinking…
            </AppText>
          </Pulse>
        ) : (
          <AppText size="sm" tone="muted" weight="medium">
            {`Thought for ${seconds || 1}s`}
          </AppText>
        )}
        {!thinking && (
          <Icon
            name={open ? "chevron.down" : "chevron.right"}
            size={10}
            weight="bold"
            tone="muted-foreground"
          />
        )}
      </Pressable>
      {shown && !!text && (
        <View className="border-muted-strong border-l-2 pl-3">
          <AppText
            size="sm"
            tone="muted"
            className="text-[14px] italic leading-[20px]"
          >
            {text}
          </AppText>
        </View>
      )}
    </View>
  );
}

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
const tool = (t: string) =>
  TOOL[t] ?? {
    verb: t,
    now: t,
    icon: "wrench.and.screwdriver" as SFSymbol,
  };

/* All of a turn's tool calls behind one "N steps" row (web: Task block).
   Live turns keep it open so you watch the work land. */
function Steps({ steps, live }: { steps: ToolStep[]; live: boolean }) {
  const [open, setOpen] = useState(false);
  const shown = open || live;
  const running = steps.find((s) => s.running);
  const files = new Set(
    steps.filter((s) => s.add !== undefined).map((s) => s.arg),
  ).size;
  return (
    <View
      className="overflow-hidden rounded-[18px] bg-card"
      style={{ borderCurve: "continuous" }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${steps.length} steps`}
        disabled={live}
        onPress={() => {
          ease();
          setOpen(!open);
        }}
        className="h-11 flex-row items-center gap-2 px-3.5 active:bg-fill"
      >
        {live ? (
          <Pulse>
            <View className="size-2 rounded-full bg-work" />
          </Pulse>
        ) : (
          <Icon name="checkmark" size={11} weight="bold" tone="success" />
        )}
        <AppText size="sm" weight="medium" className="flex-1">
          {running
            ? `Step ${steps.indexOf(running) + 1} · ${tool(running.tool).now}…`
            : live
              ? `${steps.length} ${steps.length === 1 ? "step" : "steps"} · Working…`
              : `${steps.length} ${steps.length === 1 ? "step" : "steps"}`}
          {!live && files > 0 && (
            <AppText size="sm" tone="muted">
              {` · ${files} ${files === 1 ? "file" : "files"}`}
            </AppText>
          )}
        </AppText>
        {!shown && <ToolIcons steps={steps} />}
        {!live && (
          <Icon
            name={shown ? "chevron.up" : "chevron.down"}
            size={11}
            weight="semibold"
            tone="muted-foreground"
          />
        )}
      </Pressable>
      {shown && (
        <View>
          {steps.map((s) => (
            <StepRow key={s.id} s={s} />
          ))}
        </View>
      )}
    </View>
  );
}

function ToolIcons({ steps }: { steps: ToolStep[] }) {
  const kinds = [...new Set(steps.map((s) => s.tool))].slice(0, 4);
  return (
    <View className="flex-row gap-1.5">
      {kinds.map((k) => (
        <Icon key={k} name={tool(k).icon} size={12} tone="muted-foreground" />
      ))}
    </View>
  );
}

function StepRow({ s }: { s: ToolStep }) {
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

export function ApprovalCard({
  a,
  onApprove,
  onDeny,
  flat,
}: {
  a: Approval;
  onApprove: (id: string) => void;
  onDeny: (id: string) => void;
  /** Inside a session card: no second border, no label (the chip says it). */
  flat?: boolean;
}) {
  const Box = flat ? FlatBox : Card;
  return (
    // Its own responder, so a tap on the card never opens the row under it.
    <View onStartShouldSetResponder={() => true}>
      <Box>
        {!flat && (
          <View className="mb-1.5 flex-row items-center gap-1.5">
            <View className="size-1.5 rounded-full bg-primary" />
            <AppText
              size="xs"
              weight="semibold"
              tone="none"
              className="text-accent-text"
            >
              Needs your OK
            </AppText>
          </View>
        )}
        <AppText size="sm" className="leading-5">
          {a.reason}
        </AppText>
        {a.command && (
          <View className="mt-2.5">
            <CommandLine command={a.command} />
          </View>
        )}
        {a.file && (
          <View className="mt-2.5 flex-row items-center gap-2.5 rounded-xl bg-background px-3 py-2.5">
            <Icon name="doc.text" size={15} tone="subtle-foreground" />
            <View className="flex-1">
              <Text className="font-mono text-[13px] text-foreground">
                {a.file.name}
              </Text>
              <AppText size="xs" tone="muted">
                {a.file.detail}
              </AppText>
            </View>
          </View>
        )}
        <View className="mt-3 flex-row gap-2">
          <Pill label="Approve" onPress={() => onApprove(a.id)} />
          <Pill label="Deny" variant="soft" onPress={() => onDeny(a.id)} />
        </View>
      </Box>
    </View>
  );
}

function FlatBox({ children }: { children: React.ReactNode }) {
  return <View className="px-3.5 pt-3 pb-3.5">{children}</View>;
}

/** 412 → "6m 52s", 34 → "34s". */
export function duration(s: number) {
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
}

/* Steps and files already sit on the steps row, so the footer only says
   how long and on what. */
function Footer({ f }: { f: NonNullable<AgentEntry["footer"]> }) {
  const bits = [
    f.dur !== undefined && `Worked for ${duration(f.dur)}`,
    f.model,
    f.effort,
  ].filter(Boolean);
  return (
    <AppText size="xs" tone="muted">
      {bits.join(" · ")}
    </AppText>
  );
}

/* After you choose, the ask shrinks to one line so the thread keeps a
   record of what you allowed. */
function Receipt({ d }: { d: NonNullable<AgentEntry["decided"]> }) {
  return (
    <View className="flex-row items-center gap-2 self-start rounded-full bg-fill py-1.5 pr-3 pl-2.5">
      <Icon
        name={d.approved ? "checkmark.circle.fill" : "xmark.circle.fill"}
        size={13}
        tone={d.approved ? "primary" : "muted-foreground"}
      />
      <Text
        numberOfLines={1}
        className="shrink text-[13px] text-subtle-foreground"
      >
        <Text className="font-medium text-foreground">
          {d.approved ? "You approved " : "You denied "}
        </Text>
        <Text className="font-mono text-[12px]">{d.what}</Text>
      </Text>
    </View>
  );
}
