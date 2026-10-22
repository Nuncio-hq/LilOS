import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { allowAllWhile } from "./helpers/approvals";
import {
  bootStack,
  pickPorts,
  type Stack,
  skipFirstRun,
  startChat,
  v3Peek,
} from "./helpers/stack";

/**
 * AC-112: image attachments in the real app's composers — the same path a
 * person uses in LilOS.app. AC-1 pick/drop/paste chips + capability gating,
 * AC-2 base64 attachments through conversations.open and messages.post, AC-3
 * thumbnails from stored refs after reload/reopen, AC-4 oversize and
 * over-count refusals with nothing sent, AC-5 engine-fake received the image
 * as prompt content blocks.
 *
 * v3: the first message is written in the new-chat draft beside Threads (its
 * chips sit in `[data-staged]`, a refusal reads inline there); every later one
 * in the thread's reply composer in the peek (a toast on a refusal). The old
 * DM home's feed row thumbnail has no surface any more: Threads lists a
 * thread by its title, and the thumbnail is checked in the thread itself.
 *
 * Real stack (relay + harness + engine-fake + vite dev for apps/web), same
 * as ac-27: `LILOS_ENGINE=fake bun run dev` in apps/web on offset ports.
 */
const ROOT = path.dirname(fileURLToPath(import.meta.url)).replace(/\/e2e$/, "");
const SHOTS = path.join(ROOT, "test-results", "ac-112");
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVQI12P8z/CfAQMwMCooKOgDAu2zC+h6pBe+AAAAAElFTkSuQmCC",
  "base64",
);

const TOAST = "[data-toast]";

/** The thread panel in the peek: its reply composer. */
const panel = (page: Page) => v3Peek(page).locator("[data-thread-panel]");
const formOf = (page: Page) => panel(page).locator("form");

/** The thread is up and its first turn has settled — a reply typed mid-turn
    is a steer/queue, not the plain follow-up these legs mean. */
async function settled(page: Page) {
  await expect(formOf(page)).toBeVisible({ timeout: 30_000 });
  await expect(panel(page).locator("[data-turnsettled]").last()).toBeVisible({
    timeout: 60_000,
  });
}

/** The new-chat draft with Default, open in the peek and still empty. */
const draftBox = (page: Page) =>
  v3Peek(page).getByPlaceholder("Message Default…");
/** The draft's staged files: chips, and the line that says what was left out. */
const staged = (page: Page) => v3Peek(page).locator("[data-staged]");
async function draftDefault(page: Page, base: string) {
  await skipFirstRun(page);
  await page.goto(`${base}/#?page=threads&open=newchat:default`);
  await expect(draftBox(page)).toBeVisible({ timeout: 30_000 });
}

/** Send the draft; resolves to the conversation it started, once the draft
    has swapped for its thread. */
async function sendDraft(page: Page): Promise<string> {
  await v3Peek(page).getByRole("button", { name: "Send" }).click();
  await expect(page).toHaveURL(/open=thread:[^&]+/, { timeout: 30_000 });
  return decodeURIComponent(/open=thread:([^&,]+)/.exec(page.url())?.[1] ?? "");
}

/** Type `text` into the draft and send it. */
async function sendDraftWithText(page: Page, text: string): Promise<string> {
  await draftBox(page).fill(text);
  return sendDraft(page);
}

/** Where a file goes: the thread's reply composer, or the new-chat draft. */
type Where = "thread" | "draft";
const root = (where: Where) =>
  where === "draft"
    ? 'aside[aria-label="Opened record"]'
    : "[data-thread-panel]";

