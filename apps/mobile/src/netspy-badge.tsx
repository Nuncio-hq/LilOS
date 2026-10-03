import { AppText } from "@lilos/ui-native";
import { useStore } from "@nanostores/react";
import { View } from "react-native";
import { $netSpy } from "./netspy";

/* Dev-build evidence chip (#168): a small floating counter of JS-level
   network calls made since boot — `net 0` through the whole offline demo
   flow is the AC-6 on-device proof. Green while zero, red the moment any
   fetch/WebSocket/XHR escapes; the smaller count is Metro dev-server
   traffic (tooling, shown separately rather than filtered out silently).
   Never interactive, never shipped — index.ts only installs the spy under
   __DEV__. */
export function NetSpyBadge() {
  const spy = useStore($netSpy);
  const clean = spy.app === 0;
  return (
    <View
      pointerEvents="none"
      accessible={false}
      className="absolute bottom-3 left-4"
    >
      <View
        className={`rounded-full border px-3 py-1.5 ${
          clean
            ? "border-success/50 bg-success/15"
            : "border-destructive/60 bg-destructive/20"
        }`}
      >
        <View className="flex-row items-baseline gap-1.5">
          <AppText
            size="xs"
            weight="semibold"
            tone={clean ? "success" : "destructive"}
            className="tracking-wider"
          >
            {`net ${spy.app}`}
          </AppText>
          {spy.dev > 0 && (
            <AppText size="xs" tone="muted">
              {`dev ${spy.dev}`}
            </AppText>
          )}
        </View>
      </View>
    </View>
  );
}
