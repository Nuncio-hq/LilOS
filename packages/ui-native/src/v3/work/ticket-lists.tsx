import { useState } from "react";
import { View } from "react-native";
import { Icon } from "../../components/icon";
import { Avatar, ClampText, CompactRow, Module, PersonName, T } from "../kit";
import type { ThreadRowVM } from "../types";
import type {
  TicketFact,
  TicketResultVM,
  TicketUpdateVM,
} from "./ticket-types";

/** Lines a module shows before it says "n more". */
const TOP_THREADS = 3;
const TOP_UPDATES = 2;

/** The ticket's threads, one line each; "more" unfolds the rest in place
    (a ticket's threads have no page of their own). */
export function TicketThreadsModule({
  threads,
  onOpenThread,
}: {
  threads: ThreadRowVM[];
  onOpenThread: (threadId: string) => void;
}) {
  const [all, setAll] = useState(false);
  const shown = all ? threads : threads.slice(0, TOP_THREADS);
  const hidden = threads.length - TOP_THREADS;
  return (
    <Module
      title="Threads"
      count={threads.length}
      testID="ticket-threads"
      footer={
        hidden > 0
          ? {
              label: all ? "Show less" : `${hidden} more`,
              onPress: () => setAll((v) => !v),
            }
          : undefined
      }
    >
      {shown.map((t) => (
        <CompactRow
          key={t.id}
          testID={`ticket-thread-${t.id}`}
          dot={t.status}
          title={t.title}
          trailing={<Avatar person={t.agent} size={22} />}
          onPress={() => onOpenThread(t.id)}
        />
      ))}
    </Module>
  );
}

function UpdateRow({ update }: { update: TicketUpdateVM }) {
  const [open, setOpen] = useState(false);
  return (
    <View className="flex-row items-start gap-2.5 py-1">
      {update.who ? <Avatar person={update.who} size={26} /> : null}
      <View className="flex-1 gap-0.5">
        <View className="flex-row items-center gap-2">
          {update.who ? (
            <PersonName person={update.who} variant="small" />
          ) : (
            <T variant="small" className="font-semibold">
              LilOS
            </T>
          )}
          <T variant="caption" tone="ink3">
            {update.ago}
          </T>
        </View>
        {open ? (
          <T variant="small" tone="ink2">
            {update.text}
          </T>
        ) : (
          <ClampText lines={2} tone="ink2" onMore={() => setOpen(true)}>
            {update.text}
          </ClampText>
        )}
      </View>
    </View>
  );
}

/** The latest two updates, newest first; "more" unfolds the older ones. */
export function TicketUpdatesModule({
  updates,
}: {
  updates: TicketUpdateVM[];
}) {
  const [all, setAll] = useState(false);
  const shown = all ? updates : updates.slice(0, TOP_UPDATES);
  const hidden = updates.length - TOP_UPDATES;
  return (
    <Module
      title="Updates"
      count={updates.length}
      testID="ticket-updates"
      footer={
        hidden > 0
          ? {
              label: all ? "Show less" : `${hidden} more`,
              onPress: () => setAll((v) => !v),
            }
          : undefined
      }
    >
      {shown.map((u) => (
        <UpdateRow key={u.id} update={u} />
      ))}
    </Module>
  );
}

/** The pull request and the files a finished piece of work left behind. */
export function TicketResultModule({ result }: { result: TicketResultVM }) {
  return (
    <Module title="Result" testID="ticket-result">
      {result.pr ? (
        <View className="flex-row items-center gap-2.5 py-1">
          <Icon name="arrow.triangle.pull" size={16} />
          <T variant="small" className="flex-1" numberOfLines={2}>
            {result.pr}
          </T>
        </View>
      ) : null}
      {result.files.map((f) => (
        <View key={f.name} className="flex-row items-start gap-2.5 py-1">
          <View className="pt-0.5">
            <Icon name="doc.text" size={16} tone="muted-foreground" />
          </View>
          <View className="flex-1">
            <T variant="small" numberOfLines={1}>
              {f.name}
            </T>
            <T variant="caption" tone="ink3" numberOfLines={2}>
              {f.note}
            </T>
          </View>
        </View>
      ))}
    </Module>
  );
}

/** What the header does not say, two to a row: label over value. */
export function TicketDetailsModule({ facts }: { facts: TicketFact[] }) {
  return (
    <Module title="Details" testID="ticket-details">
      <View className="-mx-1 flex-row flex-wrap">
        {facts.map((f) => (
          <View key={f.label} className="w-1/2 gap-px px-1 py-1.5">
            <T variant="caption" tone="ink3">
              {f.label}
            </T>
            <T variant="small" numberOfLines={3}>
              {f.value}
            </T>
          </View>
        ))}
      </View>
    </Module>
  );
}
