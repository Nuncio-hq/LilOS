import os from "node:os";
import { expect, type Page, test } from "@playwright/test";
import {
  bootStack,
  pickPorts,
  type Stack,
  skipFirstRun,
  v3Sidebar,
} from "./helpers/stack";
import { openTroubleshooting } from "./helpers/status";

/**
 * Settings in the v3 shell (real stack: relay + harness on engine-fake). The
 * three tabs show what the relay and the engine really report, and a change
 * made here is the company's: it survives a reload. Phone pairing mints a
 * real one-time code (a QR and the same code to type), and Cancel / Turn off
 * put the empty state back; turning access off closes the relay's phone
 * listener for real.
 */

/** Physical-interface IPv4 first: tunnel/virtual interfaces (utun, awdl) on a
 *  dev Mac can blackhole connects instead of refusing. The relay binds its
 *  phone listener here, standing in for the tailnet address. */
function lanAddress(): string | undefined {
  const physical: string[] = [];
  const other: string[] = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces()))
    for (const a of addrs ?? [])
      if (a.family === "IPv4" && !a.internal)
        (name.startsWith("en") ? physical : other).push(a.address);
  return physical[0] ?? other[0];
}

const lan = lanAddress();
let stack: Stack;
test.beforeAll(async () => {
  test.setTimeout(120_000);
  stack = await bootStack("v3settings", await pickPorts(), {
    LILOS_USER_NAME: "Test User",
    ...(lan
      ? {
          LILOS_RELAY_TAILSCALE_IP: lan,
          LILOS_RELAY_TAILSCALE_NAME: "mac.tailnet.test",
        }
      : {}),
  });
});
test.afterAll(async () => {
  await stack?.stop();
});

test.describe.configure({ mode: "serial" });

const main = (page: Page) => page.locator("#v3-main");
const settings = async (page: Page, view: "general" | "engine" | "phone") => {
  await page.goto(`${stack.webUrl}/#?page=settings&view=${view}`);
  await expect(main(page).getByRole("heading", { level: 1 })).toHaveText(
    "Settings",
    { timeout: 30_000 },
  );
};
const tab = (page: Page, name: string) =>
  main(page).getByRole("button", { name, exact: true });
const approvals = (page: Page) =>
  page.getByRole("radiogroup", { name: "Approvals" });

test("General and Engine & models show the real company and engine; what you change here is the company's, and survives a reload", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await skipFirstRun(page);

  // The tabs a company with nothing to connect gets: three, no Connectors.
  await settings(page, "general");
  await expect(main(page).locator("button[title]")).toHaveText(
    ["General", "Engine & models", "Phone"],
    { timeout: 30_000 },
  );
  await expect(tab(page, "Connectors")).toHaveCount(0);

  // General: you and the company come from the relay's profile (the name the
  // OS gave), approvals default to asking, and About names the real builds.
  await expect(main(page)).toContainText("Test User");
  await expect(main(page)).toContainText("Test's Co");
  await expect(
    approvals(page).getByRole("radio", { checked: true }),
  ).toHaveText(/Ask before risky commands/);
  // About shows the app version only; the relay/harness builds sit under
  // Troubleshooting on the Engine tab (#885).
  await expect(main(page)).toContainText(/LilOS \d+\.\d+\.\d+|\d+\.\d+\.\d+/);

  // Rename the company and yourself in place: the sidebar and Home follow.
  const fact = (label: string) =>
    main(page).getByText(label, { exact: true }).locator("..");
  await fact("Company").getByRole("button", { name: "Rename…" }).click();
  await page.getByLabel("Company").fill("Acme Labs");
  await page.getByLabel("Company").press("Enter");
  await fact("Your name").getByRole("button", { name: "Rename…" }).click();
  await page.getByLabel("Your name").fill("Rowan Test");
  await page.getByLabel("Your name").press("Enter");
  await expect(v3Sidebar(page)).toContainText("Acme Labs");
  await expect(fact("Company")).toContainText("Acme Labs");
  await expect(fact("Your name")).toContainText("Rowan Test");

  // Approvals: Full access is one click, and the new default sticks.
  await approvals(page).getByRole("radio", { name: "Full access" }).click();
  await expect(
    approvals(page).getByRole("radio", { name: "Full access" }),
  ).toHaveAttribute("aria-checked", "true");

  await page.reload();
  await expect(v3Sidebar(page)).toContainText("Acme Labs", { timeout: 30_000 });
  await expect(fact("Your name")).toContainText("Rowan Test");
  await expect(
    approvals(page).getByRole("radio", { name: "Full access" }),
  ).toHaveAttribute("aria-checked", "true");
  await page.goto(`${stack.webUrl}/#?page=home`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Good afternoon, Rowan Test",
  );

  // Engine & models: the engine names itself and is running, the relay is
  // connected, and the agents on it are the company's real ones.
  await settings(page, "engine");
  // The engine card, relay row and checks live inside Troubleshooting (#885).
  await openTroubleshooting(page);
  await expect(main(page)).toContainText("Engine-fake", { timeout: 30_000 });
  await expect(main(page)).toContainText("0.0.0");
  await expect(main(page)).toContainText(/relay \d+\.\d+\.\d+ · harness \d/);
  // "Running" is said once — by the engine's card, not again under Status.
  await expect(main(page).getByText("Running")).toHaveCount(1);
  const relayRow = main(page)
    .getByText("Local relay", { exact: true })
    .locator("../..");
  await expect(relayRow).toContainText("Connected");
  await expect(
    main(page).getByRole("button", { name: /Hermes/ }),
  ).toContainText("Connected");
  await main(page).getByRole("button", { name: "Check again" }).click();
  await expect(main(page)).toContainText("Checked just now · all good.", {
    timeout: 30_000,
  });

  // Models: the engine's catalog, each one a switch. Turning one off takes it
  // out of every picker (Hire's model row), and it is still off after a reload.
  const small = main(page).getByRole("switch", { name: "Fake Small on" });
  await expect(main(page)).toContainText("4 on");
  await expect(small).toHaveAttribute("aria-checked", "true");
  await small.click();
  await expect(small).toHaveAttribute("aria-checked", "false");
  await expect(main(page)).toContainText("3 on");
  await page.reload();
  await expect(
    main(page).getByRole("switch", { name: "Fake Small on" }),
  ).toHaveAttribute("aria-checked", "false", { timeout: 30_000 });
  await page.goto(`${stack.webUrl}/#?page=hire`);
  await main(page)
    .getByRole("button", { name: /Researcher/ })
    .click();
  const models = main(page).locator("form");
  await expect(
    models.getByRole("button", { name: "Fake Large" }),
  ).toBeVisible();
  await expect(models.getByRole("button", { name: "Fake Small" })).toHaveCount(
    0,
  );

  // The tabs are places: each is in the URL, and Back walks them.
  await settings(page, "general");
  await tab(page, "Engine & models").click();
  await expect(page).toHaveURL(/page=settings&view=engine$/);
  await tab(page, "Phone").click();
  await expect(page).toHaveURL(/page=settings&view=phone$/);
  await page.goBack();
  await expect(page).toHaveURL(/page=settings&view=engine$/);
  await expect(main(page)).toContainText("Models");
  expect(errors).toEqual([]);
});

