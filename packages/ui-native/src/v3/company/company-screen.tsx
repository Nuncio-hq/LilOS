import { Page, SerifTitle } from "../kit";
import { GoalsSection, ProjectsSection } from "./goals";
import { OrgSection, PeopleSection } from "./people";
import type { CompanyScreenProps } from "./types";

/** The Company tab: who works here, who reports to whom, what the company is
    after and where the work lives. */
export function CompanyScreen({
  people,
  org,
  goals,
  projects,
  onOpenAgent,
  onHire,
}: CompanyScreenProps) {
  return (
    <Page testID="company-screen">
      <SerifTitle>Company</SerifTitle>
      <PeopleSection
        people={people}
        onOpenAgent={onOpenAgent}
        onHire={onHire}
      />
      {org.length ? <OrgSection org={org} onOpenAgent={onOpenAgent} /> : null}
      {goals.length ? <GoalsSection goals={goals} /> : null}
      {projects.length ? <ProjectsSection projects={projects} /> : null}
    </Page>
  );
}
