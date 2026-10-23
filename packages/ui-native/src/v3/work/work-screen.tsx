import { useState } from "react";
import { Pressable, View } from "react-native";
import { Icon } from "../../components/icon";
import { EmptyState, Page, Segmented, SerifTitle, T } from "../kit";
import { ThreadRow, TicketRow } from "../rows";
import type { WorkThreadGroup, WorkTicketGroup, WorkView } from "./work-types";

const VIEWS: { key: WorkView; label: string }[] = [
  { key: "threads", label: "Threads" },
  { key: "tickets", label: "Tickets" },
];

/** A project's name with how much is open, and what it is about. */
function GroupHead({
  name,
  caption,
  about,
}: {
  name: string;
  caption: string;
  about?: string;
}) {
  return (
    <View className="px-5 pt-7 pb-1.5">
      <View className="flex-row items-baseline justify-between gap-3">
        <T variant="heading" numberOfLines={1} className="flex-1">
          {name}
        </T>
        <T variant="caption" tone="ink3">
          {caption}
        </T>
      </View>
      {about ? (
        <T variant="caption" tone="ink2" numberOfLines={2} className="pt-0.5">
          {about}
        </T>
      ) : null}
    </View>
  );
}

/** The collapsed "N done" line: done work stays out of sight until asked. */
function DoneToggle({
  groupId,
  count,
  open,
  onPress,
}: {
  groupId: string;
  count: number;
  open: boolean;
  onPress: () => void;
}) {
  const label = `${count} done`;
  return (
    <Pressable
      testID={`work-done-${groupId}`}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ expanded: open }}
      onPress={onPress}
      className="h-11 flex-row items-center gap-1.5 px-5 active:bg-paper-soft"
    >
      <T variant="small" tone="ink3">
        {label}
      </T>
      <Icon
        name={open ? "chevron.down" : "chevron.right"}
        size={11}
        tone="muted-foreground"
        weight="semibold"
      />
    </Pressable>
  );
}

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
