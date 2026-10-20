import { CheckIcon } from "lucide-react";
import { useState } from "react";
import { cn } from "../lib/utils";
import { Spinner, useTick } from "./v3-bits";
import { OutLine } from "./v3-live";
import { agentOf } from "./v3-model";
import type { V3Workbench } from "./v3-types";
import {
  CARD,
  FIELD,
  Panel,
  Quiet,
  WbBtn,
  type WbPanelProps,
} from "./v3-workbench-bits";

/* Terminal: what the agent ran and what it printed. You watch; to run
   something yourself you ask the agent, from the bar at the bottom. */

type Block = V3Workbench["terminal"][number];

/** What a command printed. */
function Lines({ lines }: { lines: string[] }) {
  if (lines.length === 0) return null;
  return (
    <div className="overflow-x-auto bg-[var(--v3-soft)]">
      <div className="min-w-max px-3.5 py-2.5 font-mono text-[12px] text-muted-foreground leading-[1.7]">
        {lines.map((l, i) => (
          <div key={i} className="lilos-v3-line-in whitespace-pre">
            <OutLine text={l} />
          </div>
        ))}
      </div>
    </div>
  );
}

/** A running command lets its output arrive a line per tick, so the tab
   reads as live. Only this one ticks; finished commands print in full. */
function LiveLines({ lines }: { lines: string[] }) {
  const n = useTick(900);
  return <Lines lines={lines.slice(0, Math.min(lines.length, 2 + n))} />;
}

function Output({ b }: { b: Block }) {
  return b.running ? <LiveLines lines={b.lines} /> : <Lines lines={b.lines} />;
}

function CommandBlock({ b }: { b: Block }) {
  return (
    <div className={cn(CARD, "overflow-hidden")}>
      <div className="flex items-center gap-2.5 px-3.5 py-2">
        <span className="min-w-0 flex-1 break-all font-mono text-[12.5px] text-foreground">
          <span className="select-none text-muted-foreground/70">$ </span>
          {b.cmd}
        </span>
        {b.running ? (
          <span className="flex shrink-0 items-center gap-1.5 text-[12.5px] text-muted-foreground">
            <Spinner />
            Running
          </span>
        ) : (
          <CheckIcon
            aria-label="Finished"
            className="size-3.5 shrink-0 text-muted-foreground/70"
          />
        )}
      </div>
      <Output b={b} />
    </div>
  );
}

function RunBar({ thread, data, act }: WbPanelProps) {
  const [cmd, setCmd] = useState("");
  const [sent, setSent] = useState<string>();
  const text = cmd.trim();
  const run = () => {
    if (!text) return;
    act.message(thread.id, `Run: ${text}`);
    setSent(text);
    setCmd("");
  };
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span className="select-none font-mono text-[12.5px] text-muted-foreground/70">
          $
        </span>
        <input
          value={cmd}
          onChange={(e) => setCmd(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) run();
          }}
          placeholder="Run a command…"
          aria-label="Run a command"
          className={cn(FIELD, "flex-1 font-mono text-[12.5px]")}
        />
        <WbBtn primary disabled={!text} onClick={run}>
          Run
        </WbBtn>
      </div>
      <p className="text-[12.5px] text-muted-foreground/70">
        {sent ? (
          <>
            Asked {agentOf(data, thread.agentId).name} to run{" "}
            <span className="font-mono text-[12px]">{sent}</span>.
          </>
        ) : (
          <>
            {agentOf(data, thread.agentId).name} runs it in {thread.folder} and
            the output lands here.
          </>
        )}
      </p>
    </div>
  );
}

export function TerminalTab(p: WbPanelProps) {
  const { terminal } = p.wb;
  return (
    <Panel bar={<RunBar {...p} />}>
      {terminal.length === 0 ? (
        <Quiet>The agent has not run anything yet.</Quiet>
      ) : (
        <div className="space-y-3">
          {terminal.map((b, i) => (
            <CommandBlock key={`${i}-${b.cmd}`} b={b} />
          ))}
        </div>
      )}
    </Panel>
  );
}
