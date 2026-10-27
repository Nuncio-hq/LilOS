import { InlineCodeText } from "../lib/inline-code";
import { Btn } from "./v3-bits";
import type { V3PageProps } from "./v3-page-types";
import { EngineFix, useRun } from "./v3-settings-bits";

/* First run's problem screen: it replaces the steps while something the
   app needs is down — the plain reason, what to do, and a way to check
   again. No internal names on this surface (#885): the detail lives behind
   "See status", in the app's diagnostics view. */

/** True while first run can proceed; false = the problem screen stands in
   for the steps (the app's relay is unreachable, or the engine reports a
   state the welcome cannot fix by itself). */
export function firstRunProblem(data: V3PageProps["data"]): boolean {
  const { engine, relay } = data.settings;
  return (
    relay.state === "down" ||
    engine.state === "missing" ||
    engine.state === "old" ||
    engine.state === "down"
  );
}

export function EngineProblem({
  data,
  act,
}: Pick<V3PageProps, "data" | "act">) {
  const { engine, relay } = data.settings;
  const [check, again] = useRun(() => act.checkEngine?.());
  const relayDown = relay.state === "down";
  return (
    <div className="mt-3" data-first-run-problem>
      <p className="text-[15px] font-medium text-foreground">
        Something LilOS needs isn't running.
      </p>
      {relayDown ? (
        relay.problem ? (
          <p className="mt-2 whitespace-pre-line text-[14px] text-muted-foreground">
            <InlineCodeText text={relay.problem} />
          </p>
        ) : (
          <p className="mt-2 text-[14px] text-muted-foreground">
            It couldn't reach the background service it runs on. Quit LilOS and
            open it again; if this stays, See status has the details.
          </p>
        )
      ) : engine.problem ? (
        <p className="mt-2 whitespace-pre-line text-[14px] text-muted-foreground">
          <InlineCodeText text={engine.problem} />
        </p>
      ) : (
        <EngineFix engine={engine} />
      )}
      <div className="mt-5 flex items-center gap-4">
        {act.checkEngine && (
          <Btn small onClick={again}>
            {check === "busy" ? "Checking…" : "Check again"}
          </Btn>
        )}
        {act.showStatus && (
          <button
            type="button"
            onClick={act.showStatus}
            className="text-[13.5px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
          >
            See status
          </button>
        )}
      </div>
    </div>
  );
}
