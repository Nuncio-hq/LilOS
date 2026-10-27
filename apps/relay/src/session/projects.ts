import {
  ProjectsCreateParams,
  ProjectsListParams,
  ProjectsRemoveParams,
} from "@lilos/contracts/app";
import { resolveUnderHomeAsync } from "@lilos/host";
import { openFolderOf, projectFolderOf, projectForFolder } from "../projects";
import type { RelayCtx } from "./ctx";
import { badParams, JsonRpcCode, RpcError } from "./rpc";

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
      const { project, created } = await store.ensureProject({
        folder,
        name: parsed.data.name,
        key: parsed.data.key,
        about: parsed.data.about,
      });
      if (created) {
        broadcast("project.upserted", { project });
        /* A folder that becomes a project adopts the threads already in it
           (and any subfolders it contains — D-#854): they were chats filed
           before the project existed. */
        const filings: { conversationId: string; projectId: string }[] = [];
        for (const conversation of await store.listConversations({
          includeArchived: true,
        })) {
          if (conversation.projectId !== undefined) continue;
          const folder = openFolderOf(conversation, homeDir);
          if (folder && projectForFolder([project], folder, homeDir)) {
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
      if (!removed) {
        throw new RpcError(
          JsonRpcCode.notFound,
          "not_found",
          "project not found",
        );
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
