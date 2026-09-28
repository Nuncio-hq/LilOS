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
  insetBottom,
  onSend,
  onStop,
  onPickFolder,
  onPickModel,
  onLayoutHeight,
  prefill,
}: {
  placeholder: string;
  /** Omit in a thread: the session already runs somewhere. */
  folder?: string;
  model: string;
  /** models.dev slug of the model's provider: its logo leads the chip. */
  modelLogo?: string;
  insetBottom: number;
  onSend: (text: string) => void;
  /** Set while the employee is mid-turn: an empty composer shows ■ Stop. */
  onStop?: () => void;
  onPickFolder?: () => void;
  onPickModel: () => void;
  /** Floating callers pad their scroll content by this. */
  onLayoutHeight?: (h: number) => void;
  /** Put this text in the box and focus it — a new object each time (plan "Change…"). */
  prefill?: { text: string };
}) {
  const [draft, setDraft] = useState("");
  const input = useRef<TextInput>(null);
  useEffect(() => {
    if (!prefill) return;
    setDraft(prefill.text);
    input.current?.focus();
  }, [prefill]);
  const muted = useThemeColor("muted-foreground");
  const ready = !!draft.trim();
  const send = () => {
    const t = draft.trim();
    if (!t) return;
    onSend(t);
    setDraft("");
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
          onChangeText={setDraft}
          placeholder={placeholder}
          placeholderTextColor={muted}
          multiline
          className="max-h-32 min-h-6 px-0.5 text-[17px] leading-[22px] text-foreground"
        />
        <View className="mt-2 flex-row items-center gap-1.5">
          {folder !== undefined && onPickFolder && (
            <Chip icon="folder" label={folder} onPress={onPickFolder} />
          )}
          <Chip
            icon="sparkle"
            lead={modelLogo && <ProviderLogo slug={modelLogo} size={14} />}
            label={model}
            onPress={onPickModel}
          />
          <View className="flex-1" />
          {onStop && !ready ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Stop"
              onPress={onStop}
              className="size-8 items-center justify-center rounded-full bg-foreground active:opacity-70"
            >
              <View className="size-2.5 rounded-[2.5px] bg-background" />
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
  onPress,
}: {
  icon: Parameters<typeof Icon>[0]["name"];
  /** Replaces the icon (a provider logo). */
  lead?: ReactNode;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      className="h-[30px] max-w-[170px] flex-row items-center gap-1.5 rounded-full bg-fill pr-2.5 pl-2.5 active:opacity-60"
    >
      {lead || (
        <Icon name={icon} size={12} tone="subtle-foreground" weight="medium" />
      )}
      <Text
        numberOfLines={1}
        className="shrink font-medium text-[13px] text-subtle-foreground"
      >
        {label}
      </Text>
      <Icon
        name="chevron.up.chevron.down"
        size={9}
        tone="muted-foreground"
        weight="semibold"
      />
    </Pressable>
  );
}
