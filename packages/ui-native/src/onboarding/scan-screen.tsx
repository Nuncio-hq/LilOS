import type { ReactNode } from "react";
import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppText } from "../components/app-text";
import { Button } from "../components/button";
import { Icon } from "../components/icon";
import { Screen } from "../components/screen";
import { StateBlock } from "../components/state-block";

/* Step 3 — scan the QR on the Mac. The camera itself is a slot (the app owns
   the native camera + permission); this draws the frame around it.
   `cameraDenied` → how to turn it back on. `wrongCode` → banner, keeps
   scanning. `onTapViewfinder` (Simulator, no camera) "scans" a demo code. */
export function ScanScreen({
  camera,
  cameraDenied,
  wrongCode,
  onTapViewfinder,
  onManual,
  onOpenSettings,
}: {
  camera?: ReactNode;
  cameraDenied?: boolean;
  wrongCode?: boolean;
  onTapViewfinder?: () => void;
  onManual: () => void;
  onOpenSettings: () => void;
}) {
  const insets = useSafeAreaInsets();

  if (cameraDenied) {
    return (
      <Screen
        topInset={false}
        footer={
          <>
            <Button
              label="Open Settings"
              icon="gear"
              onPress={onOpenSettings}
            />
            <Button
              label="Enter code instead"
              variant="ghost"
              onPress={onManual}
            />
          </>
        }
      >
        <StateBlock
          icon="video.slash"
          title="Camera is off for LilOS"
          body="To scan the code on your Mac, allow camera access in Settings → LilOS → Camera. Or type the code instead."
        />
      </Screen>
    );
  }

  return (
    <View className="flex-1 bg-black">
      {camera}
      <View
        className="flex-1 items-center justify-center gap-8 px-8"
        style={{ paddingTop: insets.top + 44 }}
      >
        <AppText size="lg" weight="semibold" className="text-center text-white">
          Scan the code on your Mac
        </AppText>
        <Pressable
          accessibilityLabel="Viewfinder"
          disabled={!onTapViewfinder}
          onPress={onTapViewfinder}
          className="aspect-square w-full max-w-[280px] items-center justify-center rounded-[36px] border-4 border-white/90"
        >
          {onTapViewfinder && (
            <View className="items-center gap-2 px-6">
              <Icon name="hand.tap" size={28} tone="primary-foreground" />
              <AppText size="sm" className="text-center text-white/80">
                Simulator: tap to scan the demo Mac's code
              </AppText>
            </View>
          )}
        </Pressable>
        <View className="items-center gap-3">
          {/* Fixed slot so the hint below never jumps when the banner appears. */}
          <View className="h-10 justify-center">
            {wrongCode && (
              <View className="flex-row items-center gap-2 rounded-full bg-white px-4 py-2.5">
                <Icon
                  name="exclamationmark.triangle.fill"
                  size={16}
                  tone="warning"
                />
                <AppText size="sm" weight="medium" className="text-black">
                  That isn't a LilOS pairing code
                </AppText>
              </View>
            )}
          </View>
          <AppText size="sm" className="text-center text-white/80">
            On your Mac: LilOS sidebar → Pair phone
          </AppText>
        </View>
      </View>
      <View
        className="px-6"
        style={{ paddingBottom: Math.max(insets.bottom, 16) + 4 }}
      >
        <Pressable
          accessibilityRole="button"
          onPress={onManual}
          className="h-[52px] items-center justify-center rounded-2xl bg-white/15 active:opacity-70"
        >
          <AppText weight="semibold" className="text-white">
            Enter code instead
          </AppText>
        </Pressable>
      </View>
    </View>
  );
}
