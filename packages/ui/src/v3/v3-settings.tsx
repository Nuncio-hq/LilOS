import { PlusIcon } from "lucide-react";
import { useState } from "react";
import { cn } from "../lib/utils";
import { AgentAvatar, Avatar, Btn, Page, Tabs, Title } from "./v3-bits";
import { EnginePane, GeneralPane } from "./v3-settings-panes";
import { PhonePane } from "./v3-settings-phone";
import type { V3ConnectorDef, V3PageProps } from "./v3-types";

/* Settings: company-level choices in four tabs. General, Engine & models and
   Phone live in their own files; Connectors stays here: the outside services
   agents use, turned on per agent. LilOS keeps what to run and who gets it,
   never a login (each connector keeps its own). */

const KIND_WORD: Record<V3ConnectorDef["kind"], string> = {
  mcp: "MCP",
  cli: "CLI",
};

const INPUT =
  "mt-1 h-8 w-full rounded-[7px] border border-foreground/15 bg-background px-2.5 text-[14px] text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-foreground/40";

/** The connector's state in plain words, with what to do about it. */
function State({
  c,
  ask,
}: {
  c: V3ConnectorDef;
  ask: V3PageProps["act"]["ask"];
}) {
  if (c.state === "ready")
    return (
      <span className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
        <span aria-hidden className="size-1.5 rounded-full bg-emerald-500" />
        Ready
      </span>
    );
  if (c.state === "signed-out")
    return (
      <span className="flex items-center gap-2 text-[13px]">
        <span className="text-amber-700 dark:text-amber-300">
          Not signed in
        </span>
        <Btn small onClick={() => ask(`Help me sign in to ${c.label}`)}>
          Sign in
        </Btn>
      </span>
    );
  return (
    <span className="text-[13px] text-muted-foreground">
      Not found
      <span className="text-muted-foreground/70">
        {" "}
        · Install it, then refresh
      </span>
    </span>
  );
}

function AddForm({
  onAdd,
  onCancel,
}: {
  onAdd: (c: { label: string; kind: "cli" | "mcp"; command: string }) => void;
  onCancel: () => void;
}) {
  const [label, setLabel] = useState("");
  const [kind, setKind] = useState<"cli" | "mcp">("cli");
  const [command, setCommand] = useState("");
  const ready = label.trim() !== "" && command.trim() !== "";
  const submit = () => {
    if (ready) onAdd({ label: label.trim(), kind, command: command.trim() });
  };
  return (
    <form
      className="mt-3 space-y-3 rounded-lg border border-[var(--v3-line)] bg-[var(--v3-soft)] p-4"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <label className="block">
        <span className="text-[13px] text-muted-foreground">Name</span>
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="What you call it"
          className={INPUT}
        />
      </label>
      <div>
        <span className="text-[13px] text-muted-foreground">Kind</span>
        <div className="mt-1 flex w-fit rounded-[7px] border border-[var(--v3-line)] bg-background p-0.5">
          {(["cli", "mcp"] as const).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setKind(k)}
              className={cn(
                "h-[26px] rounded-[5px] px-3 text-[13px] text-muted-foreground transition-colors hover:text-foreground",
                kind === k && "bg-[var(--v3-soft)] font-medium text-foreground",
              )}
            >
              {KIND_WORD[k]}
            </button>
          ))}
        </div>
      </div>
      <label className="block">
        <span className="text-[13px] text-muted-foreground">
          {kind === "cli" ? "Command" : "Command or URL"}
        </span>
        <input
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          placeholder={kind === "cli" ? "gh" : "my-server --stdio"}
          spellCheck={false}
          className={cn(INPUT, "font-mono text-[13px]")}
        />
      </label>
      <div className="flex items-center gap-2 pt-1">
        <Btn primary onClick={submit}>
          Add
        </Btn>
        <Btn onClick={onCancel}>Cancel</Btn>
      </div>
    </form>
  );
}

