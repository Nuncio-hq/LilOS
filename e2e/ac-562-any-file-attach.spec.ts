import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import {
  bootStack,
  panelIntoFocus,
  pickPorts,
  type Stack,
} from "./helpers/stack";

/**
 * #562: any file type attaches to a message, not just images. AC-1 pick a
 * non-image → chip (name, size, icon) in composer + sent message; AC-2 the
 * bytes land in the session folder (`<cwd>/.lilos/attachments/`, kept out
 * of git via info/exclude) and the prompt names the path — engine-fake
 * echoes it back; AC-3 over-cap → plain error and the draft is kept; AC-4
 * a folder-less session still stores the file (harness state dir).
 *
 * Real stack (relay + harness + engine-fake + vite dev), same pattern as
 * ac-112 (image attachments) and ac-113 (folder picking).
 */
const ROOT = path.join(
  path.dirname(fileURLToPath(import.meta.url)).replace(/\/e2e$/, ""),
  "test-results",
  "ac-562",
);
const SHOTS = path.join(ROOT, "shots");
const repoDir = path.join(ROOT, "repo-a");
mkdirSync(repoDir, { recursive: true });
execSync(
  "git init -b trunk && git -c user.email=t@t -c user.name=t commit --allow-empty -m init",
  { cwd: repoDir },
);

const PDF = Buffer.concat([
  Buffer.from("%PDF-1.4\n"),
  Buffer.alloc(2000, 0x61),
]); // 2.0 KB
const LOG = Buffer.alloc(512, 0x62); // 512 B
const TXT = Buffer.from("folder-less attachment\n");

const TOAST = "[data-toast]";

/** The employee home DM for the fake engine's seeded employee. */
async function dmDefault(page: Page, stack: Stack) {
  await page.goto(`${stack.webUrl}/?roots=${ROOT}`);
  const aside = page.locator("aside").first();
  await expect(aside.getByRole("button", { name: /default/i })).toBeVisible({
    timeout: 30_000,
  });
  const firstRun = page.getByRole("button", { name: /open dm/i });
  if (await firstRun.isVisible().catch(() => false)) {
    await firstRun.click();
  } else {
    await aside.getByRole("button", { name: /default/i }).click();
  }
  await expect(page.locator("main form")).toBeVisible({ timeout: 15_000 });
}

/** Stage a file through the composer's own input. */
async function attach(
  page: Page,
  name: string,
  mimeType: string,
  buffer: Buffer,
) {
  await page
    .locator('main input[type="file"]')
    .setInputFiles({ name, mimeType, buffer });
}

const pickerButton = (page: Page) => page.locator('[data-ws="folder"]');

/** Open the folder menu; returns the menu container. */
async function openPicker(page: Page) {
  await pickerButton(page).click();
  return page
    .locator('[role="menu"], [data-slot="dropdown-menu-content"]')
    .last();
}

const send = async (page: Page, text: string) => {
  const box = page.locator("main textarea").first();
  await box.fill(text);
  await box.press("Enter");
};

let stack: Stack;

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

test.beforeAll(async () => {
  const ports = await pickPorts();
  stack = await bootStack("ac562", ports, {
    LILOS_ENGINE: "fake",
  });
  /* The folder menu lists relay recents (ac-113: the Add-folder dialog
     populates them) — seed repoDir once so every test can pick it. */
  await rpc(stack.home, ports.relay, [
    { method: "folders.add", params: { path: repoDir } },
  ]);
});

test.afterAll(async () => {
  await stack?.stop();
  rmSync(ROOT, { recursive: true, force: true });
});

