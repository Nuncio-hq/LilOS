import {
  CEO_SETTING_KEY,
  SettingsGetParams,
  SettingsSetParams,
} from "@lilos/contracts/app";
import type { RelayCtx } from "./ctx";
import { badParams, JsonRpcCode, RpcError } from "./rpc";

/**
 * Moved verbatim out of `../session.ts`'s handle() (#441) — case
 * bodies are byte-identical modulo re-indentation. Returns `false`
 * when `method` belongs to another namespace; `undefined` once handled.
 */
export async function handleSettings(c: RelayCtx): Promise<false | undefined> {
  const { method, peer, id, params, store, broadcast, respond } = c;
  switch (method) {
    case "settings.get": {
      const parsed = SettingsGetParams.safeParse(params);
      if (!parsed.success) throw badParams(parsed.error.issues);
      const value = await store.getSetting(parsed.data.key);
      respond(peer, id, { value });
      return;
    }
    case "settings.set": {
      const parsed = SettingsSetParams.safeParse(params);
      if (!parsed.success) throw badParams(parsed.error.issues);
      /* The position and the org edges move together (D-#778). A bare
         write of `ceoId` would crown someone the chart does not follow. */
      if (parsed.data.key === CEO_SETTING_KEY) {
        throw new RpcError(
          JsonRpcCode.invalidParams,
          "invalid_params",
          "ceoId changes only through company.setCeo",
        );
      }
      await store.setSetting(parsed.data.key, parsed.data.value);
      // One list for every connected client (#92 AC-7): a write by any
      // peer is broadcast so all surfaces update at once.
      broadcast("settings.changed", {
        key: parsed.data.key,
        value: parsed.data.value,
      });
      respond(peer, id, { ok: true });
      return;
    }
    default:
      return false;
  }
}
