import { CopyIcon } from "lucide-react";
import type { ReactNode } from "react";
import { AgentAvatar, Btn, Section, Spinner } from "./v3-bits";
import {
  EngineFix,
  EngineState,
  LinkRow,
  Row,
  Segmented,
  Switch,
  useCheck,
} from "./v3-settings-bits";
import type { V3PageProps } from "./v3-types";

/* Settings panes: General, and Engine & models. Phone and Connectors live in
   their own files. Every control calls act.saveSettings (or asks the CEO);
   nothing here keeps state worth keeping beyond a one-second "checking". */

const VERSION = "LilOS 0.9 (prototype)";

const EDITORS = ["Cursor", "VS Code", "Zed", "Xcode"];

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

/** A fact about you or the company: label, value, and a way to change it. */
function Fact({
  label,
  value,
  onRename,
}: {
  label: string;
  value: string;
  onRename: () => void;
}) {
  return (
    <div className="flex items-center gap-4 border-[var(--v3-line)] border-b py-3">
      <span className="w-24 shrink-0 text-[13px] text-muted-foreground">
        {label}
      </span>
      <span className="min-w-0 flex-1 truncate text-[14.5px] text-foreground">
        {value}
      </span>
      <Btn small onClick={onRename}>
        Rename…
      </Btn>
    </div>
  );
}

/** "Check for updates" / "Copy diagnostics": a button, then a quiet result.
   `checking` adds a one-second "Checking…" before the result. */
function Confirm({
  label,
  done,
  checking,
  onClick,
  icon,
}: {
  label: string;
  done: string;
  checking?: boolean;
  onClick?: () => void;
  icon?: ReactNode;
}) {
  const [state, start] = useCheck(checking ? 1000 : 0);
  return (
    <span className="flex items-center gap-2.5">
      <Btn
        small
        onClick={() => {
          if (state === "busy") return;
          onClick?.();
          start();
        }}
      >
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
        <span className="text-[13px] text-muted-foreground">{done}</span>
      )}
    </span>
  );
}

export function GeneralPane({ data, go, act }: V3PageProps) {
  const { approvals, editor } = data.settings;
  const editors = EDITORS.includes(editor) ? EDITORS : [editor, ...EDITORS];
  return (
    <>
      <Section title="You and the company" className="mt-6" />
      <Fact
        label="Company"
        value={data.company}
        onRename={() => act.ask("Rename the company to ")}
      />
      <Fact
        label="Your name"
        value={data.me}
        onRename={() => act.ask("Call me ")}
      />

      <Section title="Approvals" />
      <div className="border-[var(--v3-line)] border-b pb-4">
        <p className="mb-3 text-[13px] text-muted-foreground">
          What agents may do without asking you. Each ticket can still ask about
          anything public or paid.
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

      <Section title="Open files in" />
      <div className="border-[var(--v3-line)] border-b pb-4">
        <p className="mb-3 text-[13px] text-muted-foreground">
          “Open in editor” on a file or a workbench goes here.
        </p>
        <Segmented
          label="Open files in"
          value={editor}
          options={editors.map((e) => ({ id: e, label: e }))}
          onChange={(id) => act.saveSettings({ editor: id })}
        />
      </div>

      <Section title="About" />
      <Row title="LilOS" hint={VERSION}>
        <Confirm
          checking
          label="Check for updates"
          done="LilOS is up to date."
        />
      </Row>
      <LinkRow onClick={() => go({ page: "guide" })}>Guide</LinkRow>
      <LinkRow onClick={() => act.ask("What changed in LilOS 0.9?")}>
        What’s new in 0.9
      </LinkRow>
    </>
  );
}

