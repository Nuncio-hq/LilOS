import { RelayError } from "@lilos/client-runtime";
import type {
  AppMessage,
  Conversation,
  FoldersDetailResult,
  RecentFolder,
} from "@lilos/contracts/app";
import type { Job } from "@lilos/contracts/engine";
import type { DemoClient, DemoConv } from "./client";
import {
  DEMO_DEFAULT_MODEL,
  DEMO_DEFAULT_PROVIDER,
  DEMO_FOLDER_DETAILS,
  DEMO_FOUND,
  DEMO_MODELS,
  DEMO_PROVIDERS,
  DEMO_RECENTS,
  demoBrowse,
} from "./team";

/* The demo's `request()` dispatch (#168): same method names and result
   shapes the relay speaks, served from the in-memory world. Anything the
   app calls that isn't here fails loudly — a silent `{}` would hide a
   wire drift the AC-6 conformance test should catch instead. */

const as = <T>(v: Record<string, unknown>, k: string): T | undefined =>
  v[k] as T | undefined;

export async function handleRequest(
  client: DemoClient,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  switch (method) {
    case "session.ping":
      return { ok: true, instanceId: "demo" };
    case "system.status":
      return {
        protocolVersion: 1,
        generatedAt: new Date().toISOString(),
        components: [
          { id: "relay", label: "Relay", state: "ok", reason: "Demo relay" },
          {
            id: "harness",
            label: "Harness",
            state: "ok",
            reason: "Demo harness",
          },
          {
            id: "engine",
            label: "Engine",
            state: "ok",
            reason: "Hermes (demo)",
          },
          {
            id: "model",
            label: "Model",
            state: "ok",
            reason: DEMO_DEFAULT_MODEL,
          },
        ],
        versions: { relay: "0.1.0-demo", relayProtocol: 1 },
        engine: {
          name: "Hermes (demo)",
          models: DEMO_MODELS,
          providers: DEMO_PROVIDERS,
          defaultModel: DEMO_DEFAULT_MODEL,
          defaultProvider: DEMO_DEFAULT_PROVIDER,
        },
      };
    case "asks.list":
      return {
        asks: client.asks.get(),
      };
    case "asks.respond": {
      const askId = as<string>(params, "askId");
      const outcome = as<string>(params, "outcome");
      if (!askId || !outcome) throw new RelayError("bad params", "bad_params");
      const ask = await client.respondToAsk(
        askId,
        outcome,
        as<string>(params, "answer"),
      );
      return { ask };
    }
    case "channels.openDm": {
      const employeeId = as<string>(params, "employeeId");
      const channel = client.channels
        .get()
        .find((c) => c.kind === "dm" && c.employeeId === employeeId);
      if (!channel) throw new RelayError("no such employee", "not_found");
      return { channel };
    }
    case "conversations.open": {
      const channelId = as<string>(params, "channelId") ?? "";
      const text = as<string>(params, "text") ?? "";
      const channel = client.channels.get().find((c) => c.id === channelId);
      if (!channel) throw new RelayError("no such channel", "not_found");
      const conv = client.openConversation({
        channelId,
        title: as<string>(params, "title") || "New thread",
        text,
        authorId: as<string>(params, "authorId") ?? "user",
        cwd: as<string>(params, "cwd"),
        workspace: params.workspace as Conversation["workspace"],
        model: as<string>(params, "model"),
        provider: as<string>(params, "provider"),
        effort: as<string>(params, "effort"),
        fast: as<boolean>(params, "fast"),
      });
      return { conversation: conv.conv, rootMessage: conv.root };
    }
    case "conversations.setModel": {
      const conv = client.convs.get(as<string>(params, "conversationId") ?? "");
      if (!conv) throw new RelayError("no such conversation", "not_found");
      client.patchConversation(conv, {
        model: as<string>(params, "model"),
        provider: as<string>(params, "provider"),
        effort: as<string>(params, "effort"),
        fast: as<boolean>(params, "fast"),
      });
      return { conversation: conv.conv };
    }
    case "conversations.prs": {
      const conv = client.convs.get(as<string>(params, "conversationId") ?? "");
      return { prs: conv?.prs ?? [] };
    }
    case "messages.list": {
      const channelId = as<string>(params, "channelId") ?? "";
      const convId = as<string>(params, "conversationId");
      const after = as<number>(params, "afterSeq") ?? 0;
      const limit = as<number>(params, "limit");
      const includeRewound = as<boolean>(params, "includeRewound") ?? false;
      const includeDropped = as<boolean>(params, "includeDropped") ?? false;
      let msgs = allMessages(client, channelId).filter(
        (m) =>
          m.seq > after &&
          (convId ? m.conversationId === convId : true) &&
          !m.removed &&
          (includeRewound || !m.rewound) &&
          (includeDropped || !m.dropped),
      );
      if (limit !== undefined) msgs = msgs.slice(-limit);
      return {
        messages: msgs,
        lastSeq: msgs.at(-1)?.seq ?? after,
      };
    }
    case "messages.post": {
      const channelId = as<string>(params, "channelId") ?? "";
      const convId = as<string>(params, "conversationId");
      const message = client.postMessage(channelId, {
        text: as<string>(params, "text") ?? "",
        authorId: as<string>(params, "authorId") ?? "user",
        authorKind: (params.authorKind as AppMessage["authorKind"]) ?? "user",
        conversationId: convId ?? null,
      });
      const conv = convId ? client.convs.get(convId) : undefined;
      if (conv) {
        /* A turn is running → the message waits in the tray; idle → the
           engine claims it as the next turn. */
        client.deliver(conv, message);
      }
      return { message };
    }
    case "messages.remove":
    case "messages.drop":
    case "messages.send": {
      const messageId = as<string>(params, "messageId") ?? "";
      const found = findMessage(client, messageId);
      if (!found) throw new RelayError("no such message", "not_found");
      const [conv, msg] = found;
      const patch: Partial<AppMessage> =
        method === "messages.remove"
          ? { removed: true }
          : method === "messages.drop"
            ? { dropped: true }
            : { dropped: false };
      const idx = conv.messages.indexOf(msg);
      conv.messages[idx] = { ...msg, ...patch };
      client.fire("message.changed", {
        channelId: msg.channelId,
        message: conv.messages[idx],
      });
      if (method === "messages.send") {
        client.deliver(conv, conv.messages[idx]);
      }
      return { ok: true };
    }
    case "turns.interrupt": {
      const conv = client.convs.get(as<string>(params, "conversationId") ?? "");
      if (conv) client.interrupt(conv);
      return { ok: true };
    }
    case "jobs.list": {
      const sessionId = as<string>(params, "sessionId");
      const conv = [...client.convs.values()].find(
        (c) => c.conv.engineRef === sessionId,
      );
      return { jobs: conv?.jobs ?? [] };
    }
    case "jobs.stop": {
      const conv = [...client.convs.values()].find(
        (c) => c.conv.engineRef === as<string>(params, "sessionId"),
      );
      const jobId = as<string>(params, "jobId") ?? "";
      if (conv) {
        conv.jobs = conv.jobs.map((j) =>
          j.jobId === jobId
            ? { ...j, status: "exited" as Job["status"], endedAt: Date.now() }
            : j,
        );
      }
      return { stopped: true };
    }
    case "folders.list": {
      const now = Date.now();
      return {
        folders: DEMO_RECENTS.map(
          (path, i): RecentFolder => ({
            path,
            lastUsedAt: now - i * 86_400_000,
          }),
        ),
      };
    }
    case "folders.detail": {
      const path = as<string>(params, "path") ?? "";
      const d = DEMO_FOLDER_DETAILS[path];
      return {
        path,
        missing: d ? d.missing : true,
        isRepo: d?.isRepo ?? false,
        root: d?.root,
        current: d?.current,
        branches: d?.branches ?? [],
        remote: undefined,
        workstreams: (d?.workstreams ?? []).map((w) => ({
          branch: w.branch,
          path: w.path,
          from: w.from,
        })),
      } satisfies FoldersDetailResult;
    }
    case "folders.browse":
      return demoBrowse(as<string>(params, "path") ?? "~");
    case "folders.discover":
      return { repos: DEMO_FOUND };
    case "folders.add":
      return {
        folder: {
          path: as<string>(params, "path") ?? "~",
          lastUsedAt: Date.now(),
        },
      };
    case "models.list":
      return {
        models: DEMO_MODELS,
        default: DEMO_DEFAULT_MODEL,
        defaultProvider: DEMO_DEFAULT_PROVIDER,
        providers: DEMO_PROVIDERS,
      };
    case "settings.get":
      return { value: client.settingsGet(as<string>(params, "key") ?? "") };
    case "settings.set": {
      client.settingsSet(as<string>(params, "key") ?? "", params.value);
      return { ok: true };
    }
    case "push.register":
    case "push.unregister":
    case "push.visibility":
      /* The demo never talks to APNs; the app gates these in demo anyway. */
      return { ok: true };
    case "devices.list":
      return { devices: client.devices.get() };
    case "devices.revoke":
      return { ok: true };
    case "session.events": {
      const conv = client.convs.get(as<string>(params, "conversationId") ?? "");
      const after = as<number>(params, "after") ?? 0;
      return {
        events: conv?.events.filter((e) => e.seq > after) ?? [],
        latestSeq: conv?.latestSeq ?? 0,
        truncated: false,
        openRequests: conv?.ask
          ? [
              {
                requestId: conv.ask.ask.requestId,
                turnId: conv.ask.ask.turnId,
                request: conv.ask.ask.request,
                seq: conv.ask.askSeq,
              },
            ]
          : [],
        snapshot: conv ? client.snapshotOfPublic(conv) : undefined,
      };
    }
    case "channel.subscribe":
    case "channel.unsubscribe":
      return { ok: true };
    case "employees.list":
      return { employees: client.employees.get() };
    case "conversations.list":
      return { conversations: client.conversations.get() };
    case "summaries.list":
      return { summaries: client.conversationSummaries.get() };
    default:
      throw new RelayError(`demo: unknown method ${method}`, "bad_method");
  }
}

function allMessages(client: DemoClient, channelId: string): AppMessage[] {
  return [...client.convs.values()]
    .filter((c) => c.conv.channelId === channelId)
    .flatMap((c) => c.messages)
    .sort((a, b) => a.seq - b.seq);
}

function findMessage(
  client: DemoClient,
  messageId: string,
): [DemoConv, AppMessage] | undefined {
  for (const conv of client.convs.values()) {
    const msg = conv.messages.find((m) => m.id === messageId);
    if (msg) return [conv, msg];
  }
  return undefined;
}
