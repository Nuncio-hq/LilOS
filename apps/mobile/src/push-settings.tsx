import type { PushPrefs } from "@lilos/contracts/app";
import { AppText, Row, Section } from "@lilos/ui-native";
import { useStore } from "@nanostores/react";
import * as Linking from "expo-linking";
import { Switch, View } from "react-native";
import {
  $pushPermission,
  $pushPrefs,
  requestPushPermission,
  setPushPref,
} from "./push";

/* AC-6: the four per-kind toggles + the OS-permission state, rendered as
   one Settings section. Toggles apply locally and re-register the prefs on
   the relay; a denied permission can't be re-asked in-app, so the row
   explains and jumps to iOS Settings. */

const KINDS: { key: keyof PushPrefs; label: string }[] = [
  { key: "needsApproval", label: "Needs approval" },
  { key: "waitingForInput", label: "Waiting for input" },
  { key: "completed", label: "Completed" },
  { key: "failed", label: "Failed" },
];

export function PushSettingsSection() {
  const prefs = useStore($pushPrefs);
  const permission = useStore($pushPermission);
  return (
    <Section title="Notifications">
      {permission === "denied" ? (
        <Row onPress={() => void Linking.openSettings()}>
          <View className="flex-1 gap-0.5">
            <AppText tone="destructive" weight="medium">
              Notifications are off
            </AppText>
            <AppText size="xs" tone="muted">
              iOS is blocking them. Open Settings → LilOS → Notifications and
              turn on Allow Notifications.
            </AppText>
          </View>
          <AppText tone="muted">Fix</AppText>
        </Row>
      ) : permission === "undetermined" ? (
        <Row onPress={() => void requestPushPermission({ manual: true })}>
          <AppText className="flex-1">Allow notifications</AppText>
          <AppText tone="muted">Ask</AppText>
        </Row>
      ) : null}
      {KINDS.map(({ key, label }) => (
        <Row key={key}>
          <AppText className="flex-1">{label}</AppText>
          <Switch
            value={prefs[key]}
            onValueChange={(value) => void setPushPref(key, value)}
          />
        </Row>
      ))}
    </Section>
  );
}
