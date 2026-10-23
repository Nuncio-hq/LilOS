import { View } from "react-native";
import { CeoChip, Page, SectionBlock, StatusLabel, T } from "../kit";
import { ListRow, ThreadRow } from "../rows";
import {
  EngineSection,
  InstructionsSection,
  NotesSection,
  SkillsSection,
  WeekSection,
} from "./agent-parts";
import type { AgentPageProps } from "./types";

/** One agent or outside worker: who they are, what they hold now, what they
    were told and know, and their threads. Sections with nothing to say are
    left out. */
export function AgentScreen({
  person,
  status,
  statusWord,
  roleLine,
  description,
  engine,
  ticket,
  nextRun,
  instructions,
  notes,
  skills,
  week,
  spend,
  threads,
  onOpenTicket,
  onOpenThread,
}: AgentPageProps) {
  return (
    <Page testID="agent-screen">
      <View className="gap-1.5 px-5 pt-2">
        <View className="flex-row items-center gap-2.5">
          <T variant="title" className="shrink" style={{ letterSpacing: -0.4 }}>
            {person.name}
          </T>
          {person.isCeo ? <CeoChip /> : null}
        </View>
        <T variant="small" tone="ink2">
          {roleLine}
        </T>
        <View className="self-start pt-0.5">
          <StatusLabel status={status} label={statusWord} />
        </View>
        {description ? (
          <T variant="small" className="pt-2">
            {description}
          </T>
        ) : null}
      </View>

      {ticket || nextRun ? (
        <SectionBlock title={ticket ? "Now" : "Next run"}>
          {ticket ? (
            <ListRow
              testID="agent-ticket"
              label={`${ticket.id}, ${ticket.title}`}
              onPress={() => onOpenTicket(ticket.id)}
              last={!nextRun}
            >
              <View className="gap-0.5">
                <T variant="label" numberOfLines={2}>
                  {ticket.title}
                </T>
                <T variant="caption" tone="ink2">
                  {`${ticket.id} · ${ticket.since}`}
                </T>
              </View>
            </ListRow>
          ) : null}
          {nextRun ? (
            <ListRow last>
              <View className="gap-0.5">
                {ticket ? (
                  <T variant="caption" tone="ink3">
                    Next run
                  </T>
                ) : null}
                <T variant="small">{nextRun}</T>
              </View>
            </ListRow>
          ) : null}
        </SectionBlock>
      ) : null}

      {engine.length ? <EngineSection rows={engine} /> : null}
      {instructions.length ? (
        <InstructionsSection items={instructions} />
      ) : null}
      {notes.length ? <NotesSection notes={notes} /> : null}
      {skills.length ? <SkillsSection skills={skills} /> : null}
      {week || spend ? <WeekSection week={week} spend={spend} /> : null}

      {threads.length ? (
        <SectionBlock title="Threads">
          {threads.map((row, i) => (
            <ThreadRow
              key={row.id}
              row={row}
              onPress={onOpenThread}
              last={i === threads.length - 1}
            />
          ))}
        </SectionBlock>
      ) : null}
    </Page>
  );
}
