import { useState } from "react";
import { Pressable, TextInput, View } from "react-native";
import { AppText } from "../components/app-text";
import { Card, Pill } from "../components/bits";
import { Icon, useThemeColor } from "../components/icon";
import { Inline, Prose } from "../components/prose";
import type { Approval } from "./types";

/* What the card hands back: options answer with their wire id, free text
   with the typed string; `label` is the human wording the receipt shows. */
export type QuestionAnswer = { value: string; label: string };

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
  stale,
  answerHint,
}: {
  a: Approval;
  onAnswer?: (id: string, answer: QuestionAnswer) => void;
  onCancel?: (id: string) => void;
  /** #652: the Mac is unreachable — options/answer/Skip render inert and
      the hint says when answering works again (nothing is sent or queued). */
  stale?: boolean;
  answerHint?: string;
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
  const inert = pending || stale || (!onAnswer && !onCancel);
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
        {/* Question + option copy ride the same markdown pass as message
            bodies — `release/0.1` is code, not backticks (FIX #515). */}
        <Prose text={a.reason} size="sm" />
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
                <Inline
                  text={o.label}
                  className="text-[15px] font-semibold leading-5"
                />
                {!!o.description && (
                  /* Subtitles keep ≥4.5:1 on the tile — Inline colors plain
                     segments foreground (FIX #515). */
                  <Inline
                    text={o.description}
                    className="mt-0.5 text-[13px] leading-4"
                  />
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
        {/* Skip is secondary, pinned to the content edge — it names what
            it does: the asking agent decides instead (FIX #515). */}
        {stale && answerHint && (
          <AppText size="xs" tone="muted" className="mt-2">
            {answerHint}
          </AppText>
        )}
        <View className="mt-3 flex-row items-center justify-end gap-2">
          {pending ? (
            <AppText size="xs" tone="muted">
              Sending…
            </AppText>
          ) : null}
          {onCancel && (
            <Pill
              label={`Skip — let ${a.employee || "the agent"} decide`}
              variant="soft"
              disabled={stale}
              onPress={() => {
                if (pending) return;
                setPending(true);
                onCancel(a.id);
              }}
            />
          )}
        </View>
      </Card>
    </View>
  );
}
