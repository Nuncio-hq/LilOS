import { useEffect } from "react";
import { Btn } from "./v3-bits";
import { EngineFix, EngineState, useRun } from "./v3-settings-bits";
import type { V3PageProps } from "./v3-types";
import { CheckRow } from "./v3-welcome-bits";

/* First run, step "Engine check": the relay, then the engine, each as the
   app last found it (never a timer). Blocked until both are fine, with the
   engine's own words about what to do, and a way to ask again. */

export function EngineStep({ data, act }: Pick<V3PageProps, "data" | "act">) {
  const { engine, relay } = data.settings;
  const [check, again] = useRun(() => act.checkEngine?.());
  // Land on a fresh answer rather than whatever the last poll said.
  useEffect(() => {
    void act.checkEngine?.();
  }, []);

  const relayLeg =
    relay.state === "ok" ? "ok" : relay.state === "starting" ? "run" : "fail";
  // The engine cannot be known while the relay is not answering.
  const engineLeg =
    relay.state !== "ok"
      ? "wait"
      : engine.state === "ok"
        ? "ok"
        : engine.state === "starting"
          ? "run"
          : "fail";
  const stuck = relayLeg === "fail" || engineLeg === "fail";

  return (
    <div className="mt-3">
      <p className="mb-1 text-[14px] text-muted-foreground">
        LilOS runs on your Mac. This makes sure everything it needs is there.
      </p>
      <CheckRow state={relayLeg} label="Local relay" result="Connected" />
      <CheckRow
        state={engineLeg}
        label={`Engine ${[engine.name, engine.state === "missing" ? undefined : engine.version].filter(Boolean).join(" ")}`}
        result={engineLeg === "ok" ? "Ready" : <EngineState engine={engine} />}
      />
      {stuck && (
        <div className="mt-4">
          {relayLeg === "fail" ? (
            relay.problem && (
              <p className="whitespace-pre-line text-[13.5px] text-muted-foreground">
                {relay.problem}
              </p>
            )
          ) : (
            <EngineFix engine={engine} />
          )}
          {act.checkEngine && (
            <div className="mt-4">
              <Btn small onClick={again}>
                {check === "busy" ? "Checking…" : "Check again"}
              </Btn>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