async function attach(
  page: Page,
  kind: "pick" | "drop" | "paste",
  name: string,
  where: Where = "thread",
) {
  if (kind === "pick") {
    await page
      .locator(`${root(where)} input[type="file"]`)
      .setInputFiles({ name, mimeType: "image/png", buffer: PNG });
    return;
  }
  // The draft has no <form>: a drop lands on its box, which the composer's
  // wrapper hears (the event bubbles), like a drop on the thread's form.
  const sel =
    kind === "drop" && where === "thread"
      ? `${root(where)} form`
      : `${root(where)} textarea`;
  // Real DataTransfer + DragEvent/ClipboardEvent, as image-attachments.spec.
  await page.evaluate(
    ([selector, fileName, as]) => {
      const dt = new DataTransfer();
      dt.items.add(new File(["png-bytes"], fileName, { type: "image/png" }));
      const el = document.querySelector(selector);
      if (!el) throw new Error(`${selector} missing`);
      el.dispatchEvent(
        as === "paste"
          ? new ClipboardEvent("paste", { clipboardData: dt, bubbles: true })
          : new DragEvent("drop", { dataTransfer: dt, bubbles: true }),
      );
    },
    [sel, name, kind] as const,
  );
}

const submit = (page: Page) =>
  formOf(page).evaluate((f: HTMLFormElement) => f.requestSubmit());

/** Default's employee id (the DM channel's owner), for wire checks. */
async function defaultEmployeeId(home: string, relayPort: number) {
  const r = await rpc(home, relayPort, [
    { method: "employees.list", params: {} },
  ]);
  const found = (
    r[0] as { employees: { id: string; name: string }[] }
  ).employees.find((e) => /default/i.test(e.name));
  if (!found) throw new Error("no Default employee");
  return found.id;
}

async function channelOf(home: string, relayPort: number) {
  const emp = await defaultEmployeeId(home, relayPort);
  const chan = await rpc(home, relayPort, [
    { method: "channels.openDm", params: { employeeId: emp } },
  ]);
  return (chan[0] as { channel: { id: string } }).channel.id;
}

type Wire = {
  id: string;
  text: string;
  authorKind: string;
  attachments?: { id: string; name: string }[];
};
async function messagesOf(
  home: string,
  relayPort: number,
  conversationId: string,
): Promise<Wire[]> {
  const channelId = await channelOf(home, relayPort);
  const listed = await rpc(home, relayPort, [
    { method: "messages.list", params: { channelId, conversationId } },
  ]);
  return (listed[0] as { messages: Wire[] }).messages;
}

/** Bare JSON-RPC client — e2e runs under Node without workspace deps. */
async function rpc(
  home: string,
  relayPort: number,
  calls: { method: string; params: Record<string, unknown> }[],
): Promise<Record<string, unknown>[]> {
  const token = readFileSync(path.join(home, "relay-token"), "utf8").trim();
  const ws = new WebSocket(
    `ws://127.0.0.1:${relayPort}/ws?token=${encodeURIComponent(token)}`,
  );
  await new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error("ws connect failed"));
  });
  const pending = new Map<string, (r: Record<string, unknown>) => void>();
  ws.onmessage = (e) => {
    const f = JSON.parse(e.data as string) as Record<string, unknown>;
    if (typeof f.id === "string") pending.get(f.id)?.(f);
  };
  const send = (id: string, method: string, params: object) =>
    new Promise<Record<string, unknown>>((res, rej) => {
      pending.set(id, (f) =>
        f.error ? rej(f.error) : res(f.result as Record<string, unknown>),
      );
      ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  await send("h", "session.hello", { protocolVersion: 1, token });
  const out: Record<string, unknown>[] = [];
  for (const [i, c] of calls.entries())
    out.push(await send(String(i), c.method, c.params));
  ws.close();
  return out;
}

test.describe.configure({ mode: "serial" });
test.setTimeout(120_000);

let stack: Stack;
let stack2: Stack | undefined;

test.beforeAll(async () => {
  stack = await bootStack("ac112", await pickPorts(), {
    LILOS_ENGINE: "fake",
  });
});

test.afterAll(async () => {
  await stack?.stop();
  await stack2?.stop();
});

test("AC-1 attach button + pick/drop/paste chips in both composers", async ({
  page,
}) => {
  await draftDefault(page, stack.webUrl);
  const draft = v3Peek(page);
  await expect(draft.locator('input[type="file"]')).toHaveCount(1);
  await expect(draft.locator('input[type="file"]')).toHaveAttribute(
    "accept",
    "*/*",
  );
  await expect(draft.locator('[aria-label="Attach files"]')).toBeVisible();

  await attach(page, "pick", "picked.png", "draft");
  await attach(page, "drop", "dropped.png", "draft");
  await attach(page, "paste", "pasted.png", "draft");
  for (const name of ["picked.png", "dropped.png", "pasted.png"]) {
    await expect(staged(page).getByText(name)).toBeVisible();
  }
  await expect(staged(page).locator('img[alt="picked.png"]')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/ac1-chips-draft.png` });

  // A chip comes back off: its ×, and Backspace in the empty box for the last.
  await staged(page).getByRole("button", { name: "Remove picked.png" }).click();
  await expect(staged(page).getByText("picked.png")).toHaveCount(0);
  await draftBox(page).press("Backspace");
  await expect(staged(page).getByText("pasted.png")).toHaveCount(0);
  await expect(staged(page).getByText("dropped.png")).toBeVisible();

  // The open thread's composer shows the same affordances.
  await draftBox(page).fill("open a thread");
  await sendDraft(page);
  await settled(page);
  await expect(panel(page).locator('input[type="file"]')).toHaveCount(1);
  await attach(page, "pick", "thread.png");
  await expect(formOf(page).getByText("thread.png")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/ac1-chips-thread.png` });
});

