import { FileIcon, FolderIcon, TerminalIcon } from "lucide-react";
import type { ReactNode } from "react";
import type { ComposerMenus } from "../chat/composer-menus";
import { cn } from "../lib/utils";
import type { V3Data } from "./v3-data-types";
import { AgentAvatar } from "./v3-marks";
import type { V3Agent } from "./v3-types";

/* The `@` and `/` menus above a v3 message box, drawn from the state every
   composer shares (`chat/composer-menus`). The markers (`data-mention-*`,
   `data-slash-command`, the listbox names) are the ones the chat composer's
   menus carry, so one set of checks reads both. */

type Menus = ComposerMenus<V3Agent>;

const BOX =
  "absolute bottom-full left-0 z-20 mb-1 max-h-64 w-80 max-w-full overflow-y-auto rounded-lg border border-[var(--v3-line)] bg-background py-1 text-[13.5px]";
const HEAD =
  "px-3 pt-1 pb-0.5 font-medium text-[11.5px] text-muted-foreground/80";
const NOTE = "px-3 py-1.5 text-[12.5px] text-muted-foreground";

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

export function MentionMenu({ data, menus }: { data: V3Data; menus: Menus }) {
  const { open, employees, fileHits, active, pick, files } = menus.mention;
  if (!open) return null;
  return (
    <div role="listbox" aria-label="Mention" className={BOX}>
      {employees.length > 0 && (
        <Section name="employees" title="People">
          {employees.map((a, i) => (
            <button
              key={a.id}
              type="button"
              role="option"
              aria-selected={active === i}
              // The box keeps the caret; a click only picks.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick({ kind: "emp", employee: a })}
              className={row(active === i)}
            >
              <AgentAvatar data={data} agent={a} size={18} />
              <span className="shrink-0">{a.name}</span>
              <span className="min-w-0 flex-1 truncate text-right text-[12.5px] text-muted-foreground/70">
                {a.role}
              </span>
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
                  onMouseDown={(e) => e.preventDefault()}
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

export function SlashMenu({ menus }: { menus: Menus }) {
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
            onMouseDown={(e) => e.preventDefault()}
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
            <span className="min-w-0 flex-1 truncate text-right text-[12.5px] text-muted-foreground/70">
              {c.description}
            </span>
          </button>
        ))
      )}
    </div>
  );
}
