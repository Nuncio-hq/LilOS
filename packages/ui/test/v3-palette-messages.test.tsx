// @vitest-environment happy-dom
/* ⌘K's Messages group: a hit shows its snippet (marked), thread and author,
   a note LilOS wrote says LilOS, an archived thread's hit says so, and the
   group exists only where the app can search. */
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { V3Data } from "../src/v3/v3-data-types";
import { V3Palette } from "../src/v3/v3-palette";
import type { V3MessageHit, V3Thread } from "../src/v3/v3-types";

afterEach(cleanup);

const thread = (id: string, title: string): V3Thread => ({
  id,
  agentId: "a1",
  title,
  status: "done",
  startedAt: "10:00",
  minutes: 1,
  turns: [],
});

const data = {
  company: "Co",
  me: "Sam",
  agents: [{ id: "a1", name: "Builder", role: "Builds", tone: "b" }],
  tickets: [],
  goals: [],
  projects: [],
  asks: [],
  threads: [thread("t1", "Live thread")],
  archivedThreads: [thread("t2", "Old thread")],
  features: { tickets: false },
} as unknown as V3Data;

const hits: V3MessageHit[] = [
  {
    messageId: "m1",
    threadId: "t1",
    by: "a1",
    at: "10:01",
    snippet: "the <mark>deploy</mark> log",
  },
  {
    messageId: "m2",
    threadId: "t1",
    by: "system",
    at: "10:02",
    snippet: "<mark>Auto-approved</mark> — Full access",
  },
  {
    messageId: "m3",
    threadId: "t2",
    by: "you",
    at: "09:00",
    snippet: "an old <mark>deploy</mark>",
  },
  {
    messageId: "m4",
    threadId: "nowhere",
    by: "a1",
    at: "09:00",
    snippet: "a <mark>deploy</mark> in a thread the app cannot open",
  },
];

function open(search?: (q: string) => Promise<V3MessageHit[]>) {
  const onOpenMessage = vi.fn();
  const go = vi.fn();
  render(
    <V3Palette
      data={data}
      seed=""
      onStart={() => {}}
      onClose={() => {}}
      go={go}
      searchMessages={search}
      onOpenMessage={onOpenMessage}
    />,
  );
  return { onOpenMessage, go };
}

const type = async (text: string) => {
  fireEvent.change(screen.getByRole("textbox"), { target: { value: text } });
  // Past the debounce, and the answer's microtask.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 250));
  });
};

describe("⌘K Messages", () => {
  test("lists each hit with its marked snippet, author, time and thread", async () => {
    open(async () => hits);
    await type("deploy");
    expect(screen.getByText("Messages")).toBeTruthy();
    const rows = document.querySelectorAll("[data-message-hit]");
    // The hit in a thread the app cannot open is dropped.
    expect(rows).toHaveLength(3);
    expect(rows[0].textContent).toContain("Builder · 10:01 · in Live thread");
    expect(rows[0].querySelector("mark")?.textContent).toBe("deploy");
  });

  test("a note LilOS wrote says LilOS, yours says your name", async () => {
    open(async () => hits);
    await type("deploy");
    const rows = [...document.querySelectorAll("[data-message-hit]")];
    expect(rows[1].textContent).toContain("LilOS · 10:02");
    expect(rows[2].textContent).toContain("Sam · 09:00");
  });

  test("a hit in an archived thread is marked archived", async () => {
    open(async () => hits);
    await type("deploy");
    const rows = [...document.querySelectorAll("[data-message-hit]")];
    expect(rows[2].querySelector("[data-archived-hit]")).toBeTruthy();
    expect(rows[0].querySelector("[data-archived-hit]")).toBeNull();
  });

  test("picking a hit opens its thread at that message", async () => {
    const { onOpenMessage } = open(async () => hits);
    await type("deploy");
    fireEvent.click(document.querySelectorAll("[data-message-hit]")[2]);
    expect(onOpenMessage).toHaveBeenCalledWith("t2", "m3");
  });

  test("without a message search there is no Messages group", async () => {
    open(undefined);
    await type("deploy");
    expect(screen.queryByText("Messages")).toBeNull();
  });

  test("an answer that arrives after the text moved on never shows", async () => {
    let release: (h: V3MessageHit[]) => void = () => {};
    const slow = new Promise<V3MessageHit[]>((r) => {
      release = r;
    });
    open((q) => (q === "dep" ? slow : Promise.resolve([])));
    await type("dep");
    await type("deployed");
    await act(async () => {
      release(hits);
    });
    expect(document.querySelectorAll("[data-message-hit]")).toHaveLength(0);
  });

  test("a search that fails shows no group rather than a stale one", async () => {
    open(async () => {
      throw new Error("boom");
    });
    await type("deploy");
    expect(screen.queryByText("Messages")).toBeNull();
  });

  test("one letter does not search", async () => {
    const search = vi.fn(async () => hits);
    open(search);
    await type("d");
    expect(search).not.toHaveBeenCalled();
  });
});