test("AC-1b without image_prompt attaching still works — as files, not image blocks", async ({
  page,
}) => {
  stack2 = await bootStack("ac112b", await pickPorts(), {
    LILOS_ENGINE: "fake",
    LILOS_HIDE_CAPS: "image_prompt",
  });
  await draftDefault(page, stack2.webUrl);
  /* Attach is no longer gated on image_prompt — that capability only
     decides whether image/* arrives as image content blocks; without it
     the same file goes through the session-folder path like any other. */
  await expect(
    v3Peek(page).locator('[aria-label="Attach files"]'),
  ).toBeVisible();
  await attach(page, "drop", "dropped.png", "draft");
  await expect(staged(page).getByText("dropped.png")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/ac1b-file-attach.png` });
});

test("AC-2 sends attachments over conversations.open and messages.post", async ({
  page,
}) => {
  await draftDefault(page, stack.webUrl);
  await attach(page, "pick", "picked.png", "draft");
  const conv = await sendDraftWithText(page, "what does this image show?");
  await settled(page);

  // Wire check: the root message carries the attachment ref and the stored
  // blob decodes to the bytes we picked (attachments round-trip base64).
  const root = (await messagesOf(stack.home, stack.ports.relay, conv)).find(
    (m) => m.attachments?.length,
  );
  expect(root?.attachments?.[0]?.name).toBe("picked.png");
  const got = await rpc(stack.home, stack.ports.relay, [
    {
      method: "attachments.get",
      params: { id: root?.attachments?.[0]?.id },
    },
  ]);
  expect((got[0] as { dataBase64: string }).dataBase64.length).toBeGreaterThan(
    0,
  );
  // The draft's chips went with the send: the thread shows the thumbnail.
  await expect(
    page.locator('[data-attachments] img[alt="picked.png"]').first(),
  ).toBeVisible();

  // Reply leg: the thread composer posts through messages.post.
  await expect(page.locator("text=/prompt content block/i").last()).toBeVisible(
    { timeout: 15_000 },
  );
  await attach(page, "pick", "reply.png");
  await panel(page)
    .locator("textarea")
    .pressSequentially("and this one?", { delay: 10 });
  await submit(page);
  await expect(
    page.locator("[data-attachments]", { hasText: "reply.png" }),
  ).toBeVisible();
  const withAtt = (
    await messagesOf(stack.home, stack.ports.relay, conv)
  ).filter((m) => m.attachments?.length);
  expect(withAtt.map((m) => m.attachments?.[0]?.name)).toEqual([
    "picked.png",
    "reply.png",
  ]);
  await page.screenshot({ path: `${SHOTS}/ac2-reply.png` });
});

test("AC-3 thumbnails render from stored refs, survive reload + reopen", async ({
  page,
}) => {
  await draftDefault(page, stack.webUrl);
  await attach(page, "pick", "stored.png", "draft");
  await sendDraftWithText(page, "look at this");
  await settled(page);
  await expect(
    page.locator('[data-attachments] img[alt="stored.png"]').first(),
  ).toBeVisible();

  // Reload: thumbnails resolve from the relay store, not from the blob URL.
  // The open thread is in the URL hash, so the reload lands on it again.
  await page.reload();
  await expect(
    page.locator('[data-attachments] img[alt="stored.png"]').first(),
  ).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: `${SHOTS}/ac3-reload.png` });

  // Reopening the session from the Threads list shows it too.
  await page.goto(`${stack.webUrl}/#?page=threads`);
  await expect(v3Peek(page)).toHaveCount(0);
  await page
    .locator("main")
    .getByRole("button", { name: /look at this/i })
    .click();
  await expect(
    page.locator('[data-attachments] img[alt="stored.png"]').first(),
  ).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: `${SHOTS}/ac3-reopen.png` });
});

