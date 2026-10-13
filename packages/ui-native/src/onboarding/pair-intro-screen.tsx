import { View } from "react-native";
import { AppText } from "../components/app-text";
import { Button } from "../components/button";
import { Icon } from "../components/icon";
import { Screen } from "../components/screen";

const STEPS = [
  "Open LilOS on your Mac.",
  /* #600: the control is an icon-only button — say where it sits. */
  "Click the phone icon at the bottom of the sidebar.",
  "Scan the code it shows.",
];

/* Step 2 — how to get the Mac's pairing code, then scan it (or type it). */
export function PairIntroScreen({
  onScan,
  onManual,
}: {
  onScan: () => void;
  onManual: () => void;
}) {
  return (
    <Screen
      topInset={false}
      footer={
        <>
          <Button
            label="Scan QR code"
            icon="qrcode.viewfinder"
            onPress={onScan}
          />
          <Button
            label="Enter code instead"
            variant="ghost"
            onPress={onManual}
          />
        </>
      }
    >
      <View className="gap-8 pt-2">
        <View className="gap-2">
          <AppText size="title">Pair with your Mac</AppText>
          <AppText tone="muted">
            Your iPhone connects straight to LilOS on your Mac. Nothing runs on
            the phone.
          </AppText>
        </View>
        <View className="gap-5">
          {STEPS.map((s, i) => (
            <View key={s} className="flex-row items-center gap-4">
              <View className="size-8 items-center justify-center rounded-full bg-secondary">
                <AppText size="sm" weight="semibold">
                  {i + 1}
                </AppText>
              </View>
              <AppText className="flex-1">{s}</AppText>
            </View>
          ))}
        </View>
        <View className="flex-row gap-3 rounded-2xl bg-secondary p-4">
          <Icon name="network" size={20} tone="muted-foreground" />
          <View className="flex-1 gap-1">
            <AppText size="sm" weight="semibold">
              Away from home
            </AppText>
            <AppText size="sm" tone="muted">
              Install Tailscale on this iPhone and sign in with the same account
              as your Mac. Then LilOS reaches your Mac from anywhere.
            </AppText>
          </View>
        </View>
      </View>
    </Screen>
  );
}
