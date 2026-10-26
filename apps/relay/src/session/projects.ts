import { ProjectsCreateParams, ProjectsListParams } from "@lilos/contracts/app";
import { resolveUnderHomeAsync } from "@lilos/host";
import { projectFolderOf } from "../projects";
import type { RelayCtx } from "./ctx";
import { badParams, JsonRpcCode, RpcError } from "./rpc";

/**
 * Projects (D-#771): the folders the company works in. `projects.create`
 * is get-or-create by folder, so the user's "new project", an agent's
 * approved `project_create` and the first-use filing inside
 * `conversations.open` all converge on one record per folder. There is no
 * update or delete — nothing renames or retires a project yet.
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
        about: parsed.data.about,
      });
      if (created) broadcast("project.upserted", { project });
      c.respond(peer, id, { project });
      return;
    }
    default:
      return false;
  }
}