test("AC-1 the composer takes any file — chips show name + size", async ({
  page,
}) => {
  await dmDefault(page, stack);
  await expect(page.locator('main input[type="file"]')).toHaveAttribute(
    "accept",
    "*/*",
  );
  await attach(page, "spec.pdf", "application/pdf", PDF);
  await attach(page, "run.log", "text/plain", LOG);
  const form = page.locator("main form");
  await expect(form.getByText("spec.pdf")).toBeVisible();
  await expect(form.getByText("run.log")).toBeVisible();
  await expect(form.getByText("2.0 KB")).toBeVisible();
  await expect(form.getByText("512 B")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/ac1-chips.png` });
});

test("AC-2 files land in the session folder; the prompt names the paths", async ({
  page,
}) => {
  await dmDefault(page, stack);
  const folderMenu = await openPicker(page);
  await folderMenu.locator(`[data-wsfolder="${repoDir}"]`).click();
  await expect(pickerButton(page)).toContainText("repo-a");
  await attach(page, "spec.pdf", "application/pdf", PDF);
  await attach(page, "run.log", "text/plain", LOG);
  await send(page, "read these files");
  await panelIntoFocus(page);

  // The sent message shows the same chips.
  const main = page.locator("main");
  await expect(
    main.locator("[data-attachments]", { hasText: "spec.pdf" }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(
    main.locator("[data-attachments]", { hasText: "run.log" }),
  ).toBeVisible();

  // engine-fake answers citing the saved paths the prompt named.
  await expect(
    main.getByText("Got your files", { exact: false }).last(),
  ).toBeVisible({ timeout: 30_000 });
  await expect(
    main.getByText("spec.pdf (2.0 KB)", { exact: false }).last(),
  ).toBeVisible();
  await expect(
    main.getByText("run.log (512 B)", { exact: false }).last(),
  ).toBeVisible();

  // The bytes are really on disk, in the session folder, out of git.
  const dir = path.join(repoDir, ".lilos", "attachments");
  expect(readFileSync(path.join(dir, "spec.pdf"))).toEqual(PDF);
  expect(readFileSync(path.join(dir, "run.log"))).toEqual(LOG);
  expect(
    readFileSync(path.join(repoDir, ".git", "info", "exclude"), "utf8"),
  ).toContain(".lilos/attachments/");
  await page.screenshot({ path: `${SHOTS}/ac2-saved.png` });
});

test("AC-2b a resend with the same name collides, not clobbers", async ({
  page,
}) => {
  await dmDefault(page, stack);
  const folderMenu = await openPicker(page);
  await folderMenu.locator(`[data-wsfolder="${repoDir}"]`).click();
  await attach(page, "spec.pdf", "application/pdf", TXT); // different bytes
  await send(page, "again");
  await panelIntoFocus(page);
  await expect(
    page.locator("main").getByText("Got your file", { exact: false }).last(),
  ).toBeVisible({ timeout: 30_000 });
  const dir = path.join(repoDir, ".lilos", "attachments");
  expect(readFileSync(path.join(dir, "spec-1.pdf"))).toEqual(TXT);
  expect(readFileSync(path.join(dir, "spec.pdf"))).toEqual(PDF);
});

test("AC-3 over-cap file → plain error, draft kept, nothing sent", async ({
  page,
}) => {
  await dmDefault(page, stack);
  const big = Buffer.alloc(10 * 1024 * 1024 + 1, 0x63);
  await page.locator("main textarea").fill("keep this draft");
  await page.locator('main input[type="file"]').setInputFiles({
    name: "huge.bin",
    mimeType: "application/octet-stream",
    buffer: big,
  });
  await expect(page.locator(TOAST)).toContainText("too large", {
    timeout: 10_000,
  });
  await expect(page.locator("main textarea")).toHaveValue("keep this draft");
  await expect(page.locator("main form").getByText("huge.bin")).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/ac3-overcap.png` });
  // Clean the draft so the next test starts empty.
  await page.locator("main textarea").fill("");
});

test("AC-4 a folder-less session still stores the attachment", async ({
  page,
}) => {
  await dmDefault(page, stack);
  // The employee remembers repoDir from earlier tests — explicitly take
  // the no-folder lane so the session has no cwd.
  const folderMenu = await openPicker(page);
  await folderMenu.getByText("No folder · just chat").click();
  await attach(page, "nofolder.txt", "text/plain", TXT);
  await send(page, "no folder on this one");
  await panelIntoFocus(page);
  await expect(
    page.locator("main").getByText("Got your file", { exact: false }).last(),
  ).toBeVisible({ timeout: 30_000 });
  const stored = path.join(
    stack.home,
    "harness",
    "attachments",
    "nofolder.txt",
  );
  expect(existsSync(stored)).toBe(true);
  expect(readFileSync(stored)).toEqual(TXT);
  await page.screenshot({ path: `${SHOTS}/ac4-no-folder.png` });
});
