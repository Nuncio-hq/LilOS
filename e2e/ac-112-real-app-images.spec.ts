import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { bootStack, type Stack } from "./helpers/stack";
import { wport } from "./ports";

/**
 * AC-112: image attachments in the real app's DM composers — the same path
 * Oscar uses in LilOS.app. Pairs with e2e/image-attachments.spec.ts, which
 * covers the prototype. AC-1 pick/drop/paste chips + capability gating in
 * both composers, AC-2 base64 attachments through conversations.open and
 * messages.post, AC-3 thumbnails from stored refs after reload/reopen, AC-4
 * oversize and over-count toasts with nothing sent, AC-5 engine-fake
 * received the image as prompt content blocks.
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

const TOAST = "div.fixed.bottom-5";

/** The employee home DM for the fake engine's seeded employee. */
async function dmDefault(page: Page, base: string) {
  await page.goto(`${base}/`);
  const aside = page.locator("aside").first();
  await expect(aside.getByRole("button", { name: /default/i })).toBeVisible({
    timeout: 30_000,
  });
  // First-run card offers "Open DM with Default"; else open via the sidebar.
  const firstRun = page.getByRole("button", { name: /open dm/i });
  if (await firstRun.isVisible().catch(() => false)) {
    await firstRun.click();
  } else {
    await aside.getByRole("button", { name: /default/i }).click();
  }
  await expect(page.locator("main form")).toBeVisible({ timeout: 15_000 });
}

/** The composer form on `scope` — "home" is main, "thread" is the panel. */
const formOf = (page: Page, scope: "home" | "thread") =>
  scope === "home" ? page.locator("main form") : page.locator("form").last();

async function attach(
  page: Page,
  kind: "pick" | "drop" | "paste",
  name: string,
  scope: "home" | "thread" = "home",
) {
  if (kind === "pick") {
    const input =
      scope === "home"
        ? page.locator('main input[type="file"]')
        : page.locator('input[type="file"]').last();
    await input.setInputFiles({ name, mimeType: "image/png", buffer: PNG });
    return;
  }
  const sel =
    kind === "drop"
      ? scope === "home"
        ? "main form"
        : "form:last-of-type"
      : scope === "home"
        ? "main textarea"
        : "textarea:last-of-type";
  // Real DataTransfer + DragEvent/ClipboardEvent, as image-attachments.spec.
  await page.evaluate(
    ([selector, fileName]) => {
      const dt = new DataTransfer();
      dt.items.add(
        new File(["png-bytes"], fileName as string, { type: "image/png" }),
      );
      const el = document.querySelector(selector as string);
      if (!el) throw new Error(`${selector} missing`);
      el.dispatchEvent(
        selector.includes("textarea")
          ? new ClipboardEvent("paste", { clipboardData: dt, bubbles: true })
          : new DragEvent("drop", { dataTransfer: dt, bubbles: true }),
      );
    },
    [sel, name] as const,
  );
}

/** Bare JSON-RPC client — e2e runs under Node without workspace deps. */
async function rpc(
  home: string,
  relayPort: number,
  calls: { method: string; params: Record<string, unknown> }[],
): Promise<Record<string, unknown>[]> {
  const token = readFileSync(path.join(home, "relay-token"), "utf8").trim();
  const ws = new WebSocket(`ws://127.0.0.1:${relayPort}/ws`);
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

const RELAY = wport(4720);
const FEED = wport(4721);
const PORT = wport(5342);
const RELAY2 = wport(4723);
const FEED2 = wport(4724);
const PORT2 = wport(5344);

test.describe.configure({ mode: "serial" });
test.setTimeout(120_000);

let stack: Stack;
let stack2: Stack | undefined;

test.beforeAll(async () => {
  stack = await bootStack(
    "ac112",
    { relay: RELAY, feed: FEED, web: PORT },
    { LILOS_ENGINE: "fake" },
  );
});

test.afterAll(async () => {
  await stack?.stop();
  await stack2?.stop();
});

test("AC-1 attach button + pick/drop/paste chips in both composers", async ({
  page,
}) => {
  await dmDefault(page, stack.webUrl);
  await expect(page.locator('main input[type="file"]')).toHaveCount(1);
  await expect(page.locator('main input[type="file"]')).toHaveAttribute(
    "accept",
    "image/*",
  );
  await expect(page.locator('main [aria-label="Attach files"]')).toBeVisible();

  await attach(page, "pick", "picked.png");
  await attach(page, "drop", "dropped.png");
  await attach(page, "paste", "pasted.png");
  const form = formOf(page, "home");
  for (const name of ["picked.png", "dropped.png", "pasted.png"]) {
    await expect(form.getByText(name)).toBeVisible();
  }
  await expect(form.locator('img[alt="picked.png"]')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/ac1-chips-home.png` });

  // The open session's composer shows the same affordances — a send opens
  // the session in Focus (#114), where its composer is the only form.
  await page
    .locator("main textarea")
    .pressSequentially("open a thread", { delay: 10 });
  await page.locator("main form").evaluate((f: HTMLFormElement) => {
    f.requestSubmit();
  });
  await page.waitForURL(/\/dm\/[^/]+\/[^/]+\/focus$/);
  await expect(page.locator("form")).toHaveCount(1);
  await expect(page.locator('input[type="file"]')).toHaveCount(1);
  await attach(page, "pick", "thread.png", "thread");
  await expect(formOf(page, "thread").getByText("thread.png")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/ac1-thread.png` });
});

