import {
  DevicesRevokeParams,
  PushRegisterParams,
  PushUnregisterParams,
  PushVisibilityParams,
  WS_CLOSE_DEVICE_REVOKED,
} from "@lilos/contracts/app";
import type { RelayCtx } from "./ctx";
import { badParams, JsonRpcCode, RpcError } from "./rpc";

/**
 * Moved verbatim out of `../session.ts`'s handle() (#441) — case
 * bodies are byte-identical modulo re-indentation. Returns `false`
 * when `method` belongs to another namespace; `undefined` once handled.
 */
export async function handlePairing(c: RelayCtx): Promise<false | undefined> {
  const {
    method,
    peer,
    id,
    params,
    options,
    store,
    devicePeers,
    now,
    requireDevice,
    respond,
  } = c;
  switch (method) {
    /* ---------------- phone pairing (#153) ---------------- */
    case "pairing.offer": {
      /**
       * The dialog's "turn on phone access": binds the Tailscale listener
       * (opt-in — loopback never appears in a QR) and mints a fresh
       * one-time grant for the code/QR it renders.
       */
      if (!options.pairing) {
        throw new RpcError(
          JsonRpcCode.unavailable,
          "internal",
          "pairing is not configured",
        );
      }
      const bound = await options.phoneAccess?.enable();
      if (!bound) {
        throw new RpcError(
          JsonRpcCode.unavailable,
          "tailscale_unavailable",
          "Tailscale isn't running on this Mac — install it and sign in, then try again.",
        );
      }
      const grant = await options.pairing.mintGrant();
      const profile = await store.getProfile();
      const name = profile.userName
        ? `${profile.userName}'s Mac`
        : (options.macName ?? "this Mac");
      respond(peer, id, {
        offer: {
          host: bound.host,
          code: grant.code,
          name,
          expiresAt: grant.expiresAt,
        },
      });
      return;
    }
    case "pairing.disable": {
      await options.phoneAccess?.disable();
      respond(peer, id, { ok: true });
      return;
    }
    case "devices.list": {
      respond(peer, id, {
        devices: (await options.pairing?.listDevices()) ?? [],
      });
      return;
    }
    case "devices.revoke": {
      const parsed = DevicesRevokeParams.safeParse(params);
      if (!parsed.success) throw badParams(parsed.error.issues);
      const device = await options.pairing?.revokeDevice(parsed.data.deviceId);
      if (!device) {
        throw new RpcError(
          JsonRpcCode.notFound,
          "not_found",
          "device not found",
        );
      }
      // Drop the revoked phone's live sockets; `closed()` then cleans
      // devicePeers/helloedPeers/subscriptions for each.
      for (const [p, did] of devicePeers) {
        if (did === device.id)
          p.close(WS_CLOSE_DEVICE_REVOKED, "device revoked");
      }
      /* #161 AC-1: revoke drops the push token too — the store cascade
         deletes the row; the fan-out forgets its visibility report. */
      options.push?.deviceGone(device.id);
      respond(peer, id, { ok: true });
      return;
    }
    /* ---------------- push registration (#161) ---------------- */
    case "push.register": {
      /* The phone reports its Expo push token + per-kind toggles, tied
         to the deviceId its hello authenticated. Idempotent upsert —
         sent after pairing and on every foreground. */
      const deviceId = requireDevice(peer);
      const parsed = PushRegisterParams.safeParse(params);
      if (!parsed.success) throw badParams(parsed.error.issues);
      await store.setDevicePush({
        deviceId,
        token: parsed.data.token,
        prefs: parsed.data.prefs,
        at: now(),
      });
      respond(peer, id, { ok: true });
      return;
    }
    case "push.unregister": {
      const deviceId = requireDevice(peer);
      const parsed = PushUnregisterParams.safeParse(params ?? {});
      if (!parsed.success) throw badParams(parsed.error.issues);
      await store.dropDevicePush(deviceId);
      options.push?.deviceGone(deviceId);
      respond(peer, id, { ok: true });
      return;
    }
    case "push.visibility": {
      /* Which thread this phone has open right now — the suppression
         input (AC-5). In-memory on the fan-out: a dead socket clears it
         in `closed()`, so a stale report can't mute pushes forever. */
      const deviceId = requireDevice(peer);
      const parsed = PushVisibilityParams.safeParse(params);
      if (!parsed.success) throw badParams(parsed.error.issues);
      options.push?.setVisibility(deviceId, parsed.data.conversationId);
      respond(peer, id, { ok: true });
      return;
    }
    default:
      return false;
  }
}
