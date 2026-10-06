import { describe, expect, it } from "vitest";
import { inline, parseProse } from "../src/components/prose-blocks";

/* #566 AC-1, phone leg: the native `Prose` renderer has no link or image
   constructs at all — `Inline` only knows **bold** and `code`, so markdown
   links and images can only ever come out as literal text. These tests pin
   that inertness at the parser layer the renderer consumes. */

describe("issue #566 — replies can't carry tappable or auto-loaded content", () => {
  it("AC-1 a javascript:/file: link stays a literal text block — nothing tappable", () => {
    const [b] = parseProse(
      "See [the payload](javascript:alert(1)) and [open it](file:///etc/passwd).",
    );
    expect(b).toEqual({
      kind: "text",
      text: "See [the payload](javascript:alert(1)) and [open it](file:///etc/passwd).",
    });
  });

  it("AC-1 a remote image stays literal source text — the phone draws no images", () => {
    const [b] = parseProse(
      "![network map](https://img.evil.example/track.png?d=secret)",
    );
    expect(b).toEqual({
      kind: "text",
      text: "![network map](https://img.evil.example/track.png?d=secret)",
    });
  });

  it("AC-1 previews flatten links to their label text — the URL never surfaces", () => {
    expect(inline("[click](javascript:alert(1))")).toBe("click");
    expect(inline("[open it](file:///etc/passwd)")).toBe("open it");
    expect(inline("![map](https://img.evil.example/x.png)")).toBe("map");
  });
});
