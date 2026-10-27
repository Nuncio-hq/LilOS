import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { bootStack, pickPorts, skipFirstRun, v3Sidebar } from "./helpers/stack";

/**
 * Issue #153 — Pair phone in the real app (relay + harness + vite,
 * engine-fake). v3: it lives in Settings → Phone (`#?page=settings&view=phone`):
 * "Pair a phone" mints the offer and draws the QR + the code to type in the
 * pane itself (no dialog); paired phones list below it. The Tailscale probe
 * is env-seamed: the stack either points
 * LILOS_TAILSCALE_BIN at a missing binary (pane must say Tailscale is off)
 * or pins a fake tailnet identity via LILOS_RELAY_TAILSCALE_* (a real second
 * bind on this machine's LAN address stands in for the CGNAT IP). The phone
 * leg is the real HTTP exchange endpoint — no fake scan. Screenshots land in
 * test-results/ac153/ for the PR.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const SHOTS = path.join(repo, "test-results", "ac153");
mkdirSync(SHOTS, { recursive: true });

/** Physical-interface IPv4 first: tunnel/virtual ifaces (utun, awdl, llw,
    bridge) on a dev Mac can blackhole connects instead of refusing. */
function lanAddress(): string | undefined {
  const physical: string[] = [];
  const other: string[] = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal)
        (name.startsWith("en") ? physical : other).push(a.address);
    }
  }
  return physical[0] ?? other[0];
}

function watchConsole(page: Page) {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(String(e)));
  return errors;
}

/** Past first run, then Settings → Phone the way a person gets there. */
async function openPhonePane(page: Page, webUrl: string) {
  await skipFirstRun(page);
  await page.goto(`${webUrl}/`);
  await v3Sidebar(page)
    .getByRole("button", { name: /Hermes/ })
    .waitFor({ timeout: 30_000 });
  await v3Sidebar(page).getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Phone", exact: true }).click();
  await expect(page).toHaveURL(/[#?&]view=phone(&|$)/);
}

const pairButton = (page: Page) =>
  page.getByRole("button", { name: "Pair a phone" });
const qr = (page: Page) =>
  page.getByRole("img", { name: "Pairing code to scan with your iPhone" });
/** The value beside an "Address" / "Code" label in the pairing card. */
const pairValue = (page: Page, label: "Address" | "Code") =>
  page
    .getByText(label, { exact: true })
    .locator("xpath=following-sibling::span[1]");
const expiry = (page: Page) => page.getByText(/Works once|code expired/);

test.describe.configure({ timeout: 120_000 });

test("AC-1/AC-6 Tailscale down → Pair phone says so, no QR", async ({
  page,
}) => {
  // No tailscaled: the honest "not installed" probe failure.
  const stack = await bootStack("153down", await pickPorts(), {
    LILOS_TAILSCALE_BIN: "/nonexistent-tailscale-bin",
  });
  try {
    const errors = watchConsole(page);
    await openPhonePane(page, stack.webUrl);
    await pairButton(page).click();
    await expect(page.getByText("Turn on Tailscale first")).toBeVisible();
    await expect(qr(page)).toHaveCount(0);
    await page.screenshot({ path: path.join(SHOTS, "1-no-tailscale.png") });
    expect(errors).toEqual([]);
  } finally {
    await stack.stop();
  }
});

test("AC-2/AC-4/AC-6 grant shows a QR, exchange pairs, revoke drops it", async ({
  page,
}) => {
  const lan = lanAddress();
  test.skip(!lan, "no LAN address for the tailnet-bind stand-in");
  const stack = await bootStack("153up", await pickPorts(), {
    LILOS_RELAY_TAILSCALE_IP: lan,
    LILOS_RELAY_TAILSCALE_NAME: "mac.tailnet.test",
  });
  try {
    const errors = watchConsole(page);
    await openPhonePane(page, stack.webUrl);
    await expect(page.getByText("No phone paired yet")).toBeVisible();
    await pairButton(page).click();

    // QR encodes the fragment-carried grant; the offer rows show it chunked.
    await expect(qr(page)).toBeVisible();
    const address = await pairValue(page, "Address").innerText();
    const shownCode = await pairValue(page, "Code").innerText();
    // The advertised port is the tailnet listener's — the same config port
    // the loopback listener took.
    expect(address).toBe(`mac.tailnet.test:${new URL(stack.relayWs).port}`);
    expect(shownCode).toMatch(
      /^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/,
    );
    await expect(expiry(page)).toContainText("Works once");
    await page.screenshot({ path: path.join(SHOTS, "2-qr-ready.png") });

    // The phone: real HTTP exchange against the tailnet listener, code read
    // off the pane exactly as scanned.
    const tsPort = Number(address.split(":")[1]);
    const exchanged = await fetch(`http://${lan}:${tsPort}/pair/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code: shownCode.replaceAll("-", ""),
        name: "E2E iPhone",
      }),
      signal: AbortSignal.timeout(10_000),
    }).then(
      (r) => r.json() as Promise<{ deviceId: string; credential: string }>,
    );
    expect(exchanged.deviceId).toMatch(/^dev_/);

    // devices.changed flips the open card to "Paired" and lists the phone.
    await expect(page.getByText("Paired", { exact: true })).toBeVisible();
    await expect(page.getByText("E2E iPhone")).toBeVisible();
    await expect(page.getByText("No phone paired yet")).toHaveCount(0);
    await page.screenshot({ path: path.join(SHOTS, "3-paired.png") });

    // The card shows "Paired", then leaves on its own (a real state change,
    // not a timer in the spec) — unpairing inside that window would bring the
    // spent code's QR back (see report).
    await expect(page.getByText("Paired", { exact: true })).toBeHidden({
      timeout: 10_000,
    });

    // AC-4: Unpair (then confirm) → the row disappears and the credential dies.
    await page.getByRole("button", { name: "Unpair", exact: true }).click();
    await page.getByRole("button", { name: "Unpair", exact: true }).click();
    await expect(page.getByText("E2E iPhone")).toHaveCount(0);
    await expect(page.getByText("No phone paired yet")).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await stack.stop();
  }
});

test("AC-2 the pane refreshes the code after expiry", async ({ page }) => {
  const lan = lanAddress();
  test.skip(!lan, "no LAN address for the tailnet-bind stand-in");
  const stack = await bootStack("153ttl", await pickPorts(), {
    LILOS_RELAY_TAILSCALE_IP: lan,
    LILOS_RELAY_TAILSCALE_NAME: "mac.tailnet.test",
    LILOS_PAIRING_TTL_MS: "2500",
  });
  try {
    await openPhonePane(page, stack.webUrl);
    await pairButton(page).click();
    await expect(qr(page)).toBeVisible();
    const first = await pairValue(page, "Code").innerText();

    // Expiry state: dimmed QR + "New code" — the grant is dead server-side.
    await expect(expiry(page)).toContainText("expired", { timeout: 10_000 });
    await page.screenshot({ path: path.join(SHOTS, "4-expired.png") });
    await page.getByRole("button", { name: "New code" }).click();
    await expect(expiry(page)).toContainText("Works once");
    const second = await pairValue(page, "Code").innerText();
    expect(second).not.toBe(first);
    await page.screenshot({ path: path.join(SHOTS, "5-new-code.png") });
  } finally {
    await stack.stop();
  }
});
