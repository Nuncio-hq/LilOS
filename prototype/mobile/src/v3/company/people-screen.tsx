import { PeopleScreen } from "@lilos/ui-native/v3";
import { useStore } from "@nanostores/react";
import { useMemo } from "react";
import { openAgent } from "../nav";
import { $data } from "../store";
import { orgTree, peopleSummary } from "./company-model";

/** The People page, pushed from Company: everyone, indented under who they
    report to. Its large title and the Hire `+` come from the stack. */
export function PeopleContainer() {
  const d = useStore($data);
  const org = useMemo(() => orgTree(d), [d]);
  const summary = useMemo(() => peopleSummary(d), [d]);
  return <PeopleScreen summary={summary} org={org} onOpenAgent={openAgent} />;
}
