import type { ReactNode } from "react";
import { View } from "react-native";
import { AppText } from "../components/app-text";
import { Row, Section } from "../components/grouped-list";
import { Icon } from "../components/icon";
import { Screen } from "../components/screen";

/* The paired Mac + Forget it. `children` = extra sections (the prototype's
   state switcher). */
export function SettingsScreen({
  mac,
  onForget,
  children,
}: {
  mac?: { name: string; host: string; routeLabel: string };
  onForget: () => void;
  children?: ReactNode;
}) {
  return (
    <Screen topInset={false} list>
      <View className="gap-8 pt-2">
        {mac && (
          <Section title="Paired Mac">
            <Row>
              <Icon name="laptopcomputer" size={22} />
              <View className="flex-1">
                <AppText weight="semibold">{mac.name}</AppText>
                <AppText size="sm" tone="muted">
                  {mac.host} · {mac.routeLabel}
                </AppText>
              </View>
            </Row>
            <Row onPress={onForget}>
              <AppText tone="destructive" weight="medium">
                Forget this Mac
              </AppText>
            </Row>
          </Section>
        )}
        {children}
      </View>
    </Screen>
  );
}
