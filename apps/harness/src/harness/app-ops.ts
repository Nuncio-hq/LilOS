import type { RelayClient } from "@lilos/client-runtime";
import type {
  AppMessage,
  CompanyUpdate,
  Conversation,
  ConversationSummary,
  Employee,
  Goal,
  MessageSearchHit,
  ProfileSettings,
  ScheduledTask,
  SystemStatusResult,
  Task,
  Ticket,
} from "@lilos/contracts/app";
import {
  CEO_SETTING_KEY,
  CODING_AGENTS_SETTING_KEY,
  codingAgentsOf,
  parseCodingAgents,
} from "@lilos/contracts/app";
import type {
  SessionBinding,
  TicketAssignParams,
  TicketCommentParams,
  TicketCreateParams,
  TicketReadParams,
  TicketUpdateParams,
  TicketUpdateResult,
  UpdatePostParams,
} from "@lilos/contracts/harness";
import type { ForgePrListItem } from "@lilos/contracts/host";
import type { AppOps } from "@lilos/surfaces";
import type { Logger } from "../log";
import { createGatewayApprovalOps, listProjects } from "./gateway-ops";
import { resolveTaskIsolation, type TaskIsolation } from "./task-isolation";

/**
 * The `appOps` factory behind `serveSurfaces` — every op talks to the relay
 * through the same methods the app uses, scoped to the bound
 * employee/channel/conversation by the session's binding (the agent never
 * passes an id). The channel is the relay's internal routing scope, not a
 * place the agent or user sees (D-#25). `runningTurnId` resolves the live
 * engine turn lazily so approval asks bind to the turn that raised them.
 */
