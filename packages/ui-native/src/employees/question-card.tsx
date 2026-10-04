import { useState } from "react";
import { Pressable, TextInput, View } from "react-native";
import { AppText } from "../components/app-text";
import { Card, Pill } from "../components/bits";
import { Icon, useThemeColor } from "../components/icon";
import type { Approval } from "./types";

/* What the card hands back: options answer with their wire id, free text
   with the typed string; `label` is the human wording the receipt shows. */
export type QuestionAnswer = { value: string; label: string };

/* A question ask this card can actually answer. Prototype asks carry
   `options`/`freeText`; the real app's Approval view-model doesn't map
   them yet, so those asks stay on the old Deny-only card until the
   real-app slice wires answers end to end. */
export const isAnswerableQuestion = (a: Approval) =>
  a.kind === "question" && (a.options != null || a.freeText != null);

/* #420: a `question` ask under the turn — the question text, its options
   as tap rows, a free-text field when allowed, and Cancel. Answering or
   cancelling folds the ask to the "You answered:" / "You cancelled:"
   receipt (decided) — the same fold the approval card makes; the phone's
   answered state is the receipt, not a resolved card. Props in, callbacks
   out: `onAnswer` continues the turn, `onCancel` refuses it. */
export function QuestionCard({
  a,
  onAnswer,
  onCancel,
}: {
  a: Approval;
  onAnswer?: (id: string, answer: QuestionAnswer) => void;
  onCancel?: (id: string) => void;
}) {
  const muted = useThemeColor("muted-foreground");
  const [draft, setDraft] = useState("");
  /* The answer is on its way to the engine — the controls lock until the
     ask folds to its receipt. */
  const [pending, setPending] = useState(false);
  const options = a.options ?? [];
  /* Wire rule (requests.ts): free text beside the options only when
     `freeText`; no options at all → the answer IS free text. */
  const freeText = a.freeText === true || options.length === 0;
  const inert = pending || (!onAnswer && !onCancel);
  const pick = (answer: QuestionAnswer) => {
    if (!onAnswer || pending) return;
    setPending(true);
    onAnswer(a.id, answer);
  };
  return (
    // Its own responder, so a tap on the card never opens the row under it.
    <View onStartShouldSetResponder={() => true}>
      <Card>
        <View className="mb-1.5 flex-row items-center gap-1.5">
          <View className="size-1.5 rounded-full bg-primary" />
          <AppText
            size="xs"
            weight="semibold"
            tone="none"
            className="text-accent-text"
          >
            Question for you
          </AppText>
        </View>
        <AppText size="sm" className="leading-5">
          {a.reason}
        </AppText>
        {options.length > 0 && (
          <View className="mt-2.5 gap-2">
            {options.map((o) => (
              <Pressable
                key={o.id}
                accessibilityRole="button"
                accessibilityLabel={o.label}
                disabled={inert}
                onPress={() => pick({ value: o.id, label: o.label })}
                className={`rounded-xl bg-fill px-3 py-2.5 ${inert ? "opacity-40" : "active:opacity-70"}`}
              >
                <AppText size="sm" weight="semibold">
                  {o.label}
                </AppText>
                {!!o.description && (
                  <AppText size="xs" tone="muted" className="mt-0.5 leading-4">
                    {o.description}
                  </AppText>
                )}
              </Pressable>
            ))}
          </View>
        )}
        {freeText && (
          <View className="mt-2.5 flex-row items-center gap-2 rounded-xl bg-background py-1 pr-1 pl-3">
            <TextInput
              value={draft}
              onChangeText={setDraft}
              editable={!inert}
              placeholder={
                options.length ? "Or type your own…" : "Type your answer…"
              }
              placeholderTextColor={muted}
              returnKeyType="send"
              onSubmitEditing={() => {
                const text = draft.trim();
                if (text) pick({ value: text, label: text });
              }}
              className="min-h-8 flex-1 text-[15px] text-foreground"
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Answer"
              disabled={inert || !draft.trim()}
              onPress={() => {
                const text = draft.trim();
                if (text) pick({ value: text, label: text });
              }}
              className={`size-8 items-center justify-center rounded-full ${!inert && draft.trim() ? "bg-primary" : "bg-fill"}`}
            >
              <Icon
                name="arrow.up"
                size={15}
                weight="bold"
                tone={
                  !inert && draft.trim()
                    ? "primary-foreground"
                    : "muted-foreground"
                }
              />
            </Pressable>
          </View>
        )}
        <View className="mt-3 flex-row items-center gap-2">
          {onCancel && (
            <Pill
              label="Cancel"
              variant="ghost"
              onPress={() => {
                if (pending) return;
                setPending(true);
                onCancel(a.id);
              }}
            />
          )}
          {pending && (
            <AppText size="xs" tone="muted">
              Sending…
            </AppText>
          )}
        </View>
      </Card>
    </View>
  );
}
