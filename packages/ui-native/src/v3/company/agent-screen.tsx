import { Pressable, Text, View } from "react-native";
import { Icon } from "../../components/icon";
import {
  AvatarRing,
  CeoChip,
  ClampText,
  Modules,
  Page,
  StatusLabel,
  T,
} from "../kit";
import {
  AgentThreadsModule,
  InstructionsModule,
  NotesModule,
  RunsOnModule,
  SkillsModule,
} from "./agent-parts";
import type { AgentPageProps } from "./types";

const SERIF = { fontFamily: "Charter" } as const;

/** One agent or outside worker: who they are and what they hold now, then
    modules. Modules with nothing to say are left out. */
export function AgentScreen({
  person,
  status,
  statusWord,
  roleLine,
  description,
  now,
  nextRun,
  week,
  spend,
  runsOn,
  instructions,
  notes,
  skills,
  threads,
  onOpenTicket,
  onOpenThread,
}: AgentPageProps) {
  const stats = [week, spend].filter(Boolean).join(" · ");
  return (
    <Page testID="agent-screen">
      <Modules>
        <View
          testID="agent-header"
          className="gap-3 rounded-[22px] bg-paper-soft p-4"
          style={{ borderCurve: "continuous" }}
        >
          <View className="flex-row items-center gap-3.5">
            <AvatarRing
              name={person.name}
              status={status}
              size={52}
              outside={person.outside}
            />
            <View className="flex-1 gap-0.5">
              <View className="flex-row items-center gap-2">
                <Text
                  accessibilityRole="header"
                  className="shrink font-semibold text-[24px] text-ink leading-[30px]"
                  style={SERIF}
                  numberOfLines={1}
                >
                  {person.name}
                </Text>
                {person.isCeo ? <CeoChip /> : null}
              </View>
              <T variant="caption" tone="ink2" numberOfLines={1}>
                {roleLine}
              </T>
            </View>
          </View>
          <StatusLabel status={status} label={statusWord} />
          {description ? (
            <ClampText lines={2} tone="ink2">
              {description}
            </ClampText>
          ) : null}
          {now ? (
            <Pressable
              testID="agent-ticket"
              accessibilityRole="button"
              accessibilityLabel={`${now.id}, ${now.title}`}
              onPress={() => onOpenTicket(now.id)}
              className="flex-row items-center gap-2 active:opacity-60"
            >
              <View className="flex-1 gap-0.5">
                <T variant="small" className="font-semibold" numberOfLines={2}>
                  {now.title}
                </T>
                <T variant="caption" tone="ink3" numberOfLines={1}>
                  {`${now.id} · ${now.since}`}
                </T>
              </View>
              <Icon
                name="chevron.right"
                size={12}
                tone="muted-foreground"
                weight="semibold"
              />
            </Pressable>
          ) : nextRun ? (
            <View className="gap-0.5">
              <T variant="caption" tone="ink3">
                Next run
              </T>
              <T variant="small" numberOfLines={2}>
                {nextRun}
              </T>
            </View>
          ) : null}
          {stats ? (
            <T variant="caption" tone="ink3" numberOfLines={2}>
              {stats}
            </T>
          ) : null}
        </View>
        {threads.length > 0 ? (
          <AgentThreadsModule threads={threads} onOpenThread={onOpenThread} />
        ) : null}
        {instructions.length > 0 ? (
          <InstructionsModule items={instructions} />
        ) : null}
        {notes.length > 0 ? <NotesModule notes={notes} /> : null}
        {skills.length > 0 ? <SkillsModule skills={skills} /> : null}
        {runsOn ? (
          <RunsOnModule line={runsOn} outside={person.outside} />
        ) : null}
      </Modules>
    </Page>
  );
}
