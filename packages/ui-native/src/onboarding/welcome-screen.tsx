import { Image, type ImageSourcePropType, View } from "react-native";
import { AppText } from "../components/app-text";
import { Button } from "../components/button";
import { Icon } from "../components/icon";
import { Screen } from "../components/screen";

/* Step 1 — first launch. One screen, then straight to pairing: whoever
   installs the phone app already runs LilOS on a Mac, so no feature tour. */
export function WelcomeScreen({
  logo,
  notice,
  onStart,
}: {
  logo: ImageSourcePropType;
  /** Shown when onboarding re-appears for a reason (e.g. the Mac removed
      this phone) — plain sentence above the intro. */
  notice?: string;
  onStart: () => void;
}) {
  return (
    <Screen footer={<Button label="Get started" onPress={onStart} />}>
      <View className="flex-1 justify-center gap-8 pb-10">
        <Image
          source={logo}
          accessibilityLabel="LilOS"
          className="size-28 self-start"
          resizeMode="contain"
        />
        {notice ? (
          <View className="flex-row items-center gap-3 rounded-2xl bg-secondary p-4">
            <Icon
              name="exclamationmark.triangle.fill"
              size={20}
              tone="warning"
            />
            <AppText size="sm" className="flex-1">
              {notice}
            </AppText>
          </View>
        ) : null}
        <View className="gap-3">
          <AppText size="hero">Welcome to LilOS</AppText>
          <AppText size="lg" tone="muted">
            Keep working with your AI employees when you're away from your Mac.
          </AppText>
        </View>
        <View className="flex-row items-center gap-3 rounded-2xl bg-secondary p-4">
          <Icon name="laptopcomputer" size={22} tone="muted-foreground" />
          <AppText size="sm" tone="muted" className="flex-1">
            Your employees keep running on your Mac. This app connects to it —
            you'll need LilOS open there to pair.
          </AppText>
        </View>
      </View>
    </Screen>
  );
}
