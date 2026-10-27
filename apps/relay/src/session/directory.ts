import {
  CEO_SETTING_KEY,
  ChannelsOpenDmParams,
  CODING_AGENTS_SETTING_KEY,
  codingAgentOf,
  EmployeesCreateParams,
  EmployeesRemoveParams,
  EmployeesUpdateParams,
  FoldersAddParams,
  FoldersBrowseParams,
  FoldersDetailParams,
  FoldersDiscoverParams,
  FoldersListParams,
  ProfileUpdateParams,
  parseCodingAgents,
} from "@lilos/contracts/app";
import { resolveUnderHomeAsync } from "@lilos/host";
import { projectFolderOf } from "../projects";
import type { RelayStore } from "../store";
import type { RelayCtx } from "./ctx";
import { badParams, JsonRpcCode, RpcError } from "./rpc";

/** D-#835 (#872): an agent hired after the KV era starts from the owner's
    old stored default for it — model + effort together when the entry names
    a model, effort alone otherwise — and the entry is consumed, so a later
    re-hire can't revive a value the owner has since changed. Everyone who is
    not one of the four coding agents is untouched. */
async function withLegacyCodingDefault(
  store: RelayStore,
  input: EmployeesCreateParams,
): Promise<EmployeesCreateParams & { effort?: string }> {
  const agent = codingAgentOf(input);
  if (!agent) return input;
  const legacy = parseCodingAgents(
    await store.getSetting(CODING_AGENTS_SETTING_KEY),
  );
  const entry = legacy[agent];
  if (!entry) return input;
  const { [agent]: _used, ...rest } = legacy;
  await store.setSetting(CODING_AGENTS_SETTING_KEY, rest);
  return {
    ...input,
    ...(entry.model ? { model: entry.model } : {}),
    ...(entry.effort ? { effort: entry.effort } : {}),
  };
}

/** `reportsTo` is an employee id, never this row, and the chain from the
    manager must not come back here (D-#775). Unknown id is not_found so it
    matches every other missing employee; a cycle is invalid_params. */
async function assertReportsTo(
  store: RelayStore,
  employeeId: string,
  reportsTo: string,
): Promise<void> {
  if (reportsTo === employeeId) {
    throw new RpcError(
      JsonRpcCode.invalidParams,
      "invalid_params",
      "an employee cannot report to itself",
    );
  }
  const manager = await store.getEmployee(reportsTo);
  if (!manager) {
    throw new RpcError(JsonRpcCode.notFound, "not_found", "manager not found");
  }
  const seen = new Set<string>([employeeId]);
  let cur: string | undefined = reportsTo;
  while (cur) {
    if (seen.has(cur)) {
      throw new RpcError(
        JsonRpcCode.invalidParams,
        "invalid_params",
        "reportsTo would cycle",
      );
    }
    seen.add(cur);
    cur = (cur === reportsTo ? manager : await store.getEmployee(cur))
      ?.reportsTo;
  }
}

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
      const employee = await store.createEmployee(
        codingAgentOf(parsed.data)
          ? await withLegacyCodingDefault(store, parsed.data)
          : parsed.data,
      );
      broadcast("employee.upserted", { employee });
      respond(peer, id, { employee });
      return;
    }
    case "employees.update": {
      const parsed = EmployeesUpdateParams.safeParse(params);
      if (!parsed.success) throw badParams(parsed.error.issues);
      const { id: employeeId, ...patch } = parsed.data;
      if (typeof patch.reportsTo === "string")
        await assertReportsTo(store, employeeId, patch.reportsTo);
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
      /* D-#29: LilOS never deletes an engine profile — an employee is only
         the LilOS record pointing at engine runtime state. Remove from
         company drops the record + its channel/conversations/messages
         (`store.removeEmployee`) and never calls the engine; `agents.*`
         has no delete method at all. Not: delete the profile on remove. */
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
      /* The same write dropped ceoId. Clients clear the chip off this
         event; a missing key reads back as null (D-#778). */
      if (removed.clearedCeo) {
        broadcast("settings.changed", {
          key: CEO_SETTING_KEY,
          value: null,
        });
      }
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
      /* One spelling per folder (D-#771): recents use the same canonical
         form as projects (`~/x` under the Mac's home, no trailing slash),
         so a path typed absolute and the project's folder never list as
         two rows. */
      let path = projectFolderOf(parsed.data.path, homeDir);
      if (devicePeers.has(peer)) {
        /* The phone may add only what its browser could have listed —
           a real folder under the Mac's home (D-#238); stored as the
           canonical form of the resolved one. */
        const abs = await resolveUnderHomeAsync(path, homeDir);
        if (!abs) {
          throw new RpcError(
            JsonRpcCode.forbidden,
            "forbidden",
            "path is outside the Mac's home folder",
          );
        }
        path = projectFolderOf(abs, homeDir);
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
