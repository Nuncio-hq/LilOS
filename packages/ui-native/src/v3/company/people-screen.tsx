import { Page } from "../kit";
import { OrgSection, PeopleSection } from "./people";
import type { PeopleScreenProps } from "./types";

/** The People page: everyone in the company, then who reports to whom. The
    native header carries the title. */
export function PeopleScreen({
  people,
  org,
  onOpenAgent,
  onHire,
}: PeopleScreenProps) {
  return (
    <Page testID="people-screen">
      <PeopleSection
        people={people}
        onOpenAgent={onOpenAgent}
        onHire={onHire}
      />
      {org.length ? <OrgSection org={org} onOpenAgent={onOpenAgent} /> : null}
    </Page>
  );
}
