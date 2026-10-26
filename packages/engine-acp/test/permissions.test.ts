import type * as acp from "@agentclientprotocol/sdk";
import { describe, expect, test } from "vitest";
import {
  acpApprovalRequest,
  acpOfferedOutcomes,
  acpPermissionAnswer,
  acpPickOptionId,
} from "../src/permissions.js";

/**
 * The #133 trap, exercised at the seam: `allow_session` and `allow_always`
 * both carry kind `allow_always`, so kind alone maps an answer wrong. These
 * mirror engine-hermes's own permission tests — now against the SHARED map.
 */
const HERMES_OPTIONS: acp.PermissionOption[] = [
  { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
  { optionId: "allow_session", name: "This session", kind: "allow_always" },
  { optionId: "allow_always", name: "Always", kind: "allow_always" },
  { optionId: "reject_once", name: "Deny", kind: "reject_once" },
];

const req = (options = HERMES_OPTIONS): acp.RequestPermissionRequest =>
  ({
    sessionId: "s1",
    toolCall: {
      toolCallId: "c1",
      title: "chmod 777 README.md",
      kind: "execute",
      status: "pending",
      rawInput: { command: "chmod 777 README.md" },
      content: [],
    },
    options,
  }) as acp.RequestPermissionRequest;

describe("acpOfferedOutcomes — the approval card's options", () => {
  test("session-scoped and permanent grants map to distinct outcomes", () => {
    expect(acpOfferedOutcomes(HERMES_OPTIONS)).toEqual([
      "once",
      "session",
      "always",
      "deny",
    ]);
  });

  test("an allow-only list still offers a deny row", () => {
    expect(
      acpOfferedOutcomes([{ optionId: "allow_once", kind: "allow_once" }]),
    ).toEqual(["once"]);
    /* nothing mappable at all -> the safe single option */
    expect(acpOfferedOutcomes([{ optionId: "mystery", kind: "???" }])).toEqual([
      "deny",
    ]);
  });

  test("unknown ids resolve by kind (kind fallback)", () => {
    expect(
      acpOfferedOutcomes([{ optionId: "weird-yes", kind: "allow_always" }]),
    ).toEqual(["always"]);
  });
});

describe("acpPickOptionId — outcome -> wire optionId", () => {
  test("always picks the permanent allow_always id, never the session twin", () => {
    expect(acpPickOptionId(HERMES_OPTIONS, "always")).toBe("allow_always");
    expect(acpPickOptionId(HERMES_OPTIONS, "session")).toBe("allow_session");
    expect(acpPickOptionId(HERMES_OPTIONS, "once")).toBe("allow_once");
  });

  test("deny prefers the plain deny id over deny_always/reject_*", () => {
    expect(acpPickOptionId(HERMES_OPTIONS, "deny")).toBe("reject_once");
    expect(
      acpPickOptionId(
        [
          { optionId: "deny", kind: "reject_once" },
          { optionId: "deny_always", kind: "reject_always" },
        ],
        "deny",
      ),
    ).toBe("deny");
  });

  test("a kind lie on a known id never upgrades the grant", () => {
    const opts = [{ optionId: "allow_session", kind: "allow_once" }];
    /* optionId wins: allow_session grants session, not once — a kind-first
       map would land the wrong grant (the bug). */
    expect(acpPickOptionId(opts, "session")).toBe("allow_session");
    expect(acpPickOptionId(opts, "once")).toBeUndefined();
  });

  test("an unanswerable outcome returns undefined — never a different grant", () => {
    const allowOnly = [{ optionId: "allow_once", kind: "allow_once" }];
    expect(acpPickOptionId(allowOnly, "always")).toBeUndefined();
    expect(acpPickOptionId(allowOnly, "session")).toBeUndefined();
  });
});

describe("acpPermissionAnswer — the wire response", () => {
  test("cancel answers cancelled", () => {
    const { response, granted } = acpPermissionAnswer(req(), "cancel");
    expect(response).toEqual({ outcome: { outcome: "cancelled" } });
    expect(granted).toBe("cancel");
  });

  test("outcomes select their exact optionId and echo the grant", () => {
    for (const [outcome, id] of [
      ["once", "allow_once"],
      ["session", "allow_session"],
      ["always", "allow_always"],
      ["deny", "reject_once"],
    ] as const) {
      const { response, granted } = acpPermissionAnswer(req(), outcome);
      expect(response).toEqual({
        outcome: { outcome: "selected", optionId: id },
      });
      expect(granted).toBe(outcome);
    }
  });

  test("deny on an allow-only list cancels — never lands on an allow id", () => {
    const { response, granted } = acpPermissionAnswer(
      req([{ optionId: "allow_once", name: "Once", kind: "allow_once" }]),
      "deny",
    );
    expect(response).toEqual({ outcome: { outcome: "cancelled" } });
    expect(granted).toBe("cancel");
  });
});

describe("acpApprovalRequest — request.opened ask construction", () => {
  test("the ask is an approval with the tool call's command and offered outcomes", () => {
    expect(acpApprovalRequest(req())).toEqual({
      kind: "approval",
      command: "chmod 777 README.md",
      options: ["once", "session", "always", "deny"],
    });
  });
});
