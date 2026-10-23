import { HIRE_TEMPLATES } from "@lilos/ui/v3-data";
import { HireSheet } from "@lilos/ui-native/v3";
import { useStore } from "@nanostores/react";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useCallback, useMemo } from "react";
import { hapticApprove } from "../haptics";
import type { RootRoutes } from "../nav";
import { openAgent } from "../nav";
import { $data, hire } from "../store";

/* The sheet's dismiss animation; the new agent's page is pushed after it so
   it lands on the Company stack, not under the closing sheet. */
const SHEET_CLOSE_MS = 350;

export function HireContainer({
  navigation,
}: NativeStackScreenProps<RootRoutes, "Hire">) {
  const d = useStore($data);
  const cards = useMemo(
    () =>
      HIRE_TEMPLATES.map((t) => ({
        role: t.role,
        does: d.features.tickets ? t.does : (t.plain ?? t.does),
        model: d.modelChoices[t.modelAt],
      })),
    [d.features.tickets, d.modelChoices],
  );
  const onHire = useCallback(
    (role: string) => {
      hapticApprove();
      const id = hire(role);
      navigation.goBack();
      setTimeout(() => openAgent(id), SHEET_CLOSE_MS);
    },
    [navigation],
  );
  return (
    <HireSheet cards={cards} onHire={onHire} onClose={navigation.goBack} />
  );
}