export function EnginePane({ data, go, act }: V3PageProps) {
  const { engine, models } = data.settings;
  const [check, again] = useCheck(1000);
  const onCount = models.filter((m) => m.on).length;
  const onAgents = data.agents.filter((a) => a.kind !== "outside");
  const diagnostics = [
    VERSION,
    "Local relay: connected",
    `Engine: ${engine.name} ${engine.version} (${engine.state}) at ${engine.path}`,
    `Agents on the engine: ${onAgents.length}`,
    `Models on: ${models
      .filter((m) => m.on)
      .map((m) => m.label)
      .join(", ")}`,
  ].join("\n");

  return (
    <>
      <Section title="Engine" className="mt-6" />
      <div className="rounded-lg border border-[var(--v3-line)] p-4">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <span
            aria-hidden
            className="grid size-9 shrink-0 place-items-center rounded-lg bg-[var(--v3-soft)] font-semibold text-[15px] text-foreground"
          >
            {engine.name.slice(0, 1)}
          </span>
          <div className="min-w-0 flex-1 basis-48">
            <div className="text-[14.5px] text-foreground">
              {engine.name}
              <span className="ml-2 text-[13px] text-muted-foreground">
                {engine.version}
              </span>
            </div>
            <div className="mt-0.5 truncate font-mono text-[12.5px] text-muted-foreground">
              {engine.path}
            </div>
          </div>
          <EngineState engine={engine} />
        </div>
        <EngineFix engine={engine} />
        <div className="mt-4 flex items-center gap-3">
          <Btn
            small
            onClick={() => {
              if (check !== "busy") again();
            }}
          >
            {check === "busy" ? "Checking…" : "Check again"}
          </Btn>
          {check === "busy" && <Spinner />}
          {check === "done" && (
            <span className="text-[13px] text-muted-foreground">
              {engine.state === "ok"
                ? "Checked just now · all good."
                : "Checked just now · still not ready."}
            </span>
          )}
        </div>
      </div>

      <Section title="Status" />
      <Row
        title="Local relay"
        hint="Carries messages between this app and the engine."
      >
        <span className="flex items-center gap-1.5 text-[13.5px] text-muted-foreground">
          <span aria-hidden className="size-1.5 rounded-full bg-emerald-500" />
          Connected
        </span>
      </Row>
      <Row title="Engine">
        <EngineState engine={engine} />
      </Row>
      <div className="py-3.5">
        <Confirm
          label="Copy diagnostics"
          done="Copied"
          icon={<CopyIcon className="size-3.5" />}
          onClick={() => {
            void navigator.clipboard?.writeText(diagnostics)?.catch(() => {});
          }}
        />
      </div>

      <Section title="Agents on this engine" count={onAgents.length} />
      {onAgents.map((a) => (
        <button
          key={a.id}
          type="button"
          onClick={() => go({ page: "agent", id: a.id })}
          className="-mx-2 flex w-[calc(100%+1rem)] items-center gap-3 rounded-md px-2 py-2 text-left transition-colors hover:bg-[var(--v3-hover)]"
        >
          <AgentAvatar data={data} agent={a} size={22} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[14.5px] text-foreground">
              {a.name}
            </span>
            <span className="block truncate font-mono text-[12.5px] text-muted-foreground">
              {a.runtime}
            </span>
          </span>
          <span className="flex shrink-0 items-center gap-1.5 text-[13px] text-muted-foreground">
            <span
              aria-hidden
              className={`size-1.5 rounded-full ${engine.state === "ok" ? "bg-emerald-500" : "bg-stone-400"}`}
            />
            {engine.state === "ok" ? "Connected" : "Waiting for engine"}
          </span>
        </button>
      ))}

      <Section title="Models" count={`${onCount} on`} />
      <p className="mb-1 text-[13px] text-muted-foreground">
        Pickers only offer the models that are on.
      </p>
      {models.map((m) => (
        <Row key={m.id} title={m.label}>
          <Switch
            label={`${m.label} on`}
            on={m.on}
            // At least one model stays on, or a picker would be empty.
            disabled={m.on && onCount === 1}
            title={
              m.on && onCount === 1 ? "Keep at least one model on" : undefined
            }
            onChange={(on) =>
              act.saveSettings({
                models: models.map((x) => (x.id === m.id ? { ...x, on } : x)),
              })
            }
          />
        </Row>
      ))}
    </>
  );
}
