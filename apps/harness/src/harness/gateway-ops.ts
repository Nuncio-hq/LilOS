import type { RelayClient } from "@lilos/client-runtime";
import type {
  AppMessage,
  Ask,
  AskHireProposal,
  Conversation,
  Employee,
  Project,
  RecentFolder,
  ScheduledTask,
} from "@lilos/contracts/app";
import type { AgentDescriptor } from "@lilos/contracts/engine";
import type {
  AskParams,
  ProjectCreateParams,
  ScheduleCreateParams,
  ScheduleUpdateParams,
  SessionBinding,
  TeamHireParams,
  TeamUpdateParams,
} from "@lilos/contracts/harness";
import type { AppOps } from "@lilos/surfaces";
import { SurfaceError } from "@lilos/surfaces";
import type { Logger } from "../log";

/**
 * Approval-gated company writes behind the gateway tools (D-#341: they
 * reuse the user's own ask). Each `access: "approval"` op posts a
 * `kind: "approval"` (once/deny) ask on the bound conversation through the
 * relay asks seam (`asks.open`) and waits for it — nothing is written before
 * "once", whatever the thread's access level: neither the engine's approval
 * path nor a thread's `access: "full"` auto-approve (asks.ts) can bypass it.
 * It then applies the change through the same relay methods the app uses.
 * `team_hire` carries its draft in `Ask.hire`, so the thread renders the
 * same hire card a channel hire shows. A decline surfaces as
 * `SurfaceError("declined")` so the agent reads a clean refusal instead of
 * a hang or a fake success.
 *
 * Asks here never touch the engine ask seam (`askByRequest`/`requestByAsk`)
 * — there is no engine request to answer, so the wait happens locally on
 * `ask.resolved` plus a slow `asks.list` poll (the event is fire-and-forget
 * and a mid-reconnect answer would otherwise be missed, the same gap the
 * reconcile pass covers for engine asks).
 *
 * Not: a parallel gateway-ask flow (the engine's `requestByAsk` path can't
 * reach it — unknown ask ids no-op there), auto-approve for gateway asks,
 * or write-first-ask-later.
 */

const POLL_MS = 2_000;

export interface GatewayApprovalDeps {
  relay: RelayClient;
  /** Scope source: the bound employee/channel/conversation — never a param. */
  binding: SessionBinding;
  /** Live running-turn id for the bound conversation (ask cards bind to the
      turn they were raised in). */
  runningTurnId: () => string | undefined;
  log: Logger;
}

/** The relay's project list — what `project_list` answers and what
    `thread_start`'s `project` resolves against (D-#771). */
export async function listProjects(relay: RelayClient): Promise<Project[]> {
  const r = await relay.request<{ projects: Project[] }>("projects.list", {});
  return r.projects;
}

const profileSlug = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[^a-z0-9]+|[-_]+$/g, "")
    .slice(0, 64);

/** Wait until the ask resolves; resolves with the final ask. */
function waitForResolution(relay: RelayClient, initial: Ask): Promise<Ask> {
  if (initial.state === "resolved") return Promise.resolve(initial);
  return new Promise((resolve) => {
    let done = false;
    const finish = (ask: Ask) => {
      if (done) return;
      done = true;
      unsub();
      clearInterval(poll);
      resolve(ask);
    };
    const unsub = relay.onEvent((method, params) => {
      if (method !== "ask.resolved") return;
      const ask = (params as { ask?: Ask }).ask;
      if (ask?.id === initial.id) finish(ask);
    });
    const poll = setInterval(() => {
      relay
        .request<{ asks: Ask[] }>("asks.list", {
          conversationId: initial.conversationId,
          state: "resolved",
        })
        .then((r) => {
          const hit = r.asks.find((a) => a.id === initial.id);
          if (hit) finish(hit);
        })
        .catch(() => {});
    }, POLL_MS);
    poll.unref?.();
  });
}

export function createGatewayApprovalOps(
  deps: GatewayApprovalDeps,
): Pick<
  AppOps,
  | "startThread"
  | "hireEmployee"
  | "updateSelf"
  | "addFolder"
  | "createProject"
  | "scheduleCreate"
  | "scheduleUpdate"
  | "scheduleDelete"
  | "scheduleRunNow"
  | "askUser"
