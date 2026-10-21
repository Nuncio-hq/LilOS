import { expect, type Page, test } from "@playwright/test";
import {
  bootStack,
  openDefaultAgent,
  pickPorts,
  type Stack,
  startChat,
  v3Peek,
  v3Sidebar,
} from "./helpers/stack";

/**
 * Nothing the app cannot do is drawn (real stack: relay + harness on
 * engine-fake, where there is no ticket backend). No Work, Goals or Inbox in
 * the sidebar and no way into them by link, no "Give a ticket", no ticket,
 * goal or CEO copy on the pages that are there; and ⌘K is a search that
 * jumps, not a CEO to draft work for.
 */

let stack: Stack;
let agent: { id: string; name: string };
test.beforeAll(async () => {
  test.setTimeout(120_000);
  stack = await bootStack("v3notickets", await pickPorts());
});
test.afterAll(async () => {
  await stack?.stop();
});

test.describe.configure({ mode: "serial" });

const main = (page: Page) => page.locator("#v3-main");
/** Words that belong to the ticket backend (M2) and to the CEO position. */
const TICKET_WORDS = /\b(tickets?|goals?|inbox|CEO)\b/i;
const palette = (page: Page) => page.getByRole("dialog", { name: "Search" });

test("the sidebar offers Work, Goals and Inbox to nobody, and a link to them lands on Home", async ({
  page,
}) => {
  test.setTimeout(120_000);
  agent = await openDefaultAgent(page, stack.webUrl);
  const side = v3Sidebar(page);

  // What a company without tickets does have.
  for (const name of [
    "Search",
    "Home",
    "Needs you",
    "Threads",
    "Hire an agent",
    "How it works",
    "Settings",
  ])
    await expect(
      side.getByRole("button", { name: new RegExp(`^${name}`) }),
    ).toBeVisible();
  await expect(side.getByText("People", { exact: true })).toBeVisible();
  await expect(side.getByRole("button", { name: /Default/ })).toBeVisible();

  // What it does not: no entry, no count, no trace.
  for (const name of ["Work", "Goals", "Inbox"])
    await expect(
      side.getByRole("button", { name: new RegExp(`^${name}`) }),
    ).toHaveCount(0);
  await expect(side.getByText("Projects", { exact: true })).toHaveCount(0);

  // A link to those pages is not a dead end: it lands on Home, and a ticket
  // or goal link opens no record beside it. (A project is not gated: it is
  // a folder, see ac-771.)
  const links: [string, string][] = [
    ["#?page=work", "Good afternoon"],
    ["#?page=inbox", "Good afternoon"],
    ["#?page=goals", "Good afternoon"],
    ["#?page=work&open=ticket:HB-12", "Good afternoon"],
    ["#?page=goals&open=goal:g1", "Good afternoon"],
  ];
  for (const [link, heading] of links) {
    await page.goto(`${stack.webUrl}/${link}`);
    await page.reload();
    await expect(main(page).getByRole("heading", { level: 1 })).toContainText(
      heading,
      { timeout: 30_000 },
    );
    await expect(v3Peek(page)).toHaveCount(0);
  }
});

test("no ticket, goal or CEO copy on the pages that exist, and no 'Give a ticket'", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await openDefaultAgent(page, stack.webUrl);
  await startChat(page, stack.webUrl, agent, "Say hello then list files");
  await expect(
    v3Peek(page).getByRole("button", { name: "Copy" }).first(),
  ).toBeVisible({ timeout: 60_000 });

  // Home: no Goals section, no CEO briefing line.
  await page.goto(`${stack.webUrl}/#?page=home`);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    "Good afternoon",
    { timeout: 30_000 },
  );
  const sections = main(page).getByRole("heading", { level: 3 });
  await expect(sections).toContainText(["Needs you", "Team"]);
  await expect(sections.filter({ hasText: "Goals" })).toHaveCount(0);
  await expect(main(page)).toContainText("Nothing needs you.");

  // Every page and view the sidebar leads to, plus a person's page and the
  // new-chat draft beside People: none of them carries the words.
  const pages: [string, string][] = [
    ["#?page=home", "Good afternoon"],
    ["#?page=needs", "Needs you"],
    ["#?page=threads", "Threads"],
    ["#?page=threads&view=all", "Threads"],
    ["#?page=threads&view=agent", "Threads"],
    ["#?page=threads&view=scheduled", "Threads"],
    ["#?page=people", "People"],
    ["#?page=people&view=org", "People"],
    ["#?page=settings&view=general", "Settings"],
    ["#?page=settings&view=engine", "Settings"],
    ["#?page=settings&view=phone", "Settings"],
    // The role blurbs on Hire and the explainer name no ticket, goal or CEO.
    ["#?page=hire", "Hire an agent"],
    ["#?page=guide", "How the company works"],
    [`#?page=people&open=agent:${encodeURIComponent(agent.id)}`, "People"],
    [`#?page=people&open=newchat:${encodeURIComponent(agent.id)}`, "People"],
  ];
  for (const [link, heading] of pages) {
    await page.goto(`${stack.webUrl}/${link}`);
    await expect(main(page).getByRole("heading", { level: 1 })).toContainText(
      heading,
      { timeout: 30_000 },
    );
    if (link.includes("open=agent"))
      await expect(v3Peek(page).getByRole("heading", { level: 1 })).toHaveText(
        agent.name,
      );
    if (link.includes("open=newchat"))
      await expect(
        v3Peek(page).getByPlaceholder(`Message ${agent.name}…`),
      ).toBeVisible();
    const text = await page.locator("body").innerText();
    expect(
      text,
      `${link} mentions tickets, goals, an inbox or a CEO`,
    ).not.toMatch(TICKET_WORDS);
  }

  // A person's page offers Message, and no way to hand them a ticket.
  await page.goto(
    `${stack.webUrl}/#?page=people&open=agent:${encodeURIComponent(agent.id)}`,
  );
  await expect(
    v3Peek(page).getByRole("button", { name: "Message" }),
  ).toBeVisible({
    timeout: 30_000,
  });
  await expect(
    v3Peek(page).getByRole("button", { name: "Give a ticket" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /give a ticket/i }),
  ).toHaveCount(0);
  await expect(
    v3Peek(page).getByRole("button", { name: "Make CEO" }),
  ).toHaveCount(0);

  // Hire offers real roles (so the blurbs were drawn, not the "not available"
  // note), and How it works explains what is there today.
  await page.goto(`${stack.webUrl}/#?page=hire`);
  await expect(main(page).getByText("opens a PR for every change")).toBeVisible(
    {
      timeout: 30_000,
    },
  );
  await page.goto(`${stack.webUrl}/#?page=guide`);
  await expect(main(page).getByText("Settings → Phone")).toBeVisible({
    timeout: 30_000,
  });
});

