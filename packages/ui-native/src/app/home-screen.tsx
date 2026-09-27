import { View } from "react-native";
import { Screen } from "../components/screen";
import { type MacLink, MacStatusCard } from "./mac-status-card";

/* Home after pairing. For now only the Mac's status; employees, threads and
   approvals land here in the next rounds. */
export function HomeScreen({
  macName,
  link,
  routeLabel,
  lastConnected,
  onRetry,
}: {
  macName: string;
  link: MacLink;
  routeLabel: string;
  lastConnected: string;
  onRetry: () => void;
}) {
  return (
    <Screen topInset={false} list>
      <View className="gap-4 pt-2">
        <MacStatusCard
          name={macName}
          link={link}
          routeLabel={routeLabel}
          lastConnected={lastConnected}
          onRetry={onRetry}
        />
      </View>
    </Screen>
  );
}
