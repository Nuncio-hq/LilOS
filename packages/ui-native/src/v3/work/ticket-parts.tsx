/* biome-ignore-all lint/suspicious/noArrayIndexKey: steps are a fixed ordered checklist; two steps can share a text. */
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { Icon } from "../../components/icon";
import { Avatar, Module, PersonName, StatusLabel, T, Tag } from "../kit";
import { DecisionButtons } from "../rows";
import type { AskVM } from "../types";
import type { TicketPageVM, TicketStepVM } from "./ticket-types";

const SERIF = { fontFamily: "Charter" } as const;

/** The ticket in one card: its state, its title, who holds it, where it
    lives. The owner opens their page. */
export function TicketHeader({
  page,
  onOpenOwner,
}: {
  page: TicketPageVM;
  onOpenOwner: (agentId: string) => void;
}) {
  const { owner } = page;
  return (
    <View
      testID="ticket-header"
      className="gap-3 rounded-[22px] bg-paper-soft p-4"
      style={{ borderCurve: "continuous" }}
    >
      <StatusLabel status={page.status} label={page.statusLine} />
      <Text
        accessibilityRole="header"
        className="font-semibold text-[24px] text-ink leading-[30px]"
        style={SERIF}
        numberOfLines={3}
      >
        {page.title}
      </Text>
      {page.note ? (
        <T variant="small" tone="ink2" numberOfLines={2}>
          {page.note}
        </T>
      ) : null}
      <Pressable
        testID="ticket-owner"
        accessibilityRole="button"
        accessibilityLabel={`Owner ${owner.name}`}
        onPress={() => onOpenOwner(owner.id)}
        className="flex-row items-center gap-2.5 active:opacity-60"
      >
        <Avatar person={owner} size={30} />
        <View className="shrink gap-px">
          <PersonName person={owner} variant="small" />
          {owner.role ? (
            <T variant="caption" tone="ink3" numberOfLines={1}>
              {owner.role}
            </T>
          ) : null}
        </View>
        <View className="flex-1" />
        <Icon
          name="chevron.right"
          size={12}
          tone="muted-foreground"
          weight="semibold"
        />
      </Pressable>
      {page.chips.length > 0 ? (
        <View className="flex-row flex-wrap gap-1.5">
          {page.chips.map((c) => (
            <Tag key={c}>{c}</Tag>
          ))}
        </View>
      ) : null}
    </View>
  );
}

/** The ask this ticket waits on, decided right here. What it costs and what
    happens otherwise sit behind one "Why and cost" line. */
export function DecisionModule({
  ask,
  onApprove,
  onDeny,
  onAnswer,
}: {
  ask: AskVM;
  onApprove: (askId: string) => void;
  onDeny: (askId: string) => void;
  onAnswer: (askId: string, option: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const more = [ask.why, ask.spend, ask.fallback].filter(
    (s): s is string => !!s,
  );
  return (
    <Module title="Decision" testID="ticket-decision">
      <T variant="small" className="font-semibold">
        {ask.title}
      </T>
      <T variant="small" tone="ink2" numberOfLines={3}>
        {ask.ask}
      </T>
      {more.length > 0 ? (
        <Pressable
          testID="ticket-decision-more"
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          onPress={() => setOpen((o) => !o)}
          className="flex-row items-center gap-1 self-start py-1 active:opacity-60"
        >
          <T variant="small" tone="ink2" className="font-semibold">
            Why and cost
          </T>
          <Icon
            name={open ? "chevron.down" : "chevron.right"}
            size={11}
            tone="muted-foreground"
            weight="semibold"
          />
        </Pressable>
      ) : null}
      {open
        ? more.map((line) => (
            <T key={line} variant="caption" tone="ink2">
              {line}
            </T>
          ))
        : null}
      <View className="pt-2">
        {ask.kind === "question" && ask.options ? (
          <View className="gap-2">
            {ask.options.map((o, i) => (
              <Pressable
                key={o}
                testID={`ticket-answer-${i}`}
                accessibilityRole="button"
                accessibilityLabel={o}
                onPress={() => onAnswer(ask.id, o)}
                className={`h-11 items-center justify-center rounded-full active:opacity-70 ${i === 0 ? "bg-ink" : "bg-paper"}`}
              >
                <Text
                  className={`font-semibold text-[16px] ${i === 0 ? "text-paper" : "text-ink"}`}
                >
                  {o}
                </Text>
              </Pressable>
            ))}
          </View>
        ) : (
          <DecisionButtons
            onSoft
            testIDPrefix="ticket-ask"
            onApprove={() => onApprove(ask.id)}
            onDeny={() => onDeny(ask.id)}
          />
        )}
      </View>
    </Module>
  );
}

const MARK: Record<
  TicketStepVM["state"],
  "checkmark.circle.fill" | "circle.inset.filled" | "circle"
> = {
  done: "checkmark.circle.fill",
  current: "circle.inset.filled",
  todo: "circle",
};

function StepRow({ step }: { step: TicketStepVM }) {
  const current = step.state === "current";
  return (
    <View className="flex-row items-start gap-2.5 py-1">
      <View className="pt-px">
        <Icon
          name={MARK[step.state]}
          size={18}
          tone={step.state === "todo" ? "muted-foreground" : "foreground"}
        />
      </View>
      <View className="flex-1">
        <T
          variant="small"
          tone={step.state === "todo" ? "ink2" : "ink"}
          className={current ? "font-semibold" : ""}
          numberOfLines={2}
        >
          {step.text}
        </T>
        {current ? (
          <T variant="caption" tone="ink3">
            {step.took ? `${step.who} · ${step.took}` : step.who}
          </T>
        ) : null}
      </View>
      {step.state === "done" && step.took ? (
        <T variant="caption" tone="ink3">
          {step.took}
        </T>
      ) : null}
    </View>
  );
}

export function ProgressModule({ steps }: { steps: TicketStepVM[] }) {
  const done = steps.filter((s) => s.state === "done").length;
  return (
    <Module title="Progress" testID="ticket-progress">
      <T variant="caption" tone="ink2">
        {`${done} of ${steps.length} done`}
      </T>
      {steps.map((s, i) => (
        <StepRow key={`${i}-${s.text}`} step={s} />
      ))}
    </Module>
  );
}
