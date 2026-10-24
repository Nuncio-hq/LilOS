import { EmptyState, Module, Modules, Page, T } from "../kit";
import { WorkItemRow } from "./work-parts";
import type { WorkScreenProps } from "./work-types";

/** Lines a project's module shows; its header opens the page with the rest. */
const TOP = 3;

/** The Work tab: what wants a person first, then one module per project with
    its top few items and a one-line count. The native header carries the
    title. */
export function WorkScreen({
  attention,
  projects,
  onOpenItem,
  onOpenProject,
}: WorkScreenProps) {
  return (
    <Page testID="work-screen">
      <Modules>
        {attention.length > 0 ? (
          <Module title="Attention">
            {attention.map((item) => (
              <WorkItemRow
                key={item.key}
                item={item}
                showWhere
                onPress={onOpenItem}
              />
            ))}
          </Module>
        ) : null}
        {projects.length === 0 ? (
          <EmptyState
            title="No projects yet"
            body="Work shows up here once the company has a project."
          />
        ) : (
          projects.map((p) => (
            <Module
              key={p.id}
              testID={`work-project-${p.id}`}
              title={p.name}
              onOpen={() => onOpenProject(p.id)}
            >
              <T variant="caption" tone="ink2">
                {p.summary}
              </T>
              {p.items.slice(0, TOP).map((item) => (
                <WorkItemRow key={item.key} item={item} onPress={onOpenItem} />
              ))}
            </Module>
          ))
        )}
      </Modules>
    </Page>
  );
}
