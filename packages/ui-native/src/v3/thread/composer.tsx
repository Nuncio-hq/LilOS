import { useEffect, useRef, useState } from "react";
import {
  Animated,
  Dimensions,
  Easing,
  Keyboard,
  type KeyboardEvent,
  Platform,
  Pressable,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useThemeColor } from "../../components/icon";
import { Glyph } from "./glyph";

/* How far the composer rides above the screen's bottom edge: the home
   indicator at rest, the keyboard's height while it is up. Measured from the
   keyboard's own frame, so it does not matter how tall the header above is. */
function useBottomGap(rest: number) {
  const gap = useRef(new Animated.Value(rest)).current;
  useEffect(() => {
    const ios = Platform.OS === "ios";
    const move = (to: number, e?: KeyboardEvent) =>
      Animated.timing(gap, {
        toValue: to,
        duration: e?.duration ?? 220,
        easing: Easing.bezier(0.25, 0.1, 0.25, 1),
        useNativeDriver: false,
      }).start();
    // The frame event also fires on hide, with the frame off the bottom.
    const frame = (e: KeyboardEvent) => {
      const overlap =
        Dimensions.get("window").height - e.endCoordinates.screenY;
      move(overlap > 0 ? overlap + 8 : rest, e);
    };
    const subs = ios
      ? [Keyboard.addListener("keyboardWillChangeFrame", frame)]
      : [
          Keyboard.addListener("keyboardDidShow", frame),
          Keyboard.addListener("keyboardDidHide", (e) => move(rest, e)),
        ];
    move(rest);
    return () => {
      for (const s of subs) s.remove();
    };
  }, [gap, rest]);
  return gap;
}

/* The message box pinned under the conversation: a soft pill, multiline, and
   one round send button that stays quiet until there is something to send. */
export function ThreadComposer({
  placeholder,
  onSend,
}: {
  placeholder: string;
  onSend: (text: string) => void;
}) {
  const insets = useSafeAreaInsets();
  const gap = useBottomGap(Math.max(insets.bottom - 12, 10));
  const [draft, setDraft] = useState("");
  const ink3 = useThemeColor("ink-3");
  const ready = draft.trim().length > 0;
  const send = () => {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    onSend(text);
  };
  return (
    <Animated.View
      className="border-rule border-t bg-paper px-3 pt-2"
      style={{ paddingBottom: gap }}
    >
      <View className="flex-row items-end gap-2 rounded-[22px] bg-paper-soft py-1.5 pr-1.5 pl-4">
        <TextInput
          testID="thread-composer-input"
          accessibilityLabel={placeholder}
          value={draft}
          onChangeText={setDraft}
          placeholder={placeholder}
          placeholderTextColor={ink3}
          multiline
          className="max-h-32 min-h-[22px] flex-1 text-[16px] text-ink leading-[22px]"
          style={{ paddingTop: 5, paddingBottom: 5 }}
        />
        <Pressable
          testID="thread-send"
          accessibilityRole="button"
          accessibilityLabel="Send"
          accessibilityState={{ disabled: !ready }}
          disabled={!ready}
          onPress={send}
          hitSlop={6}
          className={`size-[34px] items-center justify-center rounded-full ${ready ? "bg-ink active:opacity-70" : "bg-rule"}`}
        >
          <Glyph
            name="arrow.up"
            token={ready ? "paper" : "ink-3"}
            size={15}
            weight="bold"
          />
        </Pressable>
      </View>
    </Animated.View>
  );
}