test("AC-4 oversize and too many files are refused and send nothing", async ({
  page,
}) => {
  /* React reports a state write made while another component renders as a
     console error ("Cannot update a component (`X`) while rendering a
     different component") — a render-phase write in the attach path. */
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(String(e)));
  await draftDefault(page, stack.webUrl);
  // Serial mode shares the stack: assert the DM's conversation count doesn't
  // grow when a send is refused.
  const channelId = await channelOf(stack.home, stack.ports.relay);
  const opened = async () =>
    (
      (
        await rpc(stack.home, stack.ports.relay, [
          { method: "conversations.list", params: { channelId } },
        ])
      )[0] as { conversations: unknown[] }
    ).conversations.length;
  const openedBefore = await opened();

  // A file just over the 10 MiB cap: said inline, no chip, nothing sent.
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(
      new File([new Uint8Array(10 * 1024 * 1024 + 1)], "huge.png", {
        type: "image/png",
      }),
    );
    const el = document.querySelector(
      'aside[aria-label="Opened record"] textarea',
    );
    if (!el) throw new Error("draft box missing");
    el.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: dt, bubbles: true }),
    );
  });
  await expect(staged(page)).toContainText(/too large/);
  await expect(staged(page).getByText("huge.png")).toHaveCount(0);
  // Chip-less and empty: there is nothing to send.
  await expect(
    v3Peek(page).getByRole("button", { name: "Send" }),
  ).toBeDisabled();
  expect(await opened()).toBe(openedBefore);
  await page.screenshot({ path: `${SHOTS}/ac4-oversize.png` });

  // Over the 10-file cap: said inline, only the first 10 stay, still nothing sent.
  await v3Peek(page)
    .locator('input[type="file"]')
    .setInputFiles(
      Array.from({ length: 11 }, (_, i) => ({
        name: `p${i}.png`,
        mimeType: "image/png",
        buffer: PNG,
      })),
    );
  await expect(staged(page)).toContainText(/too many/i);
  await expect(staged(page).locator('img[alt^="p"]')).toHaveCount(10);
  expect(await opened()).toBe(openedBefore);

  // The thread composer still toasts the same refusal.
  await draftBox(page).fill("a thread for the toast leg");
  await sendDraft(page);
  await settled(page);
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(
      new File([new Uint8Array(10 * 1024 * 1024 + 1)], "huge.png", {
        type: "image/png",
      }),
    );
    const el = document.querySelector("[data-thread-panel] form");
    if (!el) throw new Error("form missing");
    el.dispatchEvent(
      new DragEvent("drop", { dataTransfer: dt, bubbles: true }),
    );
  });
  await expect(page.locator(TOAST)).toContainText(/too large/);
  await expect(formOf(page).getByText("huge.png")).toHaveCount(0);
  await expect(page.locator(TOAST)).toHaveCount(0, { timeout: 10_000 });
  await panel(page)
    .locator('input[type="file"]')
    .setInputFiles(
      Array.from({ length: 11 }, (_, i) => ({
        name: `q${i}.png`,
        mimeType: "image/png",
        buffer: PNG,
      })),
    );
  await expect(page.locator(TOAST)).toContainText(/too many/i);
  await expect(formOf(page).locator('img[alt^="q"]')).toHaveCount(10);

  // The relay itself still rejects an oversize attachment the same way.
  await expect(
    rpc(stack.home, stack.ports.relay, [
      {
        method: "conversations.open",
        params: {
          channelId,
          text: "x",
          attachments: [
            {
              name: "huge.png",
              mimeType: "image/png",
              dataBase64: Buffer.alloc(10 * 1024 * 1024 + 1).toString("base64"),
            },
          ],
        },
      },
    ]),
  ).rejects.toMatchObject({ data: { code: "attachment_too_large" } });

  // The refusals above ran through both composers' attach paths: none of
  // them may have written state (the toast) while another component rendered.
  expect(
    errors.filter((e) => /while rendering a different component/.test(e)),
  ).toEqual([]);
});

