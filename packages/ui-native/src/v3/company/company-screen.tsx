import { AvatarGrid, Module, Modules, Page } from "../kit";
import { GoalsModule, ProjectsModule } from "./goals";
import type { CompanyScreenProps } from "./types";

/** The Company tab: who works here (a grid, the header opens the full
    People page), what the company is after, and where the work lives. The
    native header carries the title and the Hire button. */
export function CompanyScreen({
  people,
  goals,
  projects,
  onOpenAgent,
  onOpenPeople,
  onOpenProject,
}: CompanyScreenProps) {
  return (
    <Page testID="company-screen">
      <Modules>
        <Module
          title="People"
          count={people.length}
          testID="company-people"
          onOpen={onOpenPeople}
        >
          <AvatarGrid people={people} columns={4} onPress={onOpenAgent} />
        </Module>
        {goals.length > 0 ? <GoalsModule goals={goals} /> : null}
        {projects.length > 0 ? (
          <ProjectsModule projects={projects} onOpenProject={onOpenProject} />
        ) : null}
      </Modules>
    </Page>
  );
}
