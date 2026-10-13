import type { ReactNode } from "react";
import { View } from "react-native";
import { AppText } from "../components/app-text";
import { LargeTitle } from "../components/bits";
import { MacArt } from "../components/device-art";
import { Row, Section } from "../components/grouped-list";
import { Icon } from "../components/icon";
import { Screen } from "../components/screen";
import type { MacLink } from "./mac-status-card";

/* The paired Mac + Forget it. `children` = extra sections (the prototype's
   state switcher). `app` adds an About section — which build is on the phone. */
export function SettingsScreen({
  title,
  mac,
  app,
  onForget,
  onOpenMac,
  children,
}: {
  /** Large title, when shown as a tab (see LargeTitle). */
  title?: string;
  mac?: {
    name: string;
    host: string;
    routeLabel: string;
    /** With a link state the row shows connection status. */
    link?: MacLink;
  };
  /** About row: app name + label like "0.1.0 (build 6)" from the bundle. */
  app?: {
    name: string;
    versionLabel: string;
  };
  onForget?: () => void;
  /** Opens the Mac sheet (status, versions, Forget). Replaces the Forget row. */
  onOpenMac?: () => void;
  children?: ReactNode;
}) {
  return (
    <Screen topInset={false} list>
      {title && (
        <View className="-mx-4 pb-2">
          <LargeTitle title={title} />
        </View>
      )}
      <View className="gap-8 pt-2">
        {mac && (
          <Section title="Mac">
            <Row onPress={onOpenMac}>
              <View className="w-11 items-center">
                <MacArt scale={0.5} />
              </View>
              <View className="flex-1 gap-0.5">
                <AppText weight="semibold">{mac.name}</AppText>
                {mac.link ? (
                  <View className="flex-row items-center gap-1.5">
                    <View
                      className={`size-[7px] rounded-full ${mac.link === "online" ? "bg-success" : mac.link === "offline" ? "bg-destructive" : mac.link === "blocked" ? "bg-warning" : "bg-muted-foreground"}`}
                    />
                    <AppText size="sm" tone="muted">
                      {mac.link === "online"
                        ? `Connected ${mac.routeLabel}`
                        : mac.link === "offline"
                          ? "Can't reach it"
                          : mac.link === "blocked"
                            ? "Update needed"
                            : "Reconnecting…"}
                    </AppText>
                  </View>
                ) : (
                  <AppText size="sm" tone="muted">
                    {mac.host} · {mac.routeLabel}
                  </AppText>
                )}
              </View>
              {onOpenMac && (
                <Icon
                  name="chevron.right"
                  size={12}
                  weight="semibold"
                  tone="muted-foreground"
                />
              )}
            </Row>
            {/* #599: only render Forget when a real handler exists — the
                demo passes none (its Mac is fake; "Exit demo" lives below)
                and the paired app keeps Forget inside the Mac sheet. */}
            {!onOpenMac && onForget && (
              <Row onPress={onForget}>
                <AppText tone="destructive" weight="medium">
                  Forget this Mac
                </AppText>
              </Row>
            )}
          </Section>
        )}
        {app && (
          <Section title="About">
            <Row>
              <AppText className="flex-1">{app.name}</AppText>
              <AppText tone="muted">{app.versionLabel}</AppText>
            </Row>
          </Section>
        )}
        {children}
      </View>
    </Screen>
  );
}
