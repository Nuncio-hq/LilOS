import {
  APP_PROTOCOL_VERSION,
  PairingExchangeParams,
} from "@lilos/contracts/app";
import { Hono } from "hono";
import type { PairingService } from "./pairing";

/** Plain HTTP surface; the realtime socket lives at `/ws` (upgraded in the entry). */
export function createApp(info: {
  instanceId: string;
  relayVersion: string;
  /**
   * Phone pairing service (#153): mounts `POST /pair/exchange` — the phone
   * spends a one-time grant (from the QR's URL fragment) for a per-device
   * credential. Absent = no exchange route (bare relays in tests).
   */
  pairing?: PairingService;
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
  if (info.pairing) {
    const pairing = info.pairing;
    app.post("/pair/exchange", async (c) => {
      const body = await c.req.json().catch(() => null);
      const parsed = PairingExchangeParams.safeParse(body);
      if (!parsed.success) {
        return c.json({ error: "unknown" }, 400);
      }
      const outcome = await pairing.exchangeGrant({
        code: parsed.data.code,
        name: parsed.data.name,
      });
      if ("error" in outcome) {
        // 410 Gone: the grant can never be (re)used — unknown, spent, or dead.
        return c.json({ error: outcome.error }, 410);
      }
      return c.json({
        deviceId: outcome.device.id,
        credential: outcome.credential,
        device: outcome.device,
      });
    });
  }
  return app;
}
