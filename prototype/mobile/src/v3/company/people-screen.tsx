import { PeopleScreen } from "@lilos/ui-native/v3";
import { useStore } from "@nanostores/react";
import { useLayoutEffect, useMemo } from "react";
import { openAgent, openHire } from "../nav";
import { $data } from "../store";
import { orgTree, peopleRows } from "./company-model";

/** The People page, pushed from Company: everyone, and who reports to whom.
    `navigation` is whichever stack pushed it. */
export function PeopleContainer({
  navigation,
}: {
  navigation: { setOptions: (o: { title: string }) => void };
}) {
  const d = useStore($data);
  const people = useMemo(() => peopleRows(d), [d]);
  const org = useMemo(() => orgTree(d), [d]);
  useLayoutEffect(() => {
    navigation.setOptions({ title: "People" });
  }, [navigation]);
  return (
    <PeopleScreen
      people={people}
      org={org}
      onOpenAgent={openAgent}
      onHire={openHire}
    />
  );
}
