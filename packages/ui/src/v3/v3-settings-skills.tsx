import { PlusIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "../lib/utils";
import { Btn } from "./v3-bits";
import type { V3PageProps } from "./v3-page-types";
import type { V3Skill } from "./v3-types";

/* Settings → Skills: the company library. List, read one, add from typed
   text or from a file the page reads itself. The tab exists only when the
   library and addSkill were both passed (D-#19). Reading a file is view
   state: the bytes never leave the page until Add hands the text up. */

const FIELD =
  "mt-1 w-full rounded-[7px] border border-foreground/15 bg-background px-2.5 text-[14px] text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-foreground/40";

/** A skill is a short text. Bigger than this is not one. */
const MAX_FILE_BYTES = 256 * 1024;

function firstAbout(text: string): string {
  const line = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l !== "" && !l.startsWith("#"));
  return (line ?? "").slice(0, 140);
}

function AddSkill({
  onAdd,
  onCancel,
}: {
  onAdd: (skill: { name: string; about: string; text: string }) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [about, setAbout] = useState("");
  const [text, setText] = useState("");
  const [fileNote, setFileNote] = useState<string | null>(null);
  const ready = name.trim() !== "" && text.trim() !== "";

  const load = async (file: File) => {
    const textLike =
      file.type === "" ||
      file.type.startsWith("text/") ||
      /\.(md|txt|markdown)$/i.test(file.name);
    if (!textLike) {
      setFileNote("Choose a text file.");
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      setFileNote("That file is too big. A skill is a short text.");
      return;
    }
    try {
      const body = await file.text();
      setText(body);
      setFileNote(file.name);
      if (name.trim() === "")
        setName(file.name.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " "));
      if (about.trim() === "") setAbout(firstAbout(body));
    } catch {
      setFileNote("Could not read that file.");
    }
  };

  const submit = () => {
    if (!ready) return;
    const named = name.trim();
    onAdd({
      name: named,
      about: about.trim() || firstAbout(text) || named,
      text: text.trim(),
    });
  };

  return (
    <form
      data-add-skill
      className="mt-4 space-y-3 rounded-lg border border-[var(--v3-line)] bg-[var(--v3-soft)] p-4"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <label className="block">
        <span className="text-[13px] text-muted-foreground">Name</span>
        <input
          aria-label="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="What you call it"
          className={cn(FIELD, "h-8")}
        />
      </label>
      <label className="block">
        <span className="text-[13px] text-muted-foreground">About</span>
        <input
          aria-label="About"
          value={about}
          onChange={(e) => setAbout(e.target.value)}
          placeholder="One line, for the list"
          className={cn(FIELD, "h-8")}
        />
      </label>
      <label className="block">
        <span className="text-[13px] text-muted-foreground">Skill text</span>
        <textarea
          aria-label="Skill text"
          value={text}
          rows={8}
          onChange={(e) => setText(e.target.value)}
          placeholder="Paste the skill, or choose a file below."
          className={cn(FIELD, "resize-y py-2 text-[14.5px] leading-relaxed")}
        />
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <label className="inline-flex h-7 cursor-pointer items-center rounded-[7px] border border-foreground/15 bg-background px-3 text-[13px] font-medium text-foreground hover:bg-[var(--v3-hover)]">
          <input
            aria-label="Skill file"
            type="file"
            accept=".md,.txt,.markdown,text/plain,text/markdown"
            className="sr-only"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void load(file);
              e.target.value = "";
            }}
          />
          Choose a file
        </label>
        {fileNote && (
          <span className="text-[13px] text-muted-foreground">{fileNote}</span>
        )}
      </div>
      <div className="flex items-center gap-2 pt-1">
        <Btn
          primary
          onClick={submit}
          className={!ready ? "pointer-events-none opacity-40" : undefined}
        >
          Add
        </Btn>
        <Btn onClick={onCancel}>Cancel</Btn>
      </div>
    </form>
  );
}

export function SkillsPane({ data, act }: V3PageProps) {
  const skills = data.skills ?? [];
  const [openId, setOpenId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [want, setWant] = useState<string | null>(null);
  const open = skills.find((s) => s.id === openId);

  // Add appends. Select that new row once it is in the list.
  useEffect(() => {
    if (!want) return;
    const found = [...skills].reverse().find((s) => s.name === want);
    if (!found) return;
    setOpenId(found.id);
    setWant(null);
  }, [skills, want]);

  return (
    <div data-skills-library className="@container">
      <p className="mt-4 max-w-[620px] text-[14.5px] text-muted-foreground">
        The company's skills. Each agent uses the ones attached on its page.
      </p>
      {act.addSkill && !adding && (
        <div className="mt-5">
          <Btn onClick={() => setAdding(true)}>
            <PlusIcon className="size-3.5" />
            Add skill
          </Btn>
        </div>
      )}
      {act.addSkill && adding && (
        <AddSkill
          onAdd={(skill) => {
            act.addSkill?.(skill);
            setWant(skill.name);
            setAdding(false);
          }}
          onCancel={() => setAdding(false)}
        />
      )}
      <div className="mt-4 grid gap-6 @min-[680px]:grid-cols-[minmax(0,240px)_minmax(0,1fr)]">
        <ul
          aria-label="Skill library"
          className="border-[var(--v3-line)] border-t"
        >
          {skills.length === 0 && (
            <li className="py-3 text-[14px] text-muted-foreground">
              No skills yet.
            </li>
          )}
          {skills.map((s) => (
            <li key={s.id} className="border-[var(--v3-line)] border-b">
              <button
                type="button"
                aria-current={s.id === openId ? "true" : undefined}
                onClick={() => setOpenId(s.id)}
                className="block w-full px-1 py-2 text-left hover:bg-[var(--v3-hover)]"
              >
                <span className="block text-[14px] text-foreground">
                  {s.name}
                </span>
                <span className="mt-0.5 block truncate text-[12.5px] text-muted-foreground">
                  {s.about}
                </span>
              </button>
            </li>
          ))}
        </ul>
        <SkillView skill={open} />
      </div>
    </div>
  );
}

function SkillView({ skill }: { skill: V3Skill | undefined }) {
  if (!skill)
    return <p className="text-[14px] text-muted-foreground">Choose a skill.</p>;
  return (
    <article data-skill-view>
      <h2 className="font-semibold text-[22px] text-foreground leading-tight">
        {skill.name}
      </h2>
      <p className="mt-1 text-[14px] text-muted-foreground">{skill.about}</p>
      <div className="mt-4 whitespace-pre-wrap border-[var(--v3-line)] border-l-2 pl-4 text-[14.5px] text-foreground leading-relaxed">
        {skill.text}
      </div>
    </article>
  );
}