> {
  const { relay, runningTurnId, binding } = deps;

  /** Post the ask card and wait for the answer; resolves on approve, throws
      `declined` on any other outcome. Options stay once/deny — company
      changes are one-shot grants, never widened to session/always. */
  const gate = async (
    request: { command: string; description: string },
    hire?: AskHireProposal,
  ): Promise<void> => {
    const requestId = `gw-${crypto.randomUUID()}`;
    /* Cards render inside the live turn feed (`a.turnId === turn.turnId`);
       without a running turn the ask still lands in the ask inbox /
       "Needs you" sheet and push. */
    const turnId = runningTurnId() ?? requestId;
    const { ask } = await relay.request<{ ask: Ask }>("asks.open", {
      channelId: binding.channelId,
      conversationId: binding.conversationId,
      turnId,
      requestId,
      request: {
        kind: "approval",
        command: request.command,
        description: request.description,
        options: ["once", "deny"],
      },
      ...(hire ? { hire } : {}),
    });
    const resolved = await waitForResolution(relay, ask);
    if (resolved.outcome !== "once") {
      throw new SurfaceError(
        "declined",
        `the user declined: ${request.command}`,
      );
    }
  };

  /** `thread_start`'s `project`: a project's id (exact) or key (any case),
      resolved against the relay's list. Runs BEFORE the ask opens, so an
      unknown value costs the user no card; the error names the value and
      the keys that do exist so the agent can correct itself. */
  const resolveProject = async (ref: string): Promise<Project> => {
    const projects = await listProjects(relay);
    const wanted = ref.trim();
    const hit =
      projects.find((p) => p.id === wanted) ??
      projects.find((p) => p.key.toLowerCase() === wanted.toLowerCase());
    if (hit) return hit;
    const keys = projects.map((p) => p.key);
    throw new SurfaceError(
      "not_found",
      `no project "${ref}" — pass a project's id or key from project_list (${
        keys.length > 0
          ? `available keys: ${keys.join(", ")}`
          : "there are no projects yet; project_create makes one"
      }), or leave project out for a plain chat`,
    );
  };

  return {
    startThread: async (p: {
      text: string;
      title?: string;
      project?: string;
    }) => {
      const project =
        p.project !== undefined ? await resolveProject(p.project) : undefined;
      const titled = p.title ? ` titled "${p.title}"` : "";
      await gate({
        command: `thread_start ${p.title ?? p.text.slice(0, 60)}${project ? ` (${project.key})` : ""}`,
        description: project
          ? `Start a new thread in ${project.name} (${project.folder})${titled} with the message:\n\n${p.text}`
          : `Start a new thread${titled} (a plain chat, no project) with the message:\n\n${p.text}`,
      });
      /* The folder is the only thing sent: the relay files the thread in
         the project that owns `cwd` (D-#771), and no `cwd` = a plain chat
         in the default workdir. Channel and author come from the binding —
         never from the agent (D-#341). */
      const r = await relay.request<{
        conversation: Conversation;
        rootMessage: AppMessage;
      }>("conversations.open", {
        channelId: binding.channelId,
        authorId: binding.employeeId,
        text: p.text,
        ...(p.title !== undefined ? { title: p.title } : {}),
        ...(project ? { cwd: project.folder } : {}),
      });
      return { conversation: r.conversation, message: r.rootMessage };
    },

    hireEmployee: async (p: TeamHireParams) => {
      await gate(
        {
          command: `team_hire ${p.name} (${p.role})`,
          description: `Hire ${p.name} as ${p.role} on model ${p.model}${p.provider ? ` (${p.provider})` : ""}${p.profile ? `, reusing engine profile ${p.profile}` : ", creating a new engine profile"}.`,
        },
        {
          name: p.name,
          role: p.role,
          model: p.model,
          instructions: p.instructions,
          ...(p.provider ? { provider: p.provider } : {}),
          ...(p.profile ? { profile: p.profile } : {}),
        },
      );
      let profileId = p.profile;
      if (!profileId) {
        /* No profile arg → create one from the draft, the way the hire
           dialog does (LilOS never owns profiles — the engine does). */
        const { agent } = await relay.request<{ agent: AgentDescriptor }>(
          "agents.create",
          {
            name: profileSlug(p.name),
            soul: p.instructions,
            model: p.model,
            ...(p.provider ? { provider: p.provider } : {}),
          },
        );
        profileId = agent.id;
      }
      const { employee } = await relay.request<{ employee: Employee }>(
        "employees.create",
        {
          name: p.name.trim(),
          role: p.role.trim(),
          status: "online",
          profile: profileId,
          model: p.model,
          instructions: p.instructions,
        },
      );
      await relay.request("channels.openDm", { employeeId: employee.id });
      return employee;
    },

    updateSelf: async (p: TeamUpdateParams) => {
      /* The card states the values, not just the fields — a rename to
         "CEO" must not read the same as one to "junior". */
      const fields = Object.entries(p)
        .map(([k, v]) => `${k}: ${String(v)}`)
        .join(", ");
      await gate({
        command: `team_update ${fields}`,
        description: `Update your own employee record — ${fields}.`,
      });
      /* The employee id comes from the session binding — an agent can only
         ever edit itself. The engine profile write lands first and mirrors
         the app's save path: soul/model go to `agents.update`, the company
         record follows once it sticks. A guarded model pin is re-sent with
         confirmModel because the card already stated exactly what would
         change and the user approved it. */
      const { employees } = await relay.request<{ employees: Employee[] }>(
        "employees.list",
        {},
      );
      const employee = employees.find((e) => e.id === binding.employeeId);
      const wantsEngine = p.instructions !== undefined || p.model !== undefined;
      if (wantsEngine && employee?.profile) {
        const r = await relay.request<{
          agent: AgentDescriptor;
          confirmModel?: string;
        }>("agents.update", {
          id: employee.profile,
          ...(p.name !== undefined ? { name: p.name } : {}),
          ...(p.instructions !== undefined ? { soul: p.instructions } : {}),
          ...(p.model !== undefined ? { model: p.model } : {}),
        });
        if (r.confirmModel && p.model !== undefined) {
          await relay.request("agents.update", {
            id: employee.profile,
            model: p.model,
            confirmModel: true,
          });
        }
      }
      const updated = await relay.request<{ employee: Employee }>(
        "employees.update",
        {
          id: binding.employeeId,
          ...(p.name !== undefined ? { name: p.name } : {}),
          ...(p.role !== undefined ? { role: p.role } : {}),
          ...(p.model !== undefined ? { model: p.model } : {}),
          ...(p.instructions !== undefined
            ? { instructions: p.instructions }
            : {}),
        },
      );
      return updated.employee;
    },

    addFolder: async (path: string) => {
      await gate({
        command: `folder_add ${path}`,
        description: `Add ${path} to the recent-folders list so it can be picked for a session.`,
      });
      const r = await relay.request<{ folder: RecentFolder }>("folders.add", {
        path,
      });
      return r.folder;
    },

    createProject: async (p: ProjectCreateParams) => {
      await gate({
        command: `project_create ${p.folder}${p.name ? ` (${p.name})` : ""}`,
        description: `Make a project of ${p.folder}${p.name ? ` named "${p.name}"` : ""}${p.about ? ` — ${p.about}` : ""}. Threads started in it work in that folder. A folder that already has a project keeps that one.`,
      });
      const r = await relay.request<{ project: Project }>("projects.create", {
        folder: p.folder,
        ...(p.name !== undefined ? { name: p.name } : {}),
        ...(p.about !== undefined ? { about: p.about } : {}),
      });
      return r.project;
    },

    scheduleCreate: async (p: ScheduleCreateParams) => {
      await gate({
        command: `schedule_create ${p.name}`,
        description: `Add a scheduled task "${p.name}" (${p.schedule.kind}) running "${p.prompt}"${p.folder ? ` in ${p.folder}` : ""} at ${p.access} access.`,
      });
      const r = await relay.request<{ task: ScheduledTask }>(
        "schedules.create",
        { ...p, employeeId: binding.employeeId },
      );
      return r.task;
    },

    scheduleUpdate: async (p: ScheduleUpdateParams) => {
      const fields = Object.entries(p)
        .filter(([k]) => k !== "id")
        .map(([k, v]) => `${k}: ${String(v)}`)
        .join(", ");
      await gate({
        command: `schedule_update ${fields}`,
        description: `Edit scheduled task ${p.id} — ${fields}.`,
      });
      const r = await relay.request<{ task: ScheduledTask }>(
        "schedules.update",
        p,
      );
      return r.task;
    },

    scheduleDelete: async (id: string) => {
      await gate({
        command: `schedule_delete ${id}`,
        description: `Delete scheduled task ${id} — its future runs stop.`,
      });
      await relay.request("schedules.delete", { id });
    },

    scheduleRunNow: async (id: string) => {
      await gate({
        command: `schedule_run_now ${id}`,
        description: `Run scheduled task ${id} now — a new thread opens at once.`,
      });
      const r = await relay.request<{ task: ScheduledTask }>(
        "schedules.runNow",
        { id },
      );
      return r.task;
    },

    /**
     * `ask` (D-#773). Options make a question; otherwise a once/deny
     * approval — never "always", so "Allow this next time" stays an
     * engine offer. why/ifYes/ifNo sit on the ask, not the request, so
     * an engine approval keeps its command. A decline throws, and the
     * turn resumes with that.
     */
    askUser: async (p: AskParams) => {
      const requestId = `gw-${crypto.randomUUID()}`;
      const turnId = runningTurnId() ?? requestId;
      const lines = {
        ...(p.why ? { why: p.why } : {}),
        ...(p.ifYes ? { ifYes: p.ifYes } : {}),
        ...(p.ifNo ? { ifNo: p.ifNo } : {}),
      };
      const request = p.options?.length
        ? {
            kind: "question" as const,
            question: p.question,
            options: p.options.map((label, i) => ({ id: `o${i}`, label })),
          }
        : {
            kind: "approval" as const,
            command: p.question,
            description: p.question,
            options: ["once" as const, "deny" as const],
          };
      const { ask } = await relay.request<{ ask: Ask }>("asks.open", {
        channelId: binding.channelId,
        conversationId: binding.conversationId,
        turnId,
        requestId,
        request,
        ...lines,
      });
      const resolved = await waitForResolution(relay, ask);
      if (request.kind === "question") {
        const picked =
          resolved.outcome === "answer"
            ? p.options?.find((_, i) => `o${i}` === resolved.answer)?.label
            : undefined;
        if (!picked) {
          throw new SurfaceError(
            "declined",
            `the user declined: ${p.question}`,
          );
        }
        return { outcome: "yes" as const, answer: picked };
      }
      if (resolved.outcome !== "once") {
        throw new SurfaceError("declined", `the user declined: ${p.question}`);
      }
      return { outcome: "yes" as const };
    },
  };
}
