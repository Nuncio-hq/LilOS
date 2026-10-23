import { useState } from "react";
import { View } from "react-native";
import { Icon } from "../../components/icon";
import { Note, SectionBlock, T } from "../kit";
import { ListRow } from "../rows";
import type { NoteVM, SkillVM } from "./types";

/* The read-only parts of an agent's page: what it was told, what it
   remembers, what it can do. */

export function EngineSection({
  rows,
}: {
  rows: { label: string; value: string }[];
}) {
  return (
    <SectionBlock title="Runs on">
      {rows.map((r, i) => (
        <ListRow key={r.label} last={i === rows.length - 1}>
          <View className="min-h-[32px] flex-row items-center justify-between gap-4">
            <T variant="small" tone="ink2">
              {r.label}
            </T>
            <T variant="small" className="shrink font-semibold">
              {r.value}
            </T>
          </View>
        </ListRow>
      ))}
    </SectionBlock>
  );
}

export function InstructionsSection({ items }: { items: string[] }) {
  return (
    <SectionBlock title="Instructions">
      <View className="gap-2.5 px-5 pt-1">
        {items.map((text) => (
          <T key={text} variant="small">
            {text}
          </T>
        ))}
      </View>
    </SectionBlock>
  );
}

function NoteRow({
  note,
  last,
  open,
  onToggle,
}: {
  note: NoteVM;
  last: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <ListRow
      testID={`note-${note.id}`}
      label={`${note.name}, ${open ? "collapse" : "expand"}`}
      onPress={onToggle}
      last={last}
    >
      <View className="gap-1">
        <View className="flex-row items-center justify-between gap-3">
          <T variant="label" numberOfLines={1} className="flex-1">
            {note.name}
          </T>
          <T variant="caption" tone="ink3">
            {note.updated}
          </T>
          <Icon
            name={open ? "chevron.up" : "chevron.down"}
            size={12}
            tone="muted-foreground"
          />
        </View>
        {open ? (
          <T variant="small" tone="ink2" selectable>
            {note.text}
          </T>
        ) : (
          <T variant="small" tone="ink2" numberOfLines={1}>
            {note.firstLine}
          </T>
        )}
      </View>
    </ListRow>
  );
}

export function NotesSection({ notes }: { notes: NoteVM[] }) {
  const [openId, setOpenId] = useState<string | undefined>();
  return (
    <SectionBlock title="Notes">
      {notes.map((n, i) => (
        <NoteRow
          key={n.id}
          note={n}
          last={i === notes.length - 1}
          open={openId === n.id}
          onToggle={() => setOpenId(openId === n.id ? undefined : n.id)}
        />
      ))}
    </SectionBlock>
  );
}

export function SkillsSection({ skills }: { skills: SkillVM[] }) {
  return (
    <SectionBlock title="Skills">
      {skills.map((s, i) => (
        <ListRow
          key={s.id}
          testID={`skill-${s.id}`}
          last={i === skills.length - 1}
        >
          <View className="gap-0.5">
            <T variant="label">{s.name}</T>
            {s.about ? (
              <T variant="caption" tone="ink2">
                {s.about}
              </T>
            ) : null}
          </View>
        </ListRow>
      ))}
    </SectionBlock>
  );
}

export function WeekSection({
  week,
  spend,
}: {
  week?: string;
  spend?: string;
}) {
  return (
    <SectionBlock title="This week">
      {week ? <Note>{week}</Note> : null}
      {spend ? <Note>{spend}</Note> : null}
    </SectionBlock>
  );
}
