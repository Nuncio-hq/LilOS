import { describe, expect, it } from "vitest";
import { buildSchemaDoc } from "../scripts/gen-schemas.js";
import {
  AppEventMethod,
  AppMessage,
  AppMethod,
  ChannelRemovedEvent,
  ChannelSubscribeParams,
  Conversation,
  ConversationsOpenParams,
  ConversationsSetAccessParams,
  ConversationsUpdateParams,
  Employee,
  EmployeeRemovedEvent,
  EmployeesRemoveParams,
  EmployeeUpsertedEvent,
  ENGINE_PASSTHROUGH_METHODS,
  HelloParams,
  JsonRpcNotification,
  JsonRpcRequest,
  MessageCreatedEvent,
  ProtocolVersionMismatch,
  SessionPingResult,
  WelcomeResult,
} from "../src/app";
import { appProtocol } from "../src/app/registry";
import {
  ApprovalOption,
  ApprovalOutcome,
  ApprovalRequest,
  ApprovalsSetPolicyParams,
  ApprovalsSetPolicyResult,
} from "../src/engine";
import {
  ContextResult,
  ThreadListItem,
  ThreadReadResult,
} from "../src/harness/tools";

const employee = {
  id: "emp_ada",
  name: "Ada",
  role: "Backend engineer",
  status: "online",
  profile: "Ships the relay",
  model: "qwen3.8-flash-next",
  now: "Relay slice",
  instructions: "",
  respondTo: "anyone",
  createdAt: 1_759_000_000_000,
};

const message = {
  id: "msg_1",
  channelId: "ch_dm_ada",
  conversationId: "conv_1",
  authorId: "emp_ada",
  authorKind: "employee",
  text: "hello",
  seq: 3,
  createdAt: 1_759_000_000_001,
  rewound: false,
  dropped: false,
  removed: false,
  claimed: false,
};

describe("AC-1 app protocol contracts", () => {
  it("parses a versioned hello handshake and welcome", () => {
    expect(
      HelloParams.parse({
        protocolVersion: 1,
        token: "tok",
        client: { name: "web" },
      }),
    ).toMatchObject({ protocolVersion: 1 });
    expect(
      WelcomeResult.parse({
        protocolVersion: 1,
        relayVersion: "0.0.0",
        instanceId: "inst_1",
        engineHost: { connected: false },
      }),
    ).toMatchObject({ instanceId: "inst_1" });
  });

  it("parses JSON-RPC request, notification, and domain objects", () => {
    expect(
      JsonRpcRequest.parse({
        jsonrpc: "2.0",
        id: "r1",
        method: "messages.post",
        params: { channelId: "ch_dm_ada", text: "hi" },
      }).method,
    ).toBe("messages.post");
    expect(
      JsonRpcNotification.parse({
        jsonrpc: "2.0",
        method: "message.created",
        params: { channelId: "ch_dm_ada", message },
      }).method,
    ).toBe("message.created");
    expect(Employee.parse(employee)).toEqual(employee);
    expect(AppMessage.parse(message)).toEqual(message);
    expect(
      MessageCreatedEvent.parse({ channelId: "ch_dm_ada", message }).message
        .seq,
    ).toBe(3);
  });

  it("rejects frames that are not JSON-RPC or carry a bad shape", () => {
    expect(JsonRpcRequest.safeParse({ id: 1, method: "x" }).success).toBe(
      false,
    );
    expect(AppMessage.safeParse({ ...message, seq: 0 }).success).toBe(false);
    // Unknown (e.g. transcript) keys never survive the wire shape.
    expect(
      AppMessage.parse({ ...message, tools: [], reasoning: "..." }),
    ).toEqual(message);
  });

  it("declares the session.ping keep-alive probe (#154)", () => {
    expect(AppMethod.safeParse("session.ping").success).toBe(true);
    expect(SessionPingResult.parse({ ok: true, instanceId: "i1" })).toEqual({
      ok: true,
      instanceId: "i1",
    });
    expect(
      SessionPingResult.safeParse({ ok: false, instanceId: "i1" }).success,
    ).toBe(false);
  });

  it("accepts the subscribe cursor contract (afterSeq optional, >=0)", () => {
    expect(ChannelSubscribeParams.parse({ channelId: "c" })).toEqual({
      channelId: "c",
    });
    expect(
      ChannelSubscribeParams.parse({ channelId: "c", afterSeq: 41 }),
    ).toEqual({
      channelId: "c",
      afterSeq: 41,
    });
    expect(
      ChannelSubscribeParams.safeParse({ channelId: "c", afterSeq: -1 })
        .success,
    ).toBe(false);
  });

  it("generates a deterministic JSON Schema doc containing every registered schema", () => {
    const doc = buildSchemaDoc(appProtocol) as {
      protocolVersion: number;
      definitions: Record<string, unknown>;
    };
    expect(doc.protocolVersion).toBe(1);
    for (const name of [
      "HelloParams",
      "AppMessage",
      "ChannelSubscribeParams",
    ]) {
      expect(doc.definitions[name]).toBeTruthy();
    }
  });

  // The committed-vs-fresh stale check moved to schema-gen.test.ts with the
  // unified generator (#42): regenerate with `bun run schema:gen`.
});

