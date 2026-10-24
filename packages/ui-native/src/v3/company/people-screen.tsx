import { Module, Modules, Page, T } from "../kit";
import { OrgChart } from "./people";
import type { PeopleScreenProps } from "./types";

/** The People page: everyone in the company, indented under who they report
    to. The native header carries the title. */
export function PeopleScreen({ summary, org, onOpenAgent }: PeopleScreenProps) {
  return (
    <Page testID="people-screen">
      <Modules>
        <T variant="small" tone="ink2" className="px-1">
          {summary}
        </T>
        <Module title="Org chart" testID="people-org">
          <OrgChart org={org} onOpenAgent={onOpenAgent} />
        </Module>
      </Modules>
    </Page>
  );
}
