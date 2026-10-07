import { type ReactNode, useEffect, useRef, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { Glass } from "../components/glass";
import { Icon, useThemeColor } from "../components/icon";
import { ProviderLogo } from "../components/provider-logo";

/* The conversation's composer: one Liquid Glass capsule floating over the
   bottom of the chat (content scrolls on under it), input on top and the
   session's context under it. DM: folder + model (a new session picks
   both). Thread: model only (the session's folder is fixed). */
export function Composer({
  placeholder,
  folder,
  model,
  modelLogo,
  modelUnavailable,
  insetBottom,
  onSend,
  onStop,
  stopHint,
  onPickFolder,
  onPickModel,
  onLayoutHeight,
  prefill,
  initialDraft,
  onDraftChange,
}: {
  placeholder: string;
  /** Omit in a thread: the session already runs somewhere. */
  folder?: string;
  /** Omit when the engine has no model surface — the chip hides (web's
      `models?.length` gate; #160 AC-1). */
  model?: string;
  /** models.dev slug of the model's provider: its logo leads the chip. */
  modelLogo?: string;
  /** #483 AC-2: no source had models — the chip renders dimmed as
      "Models unavailable"; `onPickModel` becomes the retry affordance. */
  modelUnavailable?: boolean;
  insetBottom: number;
  onSend: (text: string) => void;
  /** Set while the employee is mid-turn: an empty composer shows ■ Stop. */
  onStop?: () => void;
  /** #591: set with `onStop` when the press can't be delivered (Mac
     unreachable) — the ■ stays visible, dimmed and inert, and this text
     is its accessibility hint (the note above the composer says why). */
  stopHint?: string;
  onPickFolder?: () => void;
  onPickModel?: () => void;
  /** Floating callers pad their scroll content by this. */
  onLayoutHeight?: (h: number) => void;
  /** Put this text in the box and focus it — a new object each time (plan "Change…"). */
  prefill?: { text: string };
  /** #556: the draft this box opens with — the caller's per-conversation
      store; omitted = empty (prototype and tests). */
  initialDraft?: string;
  /** #556: notified on every draft change incl. the send-clear, so the
      caller can persist it (guarded — fires only when the text differs
      from the last notification). */
  onDraftChange?: (text: string) => void;
}) {
  const [draft, setDraft] = useState(initialDraft ?? "");
  const lastNotified = useRef(initialDraft ?? "");
  /* Every draft mutation goes through change(): update state and tell the
     caller (guarded — fires only when the text differs from the last
     notification, and on the send-clear so a kill can't resurrect it). */
  const change = (text: string) => {
    setDraft(text);
    if (text === lastNotified.current) return;
    lastNotified.current = text;
    onDraftChange?.(text);
  };
  const input = useRef<TextInput>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: one fill per prefill object — a new `change` identity must not re-seed the box.
  useEffect(() => {
    if (!prefill) return;
    change(prefill.text);
    input.current?.focus();
  }, [prefill]);
  const muted = useThemeColor("muted-foreground");
  const ready = !!draft.trim();
  const send = () => {
    const t = draft.trim();
    if (!t) return;
    onSend(t);
    change("");
  };
  return (
    <View
      className="px-3 pt-2"
      style={{ paddingBottom: Math.max(insetBottom - 12, 10) }}
      onLayout={(e) => onLayoutHeight?.(e.nativeEvent.layout.height)}
    >
      <Glass
        className="px-4 pt-3 pb-2.5"
        style={{ borderRadius: 26, borderCurve: "continuous" }}
      >
        <TextInput
          ref={input}
          value={draft}
          onChangeText={change}
          placeholder={placeholder}
          placeholderTextColor={muted}
          multiline
          className="max-h-32 min-h-6 px-0.5 text-[17px] leading-[22px] text-foreground"
        />
        <View className="mt-2 flex-row items-center gap-1.5">
          {folder !== undefined && onPickFolder && (
            <Chip icon="folder" label={folder} onPress={onPickFolder} />
          )}
          {model !== undefined && onPickModel && (
            <Chip
              icon="sparkle"
              lead={
                !modelUnavailable && modelLogo ? (
                  <ProviderLogo slug={modelLogo} size={14} />
                ) : undefined
              }
              label={model}
              unavailable={modelUnavailable}
              onPress={onPickModel}
            />
          )}
          <View className="flex-1" />
          {onStop && !ready ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Stop"
              {...(stopHint ? { accessibilityHint: stopHint } : {})}
              disabled={!!stopHint}
              onPress={onStop}
              className={`size-8 items-center justify-center rounded-full ${stopHint ? "bg-muted" : "bg-foreground active:opacity-70"}`}
            >
              <View
                className={`size-2.5 rounded-[2.5px] ${stopHint ? "bg-muted-foreground" : "bg-background"}`}
              />
            </Pressable>
          ) : (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Send"
              disabled={!ready}
              onPress={send}
              className={`size-8 items-center justify-center rounded-full ${ready ? "bg-primary" : "bg-fill"}`}
            >
              <Icon
                name="arrow.up"
                size={15}
                weight="bold"
                tone={ready ? "primary-foreground" : "muted-foreground"}
              />
            </Pressable>
          )}
        </View>
      </Glass>
    </View>
  );
}

function Chip({
  icon,
  lead,
  label,
  unavailable,
  onPress,
}: {
  icon: Parameters<typeof Icon>[0]["name"];
  /** Replaces the icon (a provider logo). */
  lead?: ReactNode;
  label: string;
  /** Disabled look + a retry glyph: the press re-asks for the list (#483). */
  unavailable?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      {...(unavailable
        ? { accessibilityHint: "Double-tap to retry loading models" }
        : {})}
      onPress={onPress}
      /* Unavailable: no max-width cap (the fixed label is short) and no
         opacity-50 — an all-grey error reads as inactive. Amber content +
         a brighter retry glyph carry the warning; the whole chip still
         taps to retry. */
      className={`h-[30px] ${unavailable ? "" : "max-w-[170px]"} flex-row items-center gap-1.5 rounded-full bg-fill pr-2.5 pl-2.5 active:opacity-60`}
    >
      {lead || (
        <Icon
          name={unavailable ? "exclamationmark.triangle" : icon}
          size={12}
          tone={unavailable ? "warning" : "subtle-foreground"}
          weight="medium"
        />
      )}
      <Text
        numberOfLines={1}
        className={`shrink font-medium text-[13px] ${unavailable ? "text-warning" : "text-subtle-foreground"}`}
      >
        {label}
      </Text>
      <Icon
        name={unavailable ? "arrow.clockwise" : "chevron.up.chevron.down"}
        size={9}
        tone={unavailable ? "subtle-foreground" : "muted-foreground"}
        weight="semibold"
      />
    </Pressable>
  );
}
