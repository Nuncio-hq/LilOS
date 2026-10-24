import { useState } from "react";
import { View } from "react-native";
import { EmptyState, Page, Segmented } from "../kit";
import { ThreadRow, TicketRow } from "../rows";
import { DoneToggle, GroupHead } from "./work-parts";
import type { ProjectPageVM, WorkView } from "./work-types";

const VIEWS: { key: WorkView; label: string }[] = [
  { key: "threads", label: "Threads" },
  { key: "tickets", label: "Tickets" },
];

/** One project's page: every thread and ticket in it, done work folded. The
    native header carries the project's name. `page` is absent when the
    project is gone. */
export function ProjectScreen({
  page,
  view,
  onView,
  onOpenThread,
  onOpenTicket,
}: {
  page: ProjectPageVM | undefined;
  view: WorkView;
  onView: (view: WorkView) => void;
  onOpenThread: (id: string) => void;
  onOpenTicket: (id: string) => void;
}) {
  const [doneOpen, setDoneOpen] = useState(false);
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
  const { threads, tickets } = page;
  return (
    <Page testID="project-screen">
      {tickets ? (
        <View className="pt-2">
          <Segmented options={VIEWS} value={view} onChange={onView} />
        </View>
      ) : null}
      {view === "threads" || !tickets ? (
        <View>
          <GroupHead
            name={page.name}
            caption={threads.caption}
            about={page.about}
          />
          {threads.rows.length === 0 && threads.quiet.length === 0 ? (
            <EmptyState title="No threads yet" />
          ) : null}
          {threads.rows.map((r, i) => (
            <ThreadRow
              key={r.id}
              row={r}
              onPress={onOpenThread}
              last={threads.quiet.length === 0 && i === threads.rows.length - 1}
            />
          ))}
          {threads.quiet.map((r, i) => (
            <View key={r.id} className="opacity-60">
              <ThreadRow
                row={r}
                onPress={onOpenThread}
                last={i === threads.quiet.length - 1}
              />
            </View>
          ))}
        </View>
      ) : (
        <View>
          <GroupHead
            name={page.name}
            caption={tickets.caption}
            about={page.about}
          />
          {tickets.rows.map((r, i) => (
            <TicketRow
              key={r.id}
              row={r}
              onPress={onOpenTicket}
              last={tickets.done.length === 0 && i === tickets.rows.length - 1}
            />
          ))}
          {tickets.done.length > 0 ? (
            <DoneToggle
              groupId={page.id}
              count={tickets.done.length}
              open={doneOpen}
              onPress={() => setDoneOpen((o) => !o)}
            />
          ) : null}
          {doneOpen ? (
            <View className="opacity-60">
              {tickets.done.map((r, i) => (
                <TicketRow
                  key={r.id}
                  row={r}
                  onPress={onOpenTicket}
                  last={i === tickets.done.length - 1}
                />
              ))}
            </View>
          ) : null}
        </View>
      )}
    </Page>
  );
}