describe("AC-4 version mismatch error shape", () => {
  it("names the side to update", () => {
    expect(
      ProtocolVersionMismatch.parse({
        code: "protocol_version_mismatch",
        update: "client",
        clientVersion: 1,
        serverVersion: 2,
      }).update,
    ).toBe("client");
    expect(
      ProtocolVersionMismatch.parse({
        code: "protocol_version_mismatch",
        update: "server",
        clientVersion: 3,
        serverVersion: 2,
      }).update,
    ).toBe("server");
  });
});

describe("#29 employee lifecycle + engine passthrough contracts", () => {
  it("declares employees.remove and the engine-passthrough method set", () => {
    expect(EmployeesRemoveParams.parse({ id: "emp_1" })).toEqual({
      id: "emp_1",
    });
    expect(EmployeesRemoveParams.safeParse({ id: "" }).success).toBe(false);
    for (const method of [
      "employees.remove",
      "agents.list",
      "agents.describe",
      "agents.create",
      "agents.update",
      "models.list",
      "jobs.list",
      "jobs.stop",
      "approvals.setPolicy",
    ]) {
      expect(AppMethod.safeParse(method).success).toBe(true);
    }
    expect(ENGINE_PASSTHROUGH_METHODS).toEqual([
      "agents.list",
      "agents.describe",
      "agents.create",
      "agents.update",
      "models.list",
      "jobs.list",
      "jobs.stop",
      "approvals.setPolicy",
    ]);
  });

  it("declares employee + channel lifecycle events", () => {
    for (const method of [
      "channel.removed",
      "employee.upserted",
      "employee.removed",
    ]) {
      expect(AppEventMethod.safeParse(method).success).toBe(true);
    }
    expect(EmployeeUpsertedEvent.parse({ employee })).toEqual({ employee });
    expect(EmployeeRemovedEvent.parse({ employeeId: "emp_1" })).toEqual({
      employeeId: "emp_1",
    });
    expect(ChannelRemovedEvent.parse({ channelId: "ch_1" })).toEqual({
      channelId: "ch_1",
    });
  });

  it("keeps the no-delete shape: no profile-delete method exists anywhere", () => {
    for (const method of AppMethod.options) {
      expect(method).not.toMatch(/agents\.(remove|delete)|profiles\.delete/);
    }
  });
});

describe("#106 approval modes per conversation", () => {
  it("AC-1/AC-3 access rides conversations.open and defaults to the app enum", () => {
    expect(
      ConversationsOpenParams.safeParse({
        channelId: "ch_1",
        text: "hi",
        access: "full",
      }).success,
    ).toBe(true);
    expect(
      ConversationsOpenParams.safeParse({
        channelId: "ch_1",
        text: "hi",
        access: "loud",
      }).success,
    ).toBe(false);
    // A conversation row parses with the level it was opened at; rows
    // written before #106 default to "ask".
    const conv = Conversation.parse({
      id: "c1",
      channelId: "ch_1",
      rootMessageId: "m1",
      engineRef: null,
      state: "idle",
      title: "t",
      archived: false,
      createdAt: 1,
    });
    expect(conv.access).toBe("ask");
    expect(Conversation.parse({ ...conv, access: "full" }).access).toBe("full");
  });

  it("AC-1 conversations.setAccess is the user-only switch", () => {
    expect(AppMethod.safeParse("conversations.setAccess").success).toBe(true);
    expect(
      ConversationsSetAccessParams.parse({
        conversationId: "c1",
        access: "full",
      }),
    ).toEqual({ conversationId: "c1", access: "full" });
    expect(
      ConversationsSetAccessParams.safeParse({
        conversationId: "c1",
        access: "maybe",
      }).success,
    ).toBe(false);
    // The switch never rides the generic update patch — the loose
    // (non-strict) update schema drops unknown keys, so `access` smuggled
    // there lands nowhere; the dedicated method is the only write path.
    expect(
      "access" in
        ConversationsUpdateParams.parse({
          conversationId: "c1",
          access: "full",
        }),
    ).toBe(false);
  });

  it("AC-4 approval options/outcomes gain the session grant", () => {
    expect(ApprovalOption.options).toEqual([
      "once",
      "session",
      "always",
      "deny",
    ]);
    expect(ApprovalOutcome.safeParse("session").success).toBe(true);
    const req = ApprovalRequest.parse({
      kind: "approval",
      command: "rm -rf /tmp/x",
      options: ["once", "session", "always", "deny"],
    });
    expect(req.options).toContain("session");
  });

  it("AC-3 approvals.setPolicy carries the policy choice", () => {
    expect(ApprovalsSetPolicyParams.parse({ policy: "manual" })).toEqual({
      policy: "manual",
    });
    expect(ApprovalsSetPolicyParams.safeParse({ policy: "loud" }).success).toBe(
      false,
    );
    expect(ApprovalsSetPolicyResult.parse({ policy: "off" })).toEqual({
      policy: "off",
    });
  });

  it("AC-1 agent surfaces report the thread's access", () => {
    for (const schema of [
      ContextResult.shape.thread,
      ThreadReadResult.shape.thread,
      ThreadListItem,
    ]) {
      expect("access" in schema.shape).toBe(true);
    }
  });
});
