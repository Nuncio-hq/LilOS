import { useState } from "react";
import { Pressable, View } from "react-native";
import { Icon } from "../../components/icon";
import { ClampText, CompactRow, Module, T, Tag } from "../kit";
import type { ThreadRowVM } from "../types";
import type { NoteVM, SkillVM } from "./types";

/* The modules of an agent's page. Instructions, notes and skills are
   read-only here. Each shows a few lines and unfolds in place: none of them
   has a page of its own. */

const TOP_THREADS = 3;
const TOP_NOTES = 2;
const INSTRUCTION_LINES = 3;

/** What it was told, three lines; "more" shows every rule. */
export function InstructionsModule({ items }: { items: string[] }) {
  const [all, setAll] = useState(false);
  return (
    <Module title="Instructions" testID="agent-instructions">
      {all ? (
        <View className="gap-2">
          {items.map((text) => (
            <T key={text} variant="small">
              {text}
            </T>
          ))}
        </View>
      ) : (
        <ClampText lines={INSTRUCTION_LINES} onMore={() => setAll(true)}>
          {items.join("\n")}
        </ClampText>
      )}
    </Module>
  );
}

function NoteRow({
  note,
  open,
  onToggle,
}: {
  note: NoteVM;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <Pressable
      testID={`note-${note.id}`}
      accessibilityRole="button"
      accessibilityLabel={`${note.name}, ${open ? "collapse" : "expand"}`}
      accessibilityState={{ expanded: open }}
      onPress={onToggle}
      className="gap-0.5 py-1.5 active:opacity-60"
    >
      <View className="flex-row items-center gap-2">
        <T variant="small" numberOfLines={1} className="flex-1 font-semibold">
          {note.name}
        </T>
        <T variant="caption" tone="ink3">
          {note.updated}
        </T>
        <Icon
          name={open ? "chevron.up" : "chevron.down"}
          size={11}
          tone="muted-foreground"
          weight="semibold"
        />
      </View>
      {open ? (
        <T variant="small" tone="ink2" selectable>
          {note.text}
        </T>
      ) : (
        <T variant="caption" tone="ink2" numberOfLines={1}>
          {note.firstLine}
        </T>
      )}
    </Pressable>
  );
}

/** The two newest notes; a tap reads one in full, "more" lists the rest. */
export function NotesModule({ notes }: { notes: NoteVM[] }) {
  const [openId, setOpenId] = useState<string | undefined>();
  const [all, setAll] = useState(false);
  const shown = all ? notes : notes.slice(0, TOP_NOTES);
  const hidden = notes.length - TOP_NOTES;
  return (
    <Module
      title="Notes"
      count={notes.length}
      testID="agent-notes"
      footer={
        hidden > 0
          ? {
              label: all ? "Show less" : `${hidden} more`,
              onPress: () => setAll((v) => !v),
            }
          : undefined
      }
    >
      {shown.map((n) => (
        <NoteRow
          key={n.id}
          note={n}
          open={openId === n.id}
          onToggle={() => setOpenId(openId === n.id ? undefined : n.id)}
        />
      ))}
    </Module>
  );
}

export function SkillsModule({ skills }: { skills: SkillVM[] }) {
  return (
    <Module title="Skills" count={skills.length} testID="agent-skills">
      <View className="flex-row flex-wrap gap-1.5 pt-0.5">
        {skills.map((s) => (
          <Tag key={s.id}>{s.name}</Tag>
        ))}
      </View>
    </Module>
  );
}

/** The agent's threads, most urgent first, one line each. */
export function AgentThreadsModule({
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
      testID="agent-threads"
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
          testID={`agent-thread-${t.id}`}
          dot={t.status}
          title={t.title}
          meta={t.tag}
          onPress={() => onOpenThread(t.id)}
        />
      ))}
    </Module>
  );
}

/** Where the agent runs; an outside worker is reached through a connector
    instead. */
export function RunsOnModule({
  line,
  outside,
}: {
  line: string;
  outside: boolean;
}) {
  return (
    <Module
      title={outside ? "Reached through" : "Runs on"}
      testID="agent-runs-on"
    >
      <T variant="small" tone="ink2">
        {line}
      </T>
    </Module>
  );
}
