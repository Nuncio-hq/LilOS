import { RelayError } from "@lilos/client-runtime";
import { describe, expect, it } from "vitest";
import { blockedLine, blockedUpdateFor, plainLinkReason } from "../src/mapping";

/* #597: Mac status speaks plainly. `plainLinkReason` turns the supervisor's
   raw `lastError` (socket text, fetch failures) into the one line Oscar can
   act on; `blockedUpdateFor` + `blockedLine` give protocol_version_mismatch
   its own blocked state naming the side that must update. */

describe("plainLinkReason (#597 AC-1)", () => {
  it.each([
    "socket_closed",
    "socket closed 1006",
    "Connection refused",
    "connect timeout",
    "The Internet connection appears to be offline",
    "Network request failed",
    "ECONNREFUSED 172.16.4.2:4577",
  ])("unreachable-family '%s' reads 'Mac asleep or offline.'", (m) => {
    expect(plainLinkReason(m)).toBe("Mac asleep or offline.");
  });

  it("a version-mismatch message points at updating", () => {
    expect(
      plainLinkReason(
        "protocol version mismatch: server speaks 2, client speaks 1",
      ),
    ).toBe("LilOS versions don't match — update LilOS, then try again.");
  });

  it("an auth refusal says the pairing is gone", () => {
    expect(plainLinkReason("unauthenticated")).toBe(
      "This pairing was removed — pair again from the Mac.",
    );
    expect(plainLinkReason("device_revoked")).toBe(
      "This pairing was removed — pair again from the Mac.",
    );
  });

  it("anything else stays short and plain", () => {
    expect(plainLinkReason("boom")).toBe("Can't reach your Mac right now.");
    expect(plainLinkReason(undefined)).toBe("Can't reach your Mac right now.");
  });
});

describe("blockedUpdateFor (#597 AC-2)", () => {
  const mismatch = (update: "client" | "server", extra = {}) =>
    new RelayError("protocol version mismatch", "protocol_version_mismatch", {
      code: "protocol_version_mismatch",
      update,
      clientVersion: 1,
      serverVersion: 2,
      ...extra,
    });

  it("update=client means the iPhone is behind", () => {
    expect(blockedUpdateFor(mismatch("client"))).toBe("phone");
  });

  it("update=server means the Mac is behind", () => {
    expect(blockedUpdateFor(mismatch("server"))).toBe("mac");
  });

  it("non-mismatch fatals and non-RelayErrors carry no update side", () => {
    expect(
      blockedUpdateFor(new RelayError("x", "unauthenticated")),
    ).toBeUndefined();
    expect(blockedUpdateFor(new Error("boom"))).toBeUndefined();
    expect(blockedUpdateFor("boom")).toBeUndefined();
  });

  it("a malformed payload still blocks, but with the generic line", () => {
    const e = new RelayError(
      "protocol version mismatch",
      "protocol_version_mismatch",
      {
        code: "protocol_version_mismatch",
        update: "mystery",
      },
    );
    expect(blockedUpdateFor(e)).toBeUndefined();
  });
});

describe("blockedLine (#597 AC-1)", () => {
  it("names the side that must update", () => {
    expect(blockedLine("phone")).toBe(
      "Update LilOS on this iPhone, then try again.",
    );
    expect(blockedLine("mac")).toBe("Update LilOS on the Mac, then try again.");
  });

  it("falls back to a generic update line when the side is unknown", () => {
    expect(blockedLine(undefined)).toBe(
      "LilOS versions don't match — update LilOS, then try again.",
    );
  });
});
