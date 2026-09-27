import { describe, expect, it } from "vitest";
import {
  HERMES_TOO_OLD_EXIT_CODE,
  hermesTooOldMessage,
  isHermesVersionSupported,
  MIN_HERMES_VERSION,
  parseHermesVersion,
} from "../src/version";

/**
 * AC-3 (#95) — the minimum Hermes version is declared once here and the
 * comparison is unit-tested. Evidence: v0.20.2 dies on the
 * `client.capabilities` handshake (-32601), v0.21.5 works end to end.
 */
describe("AC-3 (#95) minimum Hermes version", () => {
  it("parses versions out of real `hermes --version` output", () => {
    expect(
      parseHermesVersion("Hermes Agent v0.21.5+3173.gb4410b4 (2026.9.24)"),
    ).toBe("0.21.5");
    expect(parseHermesVersion("hermes 0.20.2")).toBe("0.20.2");
    expect(parseHermesVersion("0.21.5")).toBe("0.21.5");
    expect(parseHermesVersion("hermes-agent/1.2.3-beta.1")).toBe("1.2.3");
  });

  it("returns undefined for output without a semver", () => {
    expect(parseHermesVersion("")).toBeUndefined();
    expect(parseHermesVersion("Hermes Agent")).toBeUndefined();
    expect(parseHermesVersion("version unknown\nnext line")).toBeUndefined();
  });

  it("compares against the declared minimum", () => {
    expect(isHermesVersionSupported("0.20.2")).toBe(false);
    expect(isHermesVersionSupported("0.20.99")).toBe(false);
    expect(isHermesVersionSupported(MIN_HERMES_VERSION)).toBe(true);
    expect(isHermesVersionSupported("0.21.6")).toBe(true);
    expect(isHermesVersionSupported("1.0.0")).toBe(true);
  });

  it("the too-old message names the found version, the minimum, and the fix", () => {
    const msg = hermesTooOldMessage("0.20.2");
    expect(msg).toBe(
      `Hermes 0.20.2 is too old — LilOS needs ${MIN_HERMES_VERSION} or newer. Run \`hermes update\`.`,
    );
    expect(hermesTooOldMessage(undefined)).toContain("too old");
    expect(hermesTooOldMessage(undefined)).toContain(MIN_HERMES_VERSION);
  });

  it("the adapter's too-old exit code is a reserved non-crash code", () => {
    expect(Number.isInteger(HERMES_TOO_OLD_EXIT_CODE)).toBe(true);
    expect([0, 1, 2, 130, 137, 143]).not.toContain(HERMES_TOO_OLD_EXIT_CODE);
  });
});
