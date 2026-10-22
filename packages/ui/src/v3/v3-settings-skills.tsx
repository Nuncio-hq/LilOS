import { PlusIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { MessageResponse } from "../components/ai-elements/message";
import { cn } from "../lib/utils";
import { Btn } from "./v3-bits";
import { OPEN_ROW } from "./v3-open-record";
import type { V3PageProps } from "./v3-page-types";
import type { V3Skill } from "./v3-types";

/* Settings → Skills: the company library. The list scrolls on its own and
   the detail stays put, so a long library does not push the open skill off
   the page. Add replaces that detail (the skill you had open is not left
   underneath the form). The tab exists only when the library and addSkill
   were both passed (D-#19). Reading a file is view state: the bytes never
   leave the page until Add hands the text up. */

const FIELD =
  "mt-1 w-full rounded-[7px] border border-foreground/15 bg-background px-2.5 text-[14px] text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-foreground/40";

/** A skill is a short text. Bigger than this is not one. */
const MAX_FILE_BYTES = 256 * 1024;

/** The library's name: kebab-case, the same shape as the ids already in
    use ("launch-notes"). Accents fold to the letter first ("Éclair" is
    "eclair"), so a mark the keyboard added does not become a different
    name or an empty one. Trailing separators stay off the saved name; the
    form shows this before Add. */
export function skillSlug(name: string): string {
  const plain = name.normalize("NFKD").replace(/\p{M}/gu, "");
  return plain
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/** The body's first sentence, skipping a heading. That line is the
    description when the file did not give one. */
function firstProse(text: string): string {
  return (
    text
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l !== "" && !l.startsWith("#")) ?? ""
  );
}

/** The description is its own line above the body. A body line that says
    the same thing would show the sentence twice, so it comes out. */
function dropMatchingLine(text: string, about: string): string {
  const want = about.trim();
  if (!want) return text;
  const lines = text.split("\n");
  const at = lines.findIndex(
    (l) => l.trim().replace(/^#{1,6}\s+/, "") === want,
  );
  if (at < 0) return text;
  lines.splice(at, 1);
  return lines.join("\n");
}

function skillBody(about: string, text: string): string {
  return dropMatchingLine(text, about).trim();
}

/** A skill file is a SKILL.md: a name, a description, and a body. Two
    frontmatter lines are enough; this is not a YAML parser. With no
    description, the body's first prose line is it, and that line is not
    left at the top of the body as well. */
function readSkillFile(
  raw: string,
  filename: string,
): { name: string; about: string; text: string } {
  const source = raw.replace(/^\uFEFF/, "");
  const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(source);
  let titled = "";
  let description = "";
  let body = source;
  if (fm?.[1] != null) {
    body = source.slice(fm[0].length);
    for (const line of fm[1].split(/\r?\n/)) {
      const m = /^(name|description):\s*(.*)$/.exec(line.trim());
      if (!m?.[1] || m[2] == null) continue;
      const value = m[2].replace(/^["']|["']$/g, "").trim();
      if (m[1] === "name") titled = value;
      else description = value;
    }
  }
  const fromFile = filename.replace(/\.(md|markdown|txt)$/i, "");
  if (!description) description = firstProse(body);
  body = dropMatchingLine(body, description);
  return {
    name: skillSlug(titled || fromFile),
    about: description.slice(0, 140),
    text: body.trim(),
  };
}

function AddSkill({
  names,
  onAdd,
  onCancel,
}: {
  /** Names and ids already in the library. A second row with the same
      slug would be the same skill twice. */
  names: string[];
  onAdd: (skill: { name: string; about: string; text: string }) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [about, setAbout] = useState("");
  const [text, setText] = useState("");
  const [fileNote, setFileNote] = useState<string | null>(null);
  const slug = skillSlug(name);
  const duplicate = slug !== "" && names.includes(slug);
  const nameless = name.trim() !== "" && slug === "";
  const ready =
    slug !== "" && !duplicate && (text.trim() !== "" || about.trim() !== "");

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
      const read = readSkillFile(await file.text(), file.name);
      setName(read.name);
      setAbout(read.about);
      setText(read.text);
      setFileNote(file.name);
    } catch {
      setFileNote("Could not read that file.");
    }
  };

  const submit = () => {
    if (!ready) return;
    const full = about.trim() || firstProse(text);
    onAdd({
      name: slug,
      about: full.slice(0, 140) || slug,
      text: skillBody(full, text),
    });
  };

  return (
    <form
      data-add-skill
      className="space-y-3 rounded-lg border border-[var(--v3-line)] bg-[var(--v3-soft)] p-4"
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
        {slug !== "" && (
          <span
            data-skill-slug
            className="mt-1 block font-mono text-[12.5px] text-muted-foreground"
          >
            {slug}
          </span>
        )}
        {duplicate && (
          <p className="mt-1 text-[13px] text-foreground">
            A skill already has that name.
          </p>
        )}
        {nameless && (
          <p className="mt-1 text-[13px] text-foreground">
            Use letters or numbers.
          </p>
        )}
      </label>
      <label className="block">
        <span className="text-[13px] text-muted-foreground">Description</span>
        <input
          aria-label="Description"
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
        <Btn primary disabled={!ready} onClick={submit}>
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
  const [filter, setFilter] = useState("");
  const rows = useRef(new Map<string, HTMLButtonElement>());
  const needle = filter.trim().toLowerCase();
  const shown = skills.filter(
    (s) =>
      needle === "" ||
      s.name.toLowerCase().includes(needle) ||
      s.about.toLowerCase().includes(needle),
  );
  const open = skills.find((s) => s.id === openId);

  // Add appends. Select that new row once it is in the list, and bring it
  // into the list's own scroll (the detail pane does not move with it).
  useEffect(() => {
    if (!want) return;
    const found = [...skills].reverse().find((s) => s.name === want);
    if (!found) return;
    setOpenId(found.id);
    setWant(null);
  }, [skills, want]);

  useEffect(() => {
    if (!openId) return;
    rows.current.get(openId)?.scrollIntoView?.({ block: "nearest" });
  }, [openId]);

  return (
    <div data-skills-library className="@container">
      <p className="mt-4 max-w-[620px] text-[14.5px] text-muted-foreground">
        The company's skills. Each agent uses the ones attached on its page.
      </p>
      {act.addSkill && (
        <div className="mt-5">
          <Btn
            pressed={adding}
            disabled={adding}
            onClick={() => {
              setAdding(true);
              setOpenId(null);
            }}
          >
            <PlusIcon className="size-3.5" />
            Add skill
          </Btn>
        </div>
      )}
      <div className="mt-4 grid items-start gap-6 @min-[680px]:grid-cols-[minmax(0,260px)_minmax(0,1fr)]">
        <div className="min-w-0">
          <input
            aria-label="Filter skills"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter"
            className="mb-2 h-8 w-full rounded-[7px] border border-foreground/15 bg-background px-2.5 text-[13.5px] text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-foreground/40"
          />
          <div
            data-skill-list
            className="max-h-[min(28rem,calc(100vh-16rem))] overflow-y-auto"
          >
            <ul
              aria-label="Skill library"
              className="border-[var(--v3-line)] border-t"
            >
              {shown.length === 0 && (
                <li className="py-3 text-[14px] text-muted-foreground">
                  {skills.length === 0 ? "No skills yet." : "No skill matches."}
                </li>
              )}
              {shown.map((s) => {
                const on = s.id === openId;
                return (
                  <li key={s.id} className="border-[var(--v3-line)] border-b">
                    <button
                      ref={(el) => {
                        if (el) rows.current.set(s.id, el);
                        else rows.current.delete(s.id);
                      }}
                      type="button"
                      aria-current={on ? "true" : undefined}
                      onClick={() => {
                        setOpenId(s.id);
                        setAdding(false);
                      }}
                      className={cn(
                        "block w-full px-2 py-2 text-left hover:bg-[var(--v3-hover)]",
                        on && OPEN_ROW,
                      )}
                    >
                      <span className="block text-[14px] text-foreground">
                        {s.name}
                      </span>
                      <span className="mt-0.5 block truncate text-[12.5px] text-muted-foreground">
                        {s.about}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
        <div data-skill-detail className="sticky top-4 min-w-0 self-start">
          {adding && act.addSkill ? (
            <AddSkill
              names={skills.flatMap((s) => [s.name, s.id])}
              onAdd={(skill) => {
                act.addSkill?.(skill);
                setFilter("");
                setWant(skill.name);
                setAdding(false);
              }}
              onCancel={() => setAdding(false)}
            />
          ) : (
            <SkillView skill={open} />
          )}
        </div>
      </div>
    </div>
  );
}

function SkillView({ skill }: { skill: V3Skill | undefined }) {
  if (!skill)
    return <p className="text-[14px] text-muted-foreground">Choose a skill.</p>;
  const body = skillBody(skill.about, skill.text);
  return (
    <article data-skill-view>
      <h2 className="font-semibold text-[22px] text-foreground leading-tight">
        {skill.name}
      </h2>
      <p className="mt-1 text-[14px] text-muted-foreground">{skill.about}</p>
      {body !== "" && (
        <div className="mt-4 border-[var(--v3-line)] border-l-2 pl-4">
          <MessageResponse className="lilos-prose text-[14.5px] text-foreground leading-relaxed">
            {body}
          </MessageResponse>
        </div>
      )}
    </article>
  );
}
