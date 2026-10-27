import { execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import {
  bootStack,
  pickPorts,
  relayRpc,
  type Stack,
  skipFirstRun,
  v3Peek,
} from "./helpers/stack";

/**
 * #562: any file type attaches to a message, not just images. AC-1 pick a
 * non-image → chip (name, size, icon) in composer + sent message; AC-2 the
 * bytes land in the session folder (`<cwd>/.lilos/attachments/`, kept out
 * of git via info/exclude) and the prompt names the path — engine-fake
 * echoes it back; AC-3 a folder-less session still stores the file
 * (harness state dir); AC-4 over-cap → plain error and the draft is kept.
 *
 * Real stack (relay + harness + engine-fake + vite dev), same pattern as
 * ac-112 (image attachments) and ac-113 (folder picking).
 *
 * v3: the first message is written in the new-chat draft beside Threads: its
 * paperclip stages the files (chips in `[data-staged]`) and its Project chip
 * picks `repoDir`'s project or "No project · just chat". A reply from the thread
 * composer in the peek takes files the same way.
 */
const SHOTS = path.join(
  path.dirname(fileURLToPath(import.meta.url)).replace(/\/e2e$/, ""),
  "test-results",
  "ac-562",
  "shots",
);
/* The fixture folder is outside `test-results/`: Playwright empties that dir
   at the start of every run, and a run starting elsewhere mid-spec would pull
   the folder out from under the session (a sibling's file then lands without
   the collision this spec asserts). */
const ROOT = mkdtempSync(path.join(tmpdir(), "lilos-562-"));
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

/** The thread panel in the peek: its composer is the one that takes files. */
const panel = (page: Page) => v3Peek(page).locator("[data-thread-panel]");

/** The panel is up and its first turn has settled — a reply typed mid-turn
    is a steer, not the plain follow-up these legs mean. */
async function settled(page: Page) {
  await expect(panel(page).locator("form")).toBeVisible({ timeout: 30_000 });
  await expect(panel(page).locator("[data-turnsettled]").last()).toBeVisible({
    timeout: 60_000,
  });
}

const DEFAULT_AGENT = { id: "default", name: "Hermes" };

const draft = (page: Page) => v3Peek(page);
const draftBox = (page: Page) =>
  draft(page).getByPlaceholder(`Message ${DEFAULT_AGENT.name}…`);
/** The draft's staged files, and the line that says what was left out. */
const staged = (page: Page) => draft(page).locator("[data-staged]");

/** The new-chat draft with Default, its Project chip set to `choice`: the
    folder's project (its name), or "No project". The folder becomes a
    project over the relay first and the page reloads (the shell reads the
    company on mount). */
async function openDraft(page: Page, choice: "repo" | "none") {
  await skipFirstRun(page);
  await page.goto(`${stack.webUrl}/`);
  await relayRpc(page, stack, "folders.add", { path: repoDir });
  await relayRpc(page, stack, "projects.create", { folder: repoDir });
  await page.goto(
    `${stack.webUrl}/#?page=threads&open=newchat:${DEFAULT_AGENT.id}`,
  );
  await page.reload();
  const chip = draft(page).getByTitle(/^Project · /);
  await expect(chip).toBeVisible({ timeout: 30_000 });
  await chip.click();
  await draft(page)
    .getByRole("menuitemradio", {
      name: choice === "repo" ? /repo-a/ : /No project/,
    })
    .click();
  await expect(chip).toContainText(
    choice === "repo" ? "repo-a" : "No project",
    {
      timeout: 15_000,
    },
  );
  await expect(draftBox(page)).toBeVisible();
}

/** Send the draft; resolves once it has swapped for its thread. */
async function sendDraft(page: Page, text: string) {
  if (text) await draftBox(page).fill(text);
  await draft(page).getByRole("button", { name: "Send" }).click();
  await expect(page).toHaveURL(/open=thread:[^&]+/, { timeout: 30_000 });
  await settled(page);
}

/** Stage a file through a composer's own input: the draft's, or (`thread`)
    the open thread's reply box. */
async function attach(
  page: Page,
  name: string,
  mimeType: string,
  buffer: Buffer,
  where: "draft" | "thread" = "thread",
) {
  await (where === "draft" ? draft(page) : panel(page))
    .locator('input[type="file"]')
    .setInputFiles({ name, mimeType, buffer });
}

let stack: Stack;

test.describe.configure({ mode: "serial" });
test.setTimeout(120_000);

test.beforeAll(async () => {
  stack = await bootStack("ac562", await pickPorts(), {
    LILOS_ENGINE: "fake",
  });
});

test.afterAll(async () => {
  await stack?.stop();
  rmSync(ROOT, { recursive: true, force: true });
});

test("AC-1 the composer takes any file — chips show name + size", async ({
  page,
}) => {
  await openDraft(page, "repo");
  await expect(draft(page).locator('input[type="file"]')).toHaveAttribute(
    "accept",
    "*/*",
  );
  await attach(page, "spec.pdf", "application/pdf", PDF, "draft");
  await attach(page, "run.log", "text/plain", LOG, "draft");
  await expect(staged(page).getByText("spec.pdf")).toBeVisible();
  await expect(staged(page).getByText("run.log")).toBeVisible();
  await expect(staged(page).getByText("2.0 KB")).toBeVisible();
  await expect(staged(page).getByText("512 B")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/ac1-chips-draft.png` });

  // Chips come back off (this leg sends nothing: AC-2 names these files in
  // the same folder and must be the first to store them).
  for (const name of ["spec.pdf", "run.log"])
    await staged(page)
      .getByRole("button", { name: `Remove ${name}` })
      .click();
  await expect(staged(page).getByText("spec.pdf")).toHaveCount(0);
  await expect(staged(page).getByText("run.log")).toHaveCount(0);

  // The thread composer takes any file too.
  await sendDraft(page, "open a thread");
  await expect(panel(page).locator('input[type="file"]')).toHaveAttribute(
    "accept",
    "*/*",
  );
  await attach(page, "spec.pdf", "application/pdf", PDF);
  await attach(page, "run.log", "text/plain", LOG);
  const form = panel(page).locator("form");
  await expect(form.getByText("spec.pdf")).toBeVisible();
  await expect(form.getByText("run.log")).toBeVisible();
  await expect(form.getByText("2.0 KB")).toBeVisible();
  await expect(form.getByText("512 B")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/ac1-chips.png` });
});

