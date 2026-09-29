import { describe, expect, it } from "vitest";
import { browseWorkspacePick } from "../src/dm-model";

/* BrowseMac "Use" (#238): the browsed folder becomes the composer's
   workspace pick — a repo-root dir seeds base + new-branch mode, a plain
   dir is a direct pick; the conversations.open cwd comes from the added
   recent. Mirrors prototype App.tsx onUse. */

describe("AC-3 BrowseMac Use → workspace pick (#238)", () => {
  it("a repo dir picks new-branch mode on its current branch", () => {
    expect(
      browseWorkspacePick("~/repos/crew", {
        branch: "main",
        folders: [{ name: "sub", path: "~/repos/crew/sub" }],
      }),
    ).toEqual({ folder: "~/repos/crew", base: "main", mode: "new" });
  });

  it("a plain dir picks direct mode", () => {
    expect(browseWorkspacePick("~/Documents/notes", { folders: [] })).toEqual({
      folder: "~/Documents/notes",
      base: "",
      mode: "direct",
    });
  });
});
