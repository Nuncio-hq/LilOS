import { CopyIcon } from "lucide-react";
import { AgentAvatar, Btn, Section, Spinner } from "./v3-bits";
import { ConnectRows } from "./v3-connect-rows";
import {
  EngineFix,
  EngineState,
  Row,
  Switch,
  useRun,
} from "./v3-settings-bits";
import { Confirm } from "./v3-settings-panes";
import type { V3PageProps, V3Settings } from "./v3-types";

/* Settings → Engine & models: the engine and the link to it, how to fix
   either, the agents on it, whether LilOS is connected to its profiles, and
   which models the pickers offer. A part the app has no data for is not
   drawn. */

const RELAY_WORD: Record<
  V3Settings["relay"]["state"],
  { word: string; dot: string; text: string }
> = {
  ok: {
    word: "Connected",
    dot: "bg-emerald-500",
    text: "text-muted-foreground",
  },
  starting: {
    word: "Connecting…",
    dot: "bg-stone-400",
    text: "text-muted-foreground",
  },
  down: {
    word: "Not connected",
    dot: "bg-red-500",
    text: "text-red-600 dark:text-red-300",
  },
};

export function EnginePane({ data, go, act }: V3PageProps) {
  const { engine, relay, models, connect } = data.settings;
  const [check, again] = useRun(() => act.checkEngine?.());
  const onCount = models.filter((m) => m.on).length;
  const onAgents = data.agents.filter((a) => a.kind !== "outside");
  const diagnostics =
    data.settings.diagnostics ??
    [
      data.settings.about?.version ?? "LilOS",
      `Local relay: ${RELAY_WORD[relay.state].word.toLowerCase()}`,
      `Engine: ${[engine.name, engine.version].filter(Boolean).join(" ")} (${engine.state})${engine.path ? ` at ${engine.path}` : ""}`,
      `Agents on the engine: ${onAgents.length}`,
      `Models on: ${models
        .filter((m) => m.on)
        .map((m) => m.label)
        .join(", ")}`,
    ].join("\n");
  const relayTone = RELAY_WORD[relay.state];
  let group: string | undefined;

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
              {engine.version && (
                <span className="ml-2 text-[13px] text-muted-foreground">
                  {engine.version}
                </span>
              )}
            </div>
            {engine.path && (
              <div className="mt-0.5 truncate font-mono text-[12.5px] text-muted-foreground">
                {engine.path}
              </div>
            )}
          </div>
          <EngineState engine={engine} />
        </div>
        <EngineFix engine={engine} />
        {act.checkEngine && (
          <div className="mt-4 flex items-center gap-3">
            <Btn small onClick={again}>
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
        )}
      </div>

      <Section title="Status" />
      <Row
        title="Local relay"
        hint={
          relay.problem ?? "Carries messages between this app and the engine."
        }
      >
        <span
          className={`flex items-center gap-1.5 text-[13.5px] ${relayTone.text}`}
        >
          <span
            aria-hidden
            className={`size-1.5 rounded-full ${relayTone.dot}`}
          />
          {relayTone.word}
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
          run={() => {
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
            {a.runtime && (
              <span className="block truncate font-mono text-[12.5px] text-muted-foreground">
                {a.runtime}
              </span>
            )}
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

      {connect && (
        <>
          <Section title={`Connect ${connect.engine} to LilOS`} />
          <p className="mb-1 text-[13px] text-muted-foreground">
            Connected agents see the app (their chats, folders and work) and act
            in it for you. Only chats LilOS opens are affected.
          </p>
          <ConnectRows rows={connect.rows} />
          {!connect.approved && act.connectEngine && (
            <div className="mt-3">
              <Btn small onClick={() => void act.connectEngine?.()}>
                Connect
              </Btn>
            </div>
          )}
        </>
      )}

      {models.length > 0 && (
        <>
          <Section title="Models" count={`${onCount} on`} />
          <p className="mb-1 text-[13px] text-muted-foreground">
            Pickers only offer the models that are on.
          </p>
          {models.map((m) => {
            const heading = m.group !== group ? m.group : undefined;
            group = m.group;
            return (
              <div key={m.id}>
                {heading && (
                  <div className="mt-4 text-[12.5px] text-muted-foreground/70">
                    {heading}
                  </div>
                )}
                <Row title={m.label}>
                  <Switch
                    label={`${m.label} on`}
                    on={m.on}
                    // At least one model stays on, or a picker would be empty.
                    disabled={m.on && onCount === 1}
                    title={
                      m.on && onCount === 1
                        ? "Keep at least one model on"
                        : undefined
                    }
                    onChange={(on) =>
                      act.saveSettings({
                        models: models.map((x) =>
                          x.id === m.id ? { ...x, on } : x,
                        ),
                      })
                    }
                  />
                </Row>
              </div>
            );
          })}
        </>
      )}
    </>
  );
}
