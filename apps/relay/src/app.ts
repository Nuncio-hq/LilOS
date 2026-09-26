import { APP_PROTOCOL_VERSION } from "@lilos/contracts/app";
import { Hono } from "hono";

/** Plain HTTP surface; the realtime socket lives at `/ws` (upgraded in the entry). */
export function createApp(info: {
  instanceId: string;
  relayVersion: string;
}): Hono {
  const app = new Hono();
  app.get("/healthz", (c) =>
    c.json({
      ok: true,
      relayVersion: info.relayVersion,
      instanceId: info.instanceId,
      protocolVersion: APP_PROTOCOL_VERSION,
    }),
  );
  return app;
}
