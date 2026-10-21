import { GUIDE_TOPICS, LILOS_TOOLS } from "@lilos/contracts/harness";
import { describe, expect, it } from "vitest";
import { GUIDES, guideIndex } from "../src/guide/index.js";
import { threads } from "../src/guide/threads.js";

/**
 * D-#25 / D-#771: there are no DMs — a thread is in a project or a plain
 * chat. The `threads` page teaches that and the project tools; no page an
 * agent can read names a DM any more.
 */
describe("threads guide page (D-#771)", () => {
  const body = threads.body;

  it("is the topic the catalog names, and the old topic is gone", () => {
    expect(GUIDE_TOPICS).toContain("threads");
    expect(GUIDE_TOPICS as readonly string[]).not.toContain("dm-and-threads");
    expect(Object.keys(GUIDES).sort()).toEqual([...GUIDE_TOPICS].sort());
    expect(guideIndex()).toContain("- threads:");
    expect(LILOS_TOOLS.guide.doc).toContain("threads");
    expect(LILOS_TOOLS.guide.doc).not.toContain("dm-and-threads");
  });

  it("explains projects, plain chats and the project tools", () => {
    for (const name of [
      "project_list",
      "project_create",
      "thread_start",
      "thread_list",
    ]) {
      expect(body, name).toContain(`\`${name}\``);
    }
    expect(body).toContain("plain chat");
    expect(body).toContain("project");
    // `thread_start`'s `project` is an id or a key.
    expect(body).toMatch(/id or its key/);
    expect(body).toContain("approval ask");
  });

  it("keeps the context-fullness advice (#559)", () => {
    expect(body).toContain("usage");
    expect(body).toContain("new thread");
  });

  it("no guide page says DM", () => {
    for (const [topic, page] of Object.entries(GUIDES)) {
      expect(page.title, topic).not.toMatch(/\bDMs?\b/);
      expect(page.body, topic).not.toMatch(/\bDMs?\b/);
    }
  });
});
