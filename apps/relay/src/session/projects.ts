import {
  ProjectsCreateParams,
  ProjectsListParams,
  ProjectsRemoveParams,
} from "@lilos/contracts/app";
import { resolveUnderHomeAsync } from "@lilos/host";
import {
  folderKeyOf,
  openFolderOf,
  projectFolderOf,
  projectForFolder,
} from "../projects";
import type { RelayCtx } from "./ctx";
import { badParams, JsonRpcCode, RpcError } from "./rpc";

/** D-#854 round 2: a removed project leaves this settings tombstone —
    the goal/ticket ids it detached — so re-adding the folder puts the
    company back exactly. Keyed by the folder's canonical compare key so
    any spelling finds it. */
const tombstoneKey = (folder: string, homeDir: string) =>
  `detached.project.${folderKeyOf(folder, homeDir)}`;

interface DetachedRows {
  goalIds: string[];
  ticketIds: string[];
}

/**
 * Projects (D-#854): the folders the owner says are projects — made by hand
 * here, removed by hand here, never inferred from a folder being used.
 * `projects.create` is get-or-create by folder, so the sidebar's "new
 * project" and a chat's "Add as project" converge on one record per
 * folder; name and key are the dialog's editable picks. `projects.remove`
 * takes only the record: threads, goals, and tickets keep theirs and the
 * folder is untouched — the threads re-file by containment under whatever
 * projects remain (most become chats).
 */
export async function handleProjects(c: RelayCtx): Promise<false | undefined> {
  const { method, peer, id, params, store, devicePeers, homeDir, broadcast } =
    c;
  switch (method) {
    case "projects.list": {
      const parsed = ProjectsListParams.safeParse(params ?? {});
      if (!parsed.success) throw badParams(parsed.error.issues);
      c.respond(peer, id, { projects: await store.listProjects() });
      return;
    }
    case "projects.create": {
      const parsed = ProjectsCreateParams.safeParse(params);
      if (!parsed.success) throw badParams(parsed.error.issues);
      let folder = projectFolderOf(parsed.data.folder, homeDir);
      if (devicePeers.has(peer)) {
        /* Same boundary as a phone's `folders.add` (D-#238): a paired
           phone may only make a project of a real folder under the Mac's
           home — what its folder browser could have listed. */
        const abs = await resolveUnderHomeAsync(folder, homeDir);
        if (!abs) {
          throw new RpcError(
            JsonRpcCode.forbidden,
            "forbidden",
            "folder is outside the Mac's home folder",
          );
        }
        folder = projectFolderOf(abs, homeDir);
      }
      /* D-#854 round 2 guard: `~` or `/` would swallow every folder on the
         machine — refuse before anything files under it. */
      const homeKey = folderKeyOf("~", homeDir);
      const folderKey = folderKeyOf(folder, homeDir);
      if (folderKey === homeKey || folderKey === folderKeyOf("/", homeDir)) {
        throw new RpcError(
          JsonRpcCode.invalidParams,
          "invalid_params",
          "a project needs a folder inside it — not the home folder or the filesystem root",
        );
      }
      const existing = await store.listProjects();
      const mine = existing.find(
        (p) => folderKeyOf(p.folder, homeDir) === folderKey,
      );
      const key = parsed.data.key;
      if (!mine && key) {
        const takenBy = existing.find((p) => p.key === key);
        /* A typed key must land verbatim — a conflict is the caller's to
           fix, never a silent rename to `KEY2` (D-#854 round 2). */
        if (takenBy) {
          throw new RpcError(
            JsonRpcCode.conflict,
            "conflict",
            `Key ${key} is already taken by ${takenBy.name}`,
            { key, name: takenBy.name },
          );
        }
      }
      /* The tombstone a remove of this folder left behind — its goal and
         ticket ids rejoin the new record inside `ensureProject`. */
      const prior = (await store.getSetting(
        tombstoneKey(folder, homeDir),
      )) as DetachedRows | null;
      const { project, created, attached } = await store.ensureProject({
        folder,
        name: parsed.data.name,
        key,
        about: parsed.data.about,
        ...(prior
          ? {
              reattach: {
                goalIds: prior.goalIds,
                ticketIds: prior.ticketIds,
              },
            }
          : {}),
      });
      if (created) {
        await store.setSetting(tombstoneKey(folder, homeDir), null);
        broadcast("project.upserted", { project });
        for (const goal of attached.goals) {
          broadcast("goal.upserted", { goal });
        }
        for (const ticket of attached.tickets) {
          broadcast("ticket.upserted", { ticket });
        }
        /* A folder that becomes a project adopts every thread inside it —
           the chats filed before it existed, and the threads a shallower
           project held: the most-specific folder owns them (D-#854). */
        const filings: { conversationId: string; projectId: string }[] = [];
        const convs = await store.listConversations({
          includeArchived: true,
        });
        for (const conversation of convs) {
          if (conversation.projectId === project.id) continue;
          const folder = openFolderOf(conversation, homeDir);
          if (!folder) continue;
          /* The new project claims the thread when it is the deepest
             containing folder — a shallower project that had it loses it. */
          const best = projectForFolder(
            [...existing, project],
            folder,
            homeDir,
          );
          if (best?.id === project.id) {
            filings.push({
              conversationId: conversation.id,
              projectId: project.id,
            });
          }
        }
        if (filings.length) {
          await store.setConversationProjects(filings);
          for (const { conversationId } of filings) {
            const conversation = await store.getConversation(conversationId);
            if (conversation) {
              c.emitConversation(conversation.channelId, conversation);
            }
          }
        }
      }
      c.respond(peer, id, { project });
      return;
    }
    case "projects.remove": {
      const parsed = ProjectsRemoveParams.safeParse(params);
      if (!parsed.success) throw badParams(parsed.error.issues);
      const removed = await store.removeProject(parsed.data.id);
      /* D-#854 round 2: a stale or repeated remove answers ok — the record
         is already gone, which is the state the caller asked for. */
      if (!removed) {
        c.respond(peer, id, { ok: true });
        return;
      }
      /* Tombstone the detached goal/ticket ids under the folder's canonical
         key — re-adding it puts them back (D-#854 round 2). */
      if (removed.goals.length || removed.tickets.length) {
        await store.setSetting(tombstoneKey(removed.project.folder, homeDir), {
          goalIds: removed.goals.map((g) => g.id),
          ticketIds: removed.tickets.map((t) => t.id),
        } satisfies DetachedRows);
      }
      /* The threads re-file by containment under the projects that remain —
         a parent folder's project keeps them, the rest become chats. */
      const remaining = await store.listProjects();
      const refilings: { conversationId: string; projectId: string }[] = [];
      for (const conversation of removed.conversations) {
        const folder = openFolderOf(conversation, homeDir);
        const next = folder
          ? projectForFolder(remaining, folder, homeDir)
          : undefined;
        if (next) {
          refilings.push({
            conversationId: conversation.id,
            projectId: next.id,
          });
        }
      }
      if (refilings.length) await store.setConversationProjects(refilings);
      broadcast("project.removed", { projectId: removed.project.id });
      for (const goal of removed.goals) broadcast("goal.upserted", { goal });
      for (const ticket of removed.tickets) {
        broadcast("ticket.upserted", { ticket });
      }
      for (const detached of removed.conversations) {
        const conversation = await store.getConversation(detached.id);
        if (conversation) {
          c.emitConversation(conversation.channelId, conversation);
        }
      }
      c.respond(peer, id, { ok: true });
      return;
    }
    default:
      return false;
  }
}
