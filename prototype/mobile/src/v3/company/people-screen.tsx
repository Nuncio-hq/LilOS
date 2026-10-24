import { PeopleScreen } from "@lilos/ui-native/v3";
import { useStore } from "@nanostores/react";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useLayoutEffect, useMemo } from "react";
import type { RootRoutes } from "../nav";
import { openAgent } from "../nav";
import { $data } from "../store";
import { orgTree, peopleSummary } from "./company-model";
import { HIRE_BUTTON } from "./hire-button";

const SERIF = { fontFamily: "Charter" } as const;

/** The People page, pushed from Company: everyone, indented under who they
    report to, under a large "People" title. Hire is the `+` here too. */
export function PeopleContainer({
  navigation,
}: NativeStackScreenProps<RootRoutes, "People">) {
  const d = useStore($data);
  const org = useMemo(() => orgTree(d), [d]);
  const summary = useMemo(() => peopleSummary(d), [d]);
  useLayoutEffect(() => {
    navigation.setOptions({
      title: "People",
      headerLargeTitle: true,
      headerLargeTitleShadowVisible: false,
      headerLargeTitleStyle: SERIF,
      ...HIRE_BUTTON,
    });
  }, [navigation]);
  return <PeopleScreen summary={summary} org={org} onOpenAgent={openAgent} />;
}
