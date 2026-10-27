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

/* The adapter's real ExitPlanMode list (claude-agent-acp
   permissions/options/tools.js): every mode change rides kind
   `allow_always`, `exit-plan-clear-auto` first — r8's trap, where an
   "Always" pick cleared Claude's context and switched the session to
   `auto` so Claude approved its own tools under an Ask pill. */
const CLAUDE_EXIT_PLAN_OPTIONS: acp.PermissionOption[] = [
  {
    optionId: "exit-plan-clear-auto",
    name: "Yes, clear context and use auto mode",
    kind: "allow_always",
  },
  {
    optionId: "exit-plan-auto",
    name: "Yes, and use auto mode",
    kind: "allow_always",
  },
  {
    optionId: "exit-plan-bypass",
    name: "Yes, and bypass permissions",
    kind: "allow_always",
  },
  {
    optionId: "exit-plan-default",
    name: "Yes, manually approve edits",
    kind: "allow_once",
  },
  { optionId: "reject", name: "No, keep planning", kind: "reject_once" },
];

const CLAUDE_EXIT_PLAN_ACCEPT_EDITS: acp.PermissionOption[] = [
  {
    optionId: "exit-plan-clear-accept-edits",
    name: "Yes, clear context and auto-accept edits",
    kind: "allow_always",
  },
  {
    optionId: "exit-plan-accept-edits",
    name: "Yes, auto-accept edits",
    kind: "allow_always",
  },
  {
    optionId: "exit-plan-default",
    name: "Yes, manually approve edits",
    kind: "allow_once",
  },
  { optionId: "reject", name: "No, keep planning", kind: "reject_once" },
];

describe("Claude's ExitPlanMode card — mode-changing options can never be picked (r8)", () => {
  test("the card offers only outcomes that keep mode default — no 'Always' that means 'auto'", () => {
    expect(acpOfferedOutcomes(CLAUDE_EXIT_PLAN_OPTIONS)).toEqual([
      "once",
      "deny",
    ]);
    expect(acpOfferedOutcomes(CLAUDE_EXIT_PLAN_ACCEPT_EDITS)).toEqual([
      "once",
      "deny",
    ]);
  });

  test("no outcome ever picks an id that switches mode or clears context", () => {
    const DANGEROUS = /^exit-plan-(?!default$)/;
    for (const outcome of ["once", "session", "always", "deny"] as const)
      for (const opts of [
        CLAUDE_EXIT_PLAN_OPTIONS,
        CLAUDE_EXIT_PLAN_ACCEPT_EDITS,
      ]) {
        const id = acpPickOptionId(opts, outcome);
        if (id !== undefined) expect(id).not.toMatch(DANGEROUS);
      }
  });

  test("Always/Once land on exit-plan-default — affirmative, mode stays default", () => {
    expect(acpPickOptionId(CLAUDE_EXIT_PLAN_OPTIONS, "once")).toBe(
      "exit-plan-default",
    );
    expect(acpPickOptionId(CLAUDE_EXIT_PLAN_OPTIONS, "always")).toBe(
      "exit-plan-default",
    );
    expect(acpPickOptionId(CLAUDE_EXIT_PLAN_ACCEPT_EDITS, "always")).toBe(
      "exit-plan-default",
    );
    expect(acpPickOptionId(CLAUDE_EXIT_PLAN_OPTIONS, "deny")).toBe("reject");
  });

  test("the wire answer reports the downgrade — Always granted Once", () => {
    const { response, granted } = acpPermissionAnswer(
      req(CLAUDE_EXIT_PLAN_OPTIONS),
      "always",
    );
    expect(response).toEqual({
      outcome: { outcome: "selected", optionId: "exit-plan-default" },
    });
    expect(granted).toBe("once");
  });

  test("a normal card's true allow_always is untouched", () => {
    /* allow-with-updates is the adapter's real durable grant — still a
       genuine Always on non-plan cards. */
    const toolCard: acp.PermissionOption[] = [
      { optionId: "allow-once", name: "Yes", kind: "allow_once" },
      {
        optionId: "allow-with-updates",
        name: "Yes, and don't ask again",
        kind: "allow_always",
      },
      { optionId: "reject", name: "No", kind: "reject_once" },
    ];
    expect(acpPickOptionId(toolCard, "always")).toBe("allow-with-updates");
    expect(acpPickOptionId(toolCard, "once")).toBe("allow-once");
    expect(acpOfferedOutcomes(toolCard)).toEqual(["once", "always", "deny"]);
  });
});

describe("acpApprovalRequest — request.opened ask construction", () => {
  test("the ask is an approval with the tool call's command and offered outcomes", () => {
    expect(acpApprovalRequest(req())).toEqual({
      kind: "approval",
      command: "chmod 777 README.md",
      /* #884: the rawInput rides `details` — the card's disclosure shows
         exactly what runs when `command` is only a title. */
      details: JSON.stringify({ command: "chmod 777 README.md" }, null, 2),
      options: ["once", "session", "always", "deny"],
    });
  });
});
