import { ActivityIndicator, View } from "react-native";
import { AppText } from "../components/app-text";
import { Button } from "../components/button";
import { useThemeColor } from "../components/icon";
import { Screen } from "../components/screen";
import { StateBlock } from "../components/state-block";
import { type CodeEntry, mismatchActions } from "../lib/pairing-code";
import { MacCard } from "./mac-card";

export type ConnectingState =
  | "connecting"
  | "unreachable"
  | "expired"
  | "mismatch"
  | "throttled";

/* Step 4 — talking to the Mac, and the ways it fails, each with the one
   thing to do next: can't reach it (awake? Tailscale on?), the code expired
   (make a new one on the Mac and scan again), the code doesn't match (#593 —
   check it or make a new one), or too many tries (#568 — wait out the
   throttle). */
export function ConnectingScreen({
  state,
  macName,
  host,
  retryAfterSeconds,
  entry,
  onCancel,
  onRetry,
  onRescan,
  onManual,
}: {
  state: ConnectingState;
  macName: string;
  host: string;
  /** Throttle wait from the 429's Retry-After (#568); only for 'throttled'. */
  retryAfterSeconds?: number;
  /** How the code was entered — decides the mismatch retry (#688 AC-1). */
  entry?: CodeEntry;
  onCancel: () => void;
  onRetry: () => void;
  onRescan: () => void;
  onManual: () => void;
}) {
  const spinner = useThemeColor("muted-foreground");
  const mac = <MacCard name={macName} host={host} />;

  if (state === "connecting") {
    return (
      <Screen
        topInset={false}
        footer={<Button label="Cancel" variant="ghost" onPress={onCancel} />}
      >
        <StateBlock
          visual={<ActivityIndicator color={spinner} />}
          title="Connecting to your Mac"
          body="Keep LilOS open on your Mac."
        >
          {mac}
        </StateBlock>
      </Screen>
    );
  }

  if (state === "unreachable") {
    return (
      <Screen
        topInset={false}
        footer={
          <>
            <Button label="Try again" onPress={onRetry} />
            <Button
              label="Scan a new code"
              variant="ghost"
              onPress={onRescan}
            />
          </>
        }
      >
        <StateBlock
          icon="wifi.exclamationmark"
          iconTone="destructive"
          title="Can't reach your Mac"
          body="Your phone couldn't find it. Check that:"
        >
          <View className="gap-3">
            {[
              "Your Mac is awake and LilOS is open.",
              "Tailscale is on here and on your Mac, with the same account.",
            ].map((t) => (
              <View key={t} className="flex-row gap-3">
                <AppText tone="muted">•</AppText>
                <AppText className="flex-1">{t}</AppText>
              </View>
            ))}
          </View>
          {mac}
        </StateBlock>
      </Screen>
    );
  }

  if (state === "mismatch") {
    const actions = mismatchActions(entry);
    return (
      <Screen
        topInset={false}
        footer={
          actions.primary === "reenter" ? (
            <>
              <Button
                label="Re-enter code"
                icon="keyboard"
                onPress={onManual}
              />
              <Button
                label="Scan a QR code instead"
                variant="ghost"
                onPress={onRescan}
              />
            </>
          ) : (
            <>
              <Button
                label="Scan a new code"
                icon="qrcode.viewfinder"
                onPress={onRescan}
              />
              <Button
                label="Enter code instead"
                variant="ghost"
                onPress={onManual}
              />
            </>
          )
        }
      >
        <StateBlock
          icon="number.circle"
          iconTone="destructive"
          title="That code doesn't match"
          body="Check it or make a new one on the Mac."
        >
          {mac}
        </StateBlock>
      </Screen>
    );
  }

  if (state === "throttled") {
    return (
      <Screen
        topInset={false}
        footer={
          <>
            <Button label="Try again" onPress={onRetry} />
            <Button
              label="Scan a new code"
              variant="ghost"
              onPress={onRescan}
            />
          </>
        }
      >
        <StateBlock
          icon="hand.raised"
          iconTone="warning"
          title="Too many tries"
          body={`Wait about ${retryAfterSeconds ?? 60} seconds, then try again.`}
        >
          {mac}
        </StateBlock>
      </Screen>
    );
  }

  return (
    <Screen
      topInset={false}
      footer={
        <>
          <Button
            label="Scan a new code"
            icon="qrcode.viewfinder"
            onPress={onRescan}
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
        icon="clock.badge.exclamationmark"
        iconTone="warning"
        title="This code has expired"
        body="Pairing codes work once and only for a few minutes. On your Mac, open Pair phone again to get a new one."
      />
    </Screen>
  );
}