test("Phone: Pair a phone shows a real one-time code and a QR; Cancel and Turn off phone access put the empty state back", async ({
  page,
}) => {
  test.skip(!lan, "no LAN address for the tailnet-bind stand-in");
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await skipFirstRun(page);
  await settings(page, "phone");

  const empty = main(page).getByText(
    "No phone paired yet. Pair one to answer your agents from anywhere.",
  );
  const pair = main(page).getByRole("button", { name: "Pair a phone" });
  const qr = main(page).getByRole("img", {
    name: "Pairing code to scan with your iPhone",
  });
  const code = main(page).getByText(
    /^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/,
  );
  await expect(empty).toBeVisible({ timeout: 30_000 });
  await expect(main(page)).toContainText("Paired phones");
  await expect(qr).toHaveCount(0);

  // A code and a QR, with the address the phone types when it cannot scan:
  // the relay's phone port, on the tailnet name.
  await pair.click();
  await expect(qr).toBeVisible({ timeout: 30_000 });
  await expect(qr.locator("path").first()).toBeAttached();
  await expect(code).toBeVisible();
  await expect(main(page)).toContainText(
    `mac.tailnet.test:${stack.ports.relay}`,
  );
  await expect(main(page)).toContainText("Works once · expires in");
  await expect(main(page)).toContainText("Waiting for the phone…");
  await expect(empty).toHaveCount(0);
  const first = await code.innerText();

  // The phone port is open while the card is up.
  const phone = (path: string) =>
    fetch(`http://${lan}:${stack.ports.relay}${path}`, {
      signal: AbortSignal.timeout(5_000),
    });
  expect((await phone("/healthz")).ok).toBe(true);

  // Cancel: the card goes and the page is as it was, ready to pair again.
  await main(page).getByRole("button", { name: "Cancel" }).click();
  await expect(qr).toHaveCount(0);
  await expect(code).toHaveCount(0);
  await expect(empty).toBeVisible();
  await expect(pair).toBeVisible();

  // Again: a fresh one-time code, never the one that was shown.
  await pair.click();
  await expect(qr).toBeVisible({ timeout: 30_000 });
  await expect(code).toBeVisible();
  expect(await code.innerText()).not.toBe(first);

  // Turn off phone access: the card goes, the empty state is back, and the
  // relay really stops answering on the phone port.
  await main(page)
    .getByRole("button", { name: "Turn off phone access" })
    .click();
  await expect(qr).toHaveCount(0);
  await expect(empty).toBeVisible();
  await expect(pair).toBeVisible();
  await expect
    .poll(
      async () =>
        phone("/healthz").then(
          () => "open",
          () => "closed",
        ),
      {
        message: "the relay's phone listener should be closed",
        timeout: 15_000,
      },
    )
    .toBe("closed");
  // The page itself is unaffected: the loopback relay still serves it.
  await expect(main(page).getByRole("heading", { level: 1 })).toHaveText(
    "Settings",
  );
  expect(errors).toEqual([]);
});
