import type { RelayClient } from "@lilos/client-runtime";
import type {
  AppMessage,
  Conversation,
  ConversationSummary,
  Employee,
  MessageSearchHit,
  ProfileSettings,
  ScheduledTask,
  SystemStatusResult,
} from "@lilos/contracts/app";
import type { SessionBinding } from "@lilos/contracts/harness";
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
      readConversation: async (opts) => {
        const page = await relay.request<{ messages: AppMessage[] }>(
          "messages.list",
          {
            channelId: binding.channelId,
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
      ...createGatewayApprovalOps({
        relay,
        binding,
        runningTurnId: () => runningTurnId(binding.conversationId),
        log,
      }),
    };
  };
}
