import { useState } from "react";
import { View } from "react-native";
import { EmptyState, Module, Modules, Page, Segmented, T } from "../kit";
import type { ThreadRowVM, TicketRowVM } from "../types";
import { FoldModule, ProjectRow } from "./work-parts";
import type { ProjectList, ProjectScreenProps, WorkView } from "./work-types";

const VIEWS: { key: WorkView; label: string }[] = [
  { key: "threads", label: "Threads" },
  { key: "tickets", label: "Tickets" },
];

/** The open rows in one module, the finished ones folded under it. */
function Lists<Row extends { id: string }>({
  list,
  noun,
  render,
}: {
  list: ProjectList<Row>;
  /** "threads" / "tickets", for the empty line. */
  noun: string;
  render: (row: Row, folded: boolean) => React.ReactNode;
}) {
  const [doneOpen, setDoneOpen] = useState(false);
  return (
    <>
      <Module title="Open" count={list.open.length}>
        {list.open.length === 0 ? (
          <T variant="small" tone="ink2">
            {`No open ${noun}.`}
          </T>
        ) : (
          list.open.map((r) => render(r, false))
        )}
      </Module>
      {list.done.length > 0 ? (
        <FoldModule
          testID="project-done"
          title="Done"
          count={list.done.length}
          open={doneOpen}
          onToggle={() => setDoneOpen((o) => !o)}
        >
          {list.done.map((r) => render(r, true))}
        </FoldModule>
      ) : null}
    </>
  );
}

/** One project's page: every thread or ticket in it, finished work folded.
    The native header carries the project's name. */
export function ProjectScreen({
  page,
  view,
  onView,
  onOpenThread,
  onOpenTicket,
}: ProjectScreenProps) {
  if (!page) {
    return (
      <Page testID="project-screen">
        <EmptyState
          title="Project not found"
          body="It is no longer in the company."
        />
      </Page>
    );
  }
  const { tickets } = page;
  const threadRow = (r: ThreadRowVM, folded: boolean) => (
    <ProjectRow
      key={r.id}
      testID={`project-thread-${r.id}`}
      who={r.agent}
      title={r.title}
      status={r.status}
      statusWord={r.statusWord}
      folded={folded}
      where={r.tag === page.name ? undefined : r.tag}
      detail={r.detail}
      unseen={r.unseen}
      label={`${r.title}, ${r.agent.name}, ${r.statusWord}`}
      onPress={() => onOpenThread(r.id)}
    />
  );
  const ticketRow = (r: TicketRowVM, folded: boolean) => (
    <ProjectRow
      key={r.id}
      testID={`project-ticket-${r.id}`}
      who={r.owner}
      title={r.title}
      status={r.status}
      statusWord={r.statusWord}
      folded={folded}
      where={r.id}
      detail={r.detail}
      label={`${r.id}, ${r.title}, ${r.statusWord}`}
      onPress={() => onOpenTicket(r.id)}
    />
  );
  return (
    <Page testID="project-screen">
      <Modules>
        {page.about ? (
          <T variant="small" tone="ink2" className="px-1" numberOfLines={2}>
            {page.about}
          </T>
        ) : null}
        {tickets ? (
          <View className="-mx-5">
            <Segmented options={VIEWS} value={view} onChange={onView} />
          </View>
        ) : null}
        {tickets && view === "tickets" ? (
          <Lists
            key="tickets"
            list={tickets}
            noun="tickets"
            render={ticketRow}
          />
        ) : (
          <Lists
            key="threads"
            list={page.threads}
            noun="threads"
            render={threadRow}
          />
        )}
      </Modules>
    </Page>
  );
}