test("AC-1b without image_prompt no attach affordance renders", async ({
  page,
}) => {
  stack2 = await bootStack(
    "ac112b",
    { relay: RELAY2, feed: FEED2, web: PORT2 },
    { LILOS_ENGINE: "fake", LILOS_HIDE_CAPS: "image_prompt" },
  );
  await dmDefault(page, stack2.webUrl);
  await expect(page.locator('[aria-label="Attach files"]')).toHaveCount(0);
  await expect(page.locator('main input[type="file"]')).not.toHaveAttribute(
    "accept",
    /.+/,
  );
  // A dropped file is ignored entirely — no chip, nothing to send.
  await attach(page, "drop", "dropped.png");
  await expect(page.locator("main form").getByText("dropped.png")).toHaveCount(
    0,
  );
  await page.screenshot({ path: `${SHOTS}/ac1b-no-cap.png` });
});

test("AC-2 sends attachments over conversations.open and messages.post", async ({
  page,
}) => {
  await dmDefault(page, stack.webUrl);
  await attach(page, "pick", "picked.png");
  await page
    .locator("main textarea")
    .pressSequentially("what does this image show?", { delay: 10 });
  await page.locator("main form").evaluate((f: HTMLFormElement) => {
    f.requestSubmit();
  });
  await page.waitForURL(/\/dm\/[^/]+\/[^/]+\/focus$/);
  const dmUrl = page.url().match(/\/dm\/([^/]+)\/([^/]+?)(?:\/focus)?$/);
  if (!dmUrl) throw new Error("not on a conversation");
  const [, emp, conv] = dmUrl;

  // Wire check: the root message carries the attachment ref and the stored
  // blob decodes to the bytes we picked (attachments round-trip base64).
  const chan = await rpc(stack.home, RELAY, [
    { method: "channels.openDm", params: { employeeId: emp } },
  ]);
  const channelId = (chan[0] as { channel: { id: string } }).channel.id;
  const listed = await rpc(stack.home, RELAY, [
    { method: "messages.list", params: { channelId, conversationId: conv } },
  ]);
  const msgs = (
    listed[0] as {
      messages: { attachments?: { id: string; name: string }[] }[];
    }
  ).messages;
  const root = msgs.find((m) => m.attachments?.length);
  expect(root?.attachments?.[0]?.name).toBe("picked.png");
  const got = await rpc(stack.home, RELAY, [
    {
      method: "attachments.get",
      params: { id: root?.attachments?.[0]?.id },
    },
  ]);
  expect((got[0] as { dataBase64: string }).dataBase64.length).toBeGreaterThan(
    0,
  );

  // Reply leg: the thread composer posts through messages.post.
  await expect(page.locator("text=/prompt content block/i").last()).toBeVisible(
    { timeout: 15_000 },
  );
  await attach(page, "pick", "reply.png", "thread");
  await page
    .locator("textarea")
    .last()
    .pressSequentially("and this one?", { delay: 10 });
  await formOf(page, "thread").evaluate((f: HTMLFormElement) =>
    f.requestSubmit(),
  );
  await expect(
    page.locator("[data-attachments]", { hasText: "reply.png" }),
  ).toBeVisible();
  const listed2 = await rpc(stack.home, RELAY, [
    { method: "messages.list", params: { channelId, conversationId: conv } },
  ]);
  const withAtt = (
    listed2[0] as { messages: { attachments?: { name: string }[] }[] }
  ).messages.filter((m) => m.attachments?.length);
  expect(withAtt.map((m) => m.attachments?.[0]?.name)).toEqual([
    "picked.png",
    "reply.png",
  ]);
  await page.screenshot({ path: `${SHOTS}/ac2-reply.png` });
});