test("AC-2 files land in the session folder; the prompt names the paths", async ({
  page,
}) => {
  await openDraft(page, "repo");
  await attach(page, "spec.pdf", "application/pdf", PDF, "draft");
  await attach(page, "run.log", "text/plain", LOG, "draft");
  await sendDraft(page, "read these files");

  // The sent message shows the same chips.
  const thread = panel(page);
  await expect(
    thread.locator("[data-attachments]", { hasText: "spec.pdf" }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(
    thread.locator("[data-attachments]", { hasText: "run.log" }),
  ).toBeVisible();

  // engine-fake answers citing the saved paths the prompt named.
  await expect(
    thread.getByText("Got your files", { exact: false }).last(),
  ).toBeVisible({ timeout: 30_000 });
  await expect(
    thread.getByText("spec.pdf (2.0 KB)", { exact: false }).last(),
  ).toBeVisible();
  await expect(
    thread.getByText("run.log (512 B)", { exact: false }).last(),
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
  await openDraft(page, "repo");
  await attach(page, "spec.pdf", "application/pdf", TXT, "draft"); // different bytes
  await sendDraft(page, "again");
  await expect(
    panel(page).getByText("Got your file", { exact: false }).last(),
  ).toBeVisible({ timeout: 30_000 });
  const dir = path.join(repoDir, ".lilos", "attachments");
  expect(readFileSync(path.join(dir, "spec-1.pdf"))).toEqual(TXT);
  expect(readFileSync(path.join(dir, "spec.pdf"))).toEqual(PDF);
});

test("AC-4 over-cap file → plain error, draft kept, nothing sent", async ({
  page,
}) => {
  await openDraft(page, "repo");
  const big = Buffer.alloc(10 * 1024 * 1024 + 1, 0x63);
  await draftBox(page).fill("keep this draft");
  await attach(page, "huge.bin", "application/octet-stream", big, "draft");
  await expect(staged(page)).toContainText("too large", { timeout: 10_000 });
  await expect(draftBox(page)).toHaveValue("keep this draft");
  await expect(staged(page).getByText("huge.bin")).toHaveCount(0);
  await expect(page).not.toHaveURL(/open=thread:/);
  await page.screenshot({ path: `${SHOTS}/ac3-overcap-draft.png` });

  // The thread composer says the same, in a toast, and keeps its draft.
  await sendDraft(page, "");
  const box = panel(page).locator("textarea");
  await box.fill("keep this draft too");
  await attach(page, "huge.bin", "application/octet-stream", big);
  await expect(page.locator(TOAST)).toContainText("too large", {
    timeout: 10_000,
  });
  await expect(box).toHaveValue("keep this draft too");
  await expect(panel(page).locator("form").getByText("huge.bin")).toHaveCount(
    0,
  );
  await page.screenshot({ path: `${SHOTS}/ac3-overcap.png` });
});

test("AC-3 a folder-less session still stores the attachment", async ({
  page,
}) => {
  // The shared stack has `repoDir` in its recents by now: the draft's "No
  // folder · just chat" is the explicit lane, so the session has no cwd.
  await openDraft(page, "none");
  await attach(page, "nofolder.txt", "text/plain", TXT, "draft");
  await sendDraft(page, "no folder on this one");
  await expect(
    panel(page).getByText("Got your file", { exact: false }).last(),
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
