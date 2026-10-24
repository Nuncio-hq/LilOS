import { useState } from "react";
import { EmptyState, Module, Modules, Page, T } from "../kit";
import { WorkItemRow } from "./work-parts";
import type { WorkScreenProps } from "./work-types";

/** Lines a module shows before it says "n more". */
const TOP = 3;

/** The Work tab: what wants you, then one module per project with its top
    few items. The native header carries the title. */
export function WorkScreen({
  attention,
  projects,
  onOpenItem,
  onOpenProject,
}: WorkScreenProps) {
  // Attention has no page of its own: "more" unfolds it in place.
  const [allAttention, setAllAttention] = useState(false);
  const shown = allAttention ? attention : attention.slice(0, TOP);
  const hidden = attention.length - TOP;

  return (
    <Page testID="work-screen">
      <Modules>
        {attention.length > 0 ? (
          <Module
            title="Attention"
            count={attention.length}
            footer={
              hidden > 0
                ? {
                    label: allAttention ? "Show less" : `${hidden} more`,
                    onPress: () => setAllAttention((v) => !v),
                  }
                : undefined
            }
          >
            {shown.map((item) => (
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
              footer={
                p.items.length > TOP
                  ? {
                      label: `${p.items.length - TOP} more`,
                      onPress: () => onOpenProject(p.id),
                    }
                  : undefined
              }
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
