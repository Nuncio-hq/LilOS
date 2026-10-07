/* Issue #593: hand-typed pairing codes. The field displays the formatted
   code ("7K4M-QR2X-9TBP") while normalize/format cap input at 12 real
   characters — the tests pin the formatted length the input must admit. */
import { describe, expect, test } from "vitest";
import {
  CODE_FORMATTED_LENGTH,
  CODE_LENGTH,
  formatCode,
  normalizeCode,
  normalizeHost,
  parsePairingUrl,
  validateManual,
} from "../src/lib/pairing-code";

describe("issue #593 — manual pairing code", () => {
  test("AC-1 a full 12-char code formats to CODE_FORMATTED_LENGTH (dashes counted)", () => {
    /* The bug: the field allowed CODE_LENGTH + 1 characters but the
       formatted value is CODE_LENGTH + 2 — the 12th char couldn't be typed. */
    const raw = "7K4MQR2X9TBP";
    expect(raw.length).toBe(CODE_LENGTH);
    expect(formatCode(raw)).toBe("7K4M-QR2X-9TBP");
    expect(formatCode(raw).length).toBe(CODE_FORMATTED_LENGTH);
  });

  test("AC-1 normalizeCode caps at CODE_LENGTH and strips non-alphanumerics", () => {
    expect(normalizeCode("7k4m-qr2x-9tbp-extra")).toBe("7K4MQR2X9TBP");
    expect(normalizeCode("ab-c_d e")).toBe("ABCDE");
    expect(normalizeCode("12345678901234567").length).toBe(CODE_LENGTH);
  });

  test("AC-2/AC-4 validateManual accepts a good host + full code, flags the rest", () => {
    expect(
      validateManual("oscars-mac.tail0000.ts.net", "7K4M-QR2X-9TBP"),
    ).toEqual({});
    expect(validateManual("not a host!!", "7K4MQR2X9TBP").host).toBeTruthy();
    expect(
      validateManual("oscars-mac.tail0000.ts.net", "7K4M-QR2X").code,
    ).toBeTruthy();
  });

  test("normalizeHost strips scheme and path (paste of the full URL)", () => {
    expect(normalizeHost(" http://Mac.Tail0000.TS.Net:4577/ws ")).toBe(
      "mac.tail0000.ts.net:4577",
    );
  });

  test("parsePairingUrl still normalizes a typed/dashed code", () => {
    const offer = parsePairingUrl(
      "lilos://pair?host=mac.tail0000.ts.net:4577#code=7k4m-qr2x-9tbp",
    );
    expect(offer).toEqual({
      host: "mac.tail0000.ts.net:4577",
      code: "7K4MQR2X9TBP",
    });
  });
});