test("AC-5 engine-fake receives the image as a prompt content block", async ({
  page,
}) => {
  await draftDefault(page, stack.webUrl);
  await attach(page, "pick", "seen.png", "draft");
  await sendDraftWithText(page, "describe it");
  await expect(
    page.locator("text=/prompt content block/i").last(),
  ).toContainText("image/png (78 bytes)", { timeout: 30_000 });
  await page.screenshot({ path: `${SHOTS}/ac5-engine.png` });
});

test("AC-2b an image-only send (no typed text) opens a session and replies", async ({
  page,
}) => {
  await draftDefault(page, stack.webUrl);
  // Chip only — no text in the draft at all: Send is live on the chip alone.
  await attach(page, "pick", "only.png", "draft");
  const conv = await sendDraft(page);
  await settled(page);
  // The message rendered with its thumbnail and the engine answered it —
  // the fake only prints "prompt content block" for a real image block.
  await expect(
    page.locator('[data-attachments] img[alt="only.png"]').first(),
  ).toBeVisible();
  await expect(
    page.locator("text=/prompt content block/i").last(),
  ).toContainText("image/png", { timeout: 30_000 });

  // Wire check: the root message carried attachments with empty text.
  const rootOnly = (await messagesOf(stack.home, stack.ports.relay, conv)).find(
    (m) => m.attachments?.[0]?.name === "only.png",
  );
  expect(rootOnly?.text).toBe("");

  // Same again as a reply in the open thread.
  await attach(page, "pick", "only-reply.png");
  await submit(page);
  await expect(
    page.locator("[data-attachments]", { hasText: "only-reply.png" }),
  ).toBeVisible();
  await expect(
    page.locator("text=/prompt content block/i").last(),
  ).toContainText("image/png", { timeout: 30_000 });
  await page.screenshot({ path: `${SHOTS}/ac2b-image-only.png` });
});

test("AC-5b a mid-turn image queues as the next prompt instead of steering", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await skipFirstRun(page);
  // An edit prompt parks the fake on an approval — the turn is provably
  // running, so the next message meets the steer-or-queue fork.
  await startChat(
    page,
    stack.webUrl,
    { id: "default", name: "Default" },
    "Add a release note to the readme",
  );
  await expect(page.getByText("Approval needed").first()).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByText("Enter steers · ⌘. stop")).toBeVisible({
    timeout: 30_000,
  });

  // Mid-turn message WITH an image: `session.steer` is text-only, so the
  // harness must queue it and prompt it (with the image block) next.
  await attach(page, "pick", "midturn.png");
  await panel(page)
    .locator("textarea")
    .pressSequentially("carry this image too", { delay: 10 });
  await submit(page);

  // The fake echoes the image block AND the message's own text — the image
  // reached the engine on the queued message's prompt, not folded into the
  // steered turn.
  const imageAnswer = page
    .locator("[data-agentturn]")
    .filter({ hasText: "prompt content block" })
    .last();
  /* Unblock the parked turn; the queued image message runs as its own turn.
     The edit script raises several gated asks seconds apart — keep answering
     each one until the queued turn's answer lands instead of bailing on the
     first quiet beat, which parks the turn mid-approvals and starves the
     drain (#451). */
  await allowAllWhile(
    page,
    expect(imageAnswer).toContainText("image/png", { timeout: 120_000 }),
  );
  await expect(imageAnswer).toContainText("carry this image too");
  // No steer ever landed — a steered text shows as an "Oscar steered" chip.
  await expect(page.getByText("Oscar steered")).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/ac5b-queued-image.png` });
});
