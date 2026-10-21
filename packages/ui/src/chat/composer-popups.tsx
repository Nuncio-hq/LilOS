import { FileIcon, FolderIcon, TerminalIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../lib/utils";
import type { ComposerMenus } from "./composer-menus";

/* The `@` and `/` menus above a message box, drawn from the state the
   composer's menus hook returns. Hairline box, no shadow — the v3 look. The
   markers (`data-mention-*`, `data-slash-command`, the listbox names) are what
   the specs read. One set of menus serves the thread's composer and the v3
   draft chat's: each says how a person looks (`avatar`) and what their row
   adds (`meta`); the rest is the same. */

type Person = { id: string; name: string; role: string };

const BOX =
  "absolute bottom-full left-0 z-20 mb-1 max-h-64 w-80 max-w-full overflow-y-auto rounded-lg border border-[var(--v3-line)] bg-background py-1 text-[13.5px]";
const HEAD =
  "px-3 pt-1 pb-0.5 font-medium text-[11.5px] text-muted-foreground/80";
const NOTE = "px-3 py-1.5 text-[12.5px] text-muted-foreground";
const META =
  "min-w-0 flex-1 truncate text-right text-[12.5px] text-muted-foreground/70";

const row = (on: boolean) =>
  cn(
    "flex w-full items-center gap-2 px-3 py-1.5 text-left outline-none",
    on ? "bg-[var(--v3-hover)]" : "hover:bg-[var(--v3-hover)]",
  );

function Section({
  name,
  title,
  children,
}: {
  name: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <div data-mention-section={name} role="presentation">
      <div className={HEAD}>{title}</div>
      {children}
    </div>
  );
}

export function MentionPopup<E extends Person>({
  menus,
  employees,
  avatar,
  meta = (e) => `${e.role} · new thread`,
}: {
  menus: ComposerMenus<E>;
  employees: E[];
  avatar: (e: E) => ReactNode;
  /** What a person's row says at its right edge. */
  meta?: (e: E) => string;
}) {
  const { open, fileHits, active, pick, files } = menus.mention;
  if (!open) return null;
  return (
    <div role="listbox" aria-label="Mention" className={BOX}>
      {employees.length > 0 && (
        <Section name="employees" title="People">
          {employees.map((e, i) => (
            <button
              key={e.id}
              type="button"
              role="option"
              aria-selected={active === i}
              // The box keeps the caret; a click only picks.
              onMouseDown={(ev) => ev.preventDefault()}
              onClick={() => pick({ kind: "emp", employee: e })}
              className={row(active === i)}
            >
              {avatar(e)}
              <span className="shrink-0">{e.name}</span>
              <span className={META}>{meta(e)}</span>
            </button>
          ))}
        </Section>
      )}
      {files && (
        <Section name="files" title="Files">
          {fileHits === null ? (
            <div className={NOTE}>Searching…</div>
          ) : fileHits.length === 0 ? (
            <div className={NOTE}>No matches</div>
          ) : (
            fileHits.map((f, j) => {
              const i = employees.length + j;
              return (
                <button
                  key={f.path}
                  type="button"
                  role="option"
                  aria-selected={active === i}
                  data-mention-file={f.path}
                  data-kind={f.kind}
                  onMouseDown={(ev) => ev.preventDefault()}
                  onClick={() => pick({ kind: "file", file: f })}
                  className={row(active === i)}
                >
                  {f.kind === "dir" ? (
                    <FolderIcon className="size-3.5 shrink-0 text-muted-foreground" />
                  ) : (
                    <FileIcon className="size-3.5 shrink-0 text-muted-foreground" />
                  )}
                  <span className="min-w-0 truncate font-mono text-[12px]">
                    {f.path}
                    {f.kind === "dir" ? "/" : ""}
                  </span>
                </button>
              );
            })
          )}
        </Section>
      )}
    </div>
  );
}

export function SlashPopup<E>({ menus }: { menus: ComposerMenus<E> }) {
  const { open, hits, rows, active, pick } = menus.slash;
  if (!open) return null;
  return (
    <div role="listbox" aria-label="Commands" className={BOX}>
      <div className={HEAD}>Commands</div>
      {hits === null ? (
        <div className={NOTE}>Searching…</div>
      ) : rows.length === 0 ? (
        <div className={NOTE}>No matches</div>
      ) : (
        rows.map((c, i) => (
          <button
            key={c.name}
            type="button"
            role="option"
            aria-selected={active === i}
            data-slash-command={c.name}
            data-kind={c.kind}
            onMouseDown={(ev) => ev.preventDefault()}
            onClick={() => pick(c)}
            className={row(active === i)}
          >
            <TerminalIcon className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="shrink-0 font-mono text-[12px]">
              /{c.name}
              {c.argsHint ? (
                <span className="text-muted-foreground"> {c.argsHint}</span>
              ) : null}
            </span>
            <span className={META}>{c.description}</span>
          </button>
        ))
      )}
    </div>
  );
}
