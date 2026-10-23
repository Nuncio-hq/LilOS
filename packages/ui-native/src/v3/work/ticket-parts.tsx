/* biome-ignore-all lint/suspicious/noArrayIndexKey: steps are a fixed ordered checklist; two steps can share a text. */
import { Pressable, Text, View } from "react-native";
import { Icon } from "../../components/icon";
import { Avatar, PersonName, SectionBlock, T } from "../kit";
import { DecisionButtons } from "../rows";
import type { AskVM, Person } from "../types";
import type {
  TicketFact,
  TicketResultVM,
  TicketStepVM,
  TicketUpdateVM,
} from "./ticket-types";

const ROW = "flex-row items-start gap-3 border-b border-rule px-5 py-2.5";

function FactLabel({ children }: { children: string }) {
  return (
    <T variant="caption" tone="ink3" className="w-[92px] pt-0.5">
      {children}
    </T>
  );
}

/** Owner, then the plain facts. The owner opens their page. */
export function TicketFacts({
  owner,
  facts,
  onOpenOwner,
}: {
  owner: Person;
  facts: TicketFact[];
  onOpenOwner: (agentId: string) => void;
}) {
  return (
    <View className="border-t border-rule">
      <Pressable
        testID="ticket-owner"
        accessibilityRole="button"
        accessibilityLabel={`Owner ${owner.name}`}
        onPress={() => onOpenOwner(owner.id)}
        className={`${ROW} items-center active:bg-paper-soft`}
      >
        <FactLabel>Owner</FactLabel>
        <View className="flex-1 flex-row items-center gap-2.5">
          <Avatar person={owner} size={30} />
          <View className="shrink gap-px">
            <PersonName person={owner} variant="small" />
            {owner.role ? (
              <T variant="caption" tone="ink3" numberOfLines={1}>
                {owner.role}
              </T>
            ) : null}
          </View>
        </View>
        <Icon name="chevron.right" size={12} tone="muted-foreground" />
      </Pressable>
      {facts.map((f) => (
        <View key={f.label} className={ROW}>
          <FactLabel>{f.label}</FactLabel>
          <T variant="small" className="flex-1">
            {f.value}
          </T>
        </View>
      ))}
    </View>
  );
}

/** The ask this ticket waits on, decided right here. */
export function TicketAsk({
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
  return (
    <SectionBlock title="Waiting on you">
      <View className="gap-1.5 px-5 pt-1">
        <T variant="label">{ask.title}</T>
        <T variant="small" tone="ink2">
          {ask.ask}
        </T>
        {ask.why ? (
          <T variant="caption" tone="ink3">
            {ask.why}
          </T>
        ) : null}
        {ask.spend ? (
          <T variant="caption" tone="ink3">
            {ask.spend}
          </T>
        ) : null}
        {ask.fallback ? (
          <T variant="caption" tone="ink3">
            {ask.fallback}
          </T>
        ) : null}
        <View className="pt-2.5">
          {ask.kind === "question" && ask.options ? (
            <View className="gap-2">
              {ask.options.map((o, i) => (
                <Pressable
                  key={o}
                  testID={`ticket-answer-${i}`}
                  accessibilityRole="button"
                  accessibilityLabel={o}
                  onPress={() => onAnswer(ask.id, o)}
                  className={`h-11 items-center justify-center rounded-full active:opacity-70 ${i === 0 ? "bg-ink" : "bg-paper-soft"}`}
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
              testIDPrefix="ticket-ask"
              onApprove={() => onApprove(ask.id)}
              onDeny={() => onDeny(ask.id)}
            />
          )}
        </View>
      </View>
    </SectionBlock>
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

export function TicketProgress({ steps }: { steps: TicketStepVM[] }) {
  return (
    <SectionBlock title="Progress">
      {steps.map((s, i) => (
        <View
          key={`${i}-${s.text}`}
          className="flex-row items-start gap-3 px-5 py-2"
        >
          <View className="pt-px">
            <Icon
              name={MARK[s.state]}
              size={18}
              tone={s.state === "todo" ? "muted-foreground" : "foreground"}
            />
          </View>
          <View className="flex-1 gap-px">
            <T
              variant="small"
              tone={s.state === "todo" ? "ink2" : "ink"}
              className={s.state === "current" ? "font-semibold" : ""}
            >
              {s.text}
            </T>
            <T variant="caption" tone="ink3">
              {s.took ? `${s.who} · ${s.took}` : s.who}
            </T>
          </View>
        </View>
      ))}
    </SectionBlock>
  );
}

export function TicketResult({ result }: { result: TicketResultVM }) {
  return (
    <SectionBlock title="Result">
      <View className="border-t border-rule">
        {result.pr ? (
          <View className={`${ROW} items-center`}>
            <Icon name="arrow.triangle.pull" size={16} />
            <T variant="small" className="flex-1">
              {result.pr}
            </T>
          </View>
        ) : null}
        {result.files.map((f) => (
          <View key={f.name} className={`${ROW} items-center`}>
            <Icon name="doc.text" size={16} tone="muted-foreground" />
            <View className="flex-1">
              <T variant="small">{f.name}</T>
              <T variant="caption" tone="ink3">
                {f.note}
              </T>
            </View>
          </View>
        ))}
      </View>
    </SectionBlock>
  );
}

export function TicketUpdates({ updates }: { updates: TicketUpdateVM[] }) {
  return (
    <SectionBlock title="Updates">
      {updates.map((u) => (
        <View key={u.id} className="flex-row items-start gap-3 px-5 py-2.5">
          {u.who ? <Avatar person={u.who} size={28} /> : null}
          <View className="flex-1 gap-0.5">
            <View className="flex-row items-center gap-2">
              {u.who ? (
                <PersonName person={u.who} variant="small" />
              ) : (
                <T variant="small" className="font-semibold">
                  LilOS
                </T>
              )}
              <T variant="caption" tone="ink3">
                {u.ago}
              </T>
            </View>
            <T variant="small" tone="ink2">
              {u.text}
            </T>
          </View>
        </View>
      ))}
    </SectionBlock>
  );
}
