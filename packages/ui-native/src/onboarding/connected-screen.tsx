import { Button } from "../components/button";
import { Screen } from "../components/screen";
import { StateBlock } from "../components/state-block";
import { MacCard } from "./mac-card";

/* Step 5 — paired. Says which Mac and over which route, then into the app. */
export function ConnectedScreen({
  macName,
  routeLabel,
  onContinue,
}: {
  macName: string;
  routeLabel: string;
  onContinue: () => void;
}) {
  return (
    <Screen
      topInset={false}
      footer={<Button label="Continue" onPress={onContinue} />}
    >
      <StateBlock
        icon="checkmark.circle.fill"
        iconTone="success"
        title="You're connected"
        body="This iPhone is paired with your Mac. It reconnects by itself every time you open LilOS."
      >
        <MacCard name={macName} detail={routeLabel} />
      </StateBlock>
    </Screen>
  );
}
