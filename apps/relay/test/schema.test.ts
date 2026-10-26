import {
  AppChannel,
  AppMessage,
  Conversation,
  Employee,
} from "@lilos/contracts/app";
import { getTableColumns } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import * as schema from "../src/db/schema";

const TRANSCRIPTISH = /transcript|reason|thought|tool(_|calls|_results)|steps/i;
/* D-#862: the settle shelf's cause ("manual"|"idle"|"pr") — a list label
   the regex happens to match, not the engine transcript D-#25 keeps out. */
const NOT_TRANSCRIPT = new Set([
  "conversations.settledReason",
  "settledReason",
]);

/* D-#25: the relay owns visible messages; the engine owns transcripts. */
describe("AC-5 relay stores no engine transcript", () => {
  it("persists exactly the app tables, none with transcript fields", () => {
    expect(Object.keys(schema).sort()).toEqual([
      "asks",
      "channels",
      "companyUpdates",
      "conversations",
      "devicePush",
      "employees",
      "engineEventMarks",
      "goals",
      "messages",
      "pairedDevices",
      "pairingGrants",
      "profile",
      "projects",
      "recentFolders",
      "scheduledTasks",
      "settings",
      "tickets",
    ]);
    for (const [name, table] of Object.entries(schema)) {
      for (const column of Object.keys(
        getTableColumns(table as Parameters<typeof getTableColumns>[0]),
      )) {
        if (NOT_TRANSCRIPT.has(`${name}.${column}`)) continue;
        expect(column, `${name}.${column}`).not.toMatch(TRANSCRIPTISH);
      }
    }
  });

  it("wire schemas strip transcript fields instead of persisting them", () => {
    const polluted = AppMessage.parse({
      id: "m1",
      channelId: "c1",
      authorId: "u",
      authorKind: "employee",
      text: "hi",
      seq: 1,
      createdAt: 0,
      conversationId: null,
      toolCalls: [{ name: "bash" }],
      reasoning: "secret chain",
      transcript: [],
    });
    expect(Object.keys(polluted).sort()).toEqual([
      "authorId",
      "authorKind",
      "channelId",
      "claimed",
      "conversationId",
      "createdAt",
      "dropped",
      "id",
      "removed",
      "rewound",
      "seq",
      "text",
    ]);
    for (const contract of [AppMessage, Conversation, Employee, AppChannel]) {
      for (const key of Object.keys(contract.shape)) {
        if (NOT_TRANSCRIPT.has(key)) continue;
        expect(key).not.toMatch(TRANSCRIPTISH);
      }
    }
  });
});
