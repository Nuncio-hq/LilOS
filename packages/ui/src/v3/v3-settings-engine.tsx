import { Btn, Section } from "./v3-bits";
import { ConnectRows } from "./v3-connect-rows";
import type { V3PageProps } from "./v3-page-types";
import { Row, Switch } from "./v3-settings-bits";
import { EngineTrouble } from "./v3-settings-trouble";

/* Settings → Engine & models (#885): what you choose day to day — the
   engine's profile connection and which models the pickers offer — and a
   collapsed Troubleshooting for everything diagnostic (the engine card, the
   relay leg, versions, Copy diagnostics, the agents on it). The section
   opens by itself while something it holds is down. */

export function EnginePane({ data, go, act }: V3PageProps) {
  const { models, connect } = data.settings;
  const onCount = models.filter((m) => m.on).length;
  let group: string | undefined;

  return (
    <>
      {connect && (
        <>
          <Section
            title={`Connect ${connect.engine} to LilOS`}
            className="mt-6"
          />
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

      <EngineTrouble data={data} go={go} act={act} />
    </>
  );
}