function ConnectorRow({
  c,
  data,
  go,
  act,
}: { c: V3ConnectorDef } & V3PageProps) {
  // Outside workers are not toggled: they are reached through the connector,
  // not given it.
  const workers = data.agents.filter(
    (a) => a.kind === "outside" && a.via === c.id,
  );
  const lilos = data.agents.filter((a) => a.kind !== "outside");
  return (
    <div className="border-[var(--v3-line)] border-b py-4">
      <div className="flex items-start gap-3">
        <Avatar name={c.label} tone="n" size={28} look={c.look} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2">
            <span className="font-medium text-[14.5px] text-foreground">
              {c.label}
            </span>
            <span className="rounded border border-[var(--v3-line)] px-1.5 text-[11px] text-muted-foreground tracking-wide">
              {KIND_WORD[c.kind]}
            </span>
          </div>
          <div className="mt-0.5 truncate font-mono text-[12.5px] text-muted-foreground">
            {c.command}
          </div>
          <p className="mt-1 text-[13.5px] text-muted-foreground">{c.about}</p>
        </div>
        <div className="shrink-0 pt-0.5">
          <State c={c} ask={act.ask} />
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-1.5 pl-10">
        {lilos.map((a) => {
          const on = c.agents.includes(a.id);
          return (
            <button
              key={a.id}
              type="button"
              aria-pressed={on}
              title={`${on ? "Turn off" : "Turn on"} ${c.label} for ${a.name}`}
              onClick={() => act.toggleConnector(c.id, a.id)}
              className={cn(
                "inline-flex h-[24px] items-center gap-1.5 rounded-full border pr-2.5 pl-1 text-[12.5px] transition-colors",
                on
                  ? "border-foreground bg-foreground text-background"
                  : "border-[var(--v3-line)] text-muted-foreground hover:bg-[var(--v3-hover)] hover:text-foreground",
              )}
            >
              <AgentAvatar data={data} agent={a} size={16} />
              {a.name}
            </button>
          );
        })}
      </div>

      {workers.length > 0 && (
        <p className="mt-2.5 pl-10 text-[13px] text-muted-foreground">
          Workers through it:{" "}
          {workers.map((w, i) => (
            <span key={w.id}>
              {i > 0 && ", "}
              <button
                type="button"
                onClick={() => go({ page: "agent", id: w.id })}
                className="text-foreground underline-offset-2 hover:underline"
              >
                {w.name}
              </button>
            </span>
          ))}
        </p>
      )}
    </div>
  );
}

type View = "general" | "engine" | "phone" | "connectors";

const TABS: { id: View; label: string }[] = [
  { id: "general", label: "General" },
  { id: "engine", label: "Engine & models" },
  { id: "phone", label: "Phone" },
  { id: "connectors", label: "Connectors" },
];

function ConnectorsPane({ data, go, act }: V3PageProps) {
  const [adding, setAdding] = useState(false);
  return (
    <>
      <p className="mt-4 max-w-[620px] text-[14.5px] text-muted-foreground">
        Outside services your agents use: a command on this Mac (CLI) or an MCP
        server. LilOS stores what to run and who uses it, never your logins.
      </p>

      <div className="mt-5">
        {!adding && (
          <Btn onClick={() => setAdding(true)}>
            <PlusIcon className="size-3.5" />
            Add connector
          </Btn>
        )}
        {adding && (
          <AddForm
            onAdd={(c) => {
              act.addConnector(c);
              setAdding(false);
            }}
            onCancel={() => setAdding(false)}
          />
        )}
      </div>

      <div className="mt-4 border-[var(--v3-line)] border-t">
        {data.connectors.length === 0 && (
          <p className="py-3 text-[14px] text-muted-foreground">
            No connectors yet.
          </p>
        )}
        {data.connectors.map((c) => (
          <ConnectorRow key={c.id} c={c} data={data} go={go} act={act} />
        ))}
      </div>
    </>
  );
}

export function V3Settings({
  view = "general",
  ...props
}: V3PageProps & { view?: View }) {
  return (
    <Page wide>
      <Title>Settings</Title>
      <Tabs
        tabs={TABS}
        value={view}
        onChange={(id) => props.go({ page: "settings", view: id })}
      />
      {view === "general" && <GeneralPane {...props} />}
      {view === "engine" && <EnginePane {...props} />}
      {view === "phone" && <PhonePane {...props} />}
      {view === "connectors" && <ConnectorsPane {...props} />}
    </Page>
  );
}
