import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildSchemaDoc,
  outputPathFor,
  PROTOCOLS,
  renderSchemaDoc,
} from "../scripts/generate-json-schemas";
import {
  AppMessage,
  ChannelSubscribeParams,
  Employee,
  HelloParams,
  JsonRpcNotification,
  JsonRpcRequest,
  MessageCreatedEvent,
  ProtocolVersionMismatch,
  WelcomeResult,
} from "../src/app";

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
    const doc = buildSchemaDoc(PROTOCOLS[0]) as {
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

  it("AC-1 stale check: committed JSON Schema matches a fresh generation", () => {
    const committed = readFileSync(outputPathFor(PROTOCOLS[0]), "utf8");
    // Regenerate instead of editing by hand: bun run --cwd packages/contracts gen
    expect(committed).toBe(renderSchemaDoc(PROTOCOLS[0]));
  });
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
