import { Pressable, ScrollView, Text, View } from "react-native";
import { AppText } from "../components/app-text";
import { LargeTitle, SectionTitle } from "../components/bits";
import { Icon } from "../components/icon";
import { Orb } from "../components/orb";
import type { SessionListGroups, SessionListRow } from "./types";

/* One session row: the employee's orb, the session title, then employee ·
   folder · state and the live line (current step / open ask). An unread
   finished row leads with the blue dot — "done since you last looked". */
function SessionItem({
  r,
  onOpen,
}: {
  r: SessionListRow;
  onOpen: (r: SessionListRow) => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${r.title}, ${r.employeeName}, ${r.state}`}
      onPress={() => onOpen(r)}
      className="flex-row items-center gap-3 px-4 py-2.5 active:opacity-70"
    >
      <Orb tone={r.tone} size={28} badge={false} />
      <View className="min-w-0 flex-1">
        <View className="flex-row items-baseline gap-2">
          <AppText
            size="sm"
            weight={r.unread ? "bold" : "semibold"}
            numberOfLines={1}
            className="flex-1 text-[14px] leading-[18px]"
          >
            {r.title}
          </AppText>
          <AppText size="xs" tone="muted">
            {r.when}
          </AppText>
        </View>
        <View className="flex-row items-center gap-1">
          {r.unread && <View className="size-2 rounded-full bg-primary" />}
          <AppText size="xs" tone="muted" numberOfLines={1} className="flex-1">
            {[r.employeeName, r.folder, r.state]
              .filter(Boolean)
              .join(" · ")}
          </AppText>
        </View>
        {r.live ? (
          <AppText
            size="xs"
            numberOfLines={1}
            className={
              r.state === "needs-you" ? "text-amber-500" : "text-teal-500"
            }
          >
            {r.live}
          </AppText>
        ) : null}
      </View>
      <Icon name="chevron.right" size={12} tone="muted" />
    </Pressable>
  );
}

function Group({
  title,
  rows,
  onOpen,
}: {
  title: string;
  rows: SessionListRow[];
  onOpen: (r: SessionListRow) => void;
}) {
  if (!rows.length) return null;
  return (
    <View>
      <SectionTitle title={`${title} · ${rows.length}`} />
      {rows.map((r) => (
        <SessionItem key={r.id} r={r} onOpen={onOpen} />
      ))}
    </View>
  );
}

/* The cross-employee session list: every session grouped Needs you /
   Working / Recently finished (unread first). Rows are DM sessions — a tap
   opens the thread. */
export function SessionsScreen({
  groups,
  onOpen,
}: {
  groups: SessionListGroups;
  onOpen: (r: SessionListRow) => void;
}) {
  const empty =
    !groups.needsYou.length && !groups.running.length && !groups.finished.length;
  return (
    <ScrollView
      className="flex-1"
      contentInsetAdjustmentBehavior="automatic"
      contentContainerClassName="pb-10"
    >
      <LargeTitle title="Sessions" />
      {empty ? (
        <View className="items-center gap-2 px-8 pt-20">
          <Icon name="checklist" size={34} tone="muted" />
          <AppText weight="semibold">No sessions yet</AppText>
          <AppText size="sm" tone="muted" className="text-center">
            DM an employee to start a session — working, waiting and finished
            sessions list here.
          </AppText>
        </View>
      ) : (
        <>
          <Group title="Needs you" rows={groups.needsYou} onOpen={onOpen} />
          <Group title="Working" rows={groups.running} onOpen={onOpen} />
          <Group
            title="Recently finished"
            rows={groups.finished}
            onOpen={onOpen}
          />
        </>
      )}
    </ScrollView>
  );
}
