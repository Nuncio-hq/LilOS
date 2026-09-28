import type * as acp from "@agentclientprotocol/sdk";
import type { ApprovalOutcome, EngineRequest } from "@lilos/contracts/engine";
import { describe, expect, test } from "vitest";
import { AcpDriver } from "../src/acp.js";
import type { HermesEngine } from "../src/engine.js";
import { resolveOutcomeValid, Session } from "../src/session.js";

/**
 * Issue #133 — ACP permission mapping. `hermes acp` offers two options of
 * kind `allow_always` (a session-scoped `allow_session` first, then the
 * permanent `allow_always`); picking by kind alone silently downgraded a
 * user's "Always" to "Allow for session" and the grant died with the
 * session. These tests drive the real `onPermission` handler with the real
 * option lists Hermes' adapter builds.
 */
describe("engine-hermes ACP permission mapping (#133)", () => {
  /**
   * Verbatim mirror of `acp_adapter/permissions.py::_build_permission_options`
   * (Hermes Agent source — the actual lists `hermes acp` sends on the wire).
   */
  const opt = (optionId: string, kind: string, name: string) => ({
    optionId,
    kind,
    name,
  });
  /** allow_permanent=True, allow_session=True — the common dangerous-command card. */
  const HERMES_FULL = [
    opt("allow_once", "allow_once", "Allow once"),
    opt("allow_session", "allow_always", "Allow for session"),
    opt("allow_always", "allow_always", "Allow always"),
    opt("deny", "reject_once", "Deny"),
    opt("deny_always", "reject_always", "Deny always"),
  ];
  /** allow_permanent=False — Hermes withholds "Allow always" entirely. */
  const HERMES_NO_PERMANENT = HERMES_FULL.filter(
    (o) => o.optionId !== "allow_always",
  );
  /** smart_denied / allow_session=False — the once-only collapse. */
  const HERMES_ONCE_ONLY = [
    opt("allow_once", "allow_once", "Allow once"),
    opt("deny", "reject_once", "Deny"),
  ];

  interface Rig {
    respond: (o: ApprovalOutcome) => void;
    ask: () => { request: EngineRequest };
    permission: (
      options: { optionId: string; kind: string; name: string }[],
    ) => Promise<acp.RequestPermissionResponse>;
  }

  const rig = (): Rig => {
    let openRequest: EngineRequest | undefined;
    let settle: (v: { outcome: ApprovalOutcome }) => void = () => {};
    const engine = {
      openAsk: (
        _s: Session,
        _wireId: string,
        request: EngineRequest,
        _kind: "approval" | "clarify",
        _respond: (o: ApprovalOutcome) => void,
      ) => {
        openRequest = request;
        return new Promise<{ outcome: ApprovalOutcome; answer?: string }>(
          (r) => {
            settle = r;
          },
        );
      },
    } as unknown as HermesEngine;
    const driver = new AcpDriver({ bin: "hermes" }, engine);
    const session = new Session(
      "s1",
      "builder",
      "/tmp",
      undefined,
      [],
      undefined,
      undefined,
      undefined,
      "acp",
      "rs1",
      "rs1",
      () => {},
    );
    const handler = driver as unknown as {
      onPermission(
        s: Session,
        p: acp.RequestPermissionRequest,
      ): Promise<acp.RequestPermissionResponse>;
    };
    return {
      respond: (o) => settle({ outcome: o }),
      ask: () => {
        if (!openRequest) throw new Error("no request was opened");
        return { request: openRequest };
      },
      permission: (options) =>
        handler.onPermission(session, {
          sessionId: "rs1",
          toolCall: {
            toolCallId: "perm-check-1",
            title: "chmod 777 README.md",
          },
          options,
        } as acp.RequestPermissionRequest),
    };
  };

  const selected = (r: acp.RequestPermissionResponse) => {
    if (r.outcome.outcome !== "selected")
      throw new Error(`expected selected, got ${JSON.stringify(r.outcome)}`);
    return r.outcome.optionId;
  };

  test("AC-1 always -> allow_always, once -> allow_once (never the session-scope option)", async () => {
    const r = rig();
    const pending = r.permission(HERMES_FULL);
    expect(r.ask().request.options).toEqual(["once", "always", "deny"]);
    r.respond("always");
    expect(selected(await pending)).toBe("allow_always");

    const r2 = rig();
    const pending2 = r2.permission(HERMES_FULL);
    r2.respond("once");
    expect(selected(await pending2)).toBe("allow_once");
  });

  test("AC-2 deny prefers the plain `deny` id over deny_always", async () => {
    const r = rig();
    const pending = r.permission(HERMES_FULL);
    r.respond("deny");
    expect(selected(await pending)).toBe("deny");
  });

  test("AC-2 'always' is not offered when Hermes withholds allow_always (no silent downgrade)", async () => {
    const r = rig();
    const pending = r.permission(HERMES_NO_PERMANENT);
    const { request } = r.ask();
    expect(request.options).toEqual(["once", "deny"]);
    // A client that answers "always" anyway is rejected, not downgraded.
    expect(
      resolveOutcomeValid(
        { request } as Parameters<typeof resolveOutcomeValid>[0],
        "always",
      ),
    ).toMatch(/not in offered options/);
    r.respond("deny");
    expect(selected(await pending)).toBe("deny");
  });

  test("AC-2 once-only lists (smart_denied) offer exactly once + deny", async () => {
    const r = rig();
    const pending = r.permission(HERMES_ONCE_ONLY);
    expect(r.ask().request.options).toEqual(["once", "deny"]);
    r.respond("once");
    expect(selected(await pending)).toBe("allow_once");
  });

  test("AC-2 unknown optionId falls back to kind", async () => {
    const r = rig();
    const pending = r.permission([
      opt("permit_once", "allow_once", "Permit once"),
      opt("permit_forever", "allow_always", "Permit forever"),
      opt("nope", "reject_once", "Nope"),
    ]);
    expect(r.ask().request.options).toEqual(["once", "always", "deny"]);
    r.respond("always");
    expect(selected(await pending)).toBe("permit_forever");
  });

  test("AC-2 a kind lie on a known id never upgrades the grant", async () => {
    const r = rig();
    // allow_session claims kind allow_always; even alone it is session-scope
    // and must never answer an "always" outcome.
    const pending = r.permission([
      opt("allow_once", "allow_once", "Allow once"),
      opt("allow_session", "allow_always", "Allow for session"),
      opt("deny", "reject_once", "Deny"),
    ]);
    expect(r.ask().request.options).toEqual(["once", "deny"]);
    r.respond("always"); // invalid for the offered set; the pick must not land on it
    // (a real client can't send this — resolveOutcomeValid rejects it — but
    // the pick must still fail closed if it somehow did).
    const out = await pending;
    expect(selected(out)).not.toBe("allow_session");
    expect(selected(out)).toBe("deny");
  });
});
