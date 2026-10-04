import {
  ChannelsOpenDmParams,
  EmployeesCreateParams,
  EmployeesRemoveParams,
  EmployeesUpdateParams,
  FoldersAddParams,
  FoldersBrowseParams,
  FoldersDetailParams,
  FoldersDiscoverParams,
  FoldersListParams,
  ProfileUpdateParams,
} from "@lilos/contracts/app";
import { collapsePath, resolveUnderHome } from "@lilos/host";
import type { RelayCtx } from "./ctx";
import { badParams, JsonRpcCode, RpcError } from "./rpc";

/**
 * Moved verbatim out of `../session.ts`'s handle() (#441) — case
 * bodies are byte-identical modulo re-indentation. Returns `false`
 * when `method` belongs to another namespace; `undefined` once handled.
 */
export async function handleDirectory(c: RelayCtx): Promise<false | undefined> {
  const {
    method,
    peer,
    id,
    params,
    store,
    subscribers,
    devicePeers,
    homeDir,
    broadcast,
    forwardToHost,
    respond,
  } = c;
  switch (method) {
    case "employees.list": {
      respond(peer, id, { employees: await store.listEmployees() });
      return;
    }
    case "employees.create": {
      const parsed = EmployeesCreateParams.safeParse(params);
      if (!parsed.success) throw badParams(parsed.error.issues);
      const employee = await store.createEmployee(parsed.data);
      broadcast("employee.upserted", { employee });
      respond(peer, id, { employee });
      return;
    }
    case "employees.update": {
      const parsed = EmployeesUpdateParams.safeParse(params);
      if (!parsed.success) throw badParams(parsed.error.issues);
      const { id: employeeId, ...patch } = parsed.data;
      const employee = await store.updateEmployee(employeeId, patch);
      if (!employee) {
        throw new RpcError(
          JsonRpcCode.notFound,
          "not_found",
          "employee not found",
        );
      }
      broadcast("employee.upserted", { employee });
      respond(peer, id, { employee });
      return;
    }
    case "employees.remove": {
      const parsed = EmployeesRemoveParams.safeParse(params);
      if (!parsed.success) throw badParams(parsed.error.issues);
      const removed = await store.removeEmployee(parsed.data.id);
      if (!removed) {
        throw new RpcError(
          JsonRpcCode.notFound,
          "not_found",
          "employee not found",
        );
      }
      for (const channelId of removed.channelIds) {
        subscribers.delete(channelId);
        broadcast("channel.removed", { channelId });
      }
      broadcast("employee.removed", { employeeId: parsed.data.id });
      respond(peer, id, { ok: true });
      return;
    }
    case "channels.list": {
      respond(peer, id, { channels: await store.listChannels() });
      return;
    }
    case "folders.list": {
      const parsed = FoldersListParams.safeParse(params ?? {});
      if (!parsed.success) throw badParams(parsed.error.issues);
      respond(peer, id, { folders: await store.listRecentFolders() });
      return;
    }
    case "folders.add": {
      const parsed = FoldersAddParams.safeParse(params);
      if (!parsed.success) throw badParams(parsed.error.issues);
      let path = parsed.data.path;
      if (devicePeers.has(peer)) {
        /* The phone may add only what its browser could have listed —
           a real folder under the Mac's home (#238). The stored path
           is the canonical `~/x` form of the resolved one. */
        const abs = resolveUnderHome(path, homeDir);
        if (!abs) {
          throw new RpcError(
            JsonRpcCode.forbidden,
            "forbidden",
            "path is outside the Mac's home folder",
          );
        }
        path = collapsePath(abs, homeDir);
      }
      respond(peer, id, { folder: await store.addRecentFolder(path) });
      return;
    }
    case "folders.detail": {
      /* Branch/workstream probe of a recents-listed folder (#156): the
         phone (device scope) can read workspaces of folders the Mac
         already lists — nothing wider. The probe itself runs on the
         session machine, so the call forwards to the harness. */
      const parsed = FoldersDetailParams.safeParse(params);
      if (!parsed.success) throw badParams(parsed.error.issues);
      const recents = await store.listRecentFolders();
      if (!recents.some((f) => f.path === parsed.data.path)) {
        throw new RpcError(
          JsonRpcCode.notFound,
          "not_found",
          "folder is not in the recents list",
        );
      }
      forwardToHost(peer, id, "folders.detail", parsed.data);
      return;
    }
    case "folders.browse": {
      /* The phone's folder browser (#238): forwarded to the harness,
         which enforces the home-folder boundary server-side. */
      const parsed = FoldersBrowseParams.safeParse(params);
      if (!parsed.success) throw badParams(parsed.error.issues);
      forwardToHost(peer, id, "folders.browse", parsed.data);
      return;
    }
    case "folders.discover": {
      /* "Found on this Mac" for the phone browser (#238) — same scan
         roots as the web dialog, computed by the harness. */
      const parsed = FoldersDiscoverParams.safeParse(params ?? {});
      if (!parsed.success) throw badParams(parsed.error.issues);
      forwardToHost(peer, id, "folders.discover", parsed.data);
      return;
    }
    case "profile.get": {
      respond(peer, id, { profile: await store.getProfile() });
      return;
    }
    case "profile.update": {
      const parsed = ProfileUpdateParams.safeParse(params);
      if (!parsed.success) throw badParams(parsed.error.issues);
      const profile = await store.updateProfile(parsed.data);
      broadcast("profile.updated", { profile });
      respond(peer, id, { profile });
      return;
    }
    case "channels.openDm": {
      const parsed = ChannelsOpenDmParams.safeParse(params);
      if (!parsed.success) throw badParams(parsed.error.issues);
      const { channel, created } = await store.openDmChannel(
        parsed.data.employeeId,
      );
      if (created) broadcast("channel.created", { channel });
      respond(peer, id, { channel });
      return;
    }
    default:
      return false;
  }
}