test("AC-3 thumbnails render from stored refs, survive reload + reopen", async ({
  page,
}) => {
  await dmDefault(page, stack.webUrl);
  await attach(page, "pick", "stored.png");
  await page
    .locator("main textarea")
    .pressSequentially("look at this", { delay: 10 });
  await page.locator("main form").evaluate((f: HTMLFormElement) => {
    f.requestSubmit();
  });
  await page.waitForURL(/\/dm\/[^/]+\/[^/]+\/focus$/);
  await expect(
    page.locator('[data-attachments] img[alt="stored.png"]').first(),
  ).toBeVisible();

  // Reload: thumbnails resolve from the relay store, not from the blob URL.
  await page.reload();
  // Focus has no sidebar by design (#246) — Back to DM lands on the panel,
  // which has one.
  await page.getByTitle("Back to DM").click();
  await expect(
    page.locator("aside").getByRole("button", { name: /default/i }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(
    page.locator('[data-attachments] img[alt="stored.png"]').first(),
  ).toBeVisible({ timeout: 15_000 });

  // Home feed row shows it; reopening the session from the list does too.
  await page.goto(`${stack.webUrl}/`);
  await page
    .locator("aside")
    .first()
    .getByRole("button", { name: /default/i })
    .click();
  await expect(
    page.locator('main [data-attachments] img[alt="stored.png"]'),
  ).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: `${SHOTS}/ac3-feed.png` });
  await page
    .locator("[data-session]", { hasText: "look at this" })
    .getByRole("button", { name: /repl/i })
    .click();
  // #195: the row opens the peek panel — the conversation URL, not /focus.
  await page.waitForURL(/\/dm\/[^/]+\/[^/]+$/);
  await expect(
    page.locator('[data-attachments] img[alt="stored.png"]').first(),
  ).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/ac3-reopen.png` });
});

test("AC-4 oversize and too many files toast and send nothing", async ({
  page,
}) => {
  await dmDefault(page, stack.webUrl);
  // Serial mode shares the stack: earlier tests already left sessions in the
  // list — assert the count doesn't grow when a send is refused.
  const sessions = () => page.locator("[data-session]").count();
  const sessionsBefore = await sessions();

  // A file just over the 10 MiB cap: toast, no chip, nothing sent.
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(
      new File([new Uint8Array(10 * 1024 * 1024 + 1)], "huge.png", {
        type: "image/png",
      }),
    );
    const el = document.querySelector("main form");
    if (!el) throw new Error("form missing");
    el.dispatchEvent(
      new DragEvent("drop", { dataTransfer: dt, bubbles: true }),
    );
  });
  await expect(page.locator(TOAST)).toContainText(/exceed the maximum size/);
  await expect(formOf(page, "home").getByText("huge.png")).toHaveCount(0);
  expect(await sessions()).toBe(sessionsBefore);
  await page.screenshot({ path: `${SHOTS}/ac4-oversize.png` });

  // Over the 10-file cap: toast, only the first 10 stay, still nothing sent.
  await expect(page.locator(TOAST)).toHaveCount(0, { timeout: 10_000 });
  await page.locator('main input[type="file"]').setInputFiles(
    Array.from({ length: 11 }, (_, i) => ({
      name: `p${i}.png`,
      mimeType: "image/png",
      buffer: PNG,
    })),
  );
  await expect(page.locator(TOAST)).toContainText(/too many/i);
  await expect(page.locator('main form img[alt^="p"]')).toHaveCount(10);
  expect(await sessions()).toBe(sessionsBefore);

  // The relay itself still rejects an oversize attachment the same way.
  const empId = page.url().match(/\/dm\/([^/]+)/)?.[1] ?? "default";
  await expect(
    rpc(stack.home, RELAY, [
      { method: "channels.openDm", params: { employeeId: empId } },
    ]).then((r) =>
      rpc(stack.home, RELAY, [
        {
          method: "conversations.open",
          params: {
            channelId: (r[0] as { channel: { id: string } }).channel.id,
            text: "x",
            attachments: [
              {
                name: "huge.png",
                mimeType: "image/png",
                dataBase64: Buffer.alloc(10 * 1024 * 1024 + 1).toString(
                  "base64",
                ),
              },
            ],
          },
        },
      ]),
    ),
  ).rejects.toMatchObject({ data: { code: "attachment_too_large" } });
});

test("AC-5 engine-fake receives the image as a prompt content block", async ({
  page,
}) => {
  await dmDefault(page, stack.webUrl);
  await attach(page, "pick", "seen.png");
  await page
    .locator("main textarea")
    .pressSequentially("describe it", { delay: 10 });
  await page.locator("main form").evaluate((f: HTMLFormElement) => {
    f.requestSubmit();
  });
  await page.waitForURL(/\/dm\/[^/]+\/[^/]+\/focus$/);
  await expect(
    page.locator("text=/prompt content block/i").last(),
  ).toContainText("image/png (78 bytes)", { timeout: 15_000 });
  await page.screenshot({ path: `${SHOTS}/ac5-engine.png` });
});

test("AC-2b an image-only send (no typed text) opens a session and replies", async ({
  page,
}) => {
  await dmDefault(page, stack.webUrl);
  // Chip only — no text in the composer at all.
  await attach(page, "pick", "only.png");
  await page.locator("main form").evaluate((f: HTMLFormElement) => {
    f.requestSubmit();
  });
  await page.waitForURL(/\/dm\/[^/]+\/[^/]+\/focus$/);
  // The message rendered with its thumbnail and the engine answered it —
  // the fake only prints "prompt content block" for a real image block.
  await expect(
    page.locator('[data-attachments] img[alt="only.png"]').first(),
  ).toBeVisible();
  await expect(
    page.locator("text=/prompt content block/i").last(),
  ).toContainText("image/png", { timeout: 30_000 });

  // Wire check: the root message carried attachments with empty text.
  const dmUrl = page.url().match(/\/dm\/([^/]+)\/([^/]+?)(?:\/focus)?$/);
  if (!dmUrl) throw new Error("not on a conversation");
  const [, emp, conv] = dmUrl;
  const chan = await rpc(stack.home, RELAY, [
    { method: "channels.openDm", params: { employeeId: emp } },
  ]);
  const channelId = (chan[0] as { channel: { id: string } }).channel.id;
  const listed = await rpc(stack.home, RELAY, [
    { method: "messages.list", params: { channelId, conversationId: conv } },
  ]);
  const rootOnly = (
    listed[0] as {
      messages: {
        id: string;
        text: string;
        attachments?: { name: string }[];
      }[];
    }
  ).messages.find((m) => m.attachments?.[0]?.name === "only.png");
  expect(rootOnly?.text).toBe("");

  // Same again as a reply in the open thread.
  await attach(page, "pick", "only-reply.png", "thread");
  await formOf(page, "thread").evaluate((f: HTMLFormElement) =>
    f.requestSubmit(),
  );
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
  await dmDefault(page, stack.webUrl);
  // An edit prompt parks the fake on an approval — the turn is provably
  // running, so the next message meets the steer-or-queue fork.
  await page
    .locator("main textarea")
    .pressSequentially("Add a release note to the readme", { delay: 10 });
  await page.locator("main form").evaluate((f: HTMLFormElement) => {
    f.requestSubmit();
  });
  await page.waitForURL(/\/dm\/[^/]+\/[^/]+\/focus$/);
  await expect(page.getByText("Approval needed").first()).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByText("Enter steers · ■ stop")).toBeVisible({
    timeout: 30_000,
  });

  // Mid-turn message WITH an image: `session.steer` is text-only, so the
  // harness must queue it and prompt it (with the image block) next.
  await attach(page, "pick", "midturn.png", "thread");
  await page
    .locator("textarea")
    .last()
    .pressSequentially("carry this image too", { delay: 10 });
  await formOf(page, "thread").evaluate((f: HTMLFormElement) =>
    f.requestSubmit(),
  );

  // Unblock the parked turn; the queued image message runs as its own turn.
  // Same approval loop as ac-27 — the edit script can raise several asks.
  for (let i = 0; i < 6; i++) {
    const allow = page.getByRole("button", { name: "Allow once" });
    if (
      !(await allow
        .first()
        .isVisible()
        .catch(() => false))
    )
      break;
    await allow.first().click();
    await page.waitForTimeout(400);
  }
  // The fake echoes the image block AND the message's own text — the image
  // reached the engine on the queued message's prompt, not folded into the
  // steered turn.
  const imageAnswer = page
    .locator("[data-agentturn]")
    .filter({ hasText: "prompt content block" })
    .last();
  await expect(imageAnswer).toContainText("image/png", {
    timeout: 120_000,
  });
  await expect(imageAnswer).toContainText("carry this image too");
  // No steer ever landed — a steered text shows as an "Oscar steered" chip.
  await expect(page.getByText("Oscar steered")).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/ac5b-queued-image.png` });
});