export function createAppOps(deps: {
  relay: RelayClient;
  runningTurnId: (conversationId: string) => string | undefined;
  log: Logger;
  /* The Mac home `~` names on the wire — the same value `Harness.home`
     resolves to (`opts.homeDir ?? homedir()`). Stored `cwd`/`repoPath`
     spellings collapse against it. */
  home: string;
  /* #872: an explicit `task_create` model is checked against the CHILD
     agent's own runtime catalog — a name only the parent's engine knows
     throws here, never silently starts on the wrong runtime. Returns the
     catalog's own id/provider for the pick. */
  checkTaskModel?: (
    employee: Employee,
    model: string,
    provider?: string,
  ) => Promise<{ model: string; provider?: string }>;
}): (session: string, binding?: SessionBinding) => AppOps | undefined {
  const { relay, runningTurnId, log, home, checkTaskModel } = deps;
  return (_session, binding) => {
    if (!binding) return undefined;
    return {
      postMessage: async (text) => {
        const { message } = await relay.request<{ message: AppMessage }>(
          "messages.post",
          {
            channelId: binding.channelId,
            conversationId: binding.conversationId,
            authorKind: "employee",
            authorId: binding.employeeId,
            text,
          },
        );
        return message;
      },
      /* D-#844: `thread`'s child target — a user message on the child's
         channel is its next prompt, same as the owner typing there. */
      postToThread: async (p) => {
        const { message } = await relay.request<{ message: AppMessage }>(
          "messages.post",
          {
            channelId: p.channelId,
            conversationId: p.conversationId,
            authorKind: "user",
            authorId: "user",
            text: p.text,
          },
        );
        return message;
      },
      readConversation: async (opts) => {
        const page = await relay.request<{ messages: AppMessage[] }>(
          "messages.list",
          {
            channelId: opts?.channelId ?? binding.channelId,
            conversationId: opts?.conversationId ?? binding.conversationId,
            ...(opts?.afterSeq !== undefined
              ? { afterSeq: opts.afterSeq }
              : {}),
          },
        );
        return page.messages;
      },
      /* Thread tools: the rest of the app leg — same relay methods the app
         uses, scoped to the bound channel/conversation by the binding. */
      listThreads: async () => {
        const r = await relay.request<{ conversations: Conversation[] }>(
          "conversations.list",
          { channelId: binding.channelId, includeArchived: true },
        );
        return r.conversations;
      },
      threadSummaries: async () => {
        const r = await relay.request<{ summaries: ConversationSummary[] }>(
          "conversations.summaries",
          { channelId: binding.channelId, includeArchived: true },
        );
        return r.summaries;
      },
      employees: async () => {
        const r = await relay.request<{ employees: Employee[] }>(
          "employees.list",
          {},
        );
        return r.employees;
      },
      threadPrs: async (conversationId) => {
        const r = await relay.request<{ prs: ForgePrListItem[] }>(
          "conversations.prs",
          { conversationId },
        );
        return r.prs;
      },
      searchMessages: async (query, limit) => {
        const r = await relay.request<{ hits: MessageSearchHit[] }>(
          "messages.search",
          {
            query,
            channelId: binding.channelId,
            includeArchived: true,
            ...(limit !== undefined ? { limit } : {}),
          },
        );
        return r.hits;
      },
      setThreadTitle: async (title) => {
        /* The relay enforces it store-side: a host title write lands as
           "auto" and never overwrites a user-typed title — the response's
           titleSource tells which way it went. */
        const r = await relay.request<{ conversation: Conversation }>(
          "conversations.update",
          { conversationId: binding.conversationId, title },
        );
        return r.conversation.titleSource === "user"
          ? { outcome: "user_title" as const, title: r.conversation.title }
          : { outcome: "set" as const, title: r.conversation.title };
      },
      scheduledTasks: async (employeeId) => {
        const r = await relay.request<{ tasks: ScheduledTask[] }>(
          "schedules.list",
          { employeeId },
        );
        return r.tasks;
      },
      projects: () => listProjects(relay),
      /* D-#776: ticket writes do not ask. The bound employee is the comment
         author — the tool has no `by` for a model to fill in. */
      goals: async () => {
        const r = await relay.request<{ goals: Goal[] }>("goals.list", {});
        return r.goals;
      },
      tickets: async (project?: string) => {
        const r = await relay.request<{ tickets: Ticket[] }>("tickets.list", {
          ...(project ? { project } : {}),
        });
        return r.tickets;
      },
      readTicket: async (p: TicketReadParams) => {
        const r = await relay.request<{ ticket: Ticket }>("tickets.read", p);
        return r.ticket;
      },
      createTicket: async (p: TicketCreateParams) => {
        const r = await relay.request<{ ticket: Ticket }>("tickets.create", {
          ...p,
          ...(binding.employeeId ? { actorId: binding.employeeId } : {}),
        });
        return r.ticket;
      },
      updateTicket: async (p: TicketUpdateParams) =>
        relay.request<TicketUpdateResult>("tickets.update", {
          ...p,
          ...(binding.employeeId ? { actorId: binding.employeeId } : {}),
        }),
      assignTicket: async (p: TicketAssignParams) => {
        const r = await relay.request<{
          ticket: Ticket;
          conversation: Conversation;
        }>("tickets.assign", {
          ...p,
          ...(binding.employeeId ? { actorId: binding.employeeId } : {}),
        });
        return {
          ticket: r.ticket,
          thread: { id: r.conversation.id, title: r.conversation.title },
        };
      },
      commentTicket: async (p: TicketCommentParams) => {
        const r = await relay.request<{ ticket: Ticket }>("tickets.comment", {
          ...p,
          by: binding.employeeId,
        });
        return r.ticket;
      },
      postUpdate: async (p: UpdatePostParams) => {
        const r = await relay.request<{ update: CompanyUpdate }>(
          "updates.post",
          {
            ...p,
            authorKind: "employee",
            authorId: binding.employeeId,
          },
        );
        return r.update;
      },
      /* D-#844: the task_* leg. `parentConversationId` is the bound
         thread — the relay scopes every op to children it created, so a
         task id from anywhere else reads not_found. `agent` resolves to
         an employee by id first, then by exact (case-insensitive) name;
         an ambiguous name fails loudly instead of picking one. */
      taskCreate: async (p) => {
        const { employees } = await relay.request<{ employees: Employee[] }>(
          "employees.list",
          {},
        );
        const needle = p.agent.trim();
        const byId = employees.find((e) => e.id === needle);
        const named = employees.filter(
          (e) => e.name.toLowerCase() === needle.toLowerCase(),
        );
        const employee = byId ?? (named.length === 1 ? named[0] : undefined);
        if (!employee) {
          throw new Error(
            named.length > 1
              ? `agent "${p.agent}" names ${named.length} employees — use the id from team_list`
              : `unknown agent "${p.agent}" — team_list has the roster`,
          );
        }
        /* D-#848: the isolation pick resolves HERE — the harness is the
           only process with git (D-#11); the relay just stamps the
           `cwd`/`workspace` it is given. "shared" skips the probe (and
           the parent-row read) entirely. */
        let isolation: TaskIsolation = {};
        if (p.isolation !== "shared") {
          const { conversations } = await relay.request<{
            conversations: Conversation[];
          }>("conversations.list", {
            channelId: binding.channelId,
            includeArchived: true,
          });
          const parent = conversations.find(
            (c) => c.id === binding.conversationId,
          );
          isolation = await resolveTaskIsolation({
            cwd: parent?.cwd,
            workspace: parent?.workspace,
            isolation: p.isolation,
            seed: p.title ?? p.prompt,
            home,
          });
        }
        /* #872: a model the caller names resolves on the child's own
           runtime catalog (a cross-runtime name fails here, loudly);
           absent means the relay stamps the child's stored default —
           never the parent's pick. */
        const pick =
          p.model !== undefined && checkTaskModel
            ? await checkTaskModel(employee, p.model, p.provider)
            : undefined;
        const r = await relay.request<{
          task: Task;
          conversation: Conversation;
        }>("tasks.create", {
          parentConversationId: binding.conversationId,
          employeeId: employee.id,
          prompt: p.prompt,
          ...(p.title !== undefined ? { title: p.title } : {}),
          ...(p.requestId !== undefined ? { requestId: p.requestId } : {}),
          ...(pick
            ? {
                model: pick.model,
                ...(pick.provider ? { provider: pick.provider } : {}),
              }
            : p.model !== undefined
              ? { model: p.model }
              : {}),
          ...(pick === undefined && p.provider !== undefined
            ? { provider: p.provider }
            : {}),
          ...(p.effort !== undefined ? { effort: p.effort } : {}),
          ...(p.fast !== undefined ? { fast: p.fast } : {}),
          ...(isolation.cwd !== undefined ? { cwd: isolation.cwd } : {}),
          ...(isolation.workspace !== undefined
            ? { workspace: isolation.workspace }
            : {}),
        });
        /* The heads-up names the STORED row, never the resolved intent —
           a requestId retry re-answers the real worktree instead of one
           that was never created. "Uncommitted changes are not in it":
           the worktree forks the commit, not the working tree. */
        const ws = r.conversation.workspace;
        const note =
          ws?.mode === "new" && r.conversation.cwd
            ? `${employee.name} works in a fresh worktree ${r.conversation.cwd} on branch ${ws.branch}, forked from your checkout's current commit — your uncommitted changes are not in it. Merging back stays a separate step (for example a PR or git merge).`
            : undefined;
        return { task: r.task, ...(note ? { note } : {}) };
      },
      taskRead: async (taskId) => {
        const r = await relay.request<{ task: Task }>("tasks.read", {
          taskId,
          parentConversationId: binding.conversationId,
        });
        return r.task;
      },
      taskCancel: async (taskId) => {
        const r = await relay.request<{ task: Task }>("tasks.cancel", {
          taskId,
          parentConversationId: binding.conversationId,
        });
        return r.task;
      },
      taskChildren: async () => {
        const r = await relay.request<{
          conversations: Conversation[];
          tickets: Ticket[];
        }>("tasks.children", {
          parentConversationId: binding.conversationId,
        });
        return r;
      },
      status: () =>
        relay.request<SystemStatusResult>("system.status", { logLines: 0 }),
      profile: async () => {
        const r = await relay.request<{ profile: ProfileSettings }>(
          "profile.get",
          {},
        );
        return r.profile;
      },
      openWorkbench: async (target) => {
        await relay.request("workbench.open", {
          conversationId: binding.conversationId,
          target,
        });
      },
      /* D-#835: the user's defaults for outside coding agents are the
         Employee records' own model + effort (#872); an agent nobody has
         hired yet reads its legacy KV entry, read-only. */
      codingAgents: async () => {
        const r = await relay.request<{ employees: Employee[] }>(
          "employees.list",
          {},
        );
        const legacy = await relay
          .request<{ value: unknown }>("settings.get", {
            key: CODING_AGENTS_SETTING_KEY,
          })
          .then((x) => parseCodingAgents(x.value))
          .catch(() => ({}));
        return codingAgentsOf(r.employees, legacy);
      },
      /* The live holder. Call time reads this; the start snapshot is separate (D-#778). */
      ceoId: async () => {
        const r = await relay.request<{ value: unknown }>("settings.get", {
          key: CEO_SETTING_KEY,
        });
        return typeof r.value === "string" && r.value ? r.value : undefined;
      },
      ...createGatewayApprovalOps({
        relay,
        binding,
        runningTurnId: () => runningTurnId(binding.conversationId),
        log,
      }),
    };
  };
}