test("⌘K searches and jumps; with no CEO behind it there is no draft to make", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await openDefaultAgent(page, stack.webUrl);
  await page.goto(`${stack.webUrl}/#?page=home`);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    "Good afternoon",
    { timeout: 30_000 },
  );

  // Search is the sidebar's one row (the top bar never repeats it, nor an
  // "Ask the CEO" box), and with no CEO to ask the palette says Search too.
  await expect(
    v3Sidebar(page).getByRole("button", { name: /^Search/ }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /^Search/ })).toHaveCount(1);
  await expect(page.getByText("Ask the CEO anything…")).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+k");
  await expect(palette(page)).toBeVisible();
  const box = palette(page).getByRole("textbox");
  await expect(box).toHaveAttribute(
    "placeholder",
    "Search people, threads, projects…",
  );
  await expect(box).toBeFocused();

  // Nothing typed: places to go, no "Try" suggestions, no Work.
  await expect(
    palette(page).getByRole("button", { name: /^Needs you/ }),
  ).toBeVisible();
  await expect(
    palette(page).getByRole("button", { name: /^Threads/ }),
  ).toBeVisible();
  await expect(
    palette(page).getByRole("button", { name: /^Work/ }),
  ).toHaveCount(0);
  await expect(palette(page).getByText("Try", { exact: true })).toHaveCount(0);

  // Typed text that matches nothing is not a request to a CEO: Enter does
  // nothing, and no plan or answer ever appears.
  await box.fill("plan the product launch for next quarter");
  await expect(palette(page).getByRole("button")).toHaveCount(0);
  await expect(palette(page).getByText(/Ask the CEO/)).toHaveCount(0);
  await box.press("Enter");
  await expect(palette(page)).toBeVisible();
  await expect(
    palette(page).getByText(/CEO is reading|answered in/),
  ).toHaveCount(0);
  await expect(page).toHaveURL(/#?$|\/$/);

  // A person: searching the name jumps to them, beside the page you were on.
  await box.fill(agent.name.slice(0, 3));
  // Threads of theirs match the name too; the person is the row that is not
  // labelled a thread, and it comes first.
  const hit = palette(page)
    .getByRole("button", { name: new RegExp(agent.name) })
    .filter({ hasNotText: "thread" });
  await expect(hit).toHaveCount(1);
  await expect(palette(page).getByRole("button").first()).toHaveText(
    new RegExp(agent.name),
  );
  await box.press("Enter");
  await expect(palette(page)).toHaveCount(0);
  await expect(v3Peek(page).getByRole("heading", { level: 1 })).toHaveText(
    agent.name,
  );
  await expect(page).toHaveURL(/open=agent:/);
  await expect(page.getByRole("heading", { level: 1 }).first()).toContainText(
    "Good afternoon",
  );

  // A thread: found by its words, and Esc closes the palette without moving.
  await startChat(page, stack.webUrl, agent, "Say hello then list files");
  await expect(
    v3Peek(page).getByRole("button", { name: "Copy" }).first(),
  ).toBeVisible({ timeout: 60_000 });
  await page.goto(`${stack.webUrl}/#?page=home`);
  await page.keyboard.press("ControlOrMeta+k");
  await palette(page).getByRole("textbox").fill("hello");
  // Every earlier chat that said hello is a hit (this stack has run two).
  const threads = palette(page).getByRole("button", { name: /hello/i });
  await expect(threads.first()).toContainText("thread");
  await expect(threads).not.toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(palette(page)).toHaveCount(0);
  await expect(page).not.toHaveURL(/open=/);
  await page.keyboard.press("ControlOrMeta+k");
  await palette(page).getByRole("textbox").fill("hello");
  await palette(page).getByRole("textbox").press("Enter");
  await expect(page).toHaveURL(/open=thread:conv_/);
  await expect(page.locator("[data-thread-panel]")).toBeVisible({
    timeout: 30_000,
  });
});
