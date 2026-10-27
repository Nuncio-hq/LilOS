import { CopyIcon } from "lucide-react";
import { Btn, Section, Spinner } from "./v3-bits";
import type { V3Settings } from "./v3-data-types";
import { AgentAvatar, CeoMark } from "./v3-marks";
import type { V3PageProps } from "./v3-page-types";
import { EngineFix, EngineState, Row, useRun } from "./v3-settings-bits";
import { Confirm } from "./v3-settings-panes";

/* Settings → Engine & models' collapsed "Troubleshooting": everything
   diagnostic moved off the page in #885 — the engine card with its version,
   the relay leg, Copy diagnostics, the version line, and which agents run
   on this engine. Real internal names live here on purpose: this is the
   surface a bug report quotes from (the string scan allows it). */

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

export function EngineTrouble({ data, go, act }: V3PageProps) {
  const { engine, relay, models } = data.settings;
  const [check, again] = useRun(() => act.checkEngine?.());
  const onAgents = data.agents.filter((a) => a.kind !== "outside");
  const about = data.settings.about;
  const diagnostics =
    data.settings.diagnostics ??
    [
      about?.version ? `LilOS ${about.version}` : "LilOS",
      `Local relay: ${RELAY_WORD[relay.state].word.toLowerCase()}`,
      `Engine: ${[engine.name, engine.version].filter(Boolean).join(" ")} (${engine.state})${engine.path ? ` at ${engine.path}` : ""}`,
      `Agents on the engine: ${onAgents.length}`,
      `Models on: ${models
        .filter((m) => m.on)
        .map((m) => m.label)
        .join(", ")}`,
    ].join("\n");
  const relayTone = RELAY_WORD[relay.state];
  // Something it holds is down: the section opens by itself so the fix is
  // not behind a fold.
  const failing =
    relay.state === "down" ||
    engine.state === "missing" ||
    engine.state === "old" ||
    engine.state === "down";

  return (
    <details
      open={failing || undefined}
      className="mt-8 border-[var(--v3-line)] border-t"
    >
      <summary className="cursor-pointer select-none py-3 text-[13px] text-muted-foreground hover:text-foreground">
        Troubleshooting
      </summary>
      <div className="pb-4">
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
        {about && (
          <Row
            title="Versions"
            hint={`LilOS ${about.version}${about.detail ? ` · ${about.detail}` : ""}`}
          />
        )}
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
              <span className="flex items-center gap-1.5 truncate text-[14.5px] text-foreground">
                {a.name}
                {a.id === data.ceoId && <CeoMark />}
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
      </div>
    </details>
  );
}
