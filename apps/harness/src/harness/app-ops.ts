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
}): (session: string, binding?: SessionBinding) => AppOps | undefined {
  const { relay, runningTurnId, log } = deps;
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
        const r = await relay.request<{ task: Task }>("tasks.create", {
          parentConversationId: binding.conversationId,
          employeeId: employee.id,
          prompt: p.prompt,
          ...(p.title !== undefined ? { title: p.title } : {}),
          ...(p.requestId !== undefined ? { requestId: p.requestId } : {}),
          ...(p.model !== undefined ? { model: p.model } : {}),
          ...(p.provider !== undefined ? { provider: p.provider } : {}),
          ...(p.effort !== undefined ? { effort: p.effort } : {}),
          ...(p.fast !== undefined ? { fast: p.fast } : {}),
        });
        return r.task;
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
      /* D-#835: the user's stored defaults for outside coding agents. The
         `codingAgents` KV row is the one place they live; the hand-off
         skills read it before every run. */
      codingAgents: async () => {
        const r = await relay.request<{ value: unknown }>("settings.get", {
          key: CODING_AGENTS_SETTING_KEY,
        });
        return parseCodingAgents(r.value);
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
