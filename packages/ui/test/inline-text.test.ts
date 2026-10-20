/* Issue #448: the subagent now-line shares `inline` — the char regexes it
   replaces ate the "_" inside `write_file` / `ses_c03e` / `LILOS_ENGINE`
   while leaving real `_emph_` markers on. Issue #569: it re-parses a row's
   text on every streamed word, so each distinct text is parsed once. */
import type * as MdastFromMarkdown from "mdast-util-from-markdown";
import { describe, expect, test, vi } from "vitest";

/* Counts real markdown parses, so the cache is observable from outside. */
const counts = vi.hoisted(() => ({ parses: 0 }));

vi.mock("mdast-util-from-markdown", async (importOriginal) => {
  const orig = await importOriginal<typeof MdastFromMarkdown>();
  return {
    ...orig,
    fromMarkdown: (...args: Parameters<typeof orig.fromMarkdown>) => {
      counts.parses++;
      return orig.fromMarkdown(...args);
    },
  };
});

import { inline } from "../src/lib/helpers";

describe("issue #448 — inline() flattens markdown to one line", () => {
  test("AC-1 snake_case identifiers keep underscores, in and out of code spans", () => {
    expect(inline("Ran `write_file` on LILOS_ENGINE, then read foo_bar.")).toBe(
      "Ran write_file on LILOS_ENGINE, then read foo_bar.",
    );
  });

  test("AC-1 a session id like `ses_c03e` keeps its underscore", () => {
    expect(inline("`seq` is monotonic (checked in `ses_c03e`).")).toBe(
      "seq is monotonic (checked in ses_c03e).",
    );
  });

  test("AC-2 real emphasis unwraps: _emph_, *em*, **bold** and `code`", () => {
    expect(inline("ran _this_ *and* **that** `code_x` first")).toBe(
      "ran this and that code_x first",
    );
  });

  test("AC-2 heading and quote markers flatten away; blocks join with a space", () => {
    expect(inline("## Result\n> checked `foo_bar`")).toBe(
      "Result checked foo_bar",
    );
  });
});

describe("issue #569 — inline() parses each distinct text once", () => {
  test("AC-1 repeats are served from the cache, a new text parses once", () => {
    counts.parses = 0;
    expect(inline("**uniq-a** _em_")).toBe("uniq-a em");
    expect(inline("**uniq-a** _em_")).toBe("uniq-a em");
    expect(inline("**uniq-b**")).toBe("uniq-b");
    /* Two distinct texts, each parsed once — the repeat came from cache. */
    expect(counts.parses).toBe(2);
    inline("**uniq-a** _em_");
    inline("**uniq-b**");
    expect(counts.parses).toBe(2);

    expect(inline("## uniq-c `x_y`")).toBe("uniq-c x_y");
    expect(inline("## uniq-c `x_y`")).toBe("uniq-c x_y");
    expect(counts.parses).toBe(3);
  });
});
