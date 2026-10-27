import { type ReactNode, useState } from "react";
import { Btn, Section, Spinner } from "./v3-bits";
import { EscLayer, useFocusBack } from "./v3-keys";
import { companyOn } from "./v3-model";
import type { V3PageProps } from "./v3-page-types";
import { LinkRow, Row, Segmented, useRun } from "./v3-settings-bits";

/* Settings → General: you and the company, approvals, the editor, About.
   Each control calls act.saveSettings (or saveProfile); a control whose
   action or data the app does not have is not drawn. */

/* #884: only LilOS's own Ask / Full access shows. The engine's Smart /
   Manual / Off policy row used to sit under it — a second approval system
   nobody can reason about; the harness pins the engine to the mode that
   surfaces every ask, so nothing here needs to manage it. */
const APPROVALS = [
  {
    id: "ask" as const,
    label: "Ask before risky commands",
    does: "The agent stops and asks you before anything that deletes, publishes or spends.",
  },
  {
    id: "full" as const,
    label: "Full access",
    does: "The agent never stops to ask. Faster, and your call to make.",
  },
];

const INPUT =
  "h-8 min-w-0 flex-1 rounded-[7px] border border-foreground/15 bg-background px-2.5 text-[14px] text-foreground outline-none focus:border-foreground/40";

/** A fact about you or the company: label, value, and a way to change it:
   in place (`onSave`), by asking the CEO (`onRename`), or not at all. */
function Fact({
  label,
  value,
  onRename,
  onSave,
}: {
  label: string;
  value: string;
  onRename?: () => void;
  onSave?: (value: string) => void;
}) {
  const [draft, setDraft] = useState<string>();
  // Saving or cancelling swaps the field back for "Rename…": the keyboard goes there.
  const renameBtn = useFocusBack<HTMLButtonElement>(draft !== undefined);
  const save = () => {
    const next = draft?.trim();
    if (next && next !== value) onSave?.(next);
    setDraft(undefined);
  };
  return (
    <div className="flex items-center gap-4 border-[var(--v3-line)] border-b py-3">
      <span className="w-24 shrink-0 text-[13px] text-muted-foreground">
        {label}
      </span>
      {draft === undefined ? (
        <span className="min-w-0 flex-1 truncate text-[14.5px] text-foreground">
          {value}
        </span>
      ) : (
        <>
          {/* Esc cancels the rename, not a peek that may be open beside it. */}
          <EscLayer onEscape={() => setDraft(undefined)} />
          <input
            // biome-ignore lint/a11y/noAutofocus: it opens because you asked to rename
            autoFocus
            aria-label={label}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              // The keyboard moves to "Rename…" as the box closes; the Enter
              // being pressed must not also click it and reopen the box.
              e.preventDefault();
              save();
            }}
            className={INPUT}
          />
        </>
      )}
      {draft !== undefined ? (
        <>
          <Btn small primary onClick={save}>
            Save
          </Btn>
          <Btn small onClick={() => setDraft(undefined)}>
            Cancel
          </Btn>
        </>
      ) : (
        (onSave || onRename) && (
          <Btn
            small
            ref={renameBtn}
            onClick={onSave ? () => setDraft(value) : onRename}
          >
            Rename…
          </Btn>
        )
      )}
    </div>
  );
}

/** "Check for updates" / "Copy diagnostics": a button, then a quiet result.
   `checking` shows "Checking…" while the app works; the result it resolves
   with (a sentence) replaces `done`. */
export function Confirm({
  label,
  done,
  checking,
  run,
  icon,
}: {
  label: string;
  done: string;
  checking?: boolean;
  /** A string it returns (or resolves to) replaces `done` as the note. */
  run?: () => unknown;
  icon?: ReactNode;
}) {
  const [state, start, result] = useRun(() => run?.(), checking ? 6000 : 1800);
  return (
    <span className="flex items-center gap-2.5">
      <Btn small onClick={start}>
        {icon}
        {label}
      </Btn>
      {checking && state === "busy" && (
        <span className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
          <Spinner />
          Checking…
        </span>
      )}
      {state === "done" && (
        <span className="text-[13px] text-muted-foreground">
          {typeof result === "string" ? result : done}
        </span>
      )}
    </span>
  );
}

export function GeneralPane({ data, go, act }: V3PageProps) {
  const { approvals, editor, editors, about } = data.settings;
  // The CEO can rename things through ⌘K where the app has no way to do it
  // in place and the company has one.
  const askToRename = !act.saveProfile && !!data.ceoId;
  const editorChoices =
    editors && editor && !editors.includes(editor)
      ? [editor, ...editors]
      : editors;
  return (
    <>
      <Section
        title={companyOn(data) ? "You and the company" : "You"}
        className="mt-6"
      />
      {/* With the company layer paused (D-#836) there is no company name to
          show or rename; the saved value is untouched. */}
      {companyOn(data) && (
        <Fact
          label="Company"
          value={data.company}
          onRename={
            askToRename ? () => act.ask("Rename the company to ") : undefined
          }
          onSave={
            act.saveProfile
              ? (company) => act.saveProfile?.({ company })
              : undefined
          }
        />
      )}
      <Fact
        label="Your name"
        value={data.me}
        onRename={askToRename ? () => act.ask("Call me ") : undefined}
        onSave={act.saveProfile ? (me) => act.saveProfile?.({ me }) : undefined}
      />

      <Section title="Approvals" />
      <div className="border-[var(--v3-line)] border-b pb-4">
        <p className="mb-3 text-[13px] text-muted-foreground">
          What agents may do without asking you.
          {data.features.tickets &&
            " Each ticket can still ask about anything public or paid."}
        </p>
        <Segmented
          label="Approvals"
          value={approvals}
          options={APPROVALS.map((a) => ({ id: a.id, label: a.label }))}
          onChange={(id) => act.saveSettings({ approvals: id })}
        />
        <ul className="mt-3 space-y-1 text-[13px]">
          {APPROVALS.map((a) => (
            <li
              key={a.id}
              className={
                a.id === approvals
                  ? "text-foreground"
                  : "text-muted-foreground/70"
              }
            >
              <span className="font-medium">{a.label}.</span> {a.does}
            </li>
          ))}
        </ul>
      </div>

      {editorChoices && editorChoices.length > 0 && editor && (
        <>
          <Section title="Open files in" />
          <div className="border-[var(--v3-line)] border-b pb-4">
            <p className="mb-3 text-[13px] text-muted-foreground">
              “Open in editor” on a file or a workbench goes here.
            </p>
            <Segmented
              label="Open files in"
              value={editor}
              options={editorChoices.map((e) => ({ id: e, label: e }))}
              onChange={(id) => act.saveSettings({ editor: id })}
            />
          </div>
        </>
      )}

      <Section title="About" />
      {about && (
        <Row title="LilOS" hint={about.version}>
          {act.checkUpdates && (
            <Confirm
              checking
              label="Check for updates"
              done="LilOS is up to date."
              run={act.checkUpdates}
            />
          )}
        </Row>
      )}
      <LinkRow onClick={() => go({ page: "guide" })}>Guide</LinkRow>
      {about?.whatsNew && (
        <LinkRow onClick={() => act.ask(about.whatsNew?.ask)}>
          {about.whatsNew.label}
        </LinkRow>
      )}
    </>
  );
}
