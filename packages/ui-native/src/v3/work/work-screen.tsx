import { useState } from "react";
import { View } from "react-native";
import { EmptyState, Page, Segmented, SerifTitle } from "../kit";
import { ThreadRow, TicketRow } from "../rows";
import { DoneToggle, GroupHead } from "./work-parts";
import type { WorkThreadGroup, WorkTicketGroup, WorkView } from "./work-types";

const VIEWS: { key: WorkView; label: string }[] = [
  { key: "threads", label: "Threads" },
  { key: "tickets", label: "Tickets" },
];

export function WorkScreen({
  view,
  onView,
  threads,
  tickets,
  onOpenThread,
  onOpenTicket,
}: {
  view: WorkView;
  onView: (view: WorkView) => void;
  threads: WorkThreadGroup[];
  tickets: WorkTicketGroup[];
  onOpenThread: (id: string) => void;
  onOpenTicket: (id: string) => void;
}) {
  // Kept here, not per group, so a group stays open across a Threads/Tickets switch.
  const [openDone, setOpenDone] = useState<ReadonlySet<string>>(new Set());
  const toggleDone = (id: string) =>
    setOpenDone((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  return (
    <Page testID="work-screen">
      <SerifTitle>Work</SerifTitle>
      <Segmented options={VIEWS} value={view} onChange={onView} />
      {view === "threads" ? (
        threads.length === 0 ? (
          <EmptyState
            title="No threads yet"
            body="Threads appear here as soon as you or an agent starts one."
          />
        ) : (
          threads.map((g) => (
            <View key={g.id} testID={`work-group-${g.id}`}>
              <GroupHead name={g.name} caption={g.caption} about={g.about} />
              {g.rows.map((r, i) => (
                <ThreadRow
                  key={r.id}
                  row={r}
                  onPress={onOpenThread}
                  last={g.quiet.length === 0 && i === g.rows.length - 1}
                />
              ))}
              {g.quiet.length > 0 ? (
                <View className="opacity-60">
                  {g.quiet.map((r, i) => (
                    <ThreadRow
                      key={r.id}
                      row={r}
                      onPress={onOpenThread}
                      last={i === g.quiet.length - 1}
                    />
                  ))}
                </View>
              ) : null}
            </View>
          ))
        )
      ) : tickets.length === 0 ? (
        <EmptyState
          title="No tickets yet"
          body="Tickets appear here when the CEO plans work for a project."
        />
      ) : (
        tickets.map((g) => {
          const open = openDone.has(g.id);
          return (
            <View key={g.id} testID={`work-group-${g.id}`}>
              <GroupHead name={g.name} caption={g.caption} about={g.about} />
              {g.rows.map((r, i) => (
                <TicketRow
                  key={r.id}
                  row={r}
                  onPress={onOpenTicket}
                  last={g.done.length === 0 && i === g.rows.length - 1}
                />
              ))}
              {g.done.length > 0 ? (
                <DoneToggle
                  groupId={g.id}
                  count={g.done.length}
                  open={open}
                  onPress={() => toggleDone(g.id)}
                />
              ) : null}
              {open ? (
                <View className="opacity-60">
                  {g.done.map((r, i) => (
                    <TicketRow
                      key={r.id}
                      row={r}
                      onPress={onOpenTicket}
                      last={i === g.done.length - 1}
                    />
                  ))}
                </View>
              ) : null}
            </View>
          );
        })
      )}
    </Page>
  );
}
