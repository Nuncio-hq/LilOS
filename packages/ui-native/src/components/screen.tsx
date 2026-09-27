import { type ReactNode, useEffect, useState } from "react";
import { Keyboard, Platform, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

/* Onboarding screen frame: scrollable body, actions pinned above the home
   indicator — and above the keyboard while it's up — so the primary button
   stays in thumb reach. */
export function Screen({
  children,
  footer,
  topInset = true,
  list = false,
}: {
  children: ReactNode;
  footer?: ReactNode;
  /** false when a native header already sits above the content. */
  topInset?: boolean;
  /** App screens under a large native title: iOS's 16pt margins so content lines up with the title. */
  list?: boolean;
}) {
  const insets = useSafeAreaInsets();
  const keyboard = useKeyboardHeight();
  const bottom = keyboard > 0 ? keyboard + 12 : Math.max(insets.bottom, 16) + 4;
  return (
    <View className="flex-1 bg-background">
      <ScrollView
        contentContainerClassName={`grow ${list ? "px-4" : "px-6"}`}
        contentContainerStyle={{
          paddingTop: topInset ? insets.top + 24 : 8,
          paddingBottom: footer ? 24 : insets.bottom + 24,
        }}
        keyboardShouldPersistTaps="handled"
        contentInsetAdjustmentBehavior={topInset ? "never" : "automatic"}
      >
        {children}
      </ScrollView>
      {footer && (
        <View className="gap-2 px-6 pt-3" style={{ paddingBottom: bottom }}>
          {footer}
        </View>
      )}
    </View>
  );
}

function useKeyboardHeight(): number {
  const [h, setH] = useState(0);
  useEffect(() => {
    const ios = Platform.OS === "ios";
    const show = Keyboard.addListener(
      ios ? "keyboardWillShow" : "keyboardDidShow",
      (e) => setH(e.endCoordinates.height),
    );
    const hide = Keyboard.addListener(
      ios ? "keyboardWillHide" : "keyboardDidHide",
      () => setH(0),
    );
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return h;
}
